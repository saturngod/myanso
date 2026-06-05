const { app, BrowserWindow, ipcMain, Menu, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

const shellPath = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();

// A packaged .app launched from Finder/Dock does NOT inherit the terminal's
// LANG/LC_*, so the shell falls back to the C locale and tools like `ls` print
// `?` for every non-ASCII byte (Myanmar filenames become `????`). Force a
// UTF-8 locale when none is set. (Windows uses a code page, not LANG — skip it.)
function ptyEnv() {
  const env = { ...process.env };
  if (os.platform() !== 'win32') {
    const hasUtf8 = [env.LC_ALL, env.LC_CTYPE, env.LANG].some(
      (v) => v && /utf-?8/i.test(v),
    );
    if (!hasUtf8) env.LANG = 'en_US.UTF-8';
  }
  return env;
}

// In dev (`electron .`) the packaged icon isn't used, so set the dock icon
// manually. Packaged builds get their icon from electron-builder.yml instead.
const iconPath = path.join(__dirname, 'icon.png');

// Gear icon for the Settings menu item on Windows/Linux (macOS uses a glyph in
// the label instead). Template image so it adapts to light/dark menus.
const settingsMenuIcon = nativeImage.createFromDataURL(
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'><g fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'><path d='M6.6 1.6h2.8l.4 1.8 1.4.6 1.6-1 1.6 2.5-1.4 1.2v1.6l1.4 1.2-1.6 2.5-1.6-1-1.4.6-.4 1.8H6.6l-.4-1.8-1.4-.6-1.6 1-1.6-2.5L3 8.3V6.7L1.6 5.5 3.2 3l1.6 1 1.4-.6z'/><circle cx='8' cy='7.5' r='2.2'/></g></svg>",
);
settingsMenuIcon.setTemplateImage(true);
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(iconPath);
});

// macOS: a folder (or file) dropped onto the dock icon, or `open` from Finder,
// fires `open-file`. It can arrive BEFORE the app is ready (cold start), so the
// handler is registered up here, outside whenReady. A file resolves to its
// parent directory.
function resolveDropDir(p) {
  try { if (!fs.statSync(p).isDirectory()) return path.dirname(p); } catch (_) {}
  return p;
}

// Folder dropped before the app is ready (cold start). The `ready` handler hands
// it to the first window so its FIRST tab opens there — sending an IPC instead
// would race the renderer's load and get dropped, leaving a stray home tab.
let pendingOpenDir = null;

app.on('open-file', (event, p) => {
  event.preventDefault();
  const dir = resolveDropDir(p);
  if (!app.isReady()) { pendingOpenDir = dir; return; }
  // App already running: open the folder in a new tab of the focused window.
  const win = BrowserWindow.getFocusedWindow() ||
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win) { win.webContents.send('open-folder', { path: dir }); return; }
  // Running but all windows closed (macOS) — open a fresh window in that folder.
  createWindow(undefined, dir);
});

// The app is multi-window. ptys live here in the main process (one per pane) and
// OUTLIVE the window that created them — a tab can be dragged to another window,
// at which point its ptys' `ownerWinId` is repointed so output flows to the new
// window. Routing is therefore by BrowserWindow id, not a single global `win`.
const ptys = new Map();          // ptyId -> { proc, ownerWinId }
const ptyBuffers = new Map();    // ptyId -> string[] of output coalesced this tick
let widCounter = 0;              // logical per-window id, only for unique pty-id prefixes
const tabCounts = new Map();     // BrowserWindow.id -> tab count (drives "Go to Tab N")
const pendingAdopt = new Map();  // BrowserWindow.id -> callback to run once its renderer is ready

function ownerWindow(id) {
  const rec = ptys.get(id);
  if (!rec) return null;
  const w = BrowserWindow.fromId(rec.ownerWinId);
  return w && !w.isDestroyed() ? w : null;
}

// Send all pty output buffered this tick as one IPC message per pty, then clear.
function flushPtyBuffers() {
  for (const [id, chunks] of ptyBuffers) {
    ptyBuffers.delete(id);
    if (!chunks.length) continue;
    const w = ownerWindow(id);
    if (w) w.webContents.send('pty-data', { id, data: chunks.join('') });
  }
}

function spawnPty(id, cols, rows, cwd, ownerWinId) {
  // pty.spawn can throw (missing shell, bad cwd, fork refused). An uncaught
  // Napi error aborts the whole process, so guard it: retry from homeDir if a
  // user-supplied cwd is the problem, and if that still fails tell the renderer
  // via pty-exit instead of crashing.
  let p;
  const opts = { name: 'xterm-color', cols: cols || 80, rows: rows || 24, env: ptyEnv() };
  // Launch as a login shell so it sources the user's profile (.zprofile/.zshrc,
  // .bash_profile) — that's where Homebrew/nvm add node etc. to PATH. Without -l,
  // a shell spawned from a GUI Electron app misses them ("command not found: node").
  const shellArgs = os.platform() === 'win32' ? [] : ['-l'];
  try {
    p = pty.spawn(shellPath, shellArgs, { ...opts, cwd: cwd || homeDir });
  } catch (e) {
    try {
      p = pty.spawn(shellPath, shellArgs, { ...opts, cwd: homeDir });
    } catch (e2) {
      const w = BrowserWindow.fromId(ownerWinId);
      if (w && !w.isDestroyed()) w.webContents.send('pty-exit', { id });
      return;
    }
  }
  ptys.set(id, { proc: p, ownerWinId });
  p.on('data', (data) => {
    // Batch pty output per main-process tick. Under heavy output (cat largefile,
    // build logs) a pty emits many small chunks; one IPC message + one term.write
    // per chunk is the real cost. Coalesce chunks that arrive in the same tick and
    // flush once on setImmediate — sub-ms latency, so interactive echo still feels
    // instant, but bulk output collapses into far fewer IPC round-trips.
    let buf = ptyBuffers.get(id);
    if (!buf) {
      buf = [];
      ptyBuffers.set(id, buf);
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
    ptys.delete(id);
    if (w) w.webContents.send('pty-exit', { id });
  });
}

function createWindow(pos, initialDir) {
  const wid = ++widCounter;
  // initialDir (optional): a folder dropped on the dock at cold start — the
  // renderer opens its first tab here instead of $HOME.
  const extraArgs = ['--myanso-wid=' + wid];
  if (initialDir) extraArgs.push('--myanso-open=' + initialDir);
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    x: pos && pos.x,
    y: pos && pos.y,
    backgroundColor: '#1e1e1e',
    icon: iconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 10 },
    webPreferences: {
      // Allow require() in the renderer so it can load node-pty/xterm directly.
      nodeIntegration: true,
      contextIsolation: false,
      // The renderer reads this to prefix its pty/tab ids so two windows never
      // generate the same id (e.g. pty_1).
      additionalArguments: extraArgs
    }
  });

  win.loadFile('index.html');

  // Chromium persists per-window page zoom. A stray Cmd+- (old zoom binding)
  // could leave the UI zoomed with no way to reset it now that font shortcuts
  // replaced the zoom menu. Pin page zoom to 100% on every load.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomLevel(0);
  });

  // In fullscreen the macOS traffic lights are hidden, so the tab bar can use
  // the full width. Tell the renderer to drop its left padding.
  const sendFullscreen = (on) => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen', on);
  };
  win.on('enter-full-screen', () => sendFullscreen(true));
  win.on('leave-full-screen', () => sendFullscreen(false));

  // Keep "Go to Tab N" in sync with whichever window is focused.
  win.on('focus', () => buildMenu());

  win.on('closed', () => {
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
// Tabs awaiting the target's adopt ack before the source removes them.
// source tabId (globally unique, WID-prefixed) -> source BrowserWindow.
const pendingRemoval = new Map();
let dragTimer = null;
let dragTarget = null;   // window currently highlighted as a drop target

function windowAtTabBar(point) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    const b = w.getContentBounds();
    if (point.x >= b.x && point.x <= b.x + b.width &&
        point.y >= b.y && point.y <= b.y + CHROME_STRIP) {
      return w;
    }
  }
  return null;
}

function setDragTarget(win) {
  if (win === dragTarget) return;
  if (dragTarget && !dragTarget.isDestroyed()) dragTarget.webContents.send('tab-drag-over', { active: false });
  if (win && !win.isDestroyed()) win.webContents.send('tab-drag-over', { active: true });
  dragTarget = win;
}

function endDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  setDragTarget(null);
  dragging = null;
}

function moveTabToWindow(targetWin) {
  const { sourceWin, descriptor, ptyIds } = dragging;
  // Repoint each pty so its output now flows to the target window.
  for (const id of ptyIds) {
    const rec = ptys.get(id);
    if (rec) rec.ownerWinId = targetWin.id;
  }
  // Tell the target to adopt, but DON'T tear down the source yet. The source's
  // last-tab teardown closes its window, and doing that before the target has
  // actually built the tab risked losing it on a timing hiccup. Instead wait for
  // the target's 'tab-adopted' ack (below), then send remove-tab. ptyIds are
  // already repointed, so output in the gap is buffered by the target renderer.
  if (sourceWin && !sourceWin.isDestroyed()) {
    pendingRemoval.set(descriptor.tabId, sourceWin);
  }
  targetWin.webContents.send('adopt-tab', { descriptor });
}

function setupIpc() {
  ipcMain.on('pty-create', (event, { id, cols, rows, cwd }) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    spawnPty(id, cols, rows, cwd, w.id);
  });
  // node-pty's native write/resize/kill throw a Napi::Error if the pty already
  // exited (e.g. a stray resize during quit). Swallow it — an uncaught one
  // aborts the whole process.
  ipcMain.on('pty-input', (event, { id, data }) => {
    const rec = ptys.get(id);
    if (rec) { try { rec.proc.write(data); } catch (e) { } }
  });
  ipcMain.on('pty-resize', (event, { id, cols, rows }) => {
    const rec = ptys.get(id);
    if (rec && cols > 0 && rows > 0) { try { rec.proc.resize(cols, rows); } catch (e) { } }
  });
  ipcMain.on('pty-kill', (event, { id }) => {
    const rec = ptys.get(id);
    if (rec) { try { rec.proc.kill(); } catch (e) { } ptys.delete(id); }
  });

  ipcMain.on('close-window', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) w.close();
  });

  // The target finished building an adopted tab — now it's safe to tear it down
  // in the source (which may then close the source window). See moveTabToWindow.
  ipcMain.on('tab-adopted', (event, { tabId }) => {
    const sourceWin = pendingRemoval.get(tabId);
    pendingRemoval.delete(tabId);
    if (sourceWin && !sourceWin.isDestroyed()) {
      sourceWin.webContents.send('remove-tab', { tabId });
    }
  });
  ipcMain.on('open-window', () => createWindow());

  // A renderer reports its tab count; refresh the menu if it is the focused one.
  ipcMain.on('tab-count', (event, n) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) tabCounts.set(w.id, n);
    buildMenu();
  });

  // A (possibly freshly created) window is ready to receive an adopted tab.
  ipcMain.on('renderer-ready', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    const cb = pendingAdopt.get(w.id);
    if (cb) { pendingAdopt.delete(w.id); cb(); }
  });

  // Tab drag: source window announces the drag; main polls the cursor.
  ipcMain.on('tab-drag-start', (event, { descriptor, ptyIds }) => {
    endDrag();
    const sourceWin = BrowserWindow.fromWebContents(event.sender);
    dragging = { sourceWin, descriptor, ptyIds };
    dragTimer = setInterval(() => {
      if (!dragging) return;
      setDragTarget(windowAtTabBar(screen.getCursorScreenPoint()));
    }, 30);
  });

  ipcMain.on('tab-drag-end', () => {
    if (!dragging) return;
    const point = screen.getCursorScreenPoint();
    const target = windowAtTabBar(point);
    const sourceId = dragging.sourceWin && dragging.sourceWin.id;

    if (target && target.id === sourceId) {
      endDrag(); // dropped back on its own tab bar → cancel
      return;
    }
    if (target) {
      moveTabToWindow(target);
      endDrag();
      return;
    }
    // Dropped outside every window → tear off into a new window near the cursor.
    // Null `dragging` now so a second rapid tear-off doesn't share/overwrite this
    // drag's state before the async createWindow callback restores it.
    const held = dragging;
    dragging = null;
    const win = createWindow({ x: point.x - 40, y: point.y - 10 });
    onceReady(win, () => { dragging = held; moveTabToWindow(win); endDrag(); });
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    setDragTarget(null);
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

  // macOS can't show a custom icon next to a non-role menu item in the system
  // style, so use a gear glyph in the label there; Windows/Linux take a template
  // image instead.
  const settingsItem = {
    label: isMac ? '⚙  Settings…' : 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: send('open-settings'),
    ...(isMac ? {} : { icon: settingsMenuIcon })
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
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { label: 'Increase Font Size', accelerator: 'CmdOrCtrl+Plus', click: send('font-inc') },
      // Also bind Cmd+= (the unshifted key) to the same action; hidden so the menu shows one entry.
      { label: 'Increase Font Size', accelerator: 'CmdOrCtrl+=', click: send('font-inc'), visible: false },
      { label: 'Decrease Font Size', accelerator: 'CmdOrCtrl+-', click: send('font-dec') },
      { label: 'Reset Font Size', accelerator: 'CmdOrCtrl+0', click: send('font-reset') },
      { type: 'separator' },
      { role: 'togglefullscreen' }
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

  const template = [
    {
      label: isMac ? app.name : 'App',
      submenu: isMac
        ? [{ role: 'about' }, { type: 'separator' }, settingsItem, { type: 'separator' }, { role: 'quit' }]
        : [settingsItem, { type: 'separator' }, { role: 'quit' }]
    },
    { role: 'editMenu' },
    shellMenu,
    viewMenu,
    windowMenu
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('ready', () => {
  setupIpc();
  buildMenu();
  createWindow(undefined, pendingOpenDir);  // pendingOpenDir set if launched by a dock folder drop
  pendingOpenDir = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
