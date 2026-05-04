export {};

type TerminalContextAction =
  | "copy"
  | "paste"
  | "split-left"
  | "split-right"
  | "split-bottom"
  | "split-up";

declare global {
  interface Window {
    pty: {
      homeDir: string;
      platform: string;
      spawn(cwd?: string): Promise<string | null>;
      ready(id: string): void;
      write(id: string, data: string): void;
      resize(id: string, cols: number, rows: number): void;
      kill(id: string): void;
      onData(cb: (id: string, data: string) => void): () => void;
      onExit(cb: (id: string, code: number) => void): () => void;
      onMenu(cb: (action: string) => void): () => void;
      initialCwd(): Promise<string | null>;
      onOpenCwd(cb: (cwd: string) => void): () => void;
      onFullscreen(cb: (on: boolean) => void): () => void;
      readClipboardText(): Promise<string>;
      writeClipboardText(text: string): Promise<void>;
      showContextMenu(opts: { canCopy: boolean }): Promise<void>;
      onContextAction(cb: (action: TerminalContextAction) => void): () => void;
    };
  }
}
