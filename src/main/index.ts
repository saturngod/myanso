import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  ipcMain,
  clipboard,
  shell,
  webContents,
} from "electron";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { initPtyHost, killSessionsFor, transferSessions } from "./pty.js";

// A serialized tab handed across windows during tab drag-out. The shape is
// opaque to main except for the ptyId fields it must collect for transfer.
interface SerializedNode {
  kind: "leaf" | "branch";
  ptyId?: string;
  a?: SerializedNode;
  b?: SerializedNode;
}
interface SerializedTab {
  tree: SerializedNode;
}

function collectPtyIds(node: SerializedNode | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (node.kind === "leaf") {
    if (node.ptyId) out.push(node.ptyId);
  } else {
    collectPtyIds(node.a, out);
    collectPtyIds(node.b, out);
  }
  return out;
}

// Tab payloads waiting for a freshly-spawned window's renderer to claim them
// via window:consume-adopt once it has booted. Keyed by destination
// webContents id.
const adoptPayloads = new Map<number, SerializedTab>();

// The titlebar/tab-strip occupies the top 36px of the window (see
// #terminal-wrapper top:36px). A drop landing in this band targets the tab
// bar; lower lands on the terminal body.
const TABBAR_ZONE_PX = 40;

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_NAME = "Myanso";

app.setName(APP_NAME);

const settingsMenuIcon = nativeImage.createFromDataURL(
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'><g fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'><path d='M6.6 1.6h2.8l.4 1.8 1.4.6 1.6-1 1.6 2.5-1.4 1.2v1.6l1.4 1.2-1.6 2.5-1.6-1-1.4.6-.4 1.8H6.6l-.4-1.8-1.4-.6-1.6 1-1.6-2.5L3 8.3V6.7L1.6 5.5 3.2 3l1.6 1 1.4-.6z'/><circle cx='8' cy='7.5' r='2.2'/></g></svg>",
);
settingsMenuIcon.setTemplateImage(true);

// Folder dropped on dock → use as cwd. File dropped → use its parent dir.
function resolveCwd(p: string): string | null {
  try {
    return statSync(p).isDirectory() ? p : dirname(p);
  } catch {
    return null;
  }
}

// open-file may fire before the renderer is ready (cold launch from a
// dock drop). Queue the path; the renderer drains it via app:initial-cwd
// when it creates its first tab. Warm drops are forwarded immediately.
let pendingCwd: string | null = null;

// icon.png lives at the project root; app.getAppPath() resolves to that
// in dev and to the unpacked app dir in production.
const appIcon = nativeImage.createFromPath(join(app.getAppPath(), "icon.png"));

function createWindow(adopt?: SerializedTab): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    backgroundColor: "#15171e",
    title: APP_NAME,
    icon: appIcon,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 12, y: 10 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Stash any adopt payload so the new renderer can claim it on boot via
  // window:consume-adopt, instead of spawning its default first tab.
  if (adopt) adoptPayloads.set(win.webContents.id, adopt);

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Block the Chromium right-click context menu (which shows Inspect Element)
  // in production. Keep it in dev for debugging.
  if (app.isPackaged) {
    win.webContents.on("context-menu", (e) => e.preventDefault());
  }

  // Capture wc by reference so we can clean its sessions on close,
  // even though webContents is destroyed by the time `closed` fires.
  const wc = win.webContents;
  win.on("closed", () => {
    adoptPayloads.delete(wc.id);
    killSessionsFor(wc);
  });

  // Push fullscreen state to the renderer so it can drop the 80px
  // traffic-light reservation when macOS hides them in native fullscreen.
  const sendFs = (on: boolean) => {
    if (!win.isDestroyed()) win.webContents.send("window:fullscreen", on);
  };
  win.on("enter-full-screen", () => sendFs(true));
  win.on("leave-full-screen", () => sendFs(false));
  win.webContents.on("did-finish-load", () => sendFs(win.isFullScreen()));

  return win;
}

// Replace the default menu so Chromium's built-in accelerators don't
// pre-empt renderer shortcuts. Shell tab/split actions use
// registerAccelerator:false so key events still reach xterm's custom
// handler in the renderer; New Window is main-side, so its accelerator
// is registered normally and dispatched to the focused window's view of
// reality (a fresh window is just made by main, no renderer plumbing).
function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const showDevMenuItems = Boolean(process.env.ELECTRON_RENDERER_URL);

  // Send an action to the focused window's renderer. The application menu
  // is shared across windows on macOS, so click handlers must look up the
  // active target dynamically rather than capturing a specific window.
  const sendToFocused = (action: string) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win && !win.isDestroyed()) win.webContents.send("menu:action", action);
  };

  const shellItem = (
    label: string,
    accelerator: string,
    action: string,
  ): Electron.MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => sendToFocused(action),
  });
  const shellActionItem = (
    label: string,
    action: string,
  ): Electron.MenuItemConstructorOptions => ({
    label,
    click: () => sendToFocused(action),
  });

  const settingsItem = (
    accelerator: string,
  ): Electron.MenuItemConstructorOptions => ({
    ...shellItem(
      isMac ? "⚙  Settings..." : "Settings...",
      accelerator,
      "open-settings",
    ),
    ...(!isMac ? { icon: settingsMenuIcon } : {}),
  });

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: APP_NAME,
            submenu: [
              { role: "about" },
              { type: "separator" },
              settingsItem("Cmd+,"),
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: "Edit",
      submenu: [
        ...(!isMac
          ? ([
              settingsItem("Ctrl+,"),
              { type: "separator" },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
        shellItem("Copy", isMac ? "Cmd+C" : "Ctrl+Shift+C", "copy"),
        shellItem("Paste", isMac ? "Cmd+V" : "Ctrl+Shift+V", "paste"),
        { type: "separator" },
        shellItem("Find...", isMac ? "Cmd+F" : "Ctrl+Shift+F", "find"),
      ],
    },
    {
      label: "Shell",
      submenu: [
        {
          label: "New Window",
          accelerator: isMac ? "Cmd+N" : "Ctrl+Shift+N",
          click: () => {
            createWindow();
          },
        },
        // On mac Cmd+T/D/W are safe — readline doesn't see them. On
        // win/linux Ctrl+D is EOF and Ctrl+W is delete-previous-word, so
        // we route those actions through Ctrl+Shift to leave the shell's
        // bindings intact.
        shellItem("New Tab", isMac ? "Cmd+T" : "Ctrl+Shift+T", "new-tab"),
        { type: "separator" },
        shellActionItem("Split Left", "split-left"),
        shellItem("Split Right", isMac ? "Cmd+D" : "Ctrl+Shift+D", "split-right"),
        shellActionItem("Split Up", "split-up"),
        shellItem(
          "Split Down",
          isMac ? "Cmd+Shift+D" : "Ctrl+Shift+E",
          "split-down",
        ),
        { type: "separator" },
        shellItem("Close Pane", isMac ? "Cmd+W" : "Ctrl+Shift+W", "close-pane"),
      ],
    },
    {
      label: "View",
      submenu: [
        shellItem(
          "Increase Font Size",
          isMac ? "Cmd+=" : "Ctrl+=",
          "font-increase",
        ),
        shellItem(
          "Decrease Font Size",
          isMac ? "Cmd+-" : "Ctrl+-",
          "font-decrease",
        ),
        shellItem(
          "Reset Font Size",
          isMac ? "Cmd+0" : "Ctrl+0",
          "font-reset",
        ),
        { type: "separator" },
        ...(showDevMenuItems
          ? ([
              { role: "reload" },
              { role: "toggleDevTools" },
              { type: "separator" },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// macOS dispatches dock drops as open-file. Fires before whenReady on cold
// launch, so we queue and let the renderer drain via app:initial-cwd. With
// a window already focused, forward to it so a new tab opens at that path.
app.on("open-file", (event, p) => {
  event.preventDefault();
  const cwd = resolveCwd(p);
  if (!cwd) return;
  const target =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows()[0] ??
    null;
  if (target && !target.isDestroyed()) {
    target.webContents.send("app:open-cwd", cwd);
    if (target.isMinimized()) target.restore();
    target.focus();
    return;
  }
  pendingCwd = cwd;
  if (app.isReady()) createWindow();
});

ipcMain.handle("app:initial-cwd", () => {
  const c = pendingCwd;
  pendingCwd = null;
  return c;
});

// ---- Tab drag-out / move-to-window ------------------------------------
// Drag a tab out: spawn a window, hand its live PTYs to the new window, and
// stash the layout for the new renderer to rebuild on boot.
ipcMain.handle(
  "window:create-with-tab",
  (e, payload: SerializedTab) => {
    const ids = collectPtyIds(payload?.tree);
    const win = createWindow(payload);
    transferSessions(ids, e.sender, win.webContents);
    return true;
  },
);

// New renderer claims the tab layout queued for it (or null for a normal
// window). One-shot: removed once consumed.
ipcMain.handle("window:consume-adopt", (e) => {
  const payload = adoptPayloads.get(e.sender.id) ?? null;
  adoptPayloads.delete(e.sender.id);
  return payload;
});

// Drop a tab onto an already-open window's tab bar: hand the PTYs over and
// tell that window's renderer to rebuild the tab.
ipcMain.handle(
  "window:move-tab",
  (e, payload: SerializedTab, targetWcId: number) => {
    const target = webContents.fromId(targetWcId);
    if (!target || target.isDestroyed()) return false;
    const ids = collectPtyIds(payload?.tree);
    transferSessions(ids, e.sender, target);
    target.send("window:adopt-tab", payload);
    return true;
  },
);

// Locate the window under a screen point (for deciding drop target during a
// tab drag). Prefers a window other than the dragging one so an overlapping
// target wins. Returns whether the point lands in the tab-bar band.
ipcMain.handle("window:hit-test", (e, x: number, y: number) => {
  const all = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized(),
  );
  const ordered = [
    ...all.filter((w) => w.webContents.id !== e.sender.id),
    ...all.filter((w) => w.webContents.id === e.sender.id),
  ];
  for (const w of ordered) {
    const b = w.getContentBounds();
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      return {
        kind: w.webContents.id === e.sender.id ? "self" : "other",
        wcId: w.webContents.id,
        inTabbar: y - b.y <= TABBAR_ZONE_PX,
      };
    }
  }
  return { kind: "none" };
});

// Resolve a Cmd/Ctrl-clicked terminal token to an existing file/dir path.
// The token may be absolute, ~-relative, or relative to the pane's cwd, and
// may carry an editor-style :line(:col) suffix or surrounding punctuation —
// try progressively trimmed variants and return the first that exists, plus
// the matched variant so the caller can underline only the real path (not
// the trailing comma or wrapping parens).
function resolveOpenTarget(
  cwd: string | null,
  rawToken: string,
): { abs: string; token: string } | null {
  const base = cwd && cwd !== "~" ? cwd : homedir();
  const variants = new Set<string>();
  const add = (v: string) => {
    if (v) variants.add(v);
  };
  add(rawToken);
  // Strip wrapping/trailing punctuation, e.g. "(package.json)" or "main.ts,".
  const trimmed = rawToken.replace(/^[([{'"]+/, "").replace(/[)\]},.;:'"]+$/, "");
  add(trimmed);
  // Strip an editor-style :line(:col) suffix, e.g. "src/main.ts:42".
  add(trimmed.replace(/:\d+(:\d+)?$/, ""));
  add(rawToken.replace(/:\d+(:\d+)?$/, ""));
  for (const v of variants) {
    let p = v;
    if (p === "~") p = homedir();
    else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
    const abs = isAbsolute(p) ? p : resolve(base, p);
    if (existsSync(abs)) return { abs, token: v };
  }
  return null;
}

ipcMain.handle(
  "terminal:open-path",
  async (_event, cwd: string | null, token: string) => {
    if (!token) return false;
    const target = resolveOpenTarget(cwd, token);
    if (!target) return false;
    // shell.openPath returns "" on success, or an error message.
    const err = await shell.openPath(target.abs);
    return err === "";
  },
);

// Resolve-only (no open) — drives the Cmd-hover underline. Returns the matched
// token form (the real path, punctuation stripped) so the front-end underlines
// exactly that, or null when nothing on disk matches.
ipcMain.handle(
  "terminal:resolve-path",
  (_event, cwd: string | null, token: string) =>
    token ? (resolveOpenTarget(cwd, token)?.token ?? null) : null,
);

ipcMain.handle("clipboard:read-text", () => clipboard.readText());

ipcMain.handle("clipboard:write-text", (_event, text: string) => {
  clipboard.writeText(text);
});

ipcMain.handle("terminal:context-menu", (event, opts: { canCopy: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const canPaste = clipboard.readText().length > 0;
  const sendContextAction = (action: string) => {
    event.sender.send("terminal:context-action", action);
  };
  const menu = Menu.buildFromTemplate([
    {
      label: "Copy",
      enabled: opts.canCopy,
      click: () => sendContextAction("copy"),
    },
    {
      label: "Paste",
      enabled: canPaste,
      click: () => sendContextAction("paste"),
    },
    { type: "separator" },
    {
      label: "Split Left",
      click: () => sendContextAction("split-left"),
    },
    {
      label: "Split Right",
      click: () => sendContextAction("split-right"),
    },
    {
      label: "Split Bottom",
      click: () => sendContextAction("split-bottom"),
    },
    {
      label: "Split Up",
      click: () => sendContextAction("split-up"),
    },
  ]);
  menu.popup({ window: win });
});

app.whenReady().then(() => {
  // macOS ignores BrowserWindow.icon for the dock; set it explicitly so
  // dev mode (npm run dev) shows the icon. In a packaged build the
  // bundled .icns/.ico takes over.
  if (process.platform === "darwin" && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon);
  }
  initPtyHost();
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
