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
}

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  viewMode: "default",
  fontSize: 14,
  fontFamily: "system",
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

export function normalizeAppearance(raw: unknown): AppearancePrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_APPEARANCE };
  const obj = raw as Partial<AppearancePrefs>;
  return {
    viewMode: isViewMode(obj.viewMode)
      ? obj.viewMode
      : DEFAULT_APPEARANCE.viewMode,
    fontSize: clampFontSize(Number(obj.fontSize)),
    fontFamily: normalizeFontChoice(obj.fontFamily),
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
