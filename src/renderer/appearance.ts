import type { ITheme } from "@xterm/xterm";

const SETTINGS_KEY = "myanso:appearance";

const FALLBACK_MONO_FONTS = [
  "Menlo",
  "SF Mono",
  "Monaco",
  "Consolas",
  "Cascadia Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Ubuntu Mono",
  "Noto Sans Mono",
];

const MYANMAR_FALLBACK_FONTS = [
  "Noto Sans Myanmar",
  "Myanmar Sangam MN",
  "Myanmar MN",
];

export const VIEW_MODE_LINE_HEIGHT = {
  compact: 1.15,
  default: 1.25,
  presentation: 1.4,
} as const;

export type ViewMode = keyof typeof VIEW_MODE_LINE_HEIGHT;

export type AnsiPalette = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export interface TerminalTheme {
  id: string;
  label: string;
  colorScheme: "dark" | "light";
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  selectionInactiveBackground: string;
  ansi: AnsiPalette;
  ui: {
    muted: string;
    accent: string;
    border: string;
    tabBg: string;
    tabBgActive: string;
    chromeTop: string;
    chromeBottom: string;
    panelTop: string;
    panelBottom: string;
    modalOverlay: string;
    paneDim: string;
    controlBg: string;
    controlHover: string;
    previewBg: string;
    applyBorder: string;
    applyBg: string;
    applyBgHover: string;
    applyFg: string;
  };
}

export const TERMINAL_THEMES: readonly TerminalTheme[] = [
  {
    id: "myanso-dark",
    label: "Myanso Dark",
    colorScheme: "dark",
    foreground: "#e4e4e4",
    background: "#15171e",
    cursor: "#e4e4e4",
    cursorAccent: "#15171e",
    selectionBackground: "rgba(124, 156, 250, 0.45)",
    selectionInactiveBackground: "rgba(124, 156, 250, 0.28)",
    ansi: [
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
    ],
    ui: {
      muted: "#8b8f99",
      accent: "#69b4ff",
      border: "#2a2d38",
      tabBg: "#1a1c24",
      tabBgActive: "#15171e",
      chromeTop: "#1e2029",
      chromeBottom: "#191b23",
      panelTop: "#1d2029",
      panelBottom: "#15171e",
      modalOverlay: "rgba(8, 10, 14, 0.66)",
      paneDim: "rgba(21, 23, 30, 0.55)",
      controlBg: "rgba(255, 255, 255, 0.04)",
      controlHover: "rgba(255, 255, 255, 0.08)",
      previewBg: "rgba(0, 0, 0, 0.35)",
      applyBorder: "#5b9bd5",
      applyBg: "rgba(91, 155, 213, 0.15)",
      applyBgHover: "rgba(91, 155, 213, 0.28)",
      applyFg: "#8bbce6",
    },
  },
  {
    id: "myanso-light",
    label: "Myanso Light",
    colorScheme: "light",
    foreground: "#1f2430",
    background: "#f7f7f2",
    cursor: "#1f2430",
    cursorAccent: "#f7f7f2",
    selectionBackground: "rgba(45, 112, 179, 0.28)",
    selectionInactiveBackground: "rgba(45, 112, 179, 0.18)",
    ansi: [
      "#1f2430",
      "#b42335",
      "#217245",
      "#8a6515",
      "#2457a6",
      "#8b3d8f",
      "#0d7280",
      "#e8e2d0",
      "#6f7480",
      "#d12f43",
      "#2f8f57",
      "#a77b1f",
      "#356ec5",
      "#a04ca5",
      "#138999",
      "#ffffff",
    ],
    ui: {
      muted: "#6f7480",
      accent: "#2d70b3",
      border: "#d4d0c5",
      tabBg: "#e9e5d9",
      tabBgActive: "#f7f7f2",
      chromeTop: "#efebdf",
      chromeBottom: "#e5e1d4",
      panelTop: "#fbfaf5",
      panelBottom: "#eeeade",
      modalOverlay: "rgba(31, 36, 48, 0.28)",
      paneDim: "rgba(247, 247, 242, 0.58)",
      controlBg: "rgba(31, 36, 48, 0.04)",
      controlHover: "rgba(31, 36, 48, 0.08)",
      previewBg: "rgba(31, 36, 48, 0.05)",
      applyBorder: "#2d70b3",
      applyBg: "rgba(45, 112, 179, 0.12)",
      applyBgHover: "rgba(45, 112, 179, 0.2)",
      applyFg: "#245f9b",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    colorScheme: "dark",
    foreground: "#839496",
    background: "#002b36",
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selectionBackground: "rgba(38, 139, 210, 0.35)",
    selectionInactiveBackground: "rgba(38, 139, 210, 0.22)",
    ansi: [
      "#073642",
      "#dc322f",
      "#859900",
      "#b58900",
      "#268bd2",
      "#d33682",
      "#2aa198",
      "#eee8d5",
      "#002b36",
      "#cb4b16",
      "#586e75",
      "#657b83",
      "#839496",
      "#6c71c4",
      "#93a1a1",
      "#fdf6e3",
    ],
    ui: {
      muted: "#657b83",
      accent: "#268bd2",
      border: "#0d3f4c",
      tabBg: "#073642",
      tabBgActive: "#002b36",
      chromeTop: "#073642",
      chromeBottom: "#05313d",
      panelTop: "#073642",
      panelBottom: "#002b36",
      modalOverlay: "rgba(0, 18, 22, 0.72)",
      paneDim: "rgba(0, 43, 54, 0.58)",
      controlBg: "rgba(238, 232, 213, 0.05)",
      controlHover: "rgba(238, 232, 213, 0.1)",
      previewBg: "rgba(0, 0, 0, 0.22)",
      applyBorder: "#268bd2",
      applyBg: "rgba(38, 139, 210, 0.16)",
      applyBgHover: "rgba(38, 139, 210, 0.28)",
      applyFg: "#6cbee8",
    },
  },
] as const;

export const DEFAULT_THEME_ID = TERMINAL_THEMES[0].id;

interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

export interface AppearancePrefs {
  viewMode: ViewMode;
  fontSize: number;
  fontFamily: string;
  theme: string;
}

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  viewMode: "default",
  fontSize: 14,
  fontFamily: "system",
  theme: DEFAULT_THEME_ID,
};

export function clampFontSize(n: number): number {
  return Math.max(
    11,
    Math.min(24, Math.round(n || DEFAULT_APPEARANCE.fontSize)),
  );
}

function isViewMode(v: unknown): v is ViewMode {
  return v === "compact" || v === "default" || v === "presentation";
}

function normalizeFontChoice(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_APPEARANCE.fontFamily;
  const trimmed = v.trim();
  return trimmed || DEFAULT_APPEARANCE.fontFamily;
}

export function themeById(id: unknown): TerminalTheme {
  const key = typeof id === "string" ? id : "";
  return TERMINAL_THEMES.find((theme) => theme.id === key) ?? TERMINAL_THEMES[0];
}

export function normalizeAppearance(raw: unknown): AppearancePrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_APPEARANCE };
  const obj = raw as Partial<AppearancePrefs>;
  return {
    viewMode: isViewMode(obj.viewMode)
      ? obj.viewMode
      : DEFAULT_APPEARANCE.viewMode,
    fontSize: clampFontSize(Number(obj.fontSize)),
    fontFamily: normalizeFontChoice(obj.fontFamily),
    theme: themeById(obj.theme).id,
  };
}

export function loadAppearance(): AppearancePrefs {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw
      ? normalizeAppearance(JSON.parse(raw))
      : { ...DEFAULT_APPEARANCE };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(prefs: AppearancePrefs): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn("myanso: failed to save appearance to localStorage", e);
  }
}

function quoteFontFamily(name: string): string {
  return /[",]/.test(name) || /\s/.test(name)
    ? `"${name.replace(/"/g, '\\"')}"`
    : name;
}

export function buildTerminalFontFamily(selected: string): string {
  const families: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    families.push(trimmed);
  };

  if (selected !== "system") push(selected);
  for (const name of FALLBACK_MONO_FONTS) push(name);
  for (const name of MYANMAR_FALLBACK_FONTS) push(name);
  push("monospace");

  return families
    .map((name) => (name === "monospace" ? name : quoteFontFamily(name)))
    .join(", ");
}

export function xtermTheme(theme: TerminalTheme): ITheme {
  const ansiNames = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ] as const;
  const out: ITheme = {
    foreground: theme.foreground,
    background: theme.background,
    cursor: theme.cursor,
    cursorAccent: theme.cursorAccent,
    selectionBackground: theme.selectionBackground,
    selectionInactiveBackground: theme.selectionInactiveBackground,
  };
  if (theme.selectionForeground) {
    out.selectionForeground = theme.selectionForeground;
  }
  for (let i = 0; i < ansiNames.length; i++) {
    out[ansiNames[i]] = theme.ansi[i];
  }
  return out;
}

export function ansi256Palette(theme: TerminalTheme): string[] {
  const colors = [...theme.ansi];
  for (let code = 16; code < 256; code++) {
    if (code >= 232) {
      const v = (code - 232) * 10 + 8;
      colors.push(`rgb(${v},${v},${v})`);
      continue;
    }
    const c = code - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    const m = (x: number) => (x === 0 ? 0 : x * 40 + 55);
    colors.push(`rgb(${m(r)},${m(g)},${m(b)})`);
  }
  return colors;
}

export function applyThemeVariables(theme: TerminalTheme): void {
  const root = document.documentElement;
  root.style.colorScheme = theme.colorScheme;
  root.style.setProperty("--bg", theme.background);
  root.style.setProperty("--fg", theme.foreground);
  root.style.setProperty("--muted", theme.ui.muted);
  root.style.setProperty("--accent", theme.ui.accent);
  root.style.setProperty("--border", theme.ui.border);
  root.style.setProperty("--tab-bg", theme.ui.tabBg);
  root.style.setProperty("--tab-bg-active", theme.ui.tabBgActive);
  root.style.setProperty("--chrome-top", theme.ui.chromeTop);
  root.style.setProperty("--chrome-bottom", theme.ui.chromeBottom);
  root.style.setProperty("--panel-top", theme.ui.panelTop);
  root.style.setProperty("--panel-bottom", theme.ui.panelBottom);
  root.style.setProperty("--modal-overlay", theme.ui.modalOverlay);
  root.style.setProperty("--pane-dim", theme.ui.paneDim);
  root.style.setProperty("--control-bg", theme.ui.controlBg);
  root.style.setProperty("--control-hover", theme.ui.controlHover);
  root.style.setProperty("--preview-bg", theme.ui.previewBg);
  root.style.setProperty("--apply-border", theme.ui.applyBorder);
  root.style.setProperty("--apply-bg", theme.ui.applyBg);
  root.style.setProperty("--apply-bg-hover", theme.ui.applyBgHover);
  root.style.setProperty("--apply-fg", theme.ui.applyFg);
  root.style.setProperty("--selection-bg", theme.selectionBackground);
}

async function waitForFontsReady(): Promise<void> {
  try {
    await document.fonts.ready;
  } catch {
    // Ignore readiness failures and fall back to best-effort checks below.
  }
}

let monoProbeContext: CanvasRenderingContext2D | null = null;

function getMonoProbeContext(): CanvasRenderingContext2D | null {
  if (monoProbeContext) return monoProbeContext;
  const canvas = document.createElement("canvas");
  monoProbeContext = canvas.getContext("2d");
  return monoProbeContext;
}

function isMonospaceFamily(name: string): boolean {
  const ctx = getMonoProbeContext();
  if (!ctx) return false;
  try {
    const family = quoteFontFamily(name);
    const probes = ["i", "W", "0", "m"];
    ctx.font = `16px ${family}, monospace`;
    const monoFallbackWidths = probes.map((ch) => ctx.measureText(ch).width);
    ctx.font = `16px ${family}, sans-serif`;
    const sansFallbackWidths = probes.map((ch) => ctx.measureText(ch).width);

    // If the family does not contain the probe glyphs, Chromium falls through
    // to the generic fallback. Compare two different fallbacks so script-
    // specific fonts like Noto Sans Myanmar do not masquerade as monospace.
    const hasProbeGlyphs = monoFallbackWidths.every(
      (width, i) => Math.abs(width - sansFallbackWidths[i]) < 0.01,
    );
    if (!hasProbeGlyphs) return false;

    return (
      Math.max(...monoFallbackWidths) - Math.min(...monoFallbackWidths) < 0.01
    );
  } catch {
    return false;
  }
}

async function localFontFamilies(): Promise<string[]> {
  if (typeof window.queryLocalFonts !== "function") return [];
  try {
    const fonts = await window.queryLocalFonts();
    const families = new Set<string>();
    for (const font of fonts) {
      const family = font.family.trim();
      if (family) families.add(family);
    }
    return [...families].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  } catch (e) {
    console.warn("myanso: failed to enumerate local fonts", e);
    return [];
  }
}

let availableFontChoicesCache: Array<{ value: string; label: string }> | null =
  null;

export async function availableFontChoices(): Promise<
  Array<{ value: string; label: string }>
> {
  if (availableFontChoicesCache) return availableFontChoicesCache;
  await waitForFontsReady();
  const fonts = await localFontFamilies();
  const choices = [
    { value: "system", label: "System Mono" },
    ...fonts
      .filter((family) => isMonospaceFamily(family))
      .map((family) => ({ value: family, label: family })),
  ];
  if (choices.length > 1) availableFontChoicesCache = choices;
  return choices;
}
