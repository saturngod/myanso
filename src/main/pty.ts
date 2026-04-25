import { ipcMain, WebContents } from "electron";
import { spawn as spawnPty, IPty } from "node-pty";
import os from "node:os";

const USER_SHELL =
  process.env.SHELL ||
  (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");

interface Session {
  pty: IPty;
  buf: string;
  scheduled: boolean;
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

function schedule(id: string, s: Session): void {
  if (s.scheduled) return;
  s.scheduled = true;
  setImmediate(() => {
    s.scheduled = false;
    if (!s.buf) return;
    if (s.wc.isDestroyed()) {
      s.buf = "";
      return;
    }
    const out = s.buf;
    s.buf = "";
    s.wc.send("pty:data", id, out);
  });
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

  const s: Session = { pty, buf: "", scheduled: false, ready: false, wc };
  sessions.set(id, s);

  pty.onData((data) => {
    if (wc.isDestroyed()) return;
    s.buf += data;
    if (s.ready) schedule(id, s);
  });
  pty.onExit(({ exitCode }) => {
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
    sessions.delete(id);
  }
}
