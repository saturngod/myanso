import { Terminal, IUnicodeVersionProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  ansi256Palette,
  applyThemeVariables,
  buildTerminalFontFamily,
  clampFontSize,
  DEFAULT_APPEARANCE,
  loadAppearance,
  normalizeAppearance,
  saveAppearance,
  themeById,
  VIEW_MODE_LINE_HEIGHT,
  xtermTheme,
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
const MODE_ANSI16 = 16777216;
const MODE_256 = 33554432;
const MODE_RGB = 50331648;

// RGB color values are absolute (theme-independent), so this cache never
// needs invalidating. ANSI/256 already resolve via an array lookup. The
// hot render loop calls this twice per styled cell (fg + bg); for
// truecolor-heavy output (vim, syntax highlighting) the cache turns a
// per-cell string allocation into a Map hit.
const rgbColorCache = new Map<number, string>();
function cssColor(color: number, mode: number): string | null {
  if (mode === 0) return null;
  if (mode === MODE_ANSI16 || mode === MODE_256) {
    return activeAnsiColors[color] ?? null;
  }
  if (mode === MODE_RGB) {
    let s = rgbColorCache.get(color);
    if (s === undefined) {
      const r = (color >> 16) & 255;
      const g = (color >> 8) & 255;
      const b = color & 255;
      s = `rgb(${r},${g},${b})`;
      rgbColorCache.set(color, s);
    }
    return s;
  }
  return null;
}

// Cached because dim runs re-derive the same faded color every cell. When
// fg is null the result depends on the active theme foreground, so this is
// cleared on theme change (see applyGlobalTheme). The empty-string key is
// the null-fg sentinel (a real fg is never "").
const dimColorCache = new Map<string, string>();
function dimColor(fg: string | null): string {
  const key = fg ?? "";
  const cached = dimColorCache.get(key);
  if (cached !== undefined) return cached;
  const result = computeDimColor(fg);
  dimColorCache.set(key, result);
  return result;
}

function computeDimColor(fg: string | null): string {
  const base = fg ?? activeTheme.foreground;
  const hex = base.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full =
      raw.length === 3
        ? raw
            .split("")
            .map((ch) => ch + ch)
            .join("")
        : raw;
    const value = Number.parseInt(full, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r},${g},${b},0.5)`;
  }

  const rgb = base.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i,
  );
  if (rgb) {
    return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},0.5)`;
  }

  return `color-mix(in srgb, ${base} 50%, transparent)`;
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

type DrawableCell = {
  className: string;
  style: string[];
};

function drawableCell(ch: string): DrawableCell | null {
  switch (ch) {
    case "\u2502": // light vertical
    case "\u2506": // light triple dash vertical
    case "\u250a": // light quadruple dash vertical
    case "\u254e": // light double dash vertical
      return { className: "term-rule-v", style: ["--draw-w:1px"] };
    case "\u2503": // heavy vertical
    case "\u2507": // heavy triple dash vertical
    case "\u250b": // heavy quadruple dash vertical
    case "\u254f": // heavy double dash vertical
      return { className: "term-rule-v", style: ["--draw-w:2px"] };
    case "\u2551": // double vertical
      return { className: "term-rule-v-double", style: [] };
    case "\u2588": // full block
      return { className: "term-block-left", style: ["--draw-w:100%"] };
    case "\u2589": // left seven eighths block
      return { className: "term-block-left", style: ["--draw-w:87.5%"] };
    case "\u258a": // left three quarters block
      return { className: "term-block-left", style: ["--draw-w:75%"] };
    case "\u258b": // left five eighths block
      return { className: "term-block-left", style: ["--draw-w:62.5%"] };
    case "\u258c": // left half block
      return { className: "term-block-left", style: ["--draw-w:50%"] };
    case "\u258d": // left three eighths block
      return { className: "term-block-left", style: ["--draw-w:37.5%"] };
    case "\u258e": // left one quarter block
      return { className: "term-block-left", style: ["--draw-w:25%"] };
    case "\u258f": // left one eighth block
      return { className: "term-block-left", style: ["--draw-w:12.5%"] };
    case "\u2590": // right half block
      return { className: "term-block-right", style: ["--draw-w:50%"] };
    default:
      return null;
  }
}

function hasDrawableCell(text: string): boolean {
  for (const ch of text) {
    if (drawableCell(ch)) return true;
  }
  return false;
}

function stylePartsForRun(
  fg: string | null,
  bg: string | null,
  bold: boolean,
  italic: boolean,
  dim: boolean,
): string[] {
  const parts: string[] = [];
  if (dim) parts.push(`color:${dimColor(fg)}`);
  else if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (bold) parts.push("font-weight:bold");
  if (italic) parts.push("font-style:italic");
  return parts;
}

// The opening `<span ... style="...">` for a run depends only on the style
// flags, not the text, so cache it keyed by those flags. Runs repeat the
// same handful of style combos across a frame, so this avoids rebuilding
// (and re-joining) the style string per run. Empty string means "no styling
// — emit plain text". Cleared on theme change since dim runs embed a
// theme-derived color (see applyGlobalTheme).
const styledOpenTagCache = new Map<string, string>();
function styledOpenTag(
  fg: string | null,
  bg: string | null,
  bold: boolean,
  italic: boolean,
  dim: boolean,
): string {
  const key = `${fg ?? ""}|${bg ?? ""}|${bold ? 1 : 0}${italic ? 1 : 0}${dim ? 1 : 0}`;
  let tag = styledOpenTagCache.get(key);
  if (tag === undefined) {
    const parts = stylePartsForRun(fg, bg, bold, italic, dim);
    if (parts.length === 0) {
      tag = "";
    } else {
      const classAttr = bg ? ' class="bg-run"' : "";
      tag = `<span${classAttr} style="${parts.join(";")}">`;
    }
    styledOpenTagCache.set(key, tag);
  }
  return tag;
}

function wrapStyledText(
  text: string,
  fg: string | null,
  bg: string | null,
  bold: boolean,
  italic: boolean,
  dim: boolean,
): string {
  if (!text) return "";
  const tag = styledOpenTag(fg, bg, bold, italic, dim);
  if (tag === "") return escapeHtml(text);
  return `${tag}${escapeHtml(text)}</span>`;
}

function wrapDrawableCell(
  ch: string,
  cell: DrawableCell,
  fg: string | null,
  bg: string | null,
  dim: boolean,
): string {
  const drawColor = dim ? dimColor(fg) : (fg ?? activeTheme.foreground);
  const parts = [`--draw-color:${drawColor}`, ...cell.style];
  if (bg) parts.push(`background:${bg}`);
  return `<span class="term-draw ${cell.className}" style="${parts.join(";")}">${escapeHtml(ch)}</span>`;
}

function wrapRun(
  text: string,
  fg: string | null,
  bg: string | null,
  bold: boolean,
  italic: boolean,
  dim: boolean,
): string {
  if (!text) return "";
  let html = "";
  let plain = "";
  const flushPlain = () => {
    if (!plain) return;
    html += wrapStyledText(plain, fg, bg, bold, italic, dim);
    plain = "";
  };

  for (const ch of text) {
    const cell = drawableCell(ch);
    if (!cell) {
      plain += ch;
      continue;
    }
    flushPlain();
    html += wrapDrawableCell(ch, cell, fg, bg, dim);
  }

  flushPlain();
  return html;
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
      v11.wcwidth = (cp) => (isMyanmarMc(cp) ? 0 : origWc(cp));
    }
  } catch (e) {
    console.warn("[myanso] unicode11 failed", e);
  }
}

let appearance = loadAppearance();
let activeTheme = themeById(appearance.theme);
let activeAnsiColors = ansi256Palette(activeTheme);
applyThemeVariables(activeTheme);

function applyGlobalTheme(themeId: string): void {
  activeTheme = themeById(themeId);
  activeAnsiColors = ansi256Palette(activeTheme);
  // Both caches can embed a theme-derived color (dim runs fall back to the
  // theme foreground), so they're stale once the theme changes.
  dimColorCache.clear();
  styledOpenTagCache.clear();
  applyThemeVariables(activeTheme);
}

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

type RowRender =
  | { kind: "html"; value: string }
  | { kind: "text"; value: string };

const BLANK_ROW: RowRender = { kind: "text", value: " " };
type MouseEncoding = "default" | "sgr" | "sgr-pixels";

function currentSelectionText(): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  return sel.toString().replace(/\u00a0/g, " ");
}

// The whitespace-delimited token under a screen point \u2014 used for Cmd/Ctrl+
// click "open file" (iTerm-style). We can't trust caretRangeFromPoint here:
// the hidden xterm terminal overlaps .output at a higher z-index, so the
// caret can land on the wrong layer. Instead find the .output row via
// elementsFromPoint (which skips the pointer-events:none xterm layer), then
// locate the character by its real rendered rect \u2014 also correct for the
// fractional advances of Myanmar glyphs.
interface LinkHit {
  token: string; // full whitespace-delimited token, sent to the backend
  start: number; // global char offset of the token within its row
  row: HTMLElement; // the .line element, for rebuilding a trimmed Range later
}
function linkAtPoint(
  outputDiv: HTMLElement,
  x: number,
  y: number,
): LinkHit | null {
  let row: HTMLElement | null = null;
  for (const el of document.elementsFromPoint(x, y)) {
    if (
      el instanceof HTMLElement &&
      el.classList.contains("line") &&
      outputDiv.contains(el)
    ) {
      row = el;
      break;
    }
  }
  if (!row) return null;

  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let full = "";
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    nodes.push(t as Text);
    full += (t as Text).data;
  }
  if (!full) return null;

  // Find the global char index whose rendered rect contains the point.
  const probe = document.createRange();
  let hit = -1;
  let base = 0;
  for (const node of nodes) {
    const len = node.data.length;
    for (let i = 0; i < len && hit < 0; i++) {
      probe.setStart(node, i);
      probe.setEnd(node, i + 1);
      for (const rc of probe.getClientRects()) {
        if (x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom) {
          hit = base + i;
          break;
        }
      }
    }
    if (hit >= 0) break;
    base += len;
  }
  if (hit < 0) return null;

  const isSep = (c: string) => !c || /\s/.test(c);
  let start = hit;
  let end = hit + 1;
  while (start > 0 && !isSep(full[start - 1])) start--;
  while (end < full.length && !isSep(full[end])) end++;
  const token = full.slice(start, end);
  if (!token) return null;
  return { token, start, row };
}

// Build a Range over the [start, end) global char offsets of a row's text.
function rangeInRow(
  row: HTMLElement,
  start: number,
  end: number,
): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let startSet = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const len = node.data.length;
    if (!startSet && start < pos + len) {
      range.setStart(node, start - pos);
      startSet = true;
    }
    if (startSet && end <= pos + len) {
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

// ---- Find-in-terminal -------------------------------------------------
const SEARCH_HIGHLIGHT = "search-current";
const LINK_HIGHLIGHT = "link-hover";

// One occurrence of the query: which buffer line, and the 0-based index of
// the occurrence within that line's text (so two hits on one line stay
// distinct without tracking columns, which would be ambiguous for Myanmar).
interface SearchMatch {
  line: number;
  occ: number;
}

// The CSS Custom Highlight API isn't in every lib.dom version; access it
// through a narrow typed shim and feature-detect at the call site.
interface HighlightRegistry {
  set(name: string, highlight: object): void;
  delete(name: string): void;
}
type HighlightCtor = new (...ranges: Range[]) => object;
function highlightRegistry(): HighlightRegistry | null {
  const reg = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  return reg ?? null;
}
function highlightCtor(): HighlightCtor | null {
  return (
    (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight ?? null
  );
}

// Build a DOM Range over the occ-th case-insensitive occurrence of `query`
// in `root`'s text, walking text nodes so it works whether the row is a
// single text node (plain fast path) or a tree of styled spans.
function rangeForNthMatch(
  root: HTMLElement,
  query: string,
  occ: number,
): Range | null {
  const needle = query.toLowerCase();
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let full = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    nodes.push(t);
    full += t.data;
  }
  const hay = full.toLowerCase();
  let from = 0;
  let found = -1;
  for (let k = 0; k <= occ; k++) {
    found = hay.indexOf(needle, from);
    if (found < 0) return null;
    from = found + needle.length;
  }
  const start = found;
  const end = found + needle.length;
  const range = document.createRange();
  let pos = 0;
  let startSet = false;
  for (const node of nodes) {
    const len = node.data.length;
    if (!startSet && start < pos + len) {
      range.setStart(node, start - pos);
      startSet = true;
    }
    if (startSet && end <= pos + len) {
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

class PaneSession {
  readonly ptyId: string;
  readonly leafEl: HTMLDivElement;
  readonly hiddenDiv: HTMLDivElement;
  readonly outputDiv: HTMLDivElement;
  readonly term: Terminal;
  readonly fit: FitAddon;
  // Loaded lazily in attach(); lets a tab snapshot its screen + scrollback
  // for replay when dragged into another window.
  private serializeAddon: SerializeAddon | null = null;

  cwd = "~";
  title = "";

  private rowDivs: HTMLDivElement[] = [];
  private lastRowRender: RowRender[] = [];
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
  private wheelAccum = 0;
  private measureEl: HTMLSpanElement | null = null;
  private ro: ResizeObserver | null = null;
  private disposers: Array<() => void> = [];
  private active = false;
  private usingAltScreen = false;
  private mouseEncoding: MouseEncoding = "default";
  private linkHoverToken: string | null = null;
  private linkHoverRange: Range | null = null;
  private linkPendingToken: string | null = null;
  private linkHoverScheduled = false;
  private linkResolveTimer: number | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;

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
    this.outputDiv.addEventListener("click", (e) => {
      // Cmd+Click (mac) / Ctrl+Click (win/lin) on a file path opens it in the
      // default app, iTerm-style. The token is resolved against this pane's
      // cwd in the main process, which also verifies it exists.
      const isMac = window.pty?.platform === "darwin";
      const openMod = isMac ? e.metaKey : e.ctrlKey;
      if (openMod && e.button === 0) {
        const hit = linkAtPoint(this.outputDiv, e.clientX, e.clientY);
        if (hit) {
          e.preventDefault();
          void window.pty?.openPath(this.cwdAbsolute(), hit.token);
          return;
        }
      }
      if (!currentSelectionText()) this.focus();
    });
    // Cmd/Ctrl-hover affordance: underline the path under the pointer and show
    // a pointer cursor, so it reads as clickable (iTerm-style).
    this.outputDiv.addEventListener("mousemove", (e) => {
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      const isMac = window.pty?.platform === "darwin";
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) {
        this.clearLinkHover();
        return;
      }
      this.scheduleLinkHover();
    });
    this.outputDiv.addEventListener("mouseleave", () => this.clearLinkHover());
    this.outputDiv.addEventListener("contextmenu", (e) => {
      this.opts.onFocus(this);
      e.preventDefault();
      void window.pty?.showContextMenu({ canCopy: !!currentSelectionText() });
    });
    // The .output mirror only paints the current viewport, and xterm's real
    // scrollback lives in the hidden brain (pointer-events:none), so the
    // wheel never reaches it. Drive scrolling ourselves: mouse-aware TUIs get
    // xterm wheel reports; otherwise normal buffer scrolls xterm scrollback,
    // and alt-screen apps receive cursor keys as a compatibility fallback.
    this.outputDiv.addEventListener(
      "wheel",
      (e) => this.onWheel(e),
      { passive: false },
    );

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
      theme: xtermTheme(activeTheme),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    // Ubuntu bash/readline uses the host wcwidth table while editing the
    // prompt. There Myanmar spacing marks are one cell, so collapsing them
    // in xterm makes cursor-left redisplay paint into the prompt. On
    // other platforms, keep normal and alternate buffers in the same
    // Myanmar-aware cell model so vim renders through the HTML mirror too.
    applyMyanmarWidth(this.term, {
      collapseSpacingMarks: window.pty?.platform !== "linux",
    });

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
      if (this.usingAltScreen === enabled) return;
      this.usingAltScreen = enabled;
      this.leafEl.classList.toggle("alt-screen", enabled);
      this.scheduleRender(undefined, undefined, true);
    };
    const altOn = this.term.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        if (params.some((p) => p === 47 || p === 1047 || p === 1049)) {
          onAltScreen(true);
        }
        if (params.some((p) => p === 1006)) this.mouseEncoding = "sgr";
        if (params.some((p) => p === 1016)) this.mouseEncoding = "sgr-pixels";
        return false;
      },
    );
    const altOff = this.term.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        if (params.some((p) => p === 47 || p === 1047 || p === 1049)) {
          onAltScreen(false);
        }
        if (params.some((p) => p === 1006 || p === 1016)) {
          this.mouseEncoding = "default";
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

    // The hidden term renders only to drive parsing, cursor tracking, and
    // FitAddon's cell measurement — nobody sees it (.hidden-terminal is
    // opacity:0). The default DOM renderer would build a full span tree per
    // row, duplicating the .output mirror we paint ourselves. WebGL collapses
    // that to a single GPU canvas, so the brain costs one texture instead of
    // a second DOM render every frame. On context loss xterm auto-falls back
    // to the DOM renderer; dispose the addon so it doesn't keep retrying.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
      this.disposers.push(() => {
        try {
          webgl.dispose();
        } catch {
          /* */
        }
      });
    } catch (e) {
      console.warn("[myanso] webgl renderer unavailable, using DOM", e);
    }

    // Serialize addon: snapshots the buffer (screen + scrollback) as a string
    // of escape sequences so a dragged-out tab can repaint in its new window.
    try {
      this.serializeAddon = new SerializeAddon();
      this.term.loadAddon(this.serializeAddon);
    } catch {
      this.serializeAddon = null;
    }

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
    // Show/hide the link affordance when the modifier is pressed/released
    // without the mouse moving (e.g. holding Cmd while already hovering).
    const onModKey = (e: KeyboardEvent) => {
      if (e.key !== "Meta" && e.key !== "Control") return;
      const isMac = window.pty?.platform === "darwin";
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) {
        this.clearLinkHover();
        return;
      }
      if (!this.active) return;
      const r = this.outputDiv.getBoundingClientRect();
      const x = this.lastPointerX;
      const y = this.lastPointerY;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        this.scheduleLinkHover();
      }
    };
    document.addEventListener("keydown", onModKey);
    document.addEventListener("keyup", onModKey);
    this.disposers.push(
      () => this.term.textarea?.removeEventListener("focus", onFocus),
      () => this.term.textarea?.removeEventListener("blur", onBlur),
      () => document.removeEventListener("visibilitychange", onVisible),
      () => document.removeEventListener("keydown", onModKey),
      () => document.removeEventListener("keyup", onModKey),
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

  // xterm rounds its cell width to whole device pixels for the FitAddon, but
  // the .output mirror lays glyphs out at their true fractional advance via
  // white-space:pre. On displays where the rounded width is narrower than the
  // real advance, cols*advance overflows the pane and the last column(s) clip
  // (visible in full-width TUIs like opencode). Measure the real advance from
  // the mirror's own font so cols never exceeds what actually fits.
  private measuredCellWidth(): number {
    if (!this.measureEl) {
      const el = document.createElement("span");
      el.style.cssText =
        "position:absolute;visibility:hidden;white-space:pre;top:0;left:-9999px;";
      el.textContent = "M".repeat(100);
      this.outputDiv.appendChild(el);
      this.measureEl = el;
    }
    const w = this.measureEl.getBoundingClientRect().width;
    return w > 0 ? w / 100 : 0;
  }

  private fitAndResize(): void {
    if (!this.active) return;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    // Re-derive cols from the real rendered advance so the .output never
    // overflows. Keep the FitAddon's rows; only the column count is at risk.
    // getBoundingClientRect is the border box (full leaf width); subtract the
    // .output horizontal padding so cols reflect the real content area.
    const cs = getComputedStyle(this.outputDiv);
    const padX =
      parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
    const availW = this.outputDiv.getBoundingClientRect().width - padX;
    const cellW = this.measuredCellWidth();
    if (availW > 0 && cellW > 0) {
      const realCols = Math.max(1, Math.floor(availW / cellW));
      if (realCols !== this.term.cols) {
        try {
          this.term.resize(realCols, this.term.rows);
        } catch {
          /* */
        }
      }
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
    this.clearLinkHover();
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
    this.measureEl = null;
    this.leafEl.remove();
  }

  focus(): void {
    this.term.focus();
  }

  // ---- Find-in-terminal ----------------------------------------------
  // Scan the whole buffer (scrollback included) for case-insensitive hits.
  searchScrollback(query: string): SearchMatch[] {
    const out: SearchMatch[] = [];
    if (!query) return out;
    const needle = query.toLowerCase();
    const buffer = this.term.buffer.active;
    const total = buffer.length;
    for (let i = 0; i < total; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true).toLowerCase();
      if (!text) continue;
      let from = 0;
      let occ = 0;
      for (;;) {
        const idx = text.indexOf(needle, from);
        if (idx < 0) break;
        out.push({ line: i, occ });
        occ++;
        from = idx + needle.length;
      }
    }
    return out;
  }

  // Scroll the match into view, repaint, then highlight it once the new rows
  // have been painted into the .output mirror.
  revealMatch(match: SearchMatch, query: string): void {
    const rows = this.term.rows;
    const top = this.term.buffer.active.viewportY;
    if (match.line < top || match.line >= top + rows) {
      this.term.scrollToLine(Math.max(0, match.line - Math.floor(rows / 2)));
    }
    this.scheduleRender(undefined, undefined, true);
    requestAnimationFrame(() => this.applySearchHighlight(match, query));
  }

  private applySearchHighlight(
    match: SearchMatch,
    query: string,
    retries = 3,
  ): void {
    this.clearSearchHighlight();
    const startRow = this.term.buffer.active.viewportY;
    const rowIndex = match.line - startRow;
    if (rowIndex < 0 || rowIndex >= this.rowDivs.length) {
      // The repaint may not have landed yet; give it a couple of frames.
      if (retries > 0) {
        requestAnimationFrame(() =>
          this.applySearchHighlight(match, query, retries - 1),
        );
      }
      return;
    }
    const range = rangeForNthMatch(this.rowDivs[rowIndex], query, match.occ);
    if (!range) return;
    const reg = highlightRegistry();
    const Ctor = highlightCtor();
    if (!reg || !Ctor) return;
    reg.set(SEARCH_HIGHLIGHT, new Ctor(range));
  }

  clearSearchHighlight(): void {
    highlightRegistry()?.delete(SEARCH_HIGHLIGHT);
  }

  // ---- Cmd/Ctrl-hover link affordance --------------------------------
  private scheduleLinkHover(): void {
    if (this.linkHoverScheduled) return;
    this.linkHoverScheduled = true;
    requestAnimationFrame(() => {
      this.linkHoverScheduled = false;
      this.updateLinkHover();
    });
  }

  private updateLinkHover(): void {
    const x = this.lastPointerX;
    const y = this.lastPointerY;
    // Cheap exit: still hovering the already-underlined token.
    if (this.linkHoverRange) {
      const r = this.linkHoverRange.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
    }
    const hit = linkAtPoint(this.outputDiv, x, y);
    if (!hit) {
      this.clearLinkHover();
      return;
    }
    if (hit.token === this.linkHoverToken || hit.token === this.linkPendingToken)
      return;
    // Drop any current underline while we confirm the new token exists.
    this.clearLinkHover();
    this.linkPendingToken = hit.token;
    // Debounce the resolve: each resolvePath runs blocking existsSync probes in
    // the main process, so wait for the pointer to settle on a token instead of
    // firing one filesystem probe per token swept across.
    this.linkResolveTimer = window.setTimeout(() => {
      this.linkResolveTimer = null;
      if (this.linkPendingToken !== hit.token) return; // pointer moved on
      this.resolveLinkHover(hit);
    }, 50);
  }

  private resolveLinkHover(hit: LinkHit): void {
    void window.pty?.resolvePath(this.cwdAbsolute(), hit.token).then((matched) => {
      if (this.linkPendingToken !== hit.token) return; // pointer moved on
      this.linkPendingToken = null;
      if (!matched || !hit.row.isConnected) return; // row recycled mid-resolve
      // The backend strips wrapping punctuation / :line suffixes; underline
      // only the part that actually resolved, not the surrounding "( ),."
      const off = hit.token.indexOf(matched);
      const from = off >= 0 ? hit.start + off : hit.start;
      const to =
        off >= 0 ? from + matched.length : hit.start + hit.token.length;
      const range = rangeInRow(hit.row, from, to);
      if (range) this.setLinkHover(hit.token, range);
    });
  }

  private setLinkHover(token: string, range: Range): void {
    this.linkHoverToken = token;
    this.linkHoverRange = range;
    const reg = highlightRegistry();
    const Ctor = highlightCtor();
    if (reg && Ctor) reg.set(LINK_HIGHLIGHT, new Ctor(range));
    this.outputDiv.style.cursor = "pointer";
  }

  private clearLinkHover(): void {
    if (this.linkResolveTimer !== null) {
      clearTimeout(this.linkResolveTimer);
      this.linkResolveTimer = null;
    }
    this.linkPendingToken = null;
    if (!this.linkHoverToken && !this.linkHoverRange) return;
    this.linkHoverToken = null;
    this.linkHoverRange = null;
    highlightRegistry()?.delete(LINK_HIGHLIGHT);
    this.outputDiv.style.cursor = "";
  }

  // Convert a wheel notch into an integer number of cell-rows, carrying the
  // fractional remainder so trackpads (many small pixel deltas) accumulate
  // smoothly instead of being rounded to zero each event.
  private wheelLines(e: WheelEvent): number {
    const cell = this.lastCellH || 20;
    let px = e.deltaY;
    if (e.deltaMode === 1)
      px *= cell; // delta in lines
    else if (e.deltaMode === 2) px *= cell * this.term.rows; // delta in pages
    this.wheelAccum += px;
    const lines = Math.trunc(this.wheelAccum / cell);
    this.wheelAccum -= lines * cell;
    return lines;
  }

  private onWheel(e: WheelEvent): void {
    const lines = this.wheelLines(e);
    if (lines === 0) return;
    e.preventDefault();
    if (this.sendMouseWheel(e, lines)) return;
    if (this.usingAltScreen) {
      const seq = lines < 0 ? "\x1b[A" : "\x1b[B";
      window.pty?.write(this.ptyId, seq.repeat(Math.abs(lines)));
      return;
    }
    this.term.scrollLines(lines); // negative = up into scrollback
    this.scheduleRender();
  }

  private sendMouseWheel(e: WheelEvent, lines: number): boolean {
    const mode = this.term.modes.mouseTrackingMode;
    if (mode === "none" || mode === "x10") return false;

    const coords = this.mouseCoords(e);
    if (!coords) return false;

    const directionCode = lines < 0 ? 0 : 1;
    let code = 64 + directionCode;
    if (e.shiftKey) code += 4;
    if (e.altKey) code += 8;
    if (e.ctrlKey) code += 16;

    const count = Math.min(Math.abs(lines), 32);
    const seq =
      this.mouseEncoding === "sgr" || this.mouseEncoding === "sgr-pixels"
        ? this.sgrMouseWheel(code, coords)
        : this.defaultMouseWheel(code, coords);
    if (!seq) return false;

    window.pty?.write(this.ptyId, seq.repeat(count));
    return true;
  }

  private mouseCoords(e: WheelEvent): {
    col: number;
    row: number;
    x: number;
    y: number;
  } | null {
    const rect = this.outputDiv.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const cell = (
      this.term as unknown as {
        _core?: {
          _renderService?: {
            dimensions?: {
              css?: {
                cell?: { width?: number; height?: number };
              };
            };
          };
        };
      }
    )._core?._renderService?.dimensions?.css?.cell;
    const cellW =
      cell?.width && cell.width > 0 ? cell.width : rect.width / this.term.cols;
    const cellH =
      cell?.height && cell.height > 0
        ? cell.height
        : this.lastCellH || rect.height / this.term.rows;
    if (cellW <= 0 || cellH <= 0) return null;

    const localX = Math.max(0, Math.min(rect.width - 1, e.clientX - rect.left));
    const localY = Math.max(0, Math.min(rect.height - 1, e.clientY - rect.top));
    const col = Math.max(
      1,
      Math.min(this.term.cols, Math.floor(localX / cellW) + 1),
    );
    const row = Math.max(
      1,
      Math.min(this.term.rows, Math.floor(localY / cellH) + 1),
    );

    return {
      col,
      row,
      x: Math.max(1, Math.round(localX) + 1),
      y: Math.max(1, Math.round(localY) + 1),
    };
  }

  private sgrMouseWheel(
    code: number,
    coords: { col: number; row: number; x: number; y: number },
  ): string {
    const x = this.mouseEncoding === "sgr-pixels" ? coords.x : coords.col;
    const y = this.mouseEncoding === "sgr-pixels" ? coords.y : coords.row;
    return `\x1b[<${code};${x};${y}M`;
  }

  private defaultMouseWheel(
    code: number,
    coords: { col: number; row: number },
  ): string | null {
    const params = [code + 32, coords.col + 32, coords.row + 32];
    if (params.some((p) => p > 255)) return null;
    return `\x1b[M${String.fromCharCode(...params)}`;
  }

  writeToTerm(data: string): void {
    this.term.write(data);
  }

  applyAppearance(prefs: AppearancePrefs): void {
    const fontFamily = buildTerminalFontFamily(prefs.fontFamily);
    const theme = themeById(prefs.theme);
    this.leafEl.style.fontFamily = fontFamily;
    this.leafEl.style.fontSize = `${prefs.fontSize}px`;
    this.term.options.fontFamily = fontFamily;
    this.term.options.fontSize = prefs.fontSize;
    this.term.options.lineHeight = VIEW_MODE_LINE_HEIGHT[prefs.viewMode];
    this.term.options.theme = { ...xtermTheme(theme) };
    if (!this.active) return;
    requestAnimationFrame(() => {
      this.fitAndResize();
      this.scheduleRender(undefined, undefined, true);
    });
  }

  setDimStyle(on: boolean): void {
    this.leafEl.classList.toggle("dim", on);
  }

  // Absolute cwd (un-prettified) for spawning sibling shells.
  // Snapshot the current screen + scrollback for replay in another window.
  // Returns "" if the addon is unavailable (caller just gets a blank pane).
  serializeScreen(): string {
    try {
      return this.serializeAddon?.serialize() ?? "";
    } catch {
      return "";
    }
  }

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
      if (!this.active) return;
      this.renderBuffer();
    });
  }

  private cellColor(color: number, mode: number): string | null {
    return cssColor(color, mode);
  }

  private ensureRowCount(rows: number): void {
    while (this.rowDivs.length < rows) {
      const d = document.createElement("div");
      d.className = "line";
      d.textContent = " ";
      this.outputDiv.appendChild(d);
      this.rowDivs.push(d);
      this.lastRowRender.push(BLANK_ROW);
    }
    while (this.rowDivs.length > rows) {
      const d = this.rowDivs.pop()!;
      this.lastRowRender.pop();
      this.outputDiv.removeChild(d);
    }
  }

  private setRowRender(row: number, next: RowRender): void {
    const prev = this.lastRowRender[row];
    if (prev?.kind === next.kind && prev.value === next.value) return;
    const rowDiv = this.rowDivs[row];
    if (next.kind === "text") rowDiv.textContent = next.value;
    else rowDiv.innerHTML = next.value;
    this.lastRowRender[row] = next;
  }

  private rotateRowsForScroll(delta: number): { from: number; to: number } {
    const count = Math.abs(delta);
    if (delta > 0) {
      for (let i = 0; i < count; i++) {
        const rowDiv = this.rowDivs.shift()!;
        const rowRender = this.lastRowRender.shift()!;
        this.rowDivs.push(rowDiv);
        this.lastRowRender.push(rowRender);
        this.outputDiv.appendChild(rowDiv);
      }
      return { from: this.rowDivs.length - count, to: this.rowDivs.length - 1 };
    }

    for (let i = 0; i < count; i++) {
      const rowDiv = this.rowDivs.pop()!;
      const rowRender = this.lastRowRender.pop()!;
      this.rowDivs.unshift(rowDiv);
      this.lastRowRender.unshift(rowRender);
      this.outputDiv.insertBefore(rowDiv, this.outputDiv.firstChild);
    }
    return { from: 0, to: count - 1 };
  }

  private renderBuffer(): void {
    const buffer = this.term.buffer.active;
    const cols = this.term.cols;
    const rows = this.term.rows;
    const startRow = buffer.viewportY;
    const cursorY = buffer.cursorY + buffer.baseY;
    const cursorX = buffer.cursorX;
    const cursorRow = cursorY - startRow;
    // Respect DECTCEM (ESC[?25l). TUI apps like Claude hide the hardware
    // cursor while drawing their own UI; without this we'd paint a stray
    // cursor block on their prompt lines.
    const cursorHidden =
      (
        this.term as unknown as {
          _core?: { coreService?: { isCursorHidden?: boolean } };
        }
      )._core?.coreService?.isCursorHidden === true;
    const cell = buffer.getNullCell();
    const hasDirtyRange = this.renderStart != null && this.renderEnd != null;
    const sizeChanged = cols !== this.lastCols || rows !== this.lastRows;
    const viewportDelta = startRow - this.lastViewportY;
    const canRotateForScroll =
      !this.renderFull &&
      !sizeChanged &&
      this.lastViewportY >= 0 &&
      viewportDelta !== 0 &&
      Math.abs(viewportDelta) < rows;
    const full =
      this.renderFull ||
      sizeChanged ||
      (!hasDirtyRange && !canRotateForScroll) ||
      (startRow !== this.lastViewportY && !canRotateForScroll);

    this.ensureRowCount(rows);
    let from: number;
    let to: number;
    if (full) {
      from = 0;
      to = rows - 1;
    } else {
      if (canRotateForScroll) {
        const exposed = this.rotateRowsForScroll(viewportDelta);
        from = exposed.from;
        to = exposed.to;
      } else {
        from = rows;
        to = -1;
      }
      if (hasDirtyRange) {
        from = Math.min(from, this.renderStart!);
        to = Math.max(to, this.renderEnd!);
      }
      from = Math.max(0, Math.min(rows - 1, from));
      to = Math.max(0, Math.min(rows - 1, to));
      const previousCursorRow =
        canRotateForScroll && this.lastCursorRow != null
          ? this.lastCursorRow - viewportDelta
          : this.lastCursorRow;
      if (
        previousCursorRow != null &&
        previousCursorRow >= 0 &&
        previousCursorRow < rows
      ) {
        from = Math.min(from, previousCursorRow);
        to = Math.max(to, previousCursorRow);
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
        this.setRowRender(r, BLANK_ROW);
        continue;
      }
      const isCursorLine = absRow === cursorY;

      if (!isCursorLine) {
        let text = "";
        let textEnd = 0;
        let plain = true;
        for (let x = 0; x < cols; x++) {
          const c = line.getCell(x, cell);
          if (!c) continue;
          if (
            c.getFgColorMode() !== 0 ||
            c.getBgColorMode() !== 0 ||
            c.isBold() !== 0 ||
            c.isItalic() !== 0 ||
            c.isDim() !== 0 ||
            c.isInverse() !== 0
          ) {
            plain = false;
            break;
          }
          const chars =
            c.getWidth() === 0 ? c.getChars() : c.getChars() || " ";
          if (hasDrawableCell(chars)) {
            plain = false;
            break;
          }
          text += chars;
          if (chars && chars !== " ") textEnd = text.length;
        }
        if (plain) {
          this.setRowRender(r, {
            kind: "text",
            value: textEnd > 0 ? text.slice(0, textEnd) : " ",
          });
          continue;
        }
      }

      let html = "";
      let run = "";
      let curFg: string | null = null;
      let curBg: string | null = null;
      let curBold = false;
      let curItalic = false;
      let curDim = false;
      const flush = () => {
        if (run) {
          html += wrapRun(run, curFg, curBg, curBold, curItalic, curDim);
          run = "";
        }
      };

      for (let x = 0; x < cols; x++) {
        const c = line.getCell(x, cell);
        if (!c) continue;

        if (isCursorLine && x === cursorX && !cursorHidden) {
          flush();
          let cch = " ";
          if (c.getWidth() !== 0) cch = c.getChars() || " ";
          const cursorClass = this.focused ? "cursor" : "cursor blurred";
          html += `<span class="${cursorClass}">${escapeHtml(cch)}</span>`;
          curFg = null;
          curBg = null;
          curBold = false;
          curItalic = false;
          curDim = false;
          continue;
        }

        let fg = this.cellColor(c.getFgColor(), c.getFgColorMode());
        let bg = this.cellColor(c.getBgColor(), c.getBgColorMode());
        // Inverse video (SGR 7). TUI apps like Claude Code hide the hardware
        // cursor and draw their own block cursor as an inverse cell, so we must
        // swap fg/bg here or that cursor renders as invisible plain text.
        // Default colors resolve to the theme's fg/bg before swapping.
        if (c.isInverse() !== 0) {
          const swap = fg ?? activeTheme.foreground;
          fg = bg ?? activeTheme.background;
          bg = swap;
        }
        const bold = c.isBold() !== 0;
        const italic = c.isItalic() !== 0;
        const dim = c.isDim() !== 0;

        if (
          fg !== curFg ||
          bg !== curBg ||
          bold !== curBold ||
          italic !== curItalic ||
          dim !== curDim
        ) {
          flush();
          curFg = fg;
          curBg = bg;
          curBold = bold;
          curItalic = italic;
          curDim = dim;
        }

        if (c.getWidth() === 0) {
          // Combining marks may occupy zero-width cells instead of being
          // folded into the previous cell, especially in alternate buffers.
          run += c.getChars();
          continue;
        }

        run += c.getChars() || " ";
      }

      flush();

      if (isCursorLine && cursorX >= cols && !cursorHidden) {
        const cursorClass = this.focused ? "cursor" : "cursor blurred";
        html += `<span class="${cursorClass}"> </span>`;
      }

      if (!html) html = " ";

      this.setRowRender(r, { kind: "html", value: html });
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

// Rebuild a pane tree from a serialized snapshot (tab drag-out adoption).
// Mirrors splitLeaf's DOM shape — .split containers with a .divider between
// children — but constructs the whole tree at once instead of one split at a
// time. Sessions are produced by makeSession (which binds each to its
// already-live ptyId), so no PTY is spawned here.
function buildSerializedTree(
  node: SerializedNode,
  makeSession: (leaf: Extract<SerializedNode, { kind: "leaf" }>) => PaneSession,
  onDividerDown: (b: Branch, e: PointerEvent) => void,
): Pane {
  if (node.kind === "leaf") {
    return { kind: "leaf", session: makeSession(node), parent: null };
  }
  const a = buildSerializedTree(node.a, makeSession, onDividerDown);
  const b = buildSerializedTree(node.b, makeSession, onDividerDown);
  const el = document.createElement("div");
  el.className = `split dir-${node.dir}`;
  const divider = document.createElement("div");
  divider.className = `divider dir-${node.dir}`;
  el.appendChild(paneEl(a));
  el.appendChild(divider);
  el.appendChild(paneEl(b));
  const branch: Branch = {
    kind: "branch",
    dir: node.dir,
    ratio: node.ratio,
    a,
    b,
    el,
    divider,
    parent: null,
  };
  a.parent = branch;
  b.parent = branch;
  divider.addEventListener("pointerdown", (e) => onDividerDown(branch, e));
  applyBranchSizing(branch);
  return branch;
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
  // Set by TabManager's tab-drag handler so the trailing click event (fired
  // after a drag's pointerup) doesn't also activate/close the tab.
  justDragged = false;
  private isActive = false;

  constructor(
    init: PaneSession | Pane,
    private readonly opts: TabOpts,
    private readonly onSessionKey: (
      e: KeyboardEvent,
      s: PaneSession,
    ) => boolean,
  ) {
    this.rootEl = document.createElement("div");
    this.rootEl.className = "tab-root inactive";
    wrapper.appendChild(this.rootEl);

    if ("kind" in init) {
      // A prebuilt pane tree adopted from another window's dragged tab.
      this.root = init;
      this.active = paneLeaves(init)[0];
      this.rootEl.appendChild(paneEl(init));
    } else {
      const leaf: Leaf = { kind: "leaf", session: init, parent: null };
      this.root = leaf;
      this.active = leaf;
      this.rootEl.appendChild(init.leafEl);
    }

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
      // Swallow the click that trails a drag gesture's pointerup.
      if (this.justDragged) {
        this.justDragged = false;
        return;
      }
      if (e.target === closeEl) {
        e.stopPropagation();
        opts.onClose(this);
        return;
      }
      opts.onActivateRequest(this);
    });
  }

  // Snapshot the pane tree for transfer to another window. Captures the live
  // ptyId of each leaf plus its cwd/title so the destination rebuilds the
  // same layout and labels without re-spawning shells.
  serialize(): SerializedTab {
    const walk = (p: Pane): SerializedNode => {
      if (p.kind === "leaf") {
        return {
          kind: "leaf",
          ptyId: p.session.ptyId,
          cwd: p.session.cwd,
          title: p.session.title,
          screen: p.session.serializeScreen(),
        };
      }
      return {
        kind: "branch",
        dir: p.dir,
        ratio: p.ratio,
        a: walk(p.a),
        b: walk(p.b),
      };
    };
    return { tree: walk(this.root) };
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
  // Public so adopted (rebuilt) pane trees can wire their dividers back to it.
  beginDividerDrag(branch: Branch, e: PointerEvent): void {
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

    let pendingRatio: number | null = null;
    let dragFrame: number | null = null;
    const applyPendingRatio = () => {
      dragFrame = null;
      if (pendingRatio == null) return;
      branch.ratio = pendingRatio;
      pendingRatio = null;
      applyBranchSizing(branch);
    };
    const scheduleRatio = (ratio: number) => {
      pendingRatio = ratio;
      if (dragFrame != null) return;
      dragFrame = requestAnimationFrame(applyPendingRatio);
    };
    const onMove = (ev: PointerEvent) => {
      const cur = isRow ? ev.clientX : ev.clientY;
      const delta = (cur - startPos) / total;
      let r = startRatio + delta;
      if (r < minRatio) r = minRatio;
      if (r > maxRatio) r = maxRatio;
      scheduleRatio(r);
    };
    const onUp = (ev: PointerEvent) => {
      if (dragFrame != null) {
        cancelAnimationFrame(dragFrame);
        dragFrame = null;
      }
      applyPendingRatio();
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

// ---- Find bar --------------------------------------------------------
// A single iTerm-style find bar that operates on whichever pane is active.
// Enter steps to the previous (older) hit, Shift+Enter to the next (newer),
// Esc closes and restores terminal focus.
class TerminalSearch {
  private readonly bar: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLSpanElement;
  private matches: SearchMatch[] = [];
  private index = -1;
  private open = false;
  private debounceTimer: number | null = null;

  constructor(
    container: HTMLElement,
    private readonly getSession: () => PaneSession | null,
    private readonly restoreFocus: () => void,
  ) {
    this.bar = document.createElement("div");
    this.bar.className = "search-bar";
    this.bar.hidden = true;

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "search-input";
    this.input.placeholder = "Find";
    this.input.spellcheck = false;

    this.count = document.createElement("span");
    this.count.className = "search-count";

    const prev = this.button("↑", "Previous match", () => this.step(-1));
    const next = this.button("↓", "Next match", () => this.step(1));
    const close = this.button("✕", "Close (Esc)", () => this.close());

    this.bar.append(this.input, this.count, prev, next, close);
    container.appendChild(this.bar);

    this.input.addEventListener("input", () => this.scheduleRecompute());
    this.input.addEventListener("keydown", (e) => this.onInputKey(e));
  }

  private button(label: string, title: string, onClick: () => void) {
    const b = document.createElement("button");
    b.className = "search-btn";
    b.textContent = label;
    b.title = title;
    // Keep input focus on click so the selection/highlight stays current.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", onClick);
    return b;
  }

  isOpen(): boolean {
    return this.open;
  }

  openWith(initial?: string): void {
    this.open = true;
    this.bar.hidden = false;
    if (initial) this.input.value = initial;
    this.input.focus();
    this.input.select();
    this.recompute();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.bar.hidden = true;
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.getSession()?.clearSearchHighlight();
    this.matches = [];
    this.index = -1;
    this.restoreFocus();
  }

  private onInputKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.step(e.shiftKey ? 1 : -1);
      return;
    }
    const isMac = window.pty?.platform === "darwin";
    const mod = isMac ? e.metaKey : e.ctrlKey;
    // Find shortcut while already open: re-select the query to retype fast.
    // Mac: Cmd+F; win/lin: Ctrl+Shift+F (matches the open shortcut).
    if (mod && e.code === "KeyF" && (isMac || e.shiftKey)) {
      e.preventDefault();
      this.input.select();
      return;
    }
    // The app uses a custom menu without standard Edit roles, so native
    // select-all isn't delivered to inputs — handle it here.
    if (mod && e.code === "KeyA" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.input.select();
    }
  }

  private scheduleRecompute(): void {
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.recompute();
    }, 90);
  }

  private recompute(): void {
    const session = this.getSession();
    const query = this.input.value;
    if (!session || !query) {
      this.matches = [];
      this.index = -1;
      session?.clearSearchHighlight();
      this.updateCount();
      return;
    }
    this.matches = session.searchScrollback(query);
    if (!this.matches.length) {
      this.index = -1;
      session.clearSearchHighlight();
      this.updateCount();
      return;
    }
    // Start at the newest (bottom-most) hit, like iTerm.
    this.index = this.matches.length - 1;
    session.revealMatch(this.matches[this.index], query);
    this.updateCount();
  }

  private step(delta: number): void {
    if (!this.matches.length) return;
    const n = this.matches.length;
    this.index = (this.index + delta + n) % n;
    this.getSession()?.revealMatch(this.matches[this.index], this.input.value);
    this.updateCount();
  }

  private updateCount(): void {
    if (!this.input.value) {
      this.count.textContent = "";
    } else if (!this.matches.length) {
      this.count.textContent = "0/0";
    } else {
      this.count.textContent = `${this.index + 1}/${this.matches.length}`;
    }
  }
}

// ---- TabManager ------------------------------------------------------

class TabManager {
  private tabs = new Map<string, Tab>(); // keyed by first ptyId in tab
  private leavesByPtyId = new Map<string, Leaf>();
  private tabsByPtyId = new Map<string, Tab>();
  private order: string[] = [];
  private activeId: string | null = null;
  private readonly search: TerminalSearch;

  constructor() {
    const wrapper =
      document.getElementById("terminal-wrapper") ?? document.body;
    this.search = new TerminalSearch(
      wrapper,
      () => this.active?.active.session ?? null,
      () => this.active?.focusActive(),
    );

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
    this.setupTabDrag(tab);
    pty.ready(ptyId);
    this.activate(tab);
    return tab;
  }

  // Rebuild a tab dragged in from another window. Its PTYs are already live
  // and were re-pointed to this window by main; attach fresh xterms to them
  // (no spawn) and release buffered output with pty.ready.
  adoptSerializedTab(payload: SerializedTab): void {
    const pty = window.pty;
    if (!pty) return;
    const ptyIds: string[] = [];
    const screens = new Map<string, string>();
    const makeSession = (
      sl: Extract<SerializedNode, { kind: "leaf" }>,
    ): PaneSession => {
      ptyIds.push(sl.ptyId);
      if (sl.screen) screens.set(sl.ptyId, sl.screen);
      const session = new PaneSession({
        ptyId: sl.ptyId,
        onCwd: () => {},
        onTitle: () => {},
        onFocus: () => {},
        onKey: () => true,
      });
      session.cwd = sl.cwd || "~";
      session.title = sl.title || "";
      session.term.onData((data) => pty.write(sl.ptyId, data));
      return session;
    };
    // Dividers in the rebuilt tree bind to the tab, which doesn't exist until
    // after the tree is built; resolve it lazily through this holder.
    const holder: { tab: Tab | null } = { tab: null };
    const root = buildSerializedTree(payload.tree, makeSession, (b, e) =>
      holder.tab?.beginDividerDrag(b, e),
    );
    const tab = new Tab(
      root,
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
    holder.tab = tab;

    const id = tab.active.session.ptyId;
    for (const leaf of paneLeaves(tab.root)) {
      rewireSessionOpts(leaf.session, tab.buildSessionOpts(leaf.session.ptyId));
      leaf.session.attach();
      // Repaint the screen + scrollback captured at drag time, before any
      // live output flushes, so the pane looks continuous (a fresh xterm
      // would otherwise show nothing until the next prompt redraw).
      const screen = screens.get(leaf.session.ptyId);
      if (screen) leaf.session.writeToTerm(screen);
      this.registerLeaf(tab, leaf);
    }
    this.tabs.set(id, tab);
    this.order.push(id);
    this.setupTabDrag(tab);
    this.activate(tab);
    // ready flushes the output buffered in main since the transfer.
    for (const pid of ptyIds) pty.ready(pid);
  }

  // ---- Tab drag (reorder / tear-off to a window) -----------------------
  private setupTabDrag(tab: Tab): void {
    const el = tab.tabEl;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // Let the close button get its own click.
      if ((e.target as HTMLElement).classList.contains("tab-close")) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      let dragging = false;
      const onMove = (ev: PointerEvent) => {
        if (!dragging) {
          // A few px of slop so a normal click never reads as a drag.
          if (
            Math.abs(ev.clientX - startX) < 6 &&
            Math.abs(ev.clientY - startY) < 6
          )
            return;
          dragging = true;
          this.activate(tab);
          el.classList.add("dragging");
          try {
            el.setPointerCapture(pointerId);
          } catch {
            /* */
          }
        }
        this.dragReorder(tab, ev.clientX, ev.clientY);
      };
      const onUp = (ev: PointerEvent) => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        try {
          el.releasePointerCapture(pointerId);
        } catch {
          /* */
        }
        if (!dragging) return;
        el.classList.remove("dragging");
        tab.justDragged = true;
        void this.finishTabDrag(tab, ev);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    });
  }

  // Live-reorder the dragged tab among its siblings while the pointer is over
  // the tab strip. Once the pointer leaves the strip the tab stays put (it's
  // headed for a new/other window).
  private dragReorder(tab: Tab, clientX: number, clientY: number): void {
    const bar = tabbar.getBoundingClientRect();
    if (clientY < bar.top - 24 || clientY > bar.bottom + 24) return;
    const el = tab.tabEl;
    const others = Array.from(
      tabbar.querySelectorAll<HTMLElement>(".tab"),
    ).filter((s) => s !== el);
    let before: HTMLElement | null = null;
    for (const s of others) {
      const r = s.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) {
        before = s;
        break;
      }
    }
    if (before) {
      if (el.nextElementSibling !== before) tabbar.insertBefore(el, before);
    } else if (tabbar.lastElementChild !== el) {
      tabbar.appendChild(el);
    }
  }

  // Decide what a finished tab drag means by where it was dropped.
  private async finishTabDrag(tab: Tab, ev: PointerEvent): Promise<void> {
    const bar = tabbar.getBoundingClientRect();
    const inOwnBar =
      ev.clientX >= bar.left &&
      ev.clientX <= bar.right &&
      ev.clientY >= bar.top &&
      ev.clientY <= bar.bottom;
    if (inOwnBar) {
      // Reordered within this window — commit the live DOM order.
      this.syncOrderFromDom();
      return;
    }
    const win = window.win;
    if (!win) {
      this.syncOrderFromDom();
      return;
    }
    const hit = await win.hitTest(ev.screenX, ev.screenY);
    if (hit.kind === "other" && hit.inTabbar && hit.wcId != null) {
      const ok = await win.moveTab(tab.serialize(), hit.wcId);
      if (ok) this.removeTab(tab, false);
      else this.syncOrderFromDom();
      return;
    }
    if (hit.kind === "none") {
      // Dropped outside every window — tear off into a new one.
      const ok = await win.createWithTab(tab.serialize());
      if (ok) this.removeTab(tab, false);
      else this.syncOrderFromDom();
      return;
    }
    // Over a window body (not its tab bar): snap back.
    this.syncOrderFromDom();
  }

  // Re-derive this.order from the tab strip's DOM order after a reorder.
  private syncOrderFromDom(): void {
    const ids: string[] = [];
    for (const el of Array.from(
      tabbar.querySelectorAll<HTMLElement>(".tab"),
    )) {
      for (const [id, t] of this.tabs) {
        if (t.tabEl === el) {
          ids.push(id);
          break;
        }
      }
    }
    if (ids.length === this.order.length) this.order = ids;
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
    // The find bar is scoped to the active pane; its highlight lives in the
    // outgoing tab's DOM, so close it on switch.
    if (this.search.isOpen()) this.search.close();
    this.activeId = id;
    tab.activate();
    document.title = tab.displayName();
  }

  closeTab(tab: Tab): void {
    this.removeTab(tab, true);
  }

  // Remove a tab from this window. With kill=true the PTYs are terminated
  // (normal close); with kill=false they're left running because they've
  // already been handed to another window by a tab drag-out.
  private removeTab(tab: Tab, kill: boolean): void {
    const id = this.tabIdOf(tab);
    if (!id) return;
    const wasActive = this.activeId === id;
    if (kill) {
      for (const leaf of paneLeaves(tab.root)) {
        window.pty?.kill(leaf.session.ptyId);
      }
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
  private handleKey(e: KeyboardEvent, s: PaneSession): boolean {
    if (e.type !== "keydown") return true;

    // Shift+Enter: the classic xterm encoding sends a plain CR for both Enter
    // and Shift+Enter, so apps like Claude Code can't tell them apart and
    // treat Shift+Enter as submit. Send ESC+CR — the same sequence
    // `claude /terminal-setup` configures — so it inserts a newline instead.
    if (
      e.code === "Enter" &&
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      window.pty?.write(s.ptyId, "\x1b\r");
      return false;
    }

    // Mac uses Cmd; win/linux use Ctrl. On non-mac we additionally require
    // Shift for D/T/W because raw Ctrl+D (EOF) and Ctrl+W (delete-word)
    // are reserved by readline-driven shells.
    const isMac = window.pty?.platform === "darwin";
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return true;
    if (!isMac && e.metaKey) return true;

    if (this.handleClipboardShortcut(e)) return false;

    // Font size, iTerm2-style: Cmd/Ctrl+= bigger, Cmd/Ctrl+- smaller,
    // Cmd/Ctrl+0 reset to default. Equal covers Cmd++ too (Shift+=) so both
    // "+" and "=" work without holding Shift.
    if (!e.altKey) {
      if (e.code === "Equal") {
        e.preventDefault();
        adjustFontSize(1);
        return false;
      }
      if (e.code === "Minus") {
        e.preventDefault();
        adjustFontSize(-1);
        return false;
      }
      if (e.code === "Digit0" && !e.shiftKey) {
        e.preventDefault();
        resetFontSize();
        return false;
      }
    }

    // Find: Cmd+F (mac) / Ctrl+Shift+F (win/lin). Shift is required off-mac
    // so we don't clobber readline's Ctrl+F (forward-char), matching the
    // Ctrl+Shift+T/W convention above.
    if (e.code === "KeyF" && !e.altKey && (isMac ? !e.shiftKey : e.shiftKey)) {
      e.preventDefault();
      this.openFind();
      return false;
    }

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
    // Let the find bar's own input handle copy/paste/select natively.
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.classList.contains("search-input"))
      return false;
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

  // Inject a dropped file path into the active pane. Routed through
  // term.paste() (not a raw write) so xterm wraps it in bracketed-paste
  // markers when the app has DECSET 2004 on. Apps like Claude Code only
  // treat an image path as an attachment when it arrives as a *paste*; a
  // raw write looks like typed text and shows the literal path instead.
  // With bracketed paste off (e.g. a bare shell prompt) term.paste sends
  // the text unwrapped, so dropping a path still just inserts it.
  writeToActive(data: string): void {
    const t = this.active;
    if (!t) return;
    t.active.session.term.paste(data);
    t.focusActive();
  }

  // Open the find bar (Edit > Find, and the Cmd+F / Ctrl+Shift+F shortcut),
  // prefilled with any current selection.
  openFind(): void {
    this.search.openWith(currentSelectionText() || undefined);
  }

  async copySelection(): Promise<boolean> {
    const text = currentSelectionText();
    if (!text) return false;
    // Snapshot the selection before we copy: restoring terminal focus below
    // moves focus to xterm's textarea, which collapses the window selection
    // in the .output div. Re-apply it so Cmd+C leaves the highlight in place
    // like a normal terminal.
    const sel = window.getSelection();
    const range =
      sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    await window.pty?.writeClipboardText(text);
    this.active?.focusActive();
    if (range && sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
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
    applyGlobalTheme(appearance.theme);
    saveAppearance(appearance);
    tabs.applyAppearance(appearance);
  },
});

// Apply a font-size change made outside the settings panel (Cmd+= / Cmd+- /
// Cmd+0 or the View menu) and keep the panel in sync. iTerm2-style: bump,
// shrink, or reset to the default.
//
// Each apply triggers a fit + PTY resize (SIGWINCH → shell redraw) + full
// re-render across every pane, so firing it on every keystroke makes rapid
// zooming stutter. We update the in-memory size and the live panel slider
// immediately for instant feedback, but coalesce the heavy resize/persist
// work onto a single trailing animation frame — a burst of presses collapses
// to one resize.
let fontApplyScheduled = false;
function setFontSize(size: number): void {
  const next = clampFontSize(size);
  if (next === appearance.fontSize) return;
  appearance = normalizeAppearance({ ...appearance, fontSize: next });
  settingsPanel.syncExternal(appearance);
  if (fontApplyScheduled) return;
  fontApplyScheduled = true;
  requestAnimationFrame(() => {
    fontApplyScheduled = false;
    saveAppearance(appearance);
    tabs.applyAppearance(appearance);
  });
}
function adjustFontSize(delta: number): void {
  setFontSize(appearance.fontSize + delta);
}
function resetFontSize(): void {
  setFontSize(DEFAULT_APPEARANCE.fontSize);
}

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
  // A tab dragged onto this window's tab bar from another window.
  window.win?.onAdoptTab((payload) => tabs.adoptSerializedTab(payload));
  // Boot: if this window was spawned to adopt a dragged-out tab, rebuild it
  // instead of opening a default shell. Otherwise consume any cold-launch
  // dock-drop path so the first tab opens in that folder instead of $HOME.
  void (async () => {
    const adopt = await window.win?.consumeAdopt();
    if (adopt) {
      tabs.adoptSerializedTab(adopt);
      return;
    }
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
// Paths are resolved via webUtils.getPathForFile() (exposed through the
// preload bridge), not the non-standard File.path — the latter is removed
// in Electron 32.
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
    const p = window.pty!.getPathForFile(f);
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
    case "find":
      tabs.openFind();
      break;
    case "font-increase":
      adjustFontSize(1);
      break;
    case "font-decrease":
      adjustFontSize(-1);
      break;
    case "font-reset":
      resetFontSize();
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
