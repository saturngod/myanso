import { contextBridge, ipcRenderer } from "electron";
import os from "node:os";

const api = {
  homeDir: os.homedir(),
  platform: process.platform,
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
  onContextAction(cb: (action: "copy" | "paste") => void) {
    const listener = (
      _: Electron.IpcRendererEvent,
      action: "copy" | "paste",
    ) => cb(action);
    ipcRenderer.on("terminal:context-action", listener);
    return () =>
      ipcRenderer.removeListener("terminal:context-action", listener);
  },
};

contextBridge.exposeInMainWorld("pty", api);

export type PtyApi = typeof api;
