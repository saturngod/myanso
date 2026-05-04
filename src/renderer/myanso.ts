import { Terminal, IUnicodeVersionProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  buildTerminalFontFamily,
  loadAppearance,
  normalizeAppearance,
  saveAppearance,
  VIEW_MODE_LINE_HEIGHT,
  type AppearancePrefs,
} from "./appearance";
import { initSettingsPanel } from "./settings-panel";
import "@xterm/xterm/css/xterm.css";

// ---- Chrome DOM ------------------------------------------------------
const tabbar = document.getElementById("tabbar") as HTMLDivElement;
const newTabBtn = document.getElementById("new-tab") as HTMLButtonElement;
const wrapper = document.getElementById("terminal-wrapper") as HTMLDivElement;

// Mouse wheels emit deltaY; the tabbar only scrolls on the X axis. Without
// this, a regular wheel does nothing over an overflowing tab strip — only
// trackpad two-finger horizontal swipes work. Translate the larger axis.
tabbar.addEventListener(
  "wheel",
  (e) => {
    if (tabbar.scrollWidth <= tabbar.clientWidth) return;
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    e.preventDefault();
    tabbar.scrollLeft += delta;
  },
  { passive: false },
);

// ---- Shared (pure) helpers -------------------------------------------
const ANSI_COLORS = [
  "#000000",
  "#ff6e6e",
  "#6eff6e",
  "#ffff6e",
  "#7c9cfa",
  "#ff6eff",
  "#6effff",
  "#e4e4e4",
  "#686868",
  "#ff8b8b",
  "#8bff8b",
  "#ffff8b",
  "#9cb0fa",
  "#ff8bff",
  "#8bffff",
  "#ffffff",
];

function get256(code: number): string {
  if (code < 16) return ANSI_COLORS[code];
  if (code >= 232) {
    const v = (code - 232) * 10 + 8;
    return `rgb(${v},${v},${v})`;
  }
  const c = code - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const m = (x: number) => (x === 0 ? 0 : x * 40 + 55);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

const MODE_ANSI16 = 16777216;
const MODE_256 = 33554432;
const MODE_RGB = 50331648;

function cssColor(color: number, mode: number): string | null {
  if (mode === 0) return null;
  if (mode === MODE_ANSI16) return ANSI_COLORS[color];
  if (mode === MODE_256) return get256(color);
  if (mode === MODE_RGB) {
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    return `rgb(${r},${g},${b})`;
  }
  return null;
}

const NEEDS_ESCAPE = /[&<>"]/;
function escapeHtml(s: string): string {
  if (!NEEDS_ESCAPE.test(s)) return s;
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapRun(
  text: string,
  fg: string | null,
  bg: string | null,
  bold: boolean,
  italic: boolean,
): string {
  if (!text) return "";
  if (!fg && !bg && !bold && !italic) return escapeHtml(text);
  const parts: string[] = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (bold) parts.push("font-weight:bold");
  if (italic) parts.push("font-style:italic");
  return `<span style="${parts.join(";")}">${escapeHtml(text)}</span>`;
}

const isMyanmarMc = (cp: number): boolean =>
  (cp >= 0x102b && cp <= 0x102c) ||
  cp === 0x1031 ||
  cp === 0x1038 ||
  (cp >= 0x103b && cp <= 0x103c) ||
  (cp >= 0x1056 && cp <= 0x1057) ||
  (cp >= 0x1062 && cp <= 0x1064) ||
  (cp >= 0x1067 && cp <= 0x106d) ||
  (cp >= 0x1083 && cp <= 0x1084) ||
  (cp >= 0x1087 && cp <= 0x108c) ||
  cp === 0x108f ||
  (cp >= 0x109a && cp <= 0x109c);

function applyMyanmarWidth(
  term: Terminal,
  opts: { collapseSpacingMarks: boolean },
): void {
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    if (!opts.collapseSpacingMarks) return;
    const v11 = (
      term as unknown as {
        _core: {
          unicodeService: {
            _providers: Record<string, IUnicodeVersionProvider>;
          };
        };
      }
    )._core?.unicodeService?._providers?.["11"];
    if (v11) {
      const origWc = v11.wcwidth.bind(v11);
      v11.wcwidth = (cp) =>
        isMyanmarMc(cp) && term.buffer.active.type === "normal"
          ? 0
          : origWc(cp);
    }
  } catch (e) {
    console.warn("[myanso] unicode11 failed", e);
  }
}

let appearance = loadAppearance();

const home = window.pty?.homeDir || "";
function prettyPath(raw: string): string {
  try {
    const m = raw.match(/^file:\/\/[^/]*(\/.*)$/);
    const abs = decodeURIComponent(m ? m[1] : raw);
    if (home && abs === home) return "~";
    if (home && abs.startsWith(home + "/")) return "~" + abs.slice(home.length);
    return abs;
  } catch {
    return raw;
  }
}

// ---- PaneSession (leaf) ----------------------------------------------
// One xterm + PTY pair occupying one .leaf element. The brain/face split
// is identical to the single-pane case — splits just give us several of
// these side-by-side or stacked. Per-leaf ResizeObserver picks up window
// resizes, divider drags, and split-induced reflows uniformly.

interface PaneSessionOpts {
  ptyId: string;
  onCwd(s: PaneSession): void;
  onTitle(s: PaneSession): void;
  onFocus(s: PaneSession): void;
  onKey(e: KeyboardEvent, s: PaneSession): boolean;
}

function currentSelectionText(): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  return sel.toString().replace(/\u00a0/g, " ");
}

class PaneSession {
  readonly ptyId: string;
  readonly leafEl: HTMLDivElement;
  readonly hiddenDiv: HTMLDivElement;
  readonly outputDiv: HTMLDivElement;
  readonly term: Terminal;
  readonly fit: FitAddon;

  cwd = "~";
  title = "";

  private rowDivs: HTMLDivElement[] = [];
  private lastRowHtml: string[] = [];
  private colorCache = new Map<number, string>();
  private focused = false;
  private renderScheduled = false;
  private renderFull = true;
  private renderStart: number | null = null;
  private renderEnd: number | null = null;
  private resizeScheduled = false;
  private lastCols = 0;
  private lastRows = 0;
  private lastViewportY = -1;
  private lastCursorRow: number | null = null;
  private lastResizeCols = 0;
  private lastResizeRows = 0;
  private lastCellH = 0;
  private ro: ResizeObserver | null = null;
  private disposers: Array<() => void> = [];
  private active = false;
  private usingAltScreen = false;

  constructor(private readonly opts: PaneSessionOpts) {
    this.ptyId = opts.ptyId;

    this.leafEl = document.createElement("div");
    this.leafEl.className = "leaf";

    this.hiddenDiv = document.createElement("div");
    this.hiddenDiv.className = "hidden-terminal";
    this.leafEl.appendChild(this.hiddenDiv);

    this.outputDiv = document.createElement("div");
    this.outputDiv.className = "output";
    this.leafEl.appendChild(this.outputDiv);
    this.outputDiv.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.opts.onFocus(this);
    });
    this.outputDiv.addEventListener("click", () => {
      if (!currentSelectionText()) this.focus();
    });
    this.outputDiv.addEventListener("contextmenu", (e) => {
      this.opts.onFocus(this);
      e.preventDefault();
      void window.pty?.showContextMenu({ canCopy: !!currentSelectionText() });
    });

    // lineHeight 1.25 → 20 px cell (integer, tiles cleanly, no row seams).
    // Tighter values (1.0 = 16 px) clip Burmese above-base marks like
    // ◌ိ / ◌ီ and below-base ◌ု / ◌ူ; 1.35 works but adds airy leading.
    this.term = new Terminal({
      fontFamily: buildTerminalFontFamily(appearance.fontFamily),
      fontSize: appearance.fontSize,
      lineHeight: VIEW_MODE_LINE_HEIGHT[appearance.viewMode],
      cursorBlink: false,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: "#15171e", foreground: "#e4e4e4" },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    // Ubuntu bash/readline uses the host wcwidth table while editing the
    // prompt. There Myanmar spacing marks are one cell, so collapsing them
    // in xterm makes cursor-left redisplay paint into the prompt.
    applyMyanmarWidth(this.term, {
      collapseSpacingMarks: window.pty?.platform !== "linux",
    });
    this.term.loadAddon(new WebLinksAddon());

    this.term.attachCustomKeyEventHandler((e) => this.opts.onKey(e, this));

    this.term.parser.registerOscHandler(7, (d) => {
      this.cwd = prettyPath(d);
      this.opts.onCwd(this);
      return false;
    });
    const onOscTitle = (d: string) => {
      this.title = d || "";
      this.opts.onTitle(this);
      return false;
    };
    this.term.parser.registerOscHandler(0, onOscTitle);
    this.term.parser.registerOscHandler(2, onOscTitle);
    const onAltScreen = (enabled: boolean) => {
      this.usingAltScreen = enabled;
      this.leafEl.classList.toggle("alt-screen", enabled);
    };
    const altOn = this.term.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        if (params.some((p) => p === 47 || p === 1047 || p === 1049)) {
          onAltScreen(true);
        }
        return false;
      },
    );
    const altOff = this.term.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        if (params.some((p) => p === 47 || p === 1047 || p === 1049)) {
          onAltScreen(false);
        }
        return false;
      },
    );
    this.disposers.push(() => altOn.dispose(), () => altOff.dispose());
    this.applyAppearance(appearance);
  }

  // Two-phase init: caller places leafEl in the DOM, then calls attach().
  // xterm.js logs a debug warning if term.open() runs on a detached node,
  // and the textarea isn't created until after open().
  attach(): void {
    this.term.open(this.hiddenDiv);

    const onFocus = () => {
      this.focused = true;
      this.scheduleCursorRender();
      this.opts.onFocus(this);
    };
    const onBlur = () => {
      this.focused = false;
      this.scheduleCursorRender();
    };
    const onVisible = () => {
      if (!document.hidden && this.active) {
        this.scheduleRender(undefined, undefined, true);
      }
    };
    this.term.textarea?.addEventListener("focus", onFocus);
    this.term.textarea?.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisible);
    this.disposers.push(
      () => this.term.textarea?.removeEventListener("focus", onFocus),
      () => this.term.textarea?.removeEventListener("blur", onBlur),
      () => document.removeEventListener("visibilitychange", onVisible),
    );

    const renderDisposable = this.term.onRender((e) =>
      this.scheduleRender(e.start, e.end),
    );
    this.disposers.push(() => renderDisposable.dispose());
  }

  // Per-leaf observation: window resize, sibling split, and divider drag
  // all change the leaf's bounds, all funnel through here.
  private setupResize(): void {
    if (this.ro) return;
    const doFit = () => {
      if (this.resizeScheduled) return;
      this.resizeScheduled = true;
      requestAnimationFrame(() => {
        this.resizeScheduled = false;
        this.fitAndResize();
      });
    };
    this.ro = new ResizeObserver(doFit);
    this.ro.observe(this.leafEl);
  }

  private fitAndResize(): void {
    if (!this.active) return;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    const { cols, rows } = this.term;
    if (cols !== this.lastResizeCols || rows !== this.lastResizeRows) {
      this.lastResizeCols = cols;
      this.lastResizeRows = rows;
      window.pty?.resize(this.ptyId, cols, rows);
      this.scheduleRender(undefined, undefined, true);
    }
    const cellH = (
      this.term as unknown as {
        _core: {
          _renderService?: {
            dimensions?: { css?: { cell?: { height: number } } };
          };
        };
      }
    )._core?._renderService?.dimensions?.css?.cell?.height;
    if (cellH && cellH > 0) {
      const rounded = Math.round(cellH);
      if (rounded === this.lastCellH) return;
      this.lastCellH = rounded;
      // Round to integer pixel — fractional heights leave 1-px row seams
      // visible as horizontal stripes in solid-bg apps (htop, vim).
      document.documentElement.style.setProperty("--cell-h", `${rounded}px`);
      this.scheduleRender(undefined, undefined, true);
    }
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.setupResize();
    this.fitAndResize();
    this.scheduleRender(undefined, undefined, true);
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }
  }

  dispose(): void {
    this.deactivate();
    for (const fn of this.disposers) {
      try {
        fn();
      } catch {
        /* */
      }
    }
    this.disposers.length = 0;
    try {
      this.term.dispose();
    } catch {
      /* */
    }
    this.leafEl.remove();
  }

  focus(): void {
    this.term.focus();
  }

  writeToTerm(data: string): void {
    this.term.write(data);
  }

  applyAppearance(prefs: AppearancePrefs): void {
    const fontFamily = buildTerminalFontFamily(prefs.fontFamily);
    this.leafEl.style.fontFamily = fontFamily;
    this.leafEl.style.fontSize = `${prefs.fontSize}px`;
    this.term.options.fontFamily = fontFamily;
    this.term.options.fontSize = prefs.fontSize;
    this.term.options.lineHeight = VIEW_MODE_LINE_HEIGHT[prefs.viewMode];
    if (!this.active) return;
    requestAnimationFrame(() => {
      this.fitAndResize();
      this.scheduleRender();
    });
  }

  setDimStyle(on: boolean): void {
    this.leafEl.classList.toggle("dim", on);
  }

  // Absolute cwd (un-prettified) for spawning sibling shells.
  cwdAbsolute(): string | null {
    if (!this.cwd) return null;
    if (this.cwd === "~") return home || null;
    if (this.cwd.startsWith("~/")) return home + this.cwd.slice(1);
    return this.cwd;
  }

  private cursorRenderRow(): number | null {
    const buffer = this.term.buffer.active;
    const row = buffer.cursorY + buffer.baseY - buffer.viewportY;
    return row >= 0 && row < this.term.rows ? row : null;
  }

  private includeRenderRow(row: number | null): void {
    if (row == null) return;
    this.renderStart =
      this.renderStart == null ? row : Math.min(this.renderStart, row);
    this.renderEnd =
      this.renderEnd == null ? row : Math.max(this.renderEnd, row);
  }

  private scheduleCursorRender(): void {
    this.includeRenderRow(this.lastCursorRow);
    this.includeRenderRow(this.cursorRenderRow());
    this.scheduleRender();
  }

  scheduleRender(start?: number, end?: number, full = false): void {
    if (full) {
      this.renderFull = true;
    } else if (start != null && end != null) {
      this.renderStart =
        this.renderStart == null ? start : Math.min(this.renderStart, start);
      this.renderEnd =
        this.renderEnd == null ? end : Math.max(this.renderEnd, end);
    }
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (document.hidden) return;
      if (this.usingAltScreen) return;
      if (!this.active) return;
      this.renderBuffer();
    });
  }

  private cachedColor(color: number, mode: number): string | null {
    if (mode === 0) return null;
    const key = mode | color;
    const hit = this.colorCache.get(key);
    if (hit !== undefined) return hit;
    const v = cssColor(color, mode);
    if (v !== null) this.colorCache.set(key, v);
    return v;
  }

  private ensureRowCount(rows: number): void {
    while (this.rowDivs.length < rows) {
      const d = document.createElement("div");
      d.className = "line";
      d.innerHTML = " ";
      this.outputDiv.appendChild(d);
      this.rowDivs.push(d);
      this.lastRowHtml.push(" ");
    }
    while (this.rowDivs.length > rows) {
      const d = this.rowDivs.pop()!;
      this.lastRowHtml.pop();
      this.outputDiv.removeChild(d);
    }
  }

  private renderBuffer(): void {
    const buffer = this.term.buffer.active;
    const cols = this.term.cols;
    const rows = this.term.rows;
    const startRow = buffer.viewportY;
    const cursorY = buffer.cursorY + buffer.baseY;
    const cursorX = buffer.cursorX;
    const cursorRow = cursorY - startRow;
    const cell = buffer.getNullCell();
    const full =
      this.renderFull ||
      this.renderStart == null ||
      this.renderEnd == null ||
      cols !== this.lastCols ||
      rows !== this.lastRows ||
      startRow !== this.lastViewportY;

    this.ensureRowCount(rows);
    this.colorCache.clear();
    let from: number;
    let to: number;
    if (full) {
      from = 0;
      to = rows - 1;
    } else {
      from = this.renderStart!;
      to = this.renderEnd!;
      from = Math.max(0, Math.min(rows - 1, from));
      to = Math.max(0, Math.min(rows - 1, to));
      if (this.lastCursorRow != null) {
        from = Math.min(from, this.lastCursorRow);
        to = Math.max(to, this.lastCursorRow);
      }
      if (cursorRow >= 0 && cursorRow < rows) {
        from = Math.min(from, cursorRow);
        to = Math.max(to, cursorRow);
      }
    }

    for (let r = from; r <= to; r++) {
      const absRow = startRow + r;
      const line = buffer.getLine(absRow);
      if (!line) {
        if (this.lastRowHtml[r] !== " ") {
          this.rowDivs[r].innerHTML = " ";
          this.lastRowHtml[r] = " ";
        }
        continue;
      }
      const isCursorLine = absRow === cursorY;

      let html = "";
      let run = "";
      let curFg: string | null = null;
      let curBg: string | null = null;
      let curBold = false;
      let curItalic = false;
      const flush = () => {
        if (run) {
          html += wrapRun(run, curFg, curBg, curBold, curItalic);
          run = "";
        }
      };

      for (let x = 0; x < cols; x++) {
        const c = line.getCell(x, cell);
        if (!c) continue;

        if (isCursorLine && x === cursorX) {
          flush();
          let cch = " ";
          if (c.getWidth() !== 0) cch = c.getChars() || " ";
          const cursorClass = this.focused ? "cursor blink" : "cursor blurred";
          html += `<span class="${cursorClass}">${escapeHtml(cch)}</span>`;
          curFg = null;
          curBg = null;
          curBold = false;
          curItalic = false;
          continue;
        }

        const fg = this.cachedColor(c.getFgColor(), c.getFgColorMode());
        const bg = this.cachedColor(c.getBgColor(), c.getBgColorMode());
        const bold = c.isBold() !== 0;
        const italic = c.isItalic() !== 0;

        if (
          fg !== curFg ||
          bg !== curBg ||
          bold !== curBold ||
          italic !== curItalic
        ) {
          flush();
          curFg = fg;
          curBg = bg;
          curBold = bold;
          curItalic = italic;
        }

        if (c.getWidth() === 0) continue;

        run += c.getChars() || " ";
      }

      flush();

      if (isCursorLine && cursorX >= cols) {
        const cursorClass = this.focused ? "cursor blink" : "cursor blurred";
        html += `<span class="${cursorClass}"> </span>`;
      }

      if (!html) html = " ";

      if (html !== this.lastRowHtml[r]) {
        this.rowDivs[r].innerHTML = html;
        this.lastRowHtml[r] = html;
      }
    }

    this.renderFull = false;
    this.renderStart = null;
    this.renderEnd = null;
    this.lastCols = cols;
    this.lastRows = rows;
    this.lastViewportY = startRow;
    this.lastCursorRow = cursorRow >= 0 && cursorRow < rows ? cursorRow : null;
  }
}

// ---- Pane tree -------------------------------------------------------
// A Tab's content is a recursive Pane: either a Leaf (one PaneSession)
// or a Branch (two children with a draggable divider between them).
// dir="row" → side-by-side (vertical divider, Cmd+D in iTerm parlance).
// dir="col" → stacked (horizontal divider, Cmd+Shift+D).
type SplitAxis = "row" | "col";
type SplitPlacement = "before" | "after";

interface Leaf {
  kind: "leaf";
  session: PaneSession;
  parent: Branch | null;
}
interface Branch {
  kind: "branch";
  dir: SplitAxis;
  ratio: number;
  a: Pane;
  b: Pane;
  el: HTMLDivElement;
  divider: HTMLDivElement;
  parent: Branch | null;
}
type Pane = Leaf | Branch;

function paneEl(p: Pane): HTMLElement {
  return p.kind === "leaf" ? p.session.leafEl : p.el;
}

function paneLeaves(p: Pane, out: Leaf[] = []): Leaf[] {
  if (p.kind === "leaf") out.push(p);
  else {
    paneLeaves(p.a, out);
    paneLeaves(p.b, out);
  }
  return out;
}

function applyBranchSizing(branch: Branch): void {
  // Percentage flex-basis with shrinkable items: each child starts at its
  // ratio of the container's main-axis size, then shrinks/grows to absorb
  // the 1px divider. More robust than `<grow> 0 0` from a zero basis,
  // which can collapse to 0 in column direction during initial layout.
  const aPct = (branch.ratio * 100).toFixed(4);
  const bPct = ((1 - branch.ratio) * 100).toFixed(4);
  paneEl(branch.a).style.flex = `1 1 ${aPct}%`;
  paneEl(branch.b).style.flex = `1 1 ${bPct}%`;
}

// Splits `leaf` along `dir`. `placement` controls which side of the active
// leaf receives the new session.
// The leaf's existing DOM is wrapped in a new branch element in-place.
function splitLeaf(
  leaf: Leaf,
  dir: SplitAxis,
  newSession: PaneSession,
  placement: SplitPlacement,
  onDividerDown: (b: Branch, e: PointerEvent) => void,
): { branch: Branch; newLeaf: Leaf } {
  const el = document.createElement("div");
  el.className = `split dir-${dir}`;
  const divider = document.createElement("div");
  divider.className = `divider dir-${dir}`;
  const newLeaf: Leaf = {
    kind: "leaf",
    session: newSession,
    parent: null as unknown as Branch,
  };
  const newFirst = placement === "before";

  const branch: Branch = {
    kind: "branch",
    dir,
    ratio: 0.5,
    a: newFirst ? newLeaf : leaf,
    b: newFirst ? leaf : newLeaf,
    el,
    divider,
    parent: leaf.parent,
  };
  newLeaf.parent = branch;

  const oldEl = leaf.session.leafEl;
  // Inherit the leaf's flex slot in its old parent — otherwise nested
  // splits collapse to .split's class default (basis 0) and the other
  // sibling steals their space.
  const inheritedFlex = oldEl.style.flex;
  const host = oldEl.parentElement!;
  host.replaceChild(el, oldEl);
  if (inheritedFlex) el.style.flex = inheritedFlex;
  if (newFirst) {
    el.appendChild(newSession.leafEl);
    el.appendChild(divider);
    el.appendChild(oldEl);
  } else {
    el.appendChild(oldEl);
    el.appendChild(divider);
    el.appendChild(newSession.leafEl);
  }

  // Re-point the old parent's child slot at this new branch — without
  // this, paneLeaves(tab.root) skips the new sub-tree and follow-up
  // bookkeeping cannot see the new pane.
  const oldParent = branch.parent;
  if (oldParent) {
    if (oldParent.a === leaf) oldParent.a = branch;
    else if (oldParent.b === leaf) oldParent.b = branch;
  }
  leaf.parent = branch;
  // applyBranchSizing overwrites oldEl.style.flex for its new position
  // inside this branch (50/50). The inherited flex on `el` above keeps
  // the new branch correctly sized in the parent branch's slot.
  applyBranchSizing(branch);

  divider.addEventListener("pointerdown", (e) => onDividerDown(branch, e));
  return { branch, newLeaf };
}

// Removes leaf, replaces its parent branch with the surviving sibling.
// Returns the new tree root if the tab's root changed; else null.
function removeLeaf(leaf: Leaf): { newRoot?: Pane; sibling: Pane } | null {
  const parent = leaf.parent;
  if (!parent) return null;
  const sibling = parent.a === leaf ? parent.b : parent.a;
  const grandparent = parent.parent;

  const sibEl = paneEl(sibling);
  parent.el.parentElement!.replaceChild(sibEl, parent.el);
  sibling.parent = grandparent;

  if (grandparent) {
    if (grandparent.a === parent) grandparent.a = sibling;
    else grandparent.b = sibling;
    applyBranchSizing(grandparent);
    return { sibling };
  }
  return { newRoot: sibling, sibling };
}

// Geometric pane navigation: pick the leaf nearest in the requested
// direction from the current one, by leaf-rect centers.
function findNeighbor(
  current: Leaf,
  dir: "left" | "right" | "up" | "down",
  leaves: Leaf[],
): Leaf | null {
  const cur = current.session.leafEl.getBoundingClientRect();
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  let best: Leaf | null = null;
  let bestDist = Infinity;
  for (const leaf of leaves) {
    if (leaf === current) continue;
    const r = leaf.session.leafEl.getBoundingClientRect();
    let inDir = false;
    if (dir === "left" && r.right <= cur.left + 1) inDir = true;
    else if (dir === "right" && r.left >= cur.right - 1) inDir = true;
    else if (dir === "up" && r.bottom <= cur.top + 1) inDir = true;
    else if (dir === "down" && r.top >= cur.bottom - 1) inDir = true;
    if (!inDir) continue;
    const ox = r.left + r.width / 2;
    const oy = r.top + r.height / 2;
    const d = (ox - cx) ** 2 + (oy - cy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = leaf;
    }
  }
  return best;
}

// ---- Tab -------------------------------------------------------------
// Owns the tab chip, the tab-root container in wrapper, and the pane
// tree. Routes session events; tracks the active leaf for keyboard
// shortcuts and tab-chip text.

interface TabOpts {
  onClose(t: Tab): void;
  onActivateRequest(t: Tab): void;
  onLeafEmpty(t: Tab, leaf: Leaf): void;
  onLeafClosed(t: Tab, leaf: Leaf): void;
  onTitleChange(t: Tab): void;
}

class Tab {
  readonly tabEl: HTMLButtonElement;
  readonly titleEl: HTMLSpanElement;
  readonly rootEl: HTMLDivElement;
  root: Pane;
  active: Leaf;
  private isActive = false;

  constructor(
    initial: PaneSession,
    private readonly opts: TabOpts,
    private readonly onSessionKey: (
      e: KeyboardEvent,
      s: PaneSession,
    ) => boolean,
  ) {
    this.rootEl = document.createElement("div");
    this.rootEl.className = "tab-root inactive";
    wrapper.appendChild(this.rootEl);

    const leaf: Leaf = { kind: "leaf", session: initial, parent: null };
    this.root = leaf;
    this.active = leaf;
    this.rootEl.appendChild(initial.leafEl);

    this.tabEl = document.createElement("button");
    this.tabEl.className = "tab";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "tab-title";
    this.titleEl.textContent = this.displayName();
    const closeEl = document.createElement("span");
    closeEl.className = "tab-close";
    closeEl.textContent = "×";
    closeEl.title =
      window.pty?.platform === "darwin"
        ? "Close tab (⌘W)"
        : "Close tab (Ctrl+Shift+W)";
    this.tabEl.append(this.titleEl, closeEl);
    tabbar.appendChild(this.tabEl);
    this.tabEl.addEventListener("click", (e) => {
      if (e.target === closeEl) {
        e.stopPropagation();
        opts.onClose(this);
        return;
      }
      opts.onActivateRequest(this);
    });
  }

  // Used by TabManager when wiring a freshly-created PaneSession.
  buildSessionOpts(ptyId: string): PaneSessionOpts {
    return {
      ptyId,
      onCwd: () => this.refreshTitle(),
      onTitle: () => this.refreshTitle(),
      onFocus: (s) => this.onLeafFocused(s),
      onKey: (e, s) => this.onSessionKey(e, s),
    };
  }

  activate(): void {
    if (this.isActive) return;
    this.isActive = true;
    this.rootEl.classList.remove("inactive");
    this.tabEl.classList.add("active");
    this.tabEl.scrollIntoView({ inline: "nearest", block: "nearest" });
    for (const leaf of paneLeaves(this.root)) leaf.session.activate();
    this.applyFocusedStyles();
    this.active.session.focus();
    document.title = this.displayName();
  }

  deactivate(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.rootEl.classList.add("inactive");
    this.tabEl.classList.remove("active");
    for (const leaf of paneLeaves(this.root)) leaf.session.deactivate();
  }

  dispose(): void {
    this.deactivate();
    for (const leaf of paneLeaves(this.root)) leaf.session.dispose();
    this.rootEl.remove();
    this.tabEl.remove();
  }

  // Split the active leaf and graft a new session next to it.
  // The new session's leafEl is placed in the DOM by splitLeaf before
  // attach() runs, so xterm.open() sees a connected element.
  splitActive(
    dir: SplitAxis,
    newSession: PaneSession,
    placement: SplitPlacement = "after",
  ): Leaf {
    const leaf = this.active;
    const { branch, newLeaf } = splitLeaf(
      leaf,
      dir,
      newSession,
      placement,
      (b, e) => this.beginDividerDrag(b, e),
    );
    if (this.root === leaf) this.root = branch;
    newSession.attach();
    if (this.isActive) newSession.activate();
    this.setActiveLeaf(newLeaf);
    newLeaf.session.focus();
    return newLeaf;
  }

  // Close one leaf. Caller (TabManager) handles the case where the leaf
  // was the only one in the tab.
  closeLeaf(leaf: Leaf): void {
    if (leaf.parent === null) {
      this.opts.onLeafEmpty(this, leaf);
      return;
    }
    const result = removeLeaf(leaf);
    this.opts.onLeafClosed(this, leaf);
    leaf.session.dispose();
    if (result?.newRoot) this.root = result.newRoot;
    // Pick a new active leaf — first leaf of the surviving subtree.
    const survivors = paneLeaves(this.root);
    if (survivors.length === 0) {
      this.opts.onLeafEmpty(this, leaf);
      return;
    }
    this.setActiveLeaf(survivors[0]);
    if (this.isActive) survivors[0].session.focus();
  }

  // Called by PaneSession on textarea focus.
  private onLeafFocused(s: PaneSession): void {
    const leaf = paneLeaves(this.root).find((l) => l.session === s);
    if (!leaf) return;
    this.setActiveLeaf(leaf);
  }

  setActiveLeaf(leaf: Leaf): void {
    this.active = leaf;
    this.applyFocusedStyles();
    this.refreshTitle();
  }

  navigate(dir: "left" | "right" | "up" | "down"): void {
    const next = findNeighbor(this.active, dir, paneLeaves(this.root));
    if (!next) return;
    this.setActiveLeaf(next);
    next.session.focus();
  }

  displayName(): string {
    return this.active.session.title || this.active.session.cwd || "shell";
  }

  cwdAbsolute(): string | null {
    return this.active.session.cwdAbsolute();
  }

  focusActive(): void {
    this.active.session.focus();
  }

  private applyFocusedStyles(): void {
    const leaves = paneLeaves(this.root);
    const multi = leaves.length > 1;
    for (const leaf of leaves) {
      leaf.session.setDimStyle(multi && leaf !== this.active);
    }
  }

  private refreshTitle(): void {
    const name = this.displayName();
    if (this.titleEl.textContent !== name) this.titleEl.textContent = name;
    const cwd = this.active.session.cwd;
    this.tabEl.title = cwd ? `${name}\n${cwd}` : name;
    this.opts.onTitleChange(this);
  }

  // ---- Drag-resize -----------------------------------------------------
  private beginDividerDrag(branch: Branch, e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = branch.el.getBoundingClientRect();
    const isRow = branch.dir === "row";
    const startPos = isRow ? e.clientX : e.clientY;
    const total = isRow ? rect.width : rect.height;
    const startRatio = branch.ratio;
    // Keep at least ~3 cells of width/height on each side so a pane is
    // never resized below a usable minimum.
    const minPx = 60;
    const minRatio = total > 0 ? Math.min(0.5, minPx / total) : 0.05;
    const maxRatio = 1 - minRatio;

    const target = branch.divider;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const cur = isRow ? ev.clientX : ev.clientY;
      const delta = (cur - startPos) / total;
      let r = startRatio + delta;
      if (r < minRatio) r = minRatio;
      if (r > maxRatio) r = maxRatio;
      branch.ratio = r;
      applyBranchSizing(branch);
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }
}

// ---- TabManager ------------------------------------------------------

class TabManager {
  private tabs = new Map<string, Tab>(); // keyed by first ptyId in tab
  private leavesByPtyId = new Map<string, Leaf>();
  private tabsByPtyId = new Map<string, Tab>();
  private order: string[] = [];
  private activeId: string | null = null;

  constructor() {
    const pty = window.pty;
    if (!pty) return;

    pty.onData((id, data) => {
      this.leavesByPtyId.get(id)?.session.writeToTerm(data);
    });
    pty.onExit((id) => {
      const owner = this.tabsByPtyId.get(id);
      const leaf = this.leavesByPtyId.get(id);
      if (!owner || !leaf) return;
      owner.closeLeaf(leaf);
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (!this.handleClipboardShortcut(e)) return;
        e.stopImmediatePropagation();
      },
      true,
    );
  }

  private registerLeaf(tab: Tab, leaf: Leaf): void {
    this.leavesByPtyId.set(leaf.session.ptyId, leaf);
    this.tabsByPtyId.set(leaf.session.ptyId, tab);
  }

  private unregisterLeaf(leaf: Leaf): void {
    this.leavesByPtyId.delete(leaf.session.ptyId);
    this.tabsByPtyId.delete(leaf.session.ptyId);
  }

  private unregisterTab(tab: Tab): void {
    for (const leaf of paneLeaves(tab.root)) this.unregisterLeaf(leaf);
  }

  private get active(): Tab | null {
    return this.activeId ? (this.tabs.get(this.activeId) ?? null) : null;
  }

  // Spawns a PTY and constructs a (not-yet-attached) PaneSession. Caller
  // is responsible for placing the leafEl in the DOM, calling attach(),
  // registering the leaf so output can be routed, and finally calling
  // pty.ready(ptyId) to flush any buffered initial output.
  private async spawnSession(
    opts: PaneSessionOpts | null,
    ptyIdReturn: { id: string },
  ): Promise<PaneSession | null> {
    const pty = window.pty;
    if (!pty) return null;
    const session = new PaneSession(
      opts ?? {
        ptyId: ptyIdReturn.id,
        onCwd: () => {},
        onTitle: () => {},
        onFocus: () => {},
        onKey: () => true,
      },
    );
    session.term.onData((data) => pty.write(ptyIdReturn.id, data));
    return session;
  }

  async createTab(cwdOverride?: string): Promise<Tab | null> {
    const pty = window.pty;
    if (!pty) return null;
    const cwd = cwdOverride ?? this.active?.cwdAbsolute() ?? undefined;
    const ptyId = await pty.spawn(cwd);
    if (!ptyId) return null;

    const ref = { id: ptyId };
    const session = await this.spawnSession(null, ref);
    if (!session) return null;

    const tab = new Tab(
      session,
      {
        onClose: (t) => this.closeTab(t),
        onActivateRequest: (t) => this.activate(t),
        onLeafEmpty: (t) => this.closeTab(t),
        onLeafClosed: (_t, leaf) => this.unregisterLeaf(leaf),
        onTitleChange: (t) => {
          if (t === this.active) document.title = t.displayName();
        },
      },
      (e, s) => this.handleKey(e, s),
    );

    // Tab constructor placed the leafEl into rootEl (which is in wrapper),
    // so xterm.open() now sees a connected element.
    session.attach();
    rewireSessionOpts(session, tab.buildSessionOpts(ptyId));

    this.tabs.set(ptyId, tab);
    this.order.push(ptyId);
    this.registerLeaf(tab, tab.active);
    pty.ready(ptyId);
    this.activate(tab);
    return tab;
  }

  async splitActive(
    dir: SplitAxis,
    placement: SplitPlacement = "after",
  ): Promise<void> {
    const tab = this.active;
    if (!tab) return;
    const pty = window.pty;
    if (!pty) return;
    const cwd = tab.cwdAbsolute() ?? undefined;
    const ptyId = await pty.spawn(cwd);
    if (!ptyId) return;

    const ref = { id: ptyId };
    const session = await this.spawnSession(tab.buildSessionOpts(ptyId), ref);
    if (!session) return;

    // splitActive places leafEl into the DOM and calls session.attach()
    // before activate(), so the leaf is fully wired before pty.ready
    // releases buffered output.
    const leaf = tab.splitActive(dir, session, placement);
    this.registerLeaf(tab, leaf);
    pty.ready(ptyId);
  }

  activate(tab: Tab): void {
    const id = this.tabIdOf(tab);
    if (!id) return;
    if (this.activeId === id) {
      tab.focusActive();
      return;
    }
    const prev = this.active;
    prev?.deactivate();
    this.activeId = id;
    tab.activate();
    document.title = tab.displayName();
  }

  closeTab(tab: Tab): void {
    const id = this.tabIdOf(tab);
    if (!id) return;
    const wasActive = this.activeId === id;
    // Kill all PTYs in this tab.
    for (const leaf of paneLeaves(tab.root)) {
      window.pty?.kill(leaf.session.ptyId);
    }
    this.unregisterTab(tab);
    tab.dispose();
    this.tabs.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);

    if (this.order.length === 0) {
      window.close();
      return;
    }
    if (wasActive) {
      const next = this.order[Math.min(idx, this.order.length - 1)];
      const nextTab = this.tabs.get(next);
      if (nextTab) {
        this.activeId = null;
        this.activate(nextTab);
      }
    }
  }

  cycleNext(): void {
    if (this.order.length < 2 || !this.activeId) return;
    const idx = this.order.indexOf(this.activeId);
    const next = this.tabs.get(this.order[(idx + 1) % this.order.length]);
    if (next) this.activate(next);
  }

  cyclePrev(): void {
    if (this.order.length < 2 || !this.activeId) return;
    const idx = this.order.indexOf(this.activeId);
    const next = this.tabs.get(
      this.order[(idx - 1 + this.order.length) % this.order.length],
    );
    if (next) this.activate(next);
  }

  activateByIndex(n: number): void {
    const id = this.order[n];
    const t = id ? this.tabs.get(id) : null;
    if (t) this.activate(t);
  }

  private tabIdOf(tab: Tab): string | null {
    for (const [id, t] of this.tabs) if (t === tab) return id;
    return null;
  }

  applyAppearance(prefs: AppearancePrefs): void {
    for (const tab of this.tabs.values()) {
      for (const leaf of paneLeaves(tab.root)) {
        leaf.session.applyAppearance(prefs);
      }
    }
  }

  // Returns false to swallow the event from xterm.
  private handleKey(e: KeyboardEvent, _s: PaneSession): boolean {
    if (e.type !== "keydown") return true;
    // Mac uses Cmd; win/linux use Ctrl. On non-mac we additionally require
    // Shift for D/T/W because raw Ctrl+D (EOF) and Ctrl+W (delete-word)
    // are reserved by readline-driven shells.
    const isMac = window.pty?.platform === "darwin";
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return true;
    if (!isMac && e.metaKey) return true;

    if (this.handleClipboardShortcut(e)) return false;

    // Cmd+Opt+Arrow / Ctrl+Alt+Arrow — pane navigation
    if (e.altKey && !e.shiftKey) {
      const dir =
        e.code === "ArrowLeft"
          ? "left"
          : e.code === "ArrowRight"
            ? "right"
            : e.code === "ArrowUp"
              ? "up"
              : e.code === "ArrowDown"
                ? "down"
                : null;
      if (dir) {
        e.preventDefault();
        this.active?.navigate(dir);
        return false;
      }
    }

    // Split:
    //   mac:    Cmd+D = split right, Cmd+Shift+D = split down
    //   win/lin: Ctrl+Shift+D = split right, Ctrl+Shift+E = split down
    //   (Ctrl+D would steal EOF, so the unshifted form is unavailable.)
    if (isMac) {
      if (e.code === "KeyD" && !e.altKey) {
        e.preventDefault();
        void this.splitActive(e.shiftKey ? "col" : "row");
        return false;
      }
    } else if (e.shiftKey && !e.altKey) {
      if (e.code === "KeyD") {
        e.preventDefault();
        void this.splitActive("row");
        return false;
      }
      if (e.code === "KeyE") {
        e.preventDefault();
        void this.splitActive("col");
        return false;
      }
    }

    // New tab: Cmd+T (mac) / Ctrl+Shift+T (win/lin)
    if (e.code === "KeyT" && !e.altKey && (isMac ? !e.shiftKey : e.shiftKey)) {
      e.preventDefault();
      void this.createTab();
      return false;
    }
    // Close pane: Cmd+W (mac) / Ctrl+Shift+W (win/lin)
    if (e.code === "KeyW" && !e.altKey && (isMac ? !e.shiftKey : e.shiftKey)) {
      e.preventDefault();
      this.closeActivePane();
      return false;
    }
    // Cmd+Shift+] / Cmd+Shift+[ — cycle tabs (Shift required on all platforms)
    if (e.shiftKey && e.code === "BracketRight") {
      e.preventDefault();
      this.cycleNext();
      return false;
    }
    if (e.shiftKey && e.code === "BracketLeft") {
      e.preventDefault();
      this.cyclePrev();
      return false;
    }
    // Cmd+1..9 / Ctrl+1..9 — tab by index
    if (!e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      this.activateByIndex(parseInt(e.code.slice(5), 10) - 1);
      return false;
    }
    return true;
  }

  private handleClipboardShortcut(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return false;
    const isMac = window.pty?.platform === "darwin";
    if (e.altKey) return false;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || (!isMac && e.metaKey)) return false;
    if (isMac ? e.shiftKey : !e.shiftKey) return false;

    if (e.code === "KeyC") {
      if (!currentSelectionText()) {
        e.preventDefault();
        return true;
      }
      e.preventDefault();
      void this.copySelection();
      return true;
    }
    if (e.code === "KeyV") {
      e.preventDefault();
      void this.pasteToActive();
      return true;
    }
    return false;
  }

  closeActivePane(): void {
    const t = this.active;
    if (!t) return;
    if (t.active.parent === null) {
      this.closeTab(t);
      return;
    }
    window.pty?.kill(t.active.session.ptyId);
    t.closeLeaf(t.active);
  }

  // Inject text into the active pane as if typed. Used by file-drop to
  // paste shell-escaped paths into the prompt.
  writeToActive(data: string): void {
    const t = this.active;
    if (!t) return;
    window.pty?.write(t.active.session.ptyId, data);
    t.focusActive();
  }

  async copySelection(): Promise<boolean> {
    const text = currentSelectionText();
    if (!text) return false;
    await window.pty?.writeClipboardText(text);
    this.active?.focusActive();
    return true;
  }

  async pasteToActive(): Promise<void> {
    const text = await window.pty?.readClipboardText();
    if (!text) return;
    const t = this.active;
    if (!t) return;
    t.active.session.term.paste(text);
    t.focusActive();
  }
}

// PaneSession holds its opts as a private readonly field, but the first
// session of a tab is constructed before the Tab exists, so we need to
// swap in the real callbacks afterwards. Done via a narrow cast.
function rewireSessionOpts(session: PaneSession, opts: PaneSessionOpts): void {
  (session as unknown as { opts: PaneSessionOpts }).opts = opts;
}

// ---- Boot ------------------------------------------------------------
// body.mac gates the 80px traffic-light reservation in CSS; body.fullscreen
// drops it again when macOS hides the lights in native fullscreen.
if (window.pty?.platform === "darwin") {
  document.body.classList.add("mac");
}
window.pty?.onFullscreen((on) => {
  document.body.classList.toggle("fullscreen", on);
});

const tabs = new TabManager();
const settingsPanel = initSettingsPanel({
  initial: appearance,
  platform: window.pty?.platform,
  focusFallback: newTabBtn,
  onChange: (prefs) => {
    appearance = normalizeAppearance(prefs);
    saveAppearance(appearance);
    tabs.applyAppearance(appearance);
  },
});

if (!window.pty) {
  const fallback = document.createElement("div");
  fallback.style.cssText =
    "color:#ff6e6e;padding:20px;font-family:Menlo,monospace";
  fallback.textContent = "[preload bridge missing]";
  wrapper.appendChild(fallback);
} else {
  // Subsequent dock drops while the app is running.
  window.pty.onOpenCwd((cwd) => {
    void tabs.createTab(cwd);
  });
  // Cold-launch dock drop: main queued the path before the renderer was
  // ready; consume it here so the first tab opens in that folder instead
  // of $HOME.
  void (async () => {
    const initial = await window.pty!.initialCwd();
    void tabs.createTab(initial ?? undefined);
  })();
}

newTabBtn.addEventListener("click", () => {
  void tabs.createTab();
});

// Drag-and-drop file/folder onto the terminal area pastes its absolute
// path into the active pane (Terminal.app / iTerm2 behavior). Same code
// path makes images droppable into CLIs that accept file paths
// (e.g. Claude Code with @/path/to/image.png).
//
// Electron 30: File.path is still attached. From Electron 32 it's
// removed in favor of webUtils.getPathForFile() — switch when we bump.
function shellEscapePath(p: string): string {
  // Strip newlines (shell would treat them as Enter).
  const stripped = p.replace(/\r?\n/g, "");
  // On Windows the path separator is "\", which the unix backslash-escape
  // would mangle (C:\Users → C:\\Users). cmd and PowerShell both accept
  // double-quoted paths verbatim, and "\"" isn't a legal NTFS filename
  // character, so plain quote-wrapping is safe. Wrap only when needed so
  // bare paths (no spaces / metacharacters) round-trip cleanly.
  if (window.pty?.platform === "win32") {
    return /[\s"&|<>^`(){}\[\];,]/.test(stripped) ? `"${stripped}"` : stripped;
  }
  // mac/linux: backslash-escape unsafe chars — matches Terminal.app, which
  // produces /Users/foo/My\ Folder rather than quoting.
  return stripped.replace(/[^A-Za-z0-9_\-./]/g, "\\$&");
}

function isFileDrag(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes("Files") ?? false;
}

// Suppress the renderer's default behavior of navigating to the dropped
// file (which would replace the page with file://...).
window.addEventListener("dragover", (e) => {
  if (isFileDrag(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (isFileDrag(e)) e.preventDefault();
});

wrapper.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
wrapper.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  const paths: string[] = [];
  for (const f of Array.from(files)) {
    const p = (f as File & { path?: string }).path;
    if (p) paths.push(shellEscapePath(p));
  }
  if (paths.length === 0) return;
  // Leading space so `cd<drop>` becomes `cd /path` even if the user
  // forgot the space. Trailing not added — keeps cursor flush so the
  // user can type a slash, append more args, or hit Enter immediately.
  tabs.writeToActive(" " + paths.join(" "));
});

window.pty?.onMenu((action) => {
  switch (action) {
    case "new-tab":
      void tabs.createTab();
      break;
    case "split-row":
    case "split-right":
      void tabs.splitActive("row");
      break;
    case "split-col":
    case "split-down":
      void tabs.splitActive("col");
      break;
    case "split-left":
      void tabs.splitActive("row", "before");
      break;
    case "split-up":
      void tabs.splitActive("col", "before");
      break;
    case "close-pane":
      tabs.closeActivePane();
      break;
    case "copy":
      void tabs.copySelection();
      break;
    case "paste":
      void tabs.pasteToActive();
      break;
    case "open-settings":
      settingsPanel.open();
      break;
  }
});

window.pty?.onContextAction((action) => {
  switch (action) {
    case "copy":
      void tabs.copySelection();
      break;
    case "paste":
      void tabs.pasteToActive();
      break;
    case "split-left":
      void tabs.splitActive("row", "before");
      break;
    case "split-right":
      void tabs.splitActive("row", "after");
      break;
    case "split-bottom":
      void tabs.splitActive("col", "after");
      break;
    case "split-up":
      void tabs.splitActive("col", "before");
      break;
  }
});
