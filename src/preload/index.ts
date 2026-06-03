import { contextBridge, ipcRenderer, webUtils } from "electron";
import os from "node:os";

type TerminalContextAction =
  | "copy"
  | "paste"
  | "split-left"
  | "split-right"
  | "split-bottom"
  | "split-up";

const api = {
  homeDir: os.homedir(),
  platform: process.platform,
  // webUtils lives in the electron module and is unreachable from the
  // context-isolated renderer, so resolve the dropped File's absolute path
  // here in preload. Replaces the non-standard File.path (removed in
  // Electron 32). Returns "" for objects that aren't real filesystem files
  // or if resolution throws, so a single bad drop never breaks the batch.
  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  spawn(cwd?: string): Promise<string | null> {
    return ipcRenderer.invoke("pty:spawn", cwd);
  },
  ready(id: string) {
    ipcRenderer.send("pty:ready", id);
  },
  write(id: string, data: string) {
    ipcRenderer.send("pty:write", id, data);
  },
  resize(id: string, cols: number, rows: number) {
    ipcRenderer.send("pty:resize", id, cols, rows);
  },
  kill(id: string) {
    ipcRenderer.send("pty:kill", id);
  },
  onData(cb: (id: string, data: string) => void) {
    const listener = (
      _: Electron.IpcRendererEvent,
      id: string,
      data: string,
    ) => cb(id, data);
    ipcRenderer.on("pty:data", listener);
    return () => ipcRenderer.removeListener("pty:data", listener);
  },
  onExit(cb: (id: string, code: number) => void) {
    const listener = (
      _: Electron.IpcRendererEvent,
      id: string,
      code: number,
    ) => cb(id, code);
    ipcRenderer.on("pty:exit", listener);
    return () => ipcRenderer.removeListener("pty:exit", listener);
  },
  onMenu(cb: (action: string) => void) {
    const listener = (_: Electron.IpcRendererEvent, action: string) =>
      cb(action);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },
  // Drains a folder/file path queued by main during cold launch (dock
  // drag-and-drop fires open-file before the renderer is ready). Returns
  // null if no path is pending.
  initialCwd(): Promise<string | null> {
    return ipcRenderer.invoke("app:initial-cwd");
  },
  onOpenCwd(cb: (cwd: string) => void) {
    const listener = (_: Electron.IpcRendererEvent, cwd: string) => cb(cwd);
    ipcRenderer.on("app:open-cwd", listener);
    return () => ipcRenderer.removeListener("app:open-cwd", listener);
  },
  onFullscreen(cb: (on: boolean) => void) {
    const listener = (_: Electron.IpcRendererEvent, on: boolean) => cb(on);
    ipcRenderer.on("window:fullscreen", listener);
    return () => ipcRenderer.removeListener("window:fullscreen", listener);
  },
  readClipboardText(): Promise<string> {
    return ipcRenderer.invoke("clipboard:read-text");
  },
  writeClipboardText(text: string): Promise<void> {
    return ipcRenderer.invoke("clipboard:write-text", text);
  },
  showContextMenu(opts: { canCopy: boolean }): Promise<void> {
    return ipcRenderer.invoke("terminal:context-menu", opts);
  },
  openPath(cwd: string | null, token: string): Promise<boolean> {
    return ipcRenderer.invoke("terminal:open-path", cwd, token);
  },
  resolvePath(cwd: string | null, token: string): Promise<string | null> {
    return ipcRenderer.invoke("terminal:resolve-path", cwd, token);
  },
  onContextAction(cb: (action: TerminalContextAction) => void) {
    const listener = (
      _: Electron.IpcRendererEvent,
      action: TerminalContextAction,
    ) => cb(action);
    ipcRenderer.on("terminal:context-action", listener);
    return () =>
      ipcRenderer.removeListener("terminal:context-action", listener);
  },
};

// Tab drag-out / move-to-window bridge. Payloads are opaque serialized tab
// trees produced and consumed by the renderer; main only reads their ptyIds.
type HitTestResult = {
  kind: "self" | "other" | "none";
  wcId?: number;
  inTabbar?: boolean;
};
const winApi = {
  // Spawn a new window that adopts the given tab's live sessions.
  createWithTab(payload: unknown): Promise<boolean> {
    return ipcRenderer.invoke("window:create-with-tab", payload);
  },
  // Claim the tab layout queued for this window on boot (null if none).
  consumeAdopt(): Promise<unknown> {
    return ipcRenderer.invoke("window:consume-adopt");
  },
  // Hand a tab to an already-open window (by its webContents id).
  moveTab(payload: unknown, targetWcId: number): Promise<boolean> {
    return ipcRenderer.invoke("window:move-tab", payload, targetWcId);
  },
  // Which window sits under a screen point, and is the point on its tab bar.
  hitTest(x: number, y: number): Promise<HitTestResult> {
    return ipcRenderer.invoke("window:hit-test", x, y);
  },
  // A drag dropped a tab onto this window's tab bar — rebuild it.
  onAdoptTab(cb: (payload: unknown) => void) {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown) =>
      cb(payload);
    ipcRenderer.on("window:adopt-tab", listener);
    return () => ipcRenderer.removeListener("window:adopt-tab", listener);
  },
};

contextBridge.exposeInMainWorld("pty", api);
contextBridge.exposeInMainWorld("win", winApi);

export type PtyApi = typeof api;
export type WinApi = typeof winApi;
