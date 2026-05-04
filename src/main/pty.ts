import { ipcMain, WebContents } from "electron";
import { spawn as spawnPty, IPty } from "node-pty";
import { existsSync } from "node:fs";
import os from "node:os";
import { delimiter, join } from "node:path";

// $SHELL is unset on Windows and inside some Linux desktop launchers, so
// fall back per platform: zsh is the macOS default since Catalina; bash
// is universal on Linux; PowerShell on Windows.
function defaultShell(): string {
  if (process.platform === "win32") return windowsShell();
  if (process.platform === "darwin") return "/bin/zsh";
  return "/bin/bash";
}

function windowsShell(): string {
  return findPowerShell7() ?? "powershell.exe";
}

function findPowerShell7(): string | null {
  if (commandOnPath("pwsh.exe")) return "pwsh.exe";

  const candidates = [
    process.env.ProgramFiles &&
      join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"),
    process.env["ProgramFiles(x86)"] &&
      join(process.env["ProgramFiles(x86)"], "PowerShell", "7", "pwsh.exe"),
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, "Microsoft", "PowerShell", "7", "pwsh.exe"),
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, "Programs", "PowerShell", "7", "pwsh.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function commandOnPath(command: string): boolean {
  return (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(join(unquotePathEntry(dir), command)));
}

function unquotePathEntry(pathEntry: string): string {
  return pathEntry.replace(/^"(.+)"$/, "$1");
}

// `npm run` clobbers SHELL with its non-interactive script-shell (default
// /bin/sh), so during `npm run dev` we'd otherwise launch /bin/sh — bash
// in disguise on macOS — instead of the user's login shell. Treat any
// .../sh as "no real shell set" and use the platform default. A user with
// fish/elvish at SHELL=/usr/local/bin/fish still gets honored.
function resolveShell(): string {
  if (process.platform === "win32") return defaultShell();

  const s = process.env.SHELL;
  if (s && !/\/sh$/.test(s)) return s;
  return defaultShell();
}

const USER_SHELL = resolveShell();

interface Session {
  pty: IPty;
  buf: string;
  scheduled: boolean;
  flushTimer: NodeJS.Timeout | null;
  ready: boolean;
  wc: WebContents;
}

// One global session map across all windows. Sender identification by
// WebContents lets us multiplex multiple windows through the same IPC
// channels — registering ipcMain.handle("pty:spawn") more than once
// would throw, so we can't go per-window.
const sessions = new Map<string, Session>();
let nextId = 1;
let initialized = false;

const FLUSH_INTERVAL_MS = 8;
const MAX_BUFFERED_CHARS = 64 * 1024;

function flush(id: string, s: Session): void {
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
  s.scheduled = false;
  if (!s.buf) return;
  if (s.wc.isDestroyed()) {
    s.buf = "";
    return;
  }
  const out = s.buf;
  s.buf = "";
  s.wc.send("pty:data", id, out);
}

function schedule(id: string, s: Session): void {
  if (s.buf.length >= MAX_BUFFERED_CHARS) {
    flush(id, s);
    return;
  }
  if (s.scheduled) return;
  s.scheduled = true;
  s.flushTimer = setTimeout(() => flush(id, s), FLUSH_INTERVAL_MS);
}

function createSession(wc: WebContents, cwd?: string): string {
  const id = String(nextId++);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  const args =
    /\bbash$/.test(USER_SHELL) || /\bzsh$/.test(USER_SHELL) ? ["-l"] : [];

  const pty = spawnPty(USER_SHELL, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: cwd || os.homedir(),
    env: env as { [k: string]: string },
  });

  const s: Session = {
    pty,
    buf: "",
    scheduled: false,
    flushTimer: null,
    ready: false,
    wc,
  };
  sessions.set(id, s);

  pty.onData((data) => {
    if (wc.isDestroyed()) return;
    s.buf += data;
    if (s.ready) schedule(id, s);
  });
  pty.onExit(({ exitCode }) => {
    if (s.ready) flush(id, s);
    sessions.delete(id);
    if (!wc.isDestroyed()) wc.send("pty:exit", id, exitCode);
  });

  return id;
}

// Validate that the requesting renderer owns the session it's addressing.
// Prevents a hostile renderer (or stale cross-window id) from poking
// another window's PTYs.
function ownedSession(id: string, sender: WebContents): Session | null {
  const s = sessions.get(id);
  return s && s.wc === sender ? s : null;
}

// Initialize PTY IPC plumbing. Call once at app startup — registering
// ipcMain.handle a second time would throw.
export function initPtyHost(): void {
  if (initialized) return;
  initialized = true;

  ipcMain.handle(
    "pty:spawn",
    (e: Electron.IpcMainInvokeEvent, cwd?: string) =>
      createSession(e.sender, cwd),
  );

  ipcMain.on("pty:ready", (e, id: string) => {
    const s = ownedSession(id, e.sender);
    if (!s) return;
    s.ready = true;
    if (s.buf) schedule(id, s);
  });

  ipcMain.on("pty:write", (e, id: string, data: string) => {
    ownedSession(id, e.sender)?.pty.write(data);
  });

  ipcMain.on("pty:resize", (e, id: string, cols: number, rows: number) => {
    const s = ownedSession(id, e.sender);
    if (!s) return;
    try {
      s.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
    } catch {
      /* shell may have exited */
    }
  });

  ipcMain.on("pty:kill", (e, id: string) => {
    const s = ownedSession(id, e.sender);
    if (!s) return;
    try {
      s.pty.kill();
    } catch {
      /* already gone */
    }
    if (s.flushTimer) clearTimeout(s.flushTimer);
    sessions.delete(id);
  });
}

// Tear down all PTYs owned by a window. Caller invokes on window close,
// before the WebContents is gone — but it's safe either way since we
// only need the wc reference for identity comparison.
export function killSessionsFor(wc: WebContents): void {
  for (const [id, s] of sessions) {
    if (s.wc !== wc) continue;
    try {
      s.pty.kill();
    } catch {
      /* */
    }
    if (s.flushTimer) clearTimeout(s.flushTimer);
    sessions.delete(id);
  }
}
