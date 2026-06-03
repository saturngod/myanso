export {};

type TerminalContextAction =
  | "copy"
  | "paste"
  | "split-left"
  | "split-right"
  | "split-bottom"
  | "split-up";

declare global {
  // Serialized pane tree handed between windows during tab drag-out.
  type SerializedNode =
    | { kind: "leaf"; ptyId: string; cwd: string; title: string; screen: string }
    | {
        kind: "branch";
        dir: "row" | "col";
        ratio: number;
        a: SerializedNode;
        b: SerializedNode;
      };
  interface SerializedTab {
    tree: SerializedNode;
  }
  interface HitTestResult {
    kind: "self" | "other" | "none";
    wcId?: number;
    inTabbar?: boolean;
  }

  interface Window {
    win: {
      createWithTab(payload: SerializedTab): Promise<boolean>;
      consumeAdopt(): Promise<SerializedTab | null>;
      moveTab(payload: SerializedTab, targetWcId: number): Promise<boolean>;
      hitTest(x: number, y: number): Promise<HitTestResult>;
      onAdoptTab(cb: (payload: SerializedTab) => void): () => void;
    };
    pty: {
      homeDir: string;
      platform: string;
      getPathForFile(file: File): string;
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
      openPath(cwd: string | null, token: string): Promise<boolean>;
      resolvePath(cwd: string | null, token: string): Promise<string | null>;
      onContextAction(cb: (action: TerminalContextAction) => void): () => void;
    };
  }
}
