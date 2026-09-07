const { app, BrowserWindow, ipcMain, Menu, screen, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { exec, execSync, execFile } = require('child_process');
const pty = require('node-pty');
const { stripSynchronizedOutput } = require('./lib/sync-output');
const {
  MAX_INPUT_LENGTH,
  validPtyId,
  validTabId,
  validPtyIds,
  validPtyCreate,
  validPtyInput,
  validPtyResize,
  validPtyReference,
  validTabDescriptor,
  validPaneTransfer,
  validCloseRequest
} = require('./lib/ipc-validation');

// On Windows prefer PowerShell 7 (pwsh) if installed — it has better Unicode
// handling, modern scripting, and cross-platform consistency. Falls back to the
// built-in Windows PowerShell 5.1 (powershell.exe) when pwsh isn't on PATH.
function resolveShell() {
  if (os.platform() !== 'win32') return process.env.SHELL || 'bash';
  try {
    // `where` is the Windows equivalent of `which`. Throws if not found.
    execSync('where pwsh.exe', { stdio: 'ignore' });
    return 'pwsh.exe';
  } catch (_) {
    return 'powershell.exe';
  }
}
const shellPath = resolveShell();
const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();

// A packaged .app launched from Finder/Dock does NOT inherit the terminal's
// LANG/LC_*, so the shell falls back to the C locale and tools like `ls` print
// `?` for every non-ASCII byte (Myanmar filenames become `????`). Force a
// UTF-8 locale when none is set. (Windows uses a code page, not LANG — skip it.)
function ptyEnv() {
  const env = { ...process.env };
  if (os.platform() !== 'win32') {
    // glibc precedence for character type: LC_ALL > LC_CTYPE > LANG. A non-UTF-8
    // LC_ALL/LC_CTYPE (e.g. LC_ALL=C) overrides LANG, so just setting LANG isn't
    // enough — drop the overriding vars before forcing LANG.
    const utf8 = (v) => v && /utf-?8/i.test(v);
    if (!utf8(env.LC_ALL || env.LC_CTYPE || env.LANG)) {
      delete env.LC_ALL;
      delete env.LC_CTYPE;
      env.LANG = 'en_US.UTF-8';
    }
  }
  // Tools using supports-hyperlinks (Claude Code, many node CLIs) only emit
  // OSC 8 links when they detect a supporting terminal via TERM_PROGRAM /
  // FORCE_HYPERLINK / VTE_VERSION. Our TERM=xterm-color matches none, so
  // force it on — renderer.js handles OSC 8 clicks.
  if (env.FORCE_HYPERLINK === undefined) env.FORCE_HYPERLINK = '1';
  return env;
}

// In dev (`electron .`) the packaged icon isn't used, so set the dock icon
// manually. Packaged builds get their icon from electron-builder.yml instead.
const iconPath = path.join(__dirname, 'icon.png');
const indexPath = path.join(__dirname, 'index.html');
const indexUrl = pathToFileURL(indexPath).href;
const permissionSessions = new WeakSet();

function isTrustedWebContents(wc) {
  if (!wc || wc.isDestroyed()) return false;
  const win = BrowserWindow.fromWebContents(wc);
  return !!win && !win.isDestroyed() && wc.getURL() === indexUrl;
}

function installPermissionPolicy(session) {
  if (permissionSessions.has(session)) return;
  permissionSessions.add(session);
  const allowed = (wc, permission) => permission === 'local-fonts' && isTrustedWebContents(wc);
  session.setPermissionRequestHandler((wc, permission, callback) => callback(allowed(wc, permission)));
  session.setPermissionCheckHandler((wc, permission) => allowed(wc, permission));
}

// Gear icon for the Settings menu item. On macOS use the native SF Symbol
// "gear" (Electron 42+ resolves SF Symbol names via createFromNamedImage),
// resized to menu-icon height and flagged as a template image so it tints for
// light/dark and highlight just like a real menu icon. nativeImage can't render
// SVG and named images don't exist off macOS, so other platforms get no icon
// and rely on the "Preferences…" label.
let settingsMenuIcon = null;
if (process.platform === 'darwin') {
  // The SF Symbol comes back as a single 34x32-pixel raster (no vector rep), so
  // resizing it down blurs on Retina. Instead reinterpret those pixels as the
  // @2x representation of a 17x16-point icon: the menu uses the full-resolution
  // pixels, staying crisp. Template image so it tints for light/dark/highlight.
  const src = nativeImage.createFromNamedImage('gear', [0, 0, 0, 1]);
  settingsMenuIcon = nativeImage.createFromBuffer(src.toPNG(), { scaleFactor: 2 });
  settingsMenuIcon.setTemplateImage(true);
}
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(iconPath);
  // Each pty schedules its own foreground-process checks when it is created.
});

// macOS: a folder (or file) dropped onto the dock icon, or `open` from Finder,
// fires `open-file`. It can arrive BEFORE the app is ready (cold start), so the
// handler is registered up here, outside whenReady. A file resolves to its
// parent directory.
function resolveDropDir(p) {
  try { if (!fs.statSync(p).isDirectory()) return path.dirname(p); } catch (_) { }
  return p;
}

// Folder dropped before the app is ready (cold start). The `ready` handler hands
// it to the first window so its FIRST tab opens there — sending an IPC instead
// would race the renderer's load and get dropped, leaving a stray home tab.
let pendingOpenDir = null;

// Linux/Windows have no `open-file` event: a folder opened via the file manager's
// "Open with" (or `myanso /path`) arrives as a command-line argument instead.
// Scan argv from the end for the last token that points at an existing path,
// skipping flags and the dev app-path '.'. A file resolves to its parent dir.
// `cwd` (optional): the directory to resolve relative paths against — a second
// instance's argv is relative to ITS working directory, not this process's.
function getDirFromArgv(argv, cwd) {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (!a || a.startsWith('-') || a === '.') continue;
    const full = path.resolve(cwd || process.cwd(), a);
    try { fs.statSync(full); return resolveDropDir(full); } catch (_) { }
  }
  return null;
}

// Open a folder in the running app: a new tab of the focused window, or a fresh
// window if none are open. Shared by `open-file` (macOS) and `second-instance`.
function openFolderInRunningApp(dir) {
  const win = BrowserWindow.getFocusedWindow() ||
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('open-folder', { path: dir });
  } else {
    createWindow(undefined, dir);
  }
}

// Single-instance: when the app is already running and the user opens another
// folder via "Open with", a SECOND process launches and fires `second-instance`
// in the PRIMARY one with the new process's argv. Route that folder to the
// existing window instead of leaving two processes (and two dock/taskbar icons).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    const dir = getDirFromArgv(argv, workingDirectory);
    if (dir) openFolderInRunningApp(dir);
    else {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    }
  });
}

app.on('open-file', (event, p) => {
  event.preventDefault();
  const dir = resolveDropDir(p);
  if (!app.isReady()) { pendingOpenDir = dir; return; }
  openFolderInRunningApp(dir);
});

// The app is multi-window. ptys live here in the main process (one per pane) and
// OUTLIVE the window that created them — a tab can be dragged to another window,
// at which point its ptys' `ownerWinId` is repointed so output flows to the new
// window. Routing is therefore by BrowserWindow id, not a single global `win`.
const ptys = new Map();          // ptyId -> { proc, ownerWinId }
const ptyBuffers = new Map();    // ptyId -> string[] of output coalesced this tick
const pendingPtyCreates = new Map(); // ptyId -> queued state while cwd resolves
let ptyFlushScheduled = false;   // at most one cross-pty flush per event-loop turn
let widCounter = 0;              // logical per-window id, only for unique pty-id prefixes
const tabCounts = new Map();     // BrowserWindow.id -> tab count (drives "Go to Tab N")
const pendingAdopt = new Map();  // BrowserWindow.id -> callback to run once its renderer is ready
let quitting = false;            // set in before-quit to guard pollPtyProcesses
let readyToQuit = false;         // set once the user confirms quitting a busy app
let processPollTimer = null;
let processPollDueAt = 0;
const PROCESS_POLL_ACTIVE_MS = 600;
const PROCESS_POLL_IDLE_MS = 2000;
const PROCESS_POLL_INPUT_GRACE_MS = 2000;

function ownerWindow(id) {
  const rec = ptys.get(id);
  if (!rec) return null;
  const w = BrowserWindow.fromId(rec.ownerWinId);
  return w && !w.isDestroyed() ? w : null;
}

function senderWindow(event) {
  const win = event && BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win : null;
}

function ownedPty(event, id) {
  if (!validPtyId(id)) return null;
  const win = senderWindow(event);
  const rec = ptys.get(id);
  return win && rec && rec.ownerWinId === win.id ? rec : null;
}

// Send all pty output buffered this tick as one IPC message per pty, then clear.
function flushPtyBuffers() {
  ptyFlushScheduled = false;
  for (const [id, chunks] of ptyBuffers) {
    ptyBuffers.delete(id);
    if (!chunks.length) continue;
    const w = ownerWindow(id);
    if (w) w.webContents.send('pty-data', { id, data: chunks.join('') });
  }
}

function updatePtyPaused(rec) {
  const shouldPause = !!(rec.flowPaused || rec.transferPaused);
  if (shouldPause === !!rec.paused) return;
  rec.paused = shouldPause;
  try {
    if (shouldPause) rec.proc.pause();
    else rec.proc.resume();
  } catch (_) { }
}

// Apps disagree on Myanmar mark widths (e.g. Claude Code counts every mark as 1,
// while zsh/agy count them as 0), so the renderer picks the width per foreground
// app. node-pty exposes the tty's current foreground process via `.process`; poll
// it and tell the owner window when it changes. Set MYAN_DEBUG_PROC=1 to log the
// reported names (useful when adding an app to the width lists in renderer.js).
function resolveNodeCmd(shellPid, cb) {
  // Async on purpose: execSync here would stall the whole main process — every
  // window's IPC, menus, and pty output flushing — for up to the 500ms timeout
  // each time a node-based CLI starts in any pane.
  exec(
    `ps -o pid=,command= -p $(pgrep -P ${shellPid} node 2>/dev/null | tail -1) 2>/dev/null`,
    { shell: '/bin/sh', timeout: 500 },
    (err, stdout) => {
      const out = err ? '' : stdout.toString().trim();
      if (process.env.MYAN_DEBUG_PROC) console.log('[myan] node cmd:', JSON.stringify(out));
      cb(out);
    }
  );
}

function reportPtyProcess(id, rec, name) {
  if (process.env.MYAN_DEBUG_PROC) console.log('[myan] pty', id, 'foreground:', JSON.stringify(name));
  rec.lastProcess = name;
  const w = ownerWindow(id);
  if (w) w.webContents.send('pty-process', { id, name });
}

function pollPtyProcesses() {
  if (quitting) return false;
  const now = Date.now();
  for (const [id, rec] of ptys) {
    if ((rec.nextProcessPollAt || 0) > now) continue;
    let raw = '';
    let pid = 0;
    try { raw = (rec.proc.process || '').toString(); pid = rec.proc.pid; } catch (e) { /* dead pty */ }
    // Keep polling a live program promptly; a settled shell can use the slower
    // idle cadence. ssh/mosh are opaque here: the local foreground stays the
    // client for the whole remote session, so faster polling cannot reveal the
    // program running remotely. An empty name stays active until it resolves.
    const active = !isShellForeground(raw) && !REMOTE_SESSION_FG.test(baseName(raw));
    rec.nextProcessPollAt = now + (active || now < (rec.processPollFastUntil || 0)
      ? PROCESS_POLL_ACTIVE_MS : PROCESS_POLL_IDLE_MS);
    // Skip expensive resolution if the raw name hasn't changed.
    if (raw === rec.lastRaw) continue;
    rec.lastRaw = raw;
    // When foreground is "node", resolve full command to distinguish apps like
    // codex. Report once it's known — unless the foreground changed again while
    // ps/pgrep ran, in which case a later poll already reported the new app.
    if (raw === 'node' && pid) {
      resolveNodeCmd(pid, (cmd) => {
        if (quitting || ptys.get(id) !== rec || rec.lastRaw !== 'node') return;
        reportPtyProcess(id, rec, cmd ? 'node:' + cmd : 'node');
      });
      continue;
    }
    reportPtyProcess(id, rec, raw);
  }
}

function schedulePtyProcessPoll() {
  if (quitting) return;
  let dueAt = Infinity;
  for (const rec of ptys.values()) {
    dueAt = Math.min(dueAt, rec.nextProcessPollAt || Date.now());
  }
  if (!Number.isFinite(dueAt)) {
    if (processPollTimer) clearTimeout(processPollTimer);
    processPollTimer = null;
    processPollDueAt = 0;
    return;
  }
  // Keep an already-earlier poll. Input can preempt an idle-shell check, but
  // rapid keystrokes do not continuously push that check farther away.
  if (processPollTimer && processPollDueAt <= dueAt) return;
  if (processPollTimer) clearTimeout(processPollTimer);
  processPollDueAt = dueAt;
  processPollTimer = setTimeout(() => {
    processPollTimer = null;
    processPollDueAt = 0;
    pollPtyProcesses();
    schedulePtyProcessPoll();
  }, Math.max(0, dueAt - Date.now()));
}

function requestFastPtyProcessPoll(rec) {
  const now = Date.now();
  rec.processPollFastUntil = Math.max(rec.processPollFastUntil || 0, now + PROCESS_POLL_INPUT_GRACE_MS);
  rec.nextProcessPollAt = Math.min(rec.nextProcessPollAt || Infinity, now + 100);
  schedulePtyProcessPoll();
}

// --- "A process is still running" confirm-before-close ----------------------
// A pty is "busy" when its foreground process (rec.lastProcess, tracked by
// pollPtyProcesses) is a program other than the plain shell — e.g. Claude Code
// still loading. Closing it then asks first so a stray Cmd+W / × / red-button
// doesn't kill a running app. Detection lives here (not the renderer) so ALL
// close paths — per-pane, per-tab, OS window close, and Cmd+Q — go through it,
// and the native dialog is async so it never freezes the renderer's terminals.
const SHELL_FG = /^-?(zsh|bash|fish|dash|sh|ksh|tcsh|csh|pwsh|powershell)(\.exe)?$/;
const REMOTE_SESSION_FG = /^-?(ssh|mosh|mosh-client)(\.exe)?$/i;
function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}
// node-pty commonly reports a bare process name on macOS, but Linux builds may
// return the full executable path. Also accept the user's configured shell even
// when it is not one of the common names above (e.g. nushell or xonsh).
function isShellForeground(name) {
  const fg = baseName(String(name || '').trim()).toLowerCase();
  const configured = baseName(shellPath).toLowerCase();
  return SHELL_FG.test(fg) || fg.replace(/^-/, '') === configured.replace(/^-/, '');
}
// Returns a short program name to show the user, or null when the pty is idle
// (a plain shell, or its foreground isn't known yet).
function busyLabel(name) {
  const fg = String(name || '').trim();
  if (fg === '' || isShellForeground(fg)) return null;
  let raw = String(name);
  if (raw.startsWith('node:')) {
    // 'node:<pid> <node-path> <script-path> <args…>' (from resolveNodeCmd).
    // Show the script's basename, not a trailing flag: drop the pid + flags,
    // then the last token that isn't node itself.
    raw = raw.slice(5).replace(/^\d+\s+/, '');
    const tokens = raw.split(/\s+/).filter((t) => t && !t.startsWith('-'));
    raw = [...tokens].reverse().find((t) => baseName(t).toLowerCase() !== 'node')
      || tokens[0] || 'node';
  }
  return baseName(raw) || 'a process';
}
// Read the foreground process again at close time instead of relying solely on
// the poller's cache. This removes the short false-positive window after a
// command exits and the prompt has already returned to the shell.
function busyLabelForPty(rec) {
  if (!rec) return null;
  let current = '';
  try { current = String(rec.proc.process || ''); } catch (_) { return null; }
  if (!current || isShellForeground(current)) return null;
  // Preserve a resolved node command when it still describes the current raw
  // process; otherwise use the fresh value so stale cached apps cannot prompt.
  const name = current === rec.lastRaw && rec.lastProcess ? rec.lastProcess : current;
  return busyLabel(name);
}
function busyLabelsForPtyIds(ids) {
  const out = [];
  for (const id of ids || []) {
    const rec = ptys.get(id);
    const label = busyLabelForPty(rec);
    if (label) out.push(label);
  }
  return out;
}
function busyLabelsForWindow(winId) {
  const out = [];
  for (const [, rec] of ptys) {
    if (rec.ownerWinId !== winId) continue;
    const label = busyLabelForPty(rec);
    if (label) out.push(label);
  }
  return out;
}
function allBusyLabels() {
  const out = [];
  for (const [, rec] of ptys) {
    const label = busyLabelForPty(rec);
    if (label) out.push(label);
  }
  return out;
}
// Shows the native "still running" prompt. Returns true if the user confirmed
// the destructive action (the button named `verb`), false to cancel.
async function confirmBusyClose(win, labels, verb) {
  const unique = [...new Set(labels)];
  const names = unique.join(', ');
  const opts = {
    // macOS otherwise substitutes its yellow warning triangle for warning/error
    // message boxes. Use Myanso's app icon there, matching the branded quit
    // prompt used by terminal apps such as iTerm2. Other platforms keep their
    // native warning treatment.
    type: process.platform === 'darwin' ? 'none' : 'warning',
    ...(process.platform === 'darwin' ? { icon: iconPath } : {}),
    buttons: [verb, 'Cancel'],
    defaultId: 1,           // Cancel is the safe default (Enter cancels)
    cancelId: 1,
    message: verb === 'Quit' ? 'Quit Myanso?' : 'Close this terminal?',
    detail: `${names} ${unique.length === 1 ? 'is' : 'are'} still running.`,
    noLink: true,
  };
  const { response } = (win && !win.isDestroyed())
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return response === 0;
}

function spawnPty(id, cols, rows, cwd, ownerWinId) {
  // pty.spawn can throw (missing shell, bad cwd, fork refused). An uncaught
  // Napi error aborts the whole process, so guard it: retry from homeDir if a
  // user-supplied cwd is the problem, and if that still fails tell the renderer
  // via pty-exit instead of crashing.
  let p;
  let launchedCwd = cwd || homeDir;
  const opts = { name: 'xterm-color', cols: cols || 80, rows: rows || 24, env: ptyEnv() };
  // Launch as a login shell so it sources the user's profile (.zprofile/.zshrc,
  // .bash_profile) — that's where Homebrew/nvm add node etc. to PATH. Without -l,
  // a shell spawned from a GUI Electron app misses them ("command not found: node").
  // PowerShell: use -NoLogo to skip the banner (PS7 and 5.1 both support it).
  const shellArgs = os.platform() === 'win32' ? ['-NoLogo'] : ['-l'];
  try {
    p = pty.spawn(shellPath, shellArgs, { ...opts, cwd: launchedCwd });
  } catch (e) {
    try {
      launchedCwd = homeDir;
      p = pty.spawn(shellPath, shellArgs, { ...opts, cwd: homeDir });
    } catch (e2) {
      const w = BrowserWindow.fromId(ownerWinId);
      if (w && !w.isDestroyed()) w.webContents.send('pty-exit', { id });
      return;
    }
  }
  const rec = {
    proc: p, ownerWinId, cwd: launchedCwd, lastProcess: '', syncCarry: '',
    nextProcessPollAt: Date.now(), processPollFastUntil: 0,
    paused: false, flowPaused: false, transferPaused: false
  };
  ptys.set(id, rec);
  const owner = BrowserWindow.fromId(ownerWinId);
  if (owner && !owner.isDestroyed()) {
    owner.webContents.send('pty-cwd', { id, cwd: launchedCwd });
  }
  requestFastPtyProcessPoll(rec);
  p.on('data', (data) => {
    // Strip synchronized-output markers (DEC mode 2026 set/reset). xterm.js 6 has
    // a bug: when a Myanmar combining mark joins an existing cell *inside* a 2026
    // sync block, the deferred render goes stale and the mark never appears — so
    // TUIs that wrap each keystroke echo in 2026 (e.g. agy) drop ◌ာ / ◌း while
    // typing (paste, which isn't per-char-wrapped, is fine). Removing the markers
    // turns those into plain writes, which render correctly; the only cost is the
    // app's per-frame flicker batching, which our rAF-debounced renderer covers.
    // A pty can split this 8-byte sequence across two chunks; if the SET marker's
    // first half slips through, xterm enters sync mode and STOPS painting (every
    // later render is buffered, never drawn). So carry a trailing partial of
    // `\e[?2026h/l` over to the next chunk before stripping.
    const rec = ptys.get(id);
    const stripped = stripSynchronizedOutput(data, rec && rec.syncCarry);
    data = stripped.data;
    if (rec) rec.syncCarry = stripped.carry;
    // Batch pty output per main-process tick. Under heavy output (cat largefile,
    // build logs) a pty emits many small chunks; one IPC message + one term.write
    // per chunk is the real cost. Coalesce chunks that arrive in the same tick and
    // flush once on setImmediate — sub-ms latency, so interactive echo still feels
    // instant, but bulk output collapses into far fewer IPC round-trips.
    if (!data) return; // a chunk containing only stripped mode markers
    let buf = ptyBuffers.get(id);
    if (!buf) {
      buf = [];
      ptyBuffers.set(id, buf);
    }
    if (!ptyFlushScheduled) {
      ptyFlushScheduled = true;
      setImmediate(flushPtyBuffers);
    }
    buf.push(data);
  });
  p.on('exit', () => {
    // Flush anything buffered for this pty before the exit so its last output
    // isn't dropped, then drop the (now-stale) buffer.
    flushPtyBuffers();
    ptyBuffers.delete(id);
    const w = ownerWindow(id);
    for (const transfer of [...paneTransfers.values()]) {
      if (transfer.ptyId === id) abortPaneTransfer(transfer);
    }
    ptys.delete(id);
    if (w) w.webContents.send('pty-exit', { id });
  });
}

// Most shells do not emit OSC 7 directory updates: Linux distros rarely ship it,
// and macOS only defines update_terminal_cwd for Apple Terminal (/etc/zshrc
// sources /etc/zshrc_Apple_Terminal). So the renderer's cached pane.cwd is just
// the directory the shell was LAUNCHED in and goes stale after the first `cd` —
// a new tab would reopen $HOME. Ask the OS for the shell's real cwd instead.
//   Linux : /proc/<pid>/cwd — a readlink, no external process.
//   macOS : `lsof -a -p <pid> -d cwd -Fn` — no procfs equivalent exists. Only
//           runs asynchronously on new tab/split (never in the data path), and
//           is capped by a timeout so a hung lsof cannot delay the new shell.
// Windows has neither; it keeps using the renderer's value.
async function ptyCwd(id) {
  const rec = ptys.get(id);
  if (!rec) return null;
  let pid;
  try { pid = rec.proc && rec.proc.pid; } catch (_) { return rec.cwd || null; }
  if (!pid) return rec.cwd || null;
  try {
    if (process.platform === 'linux') {
      const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`);
      if ((await fs.promises.stat(cwd)).isDirectory()) return cwd;
    } else if (process.platform === 'darwin') {
      const out = await new Promise((resolve, reject) => {
        execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
          { encoding: 'utf8', timeout: 1000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      // -Fn output is one field per line; the cwd path is the last 'n' line.
      const line = out.split('\n').filter((l) => l.startsWith('n')).pop();
      const cwd = line && line.slice(1);
      if (cwd && (await fs.promises.stat(cwd)).isDirectory()) return cwd;
    }
  } catch (_) { }
  return rec.cwd || null;
}

function createWindow(pos, initialDir, opts) {
  const wid = ++widCounter;
  // initialDir (optional): a folder dropped on the dock at cold start — the
  // renderer opens its first tab here instead of $HOME.
  const extraArgs = ['--myanso-wid=' + wid];
  if (initialDir) extraArgs.push('--myanso-open=' + initialDir);
  // A window created to receive a torn-off tab must NOT open its own initial
  // tab — the adopted tab is the only one it should show.
  if (opts && opts.noInitialTab) extraArgs.push('--myanso-no-tab');
  if (pos) {
    const area = screen.getDisplayNearestPoint(pos).workArea;
    pos = {
      x: Math.max(area.x, Math.min(pos.x, area.x + Math.max(0, area.width - 900))),
      y: Math.max(area.y, Math.min(pos.y, area.y + Math.max(0, area.height - 600)))
    };
  }
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    x: pos && pos.x,
    y: pos && pos.y,
    backgroundColor: '#1e1e1e',
    icon: iconPath,
    frame: process.platform !== 'linux',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: process.platform === 'linux',
    trafficLightPosition: { x: 12, y: 10 },
    webPreferences: {
      // renderer.js is loaded by preload.js in an isolated world. The page's
      // main world has no Node/Electron access; preload keeps local package
      // access without adding a bundler or changing xterm's DOM execution.
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // The renderer reads this to prefix its pty/tab ids so two windows never
      // generate the same id (e.g. pty_1).
      additionalArguments: extraArgs
    }
  });

  // Only the local application document may request local-font enumeration.
  // The handler is session-wide, so install the strict policy once.
  installPermissionPolicy(win.webContents.session);

  // Terminal output and local packages must never navigate the privileged app
  // document or create another renderer. OSC 8 links use shell.openExternal.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== indexUrl) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(indexPath);

  // Some Linux desktop/menu integrations do not activate Electron's menu
  // accelerators while xterm owns keyboard focus. Intercept the app shortcuts
  // before Chromium hands them to xterm, otherwise the shell receives their
  // Ctrl control characters. The hidden native menu remains the source of the
  // visible shortcut definitions on macOS and Windows.
  if (process.platform === 'linux') {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat ||
          !input.control || input.alt || input.meta) return;
      const key = String(input.key).toLowerCase();
      const code = String(input.code);
      const isKey = (name) => key === name.toLowerCase() || code === 'Key' + name.toUpperCase();
      const send = (channel, ...args) => win.webContents.send(channel, ...args);
      let handled = true;

      if (isKey('t') && !input.shift) send('new-tab');
      else if (isKey('n') && !input.shift) createWindow();
      else if (isKey('w') && !input.shift) send('close-pane');
      else if (isKey('f') && !input.shift) send('find');
      else if (isKey('d')) send(input.shift ? 'split-down' : 'split-right');
      else if ((key === '[' || code === 'BracketLeft') && !input.shift) send('focus-prev');
      else if ((key === ']' || code === 'BracketRight') && !input.shift) send('focus-next');
      else if ((key === ',' || code === 'Comma') && !input.shift) send('open-settings');
      else if (key === '+' || key === '=' || code === 'Equal') send('font-inc');
      else if ((key === '-' || code === 'Minus') && !input.shift) send('font-dec');
      else if ((key === '0' || code === 'Digit0') && !input.shift) send('font-reset');
      else if (isKey('q') && !input.shift) app.quit();
      else {
        const match = !input.shift && code.match(/^Digit([1-9])$/);
        if (match) send('select-tab', Number(match[1]) - 1);
        else handled = false;
      }
      if (!handled) return;
      event.preventDefault();
    });
  }

  // Chromium persists per-window page zoom. A stray Cmd+- (old zoom binding)
  // could leave the UI zoomed with no way to reset it now that font shortcuts
  // replaced the zoom menu. Pin page zoom to 100% on every load.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomLevel(0);
    if (process.platform === 'linux') {
      win.webContents.send('window-maximized', win.isMaximized());
    }
  });

  // In fullscreen the macOS traffic lights are hidden, so the tab bar can use
  // the full width. Tell the renderer to drop its left padding.
  const sendFullscreen = (on) => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen', on);
  };
  win.on('enter-full-screen', () => sendFullscreen(true));
  win.on('leave-full-screen', () => sendFullscreen(false));
  if (process.platform === 'linux') {
    win.on('maximize', () => {
      if (!win.isDestroyed()) win.webContents.send('window-maximized', true);
    });
    win.on('unmaximize', () => {
      if (!win.isDestroyed()) win.webContents.send('window-maximized', false);
    });
  }

  // Keep "Go to Tab N" in sync with whichever window is focused.
  win.on('focus', () => buildMenu());

  // Intercept OS window close (red traffic light / Alt+F4) and the close-window
  // IPC so a busy pane isn't killed without asking. Async: preventDefault holds
  // the close, then re-issue win.close() once the user confirms.
  win.on('close', (e) => {
    if (win._readyToClose) return;
    const labels = busyLabelsForWindow(win.id);
    if (labels.length === 0) return;
    e.preventDefault();
    confirmBusyClose(win, labels, 'Close').then((ok) => {
      if (ok && !win.isDestroyed()) { win._readyToClose = true; win.close(); }
    });
  });

  win.on('closed', () => {
    for (const transfer of [...paneTransfers.values()]) {
      if (transfer.sourceWin === win || transfer.targetWin === win) abortPaneTransfer(transfer);
    }
    // Kill only the ptys this window still owns (moved-away tabs were repointed).
    for (const [id, rec] of ptys) {
      if (rec.ownerWinId === win.id) {
        try { rec.proc.kill(); } catch (e) { }
        ptys.delete(id);
      }
    }
    tabCounts.delete(win.id);
    pendingAdopt.delete(win.id);
    buildMenu();
  });

  return win;
}

// Run `cb` once the given window's renderer has signalled it is ready to receive
// IPC (used when a tab is dropped outside all windows → spawn + adopt).
function onceReady(win, cb) {
  pendingAdopt.set(win.id, cb);
}

// --- Cross-window tab drag --------------------------------------------------
// HTML5 drag-and-drop cannot cross BrowserWindows, so the main process tracks
// the cursor by screen coordinates and decides which window (if any) a tab is
// dropped onto.
const CHROME_STRIP = 38; // tab-bar height (see #chrome in index.html)
let dragging = null;     // { sourceWin, descriptor, ptyIds }
// Tabs awaiting the expected target's adopt ack before the source removes them.
// source tabId -> { sourceWin, targetWin, ptyIds }.
const pendingRemoval = new Map();
const paneTransfers = new Map();
let paneDragging = null;
let dragTimer = null;
let dragTarget = null;   // window currently highlighted as a drop target

function windowAtTabBar(point) {
  for (const w of candidateWindows()) {
    const b = w.getContentBounds();
    if (point.x >= b.x && point.x <= b.x + b.width &&
      point.y >= b.y && point.y <= b.y + CHROME_STRIP) {
      return w;
    }
  }
  return null;
}

function candidateWindows() {
  const focused = BrowserWindow.getFocusedWindow();
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.isMinimized()).reverse();
  if (focused && !focused.isDestroyed() && !focused.isMinimized()) {
    return [focused, ...windows.filter((w) => w !== focused)];
  }
  return windows;
}

function windowAtPoint(point) {
  for (const w of candidateWindows()) {
    const b = w.getContentBounds();
    if (point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height) return w;
  }
  return null;
}

function setPaneDragTarget(win) {
  const previous = paneDragging && paneDragging.dragTarget;
  if (previous === win) return;
  if (previous && !previous.isDestroyed()) previous.webContents.send('pane-drag-over', { active: false });
  if (win && !win.isDestroyed()) win.webContents.send('pane-drag-over', { active: true });
  if (paneDragging) paneDragging.dragTarget = win;
}

function sendPaneDragResult(transfer, outcome) {
  if (!transfer || transfer.sourceWin.isDestroyed()) return;
  transfer.sourceWin.webContents.send('pane-drag-result', {
    transferId: transfer.transferId, tabId: transfer.tabId, ptyId: transfer.ptyId, outcome
  });
}

function abortPaneTransfer(transfer) {
  if (!transfer || paneTransfers.get(transfer.transferId) !== transfer) return;
  paneTransfers.delete(transfer.transferId);
  if (transfer.timeout) clearTimeout(transfer.timeout);
  const rec = ptys.get(transfer.ptyId);
  if (rec) { rec.transferPaused = false; updatePtyPaused(rec); }
  if (transfer.createdWindow && transfer.targetWin && !transfer.targetWin.isDestroyed()) {
    transfer.targetWin._readyToClose = true;
    transfer.targetWin.close();
  } else if (transfer.targetWin && !transfer.targetWin.isDestroyed()) {
    transfer.targetWin.webContents.send('discard-pane-transfer', {
      transferId: transfer.transferId, tabId: transfer.tabId, ptyId: transfer.ptyId
    });
  }
  sendPaneDragResult(transfer, 'cancelled');
  if (paneDragging === transfer) {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    setPaneDragTarget(null);
    paneDragging = null;
  }
}

function preparePaneTransfer(transfer, targetWin) {
  if (!transfer || !targetWin || targetWin.isDestroyed()) { abortPaneTransfer(transfer); return; }
  const rec = ptys.get(transfer.ptyId);
  if (!rec || rec.ownerWinId !== transfer.sourceWin.id) { abortPaneTransfer(transfer); return; }
  transfer.targetWin = targetWin;
  transfer.resultSent = true;
  sendPaneDragResult(transfer, 'transferring');
  flushPtyBuffers();
  rec.transferPaused = true;
  updatePtyPaused(rec);
  transfer.timeout = setTimeout(() => abortPaneTransfer(transfer), 10000);
  transfer.sourceWin.webContents.send('pane-transfer-serialize', {
    transferId: transfer.transferId, tabId: transfer.tabId, ptyId: transfer.ptyId
  });
}

function createPaneTransfer(sourceWin, payload) {
  if (!sourceWin || !validPaneTransfer(payload) || paneTransfers.has(payload.transferId) ||
      [...paneTransfers.values()].some((item) => item.ptyId === payload.ptyId)) return null;
  const rec = ptys.get(payload.ptyId);
  if (!rec || rec.ownerWinId !== sourceWin.id || pendingPtyCreates.has(payload.ptyId)) return null;
  const transfer = { sourceWin, transferId: payload.transferId, tabId: payload.tabId, ptyId: payload.ptyId };
  paneTransfers.set(payload.transferId, transfer);
  return transfer;
}

function setDragTarget(win) {
  if (win === dragTarget) return;
  if (dragTarget && !dragTarget.isDestroyed()) dragTarget.webContents.send('tab-drag-over', { active: false });
  if (win && !win.isDestroyed()) win.webContents.send('tab-drag-over', { active: true });
  dragTarget = win;
}

function sendDragResult(session, outcome) {
  if (!session || !session.sourceWin || session.sourceWin.isDestroyed()) return;
  session.sourceWin.webContents.send('tab-drag-result', {
    tabId: session.descriptor.tabId,
    outcome
  });
}

function endDrag(outcome) {
  const session = dragging;
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  setDragTarget(null);
  dragging = null;
  if (outcome) sendDragResult(session, outcome);
}

// Scrollback serialization can be expensive for a split tab. Wait until main
// has confirmed that the drag really leaves its source window, then ask the
// source renderer for the fresh descriptor. In-window reorders and cancelled
// drags avoid this work entirely.
function requestTransferDescriptor(targetWin) {
  if (!dragging || !targetWin || targetWin.isDestroyed()) { endDrag('cancelled'); return; }
  const { sourceWin, descriptor } = dragging;
  if (!sourceWin || sourceWin.isDestroyed()) { endDrag('cancelled'); return; }
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  setDragTarget(null);
  dragging.targetWin = targetWin;
  if (!dragging.resultSent) {
    sendDragResult(dragging, 'transferring');
    dragging.resultSent = true;
  }
  sourceWin.webContents.send('tab-drag-serialize', { tabId: descriptor.tabId });
}

function moveTabToWindow(targetWin) {
  const { sourceWin, descriptor, ptyIds } = dragging;
  if (!sourceWin || sourceWin.isDestroyed() || !targetWin || targetWin.isDestroyed() ||
      !ptyIds.every((id) => {
        const rec = ptys.get(id);
        return rec && rec.ownerWinId === sourceWin.id;
      })) return false;
  // Repoint each pty so its output now flows to the target window.
  for (const id of ptyIds) {
    const rec = ptys.get(id);
    if (rec) {
      rec.ownerWinId = targetWin.id;
      // A pty paused by the source renderer's flow control would never be
      // resumed by the target (its byte counter starts fresh) — resume here.
      rec.flowPaused = false;
      rec.transferPaused = false;
      updatePtyPaused(rec);
    }
  }
  // Tell the target to adopt, but DON'T tear down the source yet. The source's
  // last-tab teardown closes its window, and doing that before the target has
  // actually built the tab risked losing it on a timing hiccup. Instead wait for
  // the target's 'tab-adopted' ack (below), then send remove-tab. ptyIds are
  // already repointed, so output in the gap is buffered by the target renderer.
  pendingRemoval.set(descriptor.tabId, { sourceWin, targetWin, ptyIds: [...ptyIds] });
  targetWin.webContents.send('adopt-tab', { descriptor });
  // The descriptor doesn't carry each pane's foreground process, and the poller
  // won't re-send it (the raw name hasn't changed) — so a moved tab running e.g.
  // Claude Code would lose its Myanmar mark width. Re-send the last known name;
  // IPC order guarantees adopt-tab built the panes before these arrive.
  for (const id of ptyIds) {
    const rec = ptys.get(id);
    if (rec && rec.lastProcess) {
      targetWin.webContents.send('pty-process', { id, name: rec.lastProcess });
    }
  }
  return true;
}

function setupIpc() {
  ipcMain.on('pty-create', (event, payload) => {
    if (!validPtyCreate(payload) || ptys.has(payload.id) || pendingPtyCreates.has(payload.id)) return;
    const { id, cols, rows, cwd, inheritPtyId } = payload;
    // Can be null if the window was destroyed while the IPC was in flight —
    // a throw here would be an uncaught main-process exception.
    const w = senderWindow(event);
    if (!w) return;
    if (!inheritPtyId) {
      spawnPty(id, cols, rows, cwd, w.id);
      return;
    }
    const source = ownedPty(event, inheritPtyId);
    if (!source) return;
    const pending = { ownerWinId: w.id, cols, rows, input: '' };
    pendingPtyCreates.set(id, pending);
    ptyCwd(inheritPtyId).then((resolvedCwd) => {
      if (pendingPtyCreates.get(id) !== pending) return;
      pendingPtyCreates.delete(id);
      if (quitting || w.isDestroyed() || ptys.has(id) || ptys.get(inheritPtyId) !== source || source.ownerWinId !== w.id) return;
      spawnPty(id, pending.cols, pending.rows, resolvedCwd || cwd, w.id);
      const rec = ptys.get(id);
      if (rec && pending.input) {
        try { rec.proc.write(pending.input); } catch (_) { }
      }
    });
  });
  // node-pty's native write/resize/kill throw a Napi::Error if the pty already
  // exited (e.g. a stray resize during quit). Swallow it — an uncaught one
  // aborts the whole process.
  ipcMain.on('pty-input', (event, payload) => {
    if (!validPtyInput(payload)) return;
    const { id, data } = payload;
    const rec = ownedPty(event, id);
    if (!rec) {
      const w = senderWindow(event);
      const pending = pendingPtyCreates.get(id);
      if (w && pending && pending.ownerWinId === w.id && pending.input.length + data.length <= MAX_INPUT_LENGTH) {
        pending.input += data;
      }
      return;
    }
    try { rec.proc.write(data); } catch (e) { }
    // Input normally requests a prompt foreground-process check. Once the
    // foreground is a remote client, however, local PTY inspection cannot see
    // remote process changes, so repeated keystrokes should not keep polling it
    // at the active cadence.
    if (!REMOTE_SESSION_FG.test(rec.lastRaw || '')) requestFastPtyProcessPoll(rec);
  });
  ipcMain.on('pty-resize', (event, payload) => {
    if (!validPtyResize(payload)) return;
    const rec = ownedPty(event, payload.id);
    if (rec) {
      try { rec.proc.resize(payload.cols, payload.rows); } catch (e) { }
      return;
    }
    const w = senderWindow(event);
    const pending = pendingPtyCreates.get(payload.id);
    if (w && pending && pending.ownerWinId === w.id) {
      pending.cols = payload.cols;
      pending.rows = payload.rows;
    }
  });
  ipcMain.on('pty-kill', (event, payload) => {
    if (!validPtyReference(payload)) return;
    const rec = ownedPty(event, payload.id);
    if (rec) {
      try { rec.proc.kill(); } catch (e) { }
      ptys.delete(payload.id);
      schedulePtyProcessPoll();
      return;
    }
    const w = senderWindow(event);
    const pending = pendingPtyCreates.get(payload.id);
    if (w && pending && pending.ownerWinId === w.id) pendingPtyCreates.delete(payload.id);
  });

  // Renderer-driven flow control: when xterm's write queue backs up (a huge
  // `cat`, fast build logs), the renderer asks main to stop reading the pty
  // until it catches up — otherwise the queue grows without bound and the UI
  // stalls. See writeToPane() in renderer.js for the watermarks.
  ipcMain.on('pty-pause', (event, payload) => {
    if (!validPtyReference(payload)) return;
    const rec = ownedPty(event, payload.id);
    if (rec) { rec.flowPaused = true; updatePtyPaused(rec); }
  });
  ipcMain.on('pty-resume', (event, payload) => {
    if (!validPtyReference(payload)) return;
    const rec = ownedPty(event, payload.id);
    if (rec) { rec.flowPaused = false; updatePtyPaused(rec); }
  });

  ipcMain.on('close-window', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) w.close();
  });
  ipcMain.on('window-minimize', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) w.minimize();
  });
  ipcMain.on('window-toggle-maximize', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || w.isDestroyed()) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });

  // Renderer asks before closing a pane/tab: reply whether it's OK to proceed
  // (no busy pty, or the user confirmed the prompt).
  ipcMain.handle('confirm-close-ptys', async (event, payload) => {
    if (!validCloseRequest(payload) || !payload.ptyIds.every((id) => ownedPty(event, id))) return false;
    const { ptyIds } = payload;
    const labels = busyLabelsForPtyIds(ptyIds);
    if (labels.length === 0) return true;
    return confirmBusyClose(BrowserWindow.fromWebContents(event.sender), labels, 'Close');
  });

  // The target finished building an adopted tab — now it's safe to tear it down
  // in the source (which may then close the source window). See moveTabToWindow.
  ipcMain.on('tab-adopted', (event, payload) => {
    if (!payload || !validTabId(payload.tabId)) return;
    const { tabId } = payload;
    const pending = pendingRemoval.get(tabId);
    const targetWin = senderWindow(event);
    if (!pending || !targetWin || pending.targetWin.id !== targetWin.id) return;
    pendingRemoval.delete(tabId);
    if (!pending.sourceWin.isDestroyed()) {
      pending.sourceWin.webContents.send('remove-tab', { tabId });
    }
  });
  ipcMain.on('open-window', (event) => { if (senderWindow(event)) createWindow(); });
  ipcMain.on('quit-app', (event) => { if (senderWindow(event)) app.quit(); });

  // A renderer reports its tab count; refresh the menu if it is the focused one.
  // renderTabBar() sends this on every tab switch too, so skip the (relatively
  // expensive) menu rebuild when the count didn't change; an unfocused window's
  // change is picked up by the rebuild its 'focus' event triggers.
  ipcMain.on('tab-count', (event, n) => {
    if (!Number.isInteger(n) || n < 0 || n > 1000) return;
    const w = senderWindow(event);
    if (!w || tabCounts.get(w.id) === n) return;
    tabCounts.set(w.id, n);
    if (w.isFocused()) buildMenu();
  });

  // A (possibly freshly created) window is ready to receive an adopted tab.
  ipcMain.on('renderer-ready', (event) => {
    const w = senderWindow(event);
    if (!w) return;
    const cb = pendingAdopt.get(w.id);
    if (cb) { pendingAdopt.delete(w.id); cb(); }
  });

  ipcMain.on('pane-drag-start', (event, payload) => {
    endDrag('cancelled');
    if (paneDragging) abortPaneTransfer(paneDragging);
    const sourceWin = senderWindow(event);
    const transfer = createPaneTransfer(sourceWin, payload);
    if (!transfer) {
      if (sourceWin && validPaneTransfer(payload)) sourceWin.webContents.send('pane-drag-result', { ...payload, outcome: 'cancelled' });
      return;
    }
    paneDragging = transfer;
    dragTimer = setInterval(() => {
      if (!paneDragging) return;
      const target = windowAtTabBar(screen.getCursorScreenPoint());
      setPaneDragTarget(target && target !== paneDragging.sourceWin ? target : null);
    }, 30);
  });

  ipcMain.on('pane-drag-end', (event, payload) => {
    const sourceWin = senderWindow(event);
    const transfer = paneDragging;
    if (!transfer || sourceWin !== transfer.sourceWin || !validPaneTransfer(payload) ||
        payload.transferId !== transfer.transferId || payload.ptyId !== transfer.ptyId) return;
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    setPaneDragTarget(null);
    paneDragging = null;
    const point = screen.getCursorScreenPoint();
    const tabTarget = windowAtTabBar(point);
    if (tabTarget && tabTarget !== sourceWin) { preparePaneTransfer(transfer, tabTarget); return; }
    if (windowAtPoint(point)) { abortPaneTransfer(transfer); return; }
    const win = createWindow({ x: point.x - 40, y: point.y - 10 }, undefined, { noInitialTab: true });
    transfer.createdWindow = true;
    transfer.targetWin = win;
    onceReady(win, () => preparePaneTransfer(transfer, win));
  });

  ipcMain.on('pane-drag-cancel', (event, payload) => {
    const transfer = payload && paneTransfers.get(payload.transferId);
    if (!transfer || senderWindow(event) !== transfer.sourceWin) return;
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    setPaneDragTarget(null);
    paneDragging = null;
    abortPaneTransfer(transfer);
  });

  ipcMain.on('pane-move-new-window', (event, payload) => {
    const sourceWin = senderWindow(event);
    const transfer = createPaneTransfer(sourceWin, payload);
    if (!transfer) {
      if (sourceWin && validPaneTransfer(payload)) sourceWin.webContents.send('pane-drag-result', { ...payload, outcome: 'cancelled' });
      return;
    }
    const b = sourceWin.getBounds();
    const win = createWindow({ x: b.x + 48, y: b.y + 48 }, undefined, { noInitialTab: true });
    transfer.createdWindow = true;
    transfer.targetWin = win;
    onceReady(win, () => preparePaneTransfer(transfer, win));
  });

  ipcMain.on('pane-transfer-serialized', (event, payload) => {
    if (!validPaneTransfer(payload, true) || payload.descriptor.ptyId !== payload.ptyId) return;
    const transfer = paneTransfers.get(payload.transferId);
    const sourceWin = senderWindow(event);
    if (!transfer || sourceWin !== transfer.sourceWin || payload.tabId !== transfer.tabId ||
        payload.ptyId !== transfer.ptyId || !transfer.targetWin || transfer.targetWin.isDestroyed()) return;
    transfer.targetWin.webContents.send('adopt-pane', payload);
  });

  ipcMain.on('pane-transfer-failed', (event, payload) => {
    const transfer = payload && paneTransfers.get(payload.transferId);
    if (transfer && senderWindow(event) === transfer.sourceWin) abortPaneTransfer(transfer);
  });

  ipcMain.on('pane-adopted', (event, payload) => {
    if (!validPaneTransfer(payload)) return;
    const transfer = paneTransfers.get(payload.transferId);
    const targetWin = senderWindow(event);
    if (!transfer || targetWin !== transfer.targetWin || payload.tabId !== transfer.tabId || payload.ptyId !== transfer.ptyId) return;
    const rec = ptys.get(transfer.ptyId);
    if (!rec || rec.ownerWinId !== transfer.sourceWin.id) { abortPaneTransfer(transfer); return; }
    paneTransfers.delete(transfer.transferId);
    if (transfer.timeout) clearTimeout(transfer.timeout);
    rec.ownerWinId = targetWin.id;
    transfer.sourceWin.webContents.send('remove-transferred-pane', payload);
    targetWin.webContents.send('commit-pane-transfer', payload);
    if (rec.lastProcess) targetWin.webContents.send('pty-process', { id: transfer.ptyId, name: rec.lastProcess });
    rec.transferPaused = false;
    rec.flowPaused = false;
    updatePtyPaused(rec);
  });

  // Tab drag: source window announces the drag; main polls the cursor.
  ipcMain.on('tab-drag-start', (event, payload) => {
    if (!payload || !validTabDescriptor(payload.descriptor) || !validPtyIds(payload.ptyIds) ||
        payload.ptyIds.length !== payload.descriptor.ptyIds.length ||
        !payload.ptyIds.every((id) => payload.descriptor.ptyIds.includes(id) && ownedPty(event, id))) return;
    endDrag('cancelled');
    if (paneDragging) abortPaneTransfer(paneDragging);
    const sourceWin = senderWindow(event);
    if (!sourceWin) return;
    dragging = { sourceWin, descriptor: payload.descriptor, ptyIds: [...payload.ptyIds] };
    dragTimer = setInterval(() => {
      if (!dragging) return;
      setDragTarget(windowAtTabBar(screen.getCursorScreenPoint()));
    }, 30);
  });

  ipcMain.on('tab-drag-end', (event) => {
    const sourceWin = senderWindow(event);
    if (!dragging || !sourceWin || !dragging.sourceWin || sourceWin.id !== dragging.sourceWin.id) return;
    const point = screen.getCursorScreenPoint();
    const target = windowAtTabBar(point);
    const sourceId = dragging.sourceWin && dragging.sourceWin.id;

    if (target && target.id === sourceId) {
      endDrag('reordered'); // in-window reorder is already reflected in the renderer
      return;
    }
    if (target) {
      requestTransferDescriptor(target);
      return;
    }
    // Dropped outside every window → tear off into a new window near the cursor.
    // Hold the drag state until the new renderer is ready, then ask the source
    // for scrollback. This avoids serializing before we know a move is needed.
    const held = dragging;
    if (!dragging.resultSent) {
      sendDragResult(dragging, 'transferring');
      dragging.resultSent = true;
    }
    const win = createWindow({ x: point.x - 40, y: point.y - 10 }, undefined, { noInitialTab: true });
    onceReady(win, () => {
      if (dragging === held) requestTransferDescriptor(win);
    });
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    setDragTarget(null);
  });

  // The source has now serialized current scrollback, after main confirmed the
  // target. Verify this is still the same drag before repointing its ptys.
  ipcMain.on('tab-drag-serialized', (event, payload) => {
    if (!payload || !validTabId(payload.tabId) || !validTabDescriptor(payload.descriptor)) return;
    const { tabId, descriptor } = payload;
    if (!dragging || dragging.descriptor.tabId !== tabId || descriptor.tabId !== tabId ||
        descriptor.ptyIds.length !== dragging.ptyIds.length ||
        !descriptor.ptyIds.every((id) => dragging.ptyIds.includes(id))) return;
    const sourceWin = senderWindow(event);
    if (!sourceWin || !dragging.sourceWin || sourceWin.id !== dragging.sourceWin.id) return;
    const target = dragging.targetWin;
    if (!target || target.isDestroyed()) {
      if (dragging.resultSent) sendDragResult(dragging, 'cancelled');
      endDrag();
      return;
    }
    dragging.descriptor = descriptor;
    const moved = moveTabToWindow(target);
    if (!moved) {
      if (dragging.resultSent) sendDragResult(dragging, 'cancelled');
      endDrag(dragging.resultSent ? undefined : 'cancelled');
      return;
    }
    endDrag();
  });
}

// App menu. Settings opens the panel; the Shell menu drives tabs/splits in the
// FOCUSED window via IPC (accelerators fire even while xterm has keyboard
// focus). "Go to Tab N" reflects the focused window's tab count (capped at 9).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const focused = () => BrowserWindow.getFocusedWindow();
  const send = (channel) => () => {
    const w = focused();
    if (w && !w.isDestroyed()) w.webContents.send(channel);
  };
  const tabCount = (() => {
    const w = focused();
    return w ? (tabCounts.get(w.id) || 0) : 0;
  })();

  // macOS gets the native SF Symbol gear next to the item; other platforms have
  // no usable icon source, so they rely on the label. Linux follows GNOME
  // convention: "Preferences" under Edit.
  const settingsItem = {
    label: isMac ? 'Settings…' : 'Preferences…',
    accelerator: 'CmdOrCtrl+,',
    click: send('open-settings'),
    ...(settingsMenuIcon ? { icon: settingsMenuIcon } : {})
  };

  const shellMenu = {
    label: 'Shell',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: send('new-tab') },
      { label: 'Close', accelerator: 'CmdOrCtrl+W', click: send('close-pane') },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: send('find') },
      { type: 'separator' },
      { label: 'Split Right', accelerator: 'CmdOrCtrl+D', click: send('split-right') },
      { label: 'Split Down', accelerator: 'Shift+CmdOrCtrl+D', click: send('split-down') },
      { type: 'separator' },
      { label: 'Previous Pane', accelerator: 'CmdOrCtrl+[', click: send('focus-prev') },
      { label: 'Next Pane', accelerator: 'CmdOrCtrl+]', click: send('focus-next') },
      // Cmd+1 … Cmd+9 jump to the focused window's open tabs (max 9).
      ...(tabCount > 0 ? [{ type: 'separator' }] : []),
      ...Array.from({ length: Math.min(tabCount, 9) }, (_, i) => ({
        label: 'Go to Tab ' + (i + 1),
        accelerator: 'CmdOrCtrl+' + (i + 1),
        click: () => {
          const w = focused();
          if (w && !w.isDestroyed()) w.webContents.send('select-tab', i);
        }
      }))
    ]
  };

  // Custom View menu WITHOUT the default zoomIn/zoomOut/resetZoom roles: those
  // bind Cmd+= / Cmd+- / Cmd+0 to Chromium page zoom (which scales the whole UI,
  // tabs included). We replace them with terminal-only font-size actions.
  const viewMenu = {
    label: 'View',
    submenu: [
      // Reload / forceReload / DevTools only in development (npm start); hidden in the packaged build.
      ...(app.isPackaged ? [] : [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
      ]),
      { label: 'Increase Font Size', accelerator: 'CmdOrCtrl+Plus', click: send('font-inc') },
      // Also bind Cmd+= (the unshifted key) to the same action; hidden so the menu shows one entry.
      { label: 'Increase Font Size', accelerator: 'CmdOrCtrl+=', click: send('font-inc'), visible: false },
      { label: 'Decrease Font Size', accelerator: 'CmdOrCtrl+-', click: send('font-dec') },
      { label: 'Reset Font Size', accelerator: 'CmdOrCtrl+0', click: send('font-reset') },
      // macOS auto-adds its own "Toggle Full Screen" (Globe+F) to the View menu,
      // so add ours only on non-mac to avoid a duplicate entry.
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'togglefullscreen' }])
    ]
  };

  // Window menu without the default Cmd+W "Close Window" so it doesn't clash
  // with the Shell menu's Cmd+W "Close (pane/tab)".
  const windowMenu = {
    role: 'window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }]
  };

  // On Linux (GNOME style), Preferences goes under Edit menu, not the App menu.
  // macOS keeps Settings under the app name menu; Windows keeps it under App.
  const isLinux = process.platform === 'linux';
  const editMenu = isLinux
    ? {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        settingsItem
      ]
    }
    : { role: 'editMenu' };

  const template = [
    {
      label: isMac ? app.name : 'App',
      submenu: isMac
        ? [{ role: 'about' }, { type: 'separator' }, settingsItem, { type: 'separator' }, { role: 'quit' }]
        : isLinux
          ? [{ role: 'quit' }]
          : [settingsItem, { type: 'separator' }, { role: 'quit' }]
    },
    editMenu,
    shellMenu,
    viewMenu,
    windowMenu
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // Linux gets a browser-style hamburger menu in the renderer. Keep this
  // application menu installed (its accelerators still work), but hide the
  // native desktop menu bar in every window. macOS and Windows are untouched.
  if (isLinux) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      w.setAutoHideMenuBar(true);
      w.setMenuBarVisibility(false);
    }
  }
}

app.on('ready', () => {
  setupIpc();
  buildMenu();
  // First tab opens in: a folder dropped on the dock (macOS open-file, cold
  // start) OR a folder passed on the command line (Linux/Windows "Open with").
  const startDir = pendingOpenDir || getDirFromArgv(process.argv);
  createWindow(undefined, startDir);
  pendingOpenDir = null;
});

// node-pty's native accessors (`.process`, `.pid`) throw a Napi::Error after the
// pty exits, and during app quit the native addon tears down while the polling
// interval is still firing. Kill every surviving pty BEFORE the native cleanup
// runs, so no stray Napi call can abort the process.
app.on('before-quit', (e) => {
  // Ask before quitting if any window has a busy pane; on confirm, quit again
  // and fall through to teardown. (Second pass: readyToQuit is set.)
  if (!readyToQuit) {
    const labels = allBusyLabels();
    if (labels.length > 0) {
      e.preventDefault();
      confirmBusyClose(null, labels, 'Quit').then((ok) => {
        if (ok) { readyToQuit = true; app.quit(); }
      });
      return;
    }
  }
  quitting = true;
  for (const [id, rec] of ptys) {
    try { rec.proc.kill(); } catch (e) { }
    ptys.delete(id);
  }
  ptyBuffers.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
