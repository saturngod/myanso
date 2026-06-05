const { ipcRenderer, shell, webUtils, clipboard } = require('electron');
const { fileURLToPath } = require('url');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { SearchAddon } = require('@xterm/addon-search');
const fs = require('fs');
const path = require('path');

// Each window gets a unique id (passed by main via additionalArguments) so two
// windows never generate the same pty/tab id. Tells main this renderer is ready
// to receive IPC (e.g. an adopted tab when a window is torn off).
const WID = (process.argv.find((a) => a.startsWith('--myanso-wid=')) || '').split('=')[1] || '0';
ipcRenderer.send('renderer-ready');

const IS_WIN = process.platform === 'win32';

// Quote a file path for the current shell so it can be pasted safely.
// PowerShell uses single quotes with '' for embedded single quotes;
// POSIX shells use '\'' (close-quote, escaped quote, re-open quote).
function quoteShellPath(p) {
  if (IS_WIN) {
    // PowerShell: wrap in single quotes; double any embedded single quotes.
    return `'${p.replace(/'/g, "''")}'`;
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// A Myanmar-capable fallback list is always appended so the whole cluster is
// shaped by one font instead of per-glyph fallbacks.
const MYANMAR_FALLBACK = '"Noto Sans Myanmar", "Myanmar MN", "Myanmar Text", "Courier New", monospace';

// --- Color helpers (used to derive panel UI tints from a few seed colors) ---
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function mix(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const ch = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return '#' + ch(ca.r, cb.r) + ch(ca.g, cb.g) + ch(ca.b, cb.b);
}

// Derive a full panel `ui` palette from a few seed colors, so themes that don't
// hand-author every key still get a consistent settings-panel look.
function generatedUi({ colorScheme, foreground, background, muted, accent, border }) {
  const dark = colorScheme === 'dark';
  const toward = dark ? '#ffffff' : '#000000';
  const away = dark ? '#000000' : '#ffffff';
  const lighten = (hex, t) => mix(hex, toward, t);
  const darken = (hex, t) => mix(hex, away, t);
  return {
    muted, accent, border,
    tabBg: darken(background, 0.06),
    tabBgActive: background,
    chromeTop: lighten(background, 0.04),
    chromeBottom: darken(background, 0.03),
    panelTop: lighten(background, 0.05),
    panelBottom: background,
    modalOverlay: dark ? 'rgba(0, 0, 0, 0.66)' : rgba(foreground, 0.28),
    paneDim: rgba(background, 0.56),
    controlBg: rgba(foreground, 0.04),
    controlHover: rgba(foreground, 0.08),
    previewBg: dark ? 'rgba(0, 0, 0, 0.32)' : rgba(foreground, 0.05),
    applyBorder: accent,
    applyBg: rgba(accent, 0.15),
    applyBgHover: rgba(accent, 0.28),
    applyFg: dark ? lighten(accent, 0.25) : darken(accent, 0.15),
  };
}

// Built-in themes. Each is a full palette: terminal colors (16-color `ansi` +
// selection + cursor) plus a `ui` object used to tint the settings panel.
const THEME_LIST = [
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
      "#000000", "#ff6e6e", "#6eff6e", "#ffff6e", "#7c9cfa", "#ff6eff", "#6effff", "#e4e4e4",
      "#686868", "#ff8b8b", "#8bff8b", "#ffff8b", "#9cb0fa", "#ff8bff", "#8bffff", "#ffffff",
    ],
    ui: {
      muted: "#8b8f99", accent: "#69b4ff", border: "#2a2d38",
      tabBg: "#1a1c24", tabBgActive: "#15171e",
      chromeTop: "#1e2029", chromeBottom: "#191b23",
      panelTop: "#1d2029", panelBottom: "#15171e",
      modalOverlay: "rgba(8, 10, 14, 0.66)", paneDim: "rgba(21, 23, 30, 0.55)",
      controlBg: "rgba(255, 255, 255, 0.04)", controlHover: "rgba(255, 255, 255, 0.08)",
      previewBg: "rgba(0, 0, 0, 0.35)",
      applyBorder: "#5b9bd5", applyBg: "rgba(91, 155, 213, 0.15)",
      applyBgHover: "rgba(91, 155, 213, 0.28)", applyFg: "#8bbce6",
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
      "#1f2430", "#b42335", "#217245", "#8a6515", "#2457a6", "#8b3d8f", "#0d7280", "#e8e2d0",
      "#6f7480", "#d12f43", "#2f8f57", "#a77b1f", "#356ec5", "#a04ca5", "#138999", "#ffffff",
    ],
    ui: {
      muted: "#6f7480", accent: "#2d70b3", border: "#d4d0c5",
      tabBg: "#e9e5d9", tabBgActive: "#f7f7f2",
      chromeTop: "#efebdf", chromeBottom: "#e5e1d4",
      panelTop: "#fbfaf5", panelBottom: "#eeeade",
      modalOverlay: "rgba(31, 36, 48, 0.28)", paneDim: "rgba(247, 247, 242, 0.58)",
      controlBg: "rgba(31, 36, 48, 0.04)", controlHover: "rgba(31, 36, 48, 0.08)",
      previewBg: "rgba(31, 36, 48, 0.05)",
      applyBorder: "#2d70b3", applyBg: "rgba(45, 112, 179, 0.12)",
      applyBgHover: "rgba(45, 112, 179, 0.2)", applyFg: "#245f9b",
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
      "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
    ui: {
      muted: "#657b83", accent: "#268bd2", border: "#0d3f4c",
      tabBg: "#073642", tabBgActive: "#002b36",
      chromeTop: "#073642", chromeBottom: "#05313d",
      panelTop: "#073642", panelBottom: "#002b36",
      modalOverlay: "rgba(0, 18, 22, 0.72)", paneDim: "rgba(0, 43, 54, 0.58)",
      controlBg: "rgba(238, 232, 213, 0.05)", controlHover: "rgba(238, 232, 213, 0.1)",
      previewBg: "rgba(0, 0, 0, 0.22)",
      applyBorder: "#268bd2", applyBg: "rgba(38, 139, 210, 0.16)",
      applyBgHover: "rgba(38, 139, 210, 0.28)", applyFg: "#6cbee8",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    colorScheme: "light",
    foreground: "#657b83",
    background: "#fdf6e3",
    cursor: "#586e75",
    cursorAccent: "#fdf6e3",
    selectionBackground: "rgba(38, 139, 210, 0.24)",
    selectionInactiveBackground: "rgba(38, 139, 210, 0.14)",
    ansi: [
      "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
    ui: generatedUi({
      colorScheme: "light", foreground: "#657b83", background: "#fdf6e3",
      muted: "#839496", accent: "#268bd2", border: "#d8d0b9",
    }),
  },
  {
    id: "dracula",
    label: "Dracula",
    colorScheme: "dark",
    foreground: "#f8f8f2",
    background: "#282a36",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "rgba(189, 147, 249, 0.35)",
    selectionInactiveBackground: "rgba(189, 147, 249, 0.22)",
    ansi: [
      "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
      "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#f8f8f2", background: "#282a36",
      muted: "#6272a4", accent: "#bd93f9", border: "#44475a",
    }),
  },
  {
    id: "nord",
    label: "Nord",
    colorScheme: "dark",
    foreground: "#d8dee9",
    background: "#2e3440",
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: "rgba(136, 192, 208, 0.32)",
    selectionInactiveBackground: "rgba(136, 192, 208, 0.2)",
    ansi: [
      "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#d8dee9", background: "#2e3440",
      muted: "#7d8799", accent: "#88c0d0", border: "#434c5e",
    }),
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    colorScheme: "dark",
    foreground: "#ebdbb2",
    background: "#282828",
    cursor: "#ebdbb2",
    cursorAccent: "#282828",
    selectionBackground: "rgba(214, 153, 33, 0.32)",
    selectionInactiveBackground: "rgba(214, 153, 33, 0.2)",
    ansi: [
      "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
      "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#ebdbb2", background: "#282828",
      muted: "#928374", accent: "#fabd2f", border: "#504945",
    }),
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    colorScheme: "dark",
    foreground: "#c0caf5",
    background: "#1a1b26",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "rgba(122, 162, 247, 0.33)",
    selectionInactiveBackground: "rgba(122, 162, 247, 0.2)",
    ansi: [
      "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
      "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#c0caf5", background: "#1a1b26",
      muted: "#565f89", accent: "#7aa2f7", border: "#2f3549",
    }),
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    colorScheme: "dark",
    foreground: "#cdd6f4",
    background: "#1e1e2e",
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "rgba(137, 180, 250, 0.32)",
    selectionInactiveBackground: "rgba(137, 180, 250, 0.2)",
    ansi: [
      "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
      "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#cdd6f4", background: "#1e1e2e",
      muted: "#7f849c", accent: "#89b4fa", border: "#313244",
    }),
  },
  {
    id: "one-dark",
    label: "One Dark",
    colorScheme: "dark",
    foreground: "#abb2bf",
    background: "#282c34",
    cursor: "#528bff",
    cursorAccent: "#282c34",
    selectionBackground: "rgba(82, 139, 255, 0.3)",
    selectionInactiveBackground: "rgba(82, 139, 255, 0.18)",
    ansi: [
      "#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
      "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#abb2bf", background: "#282c34",
      muted: "#7f848e", accent: "#61afef", border: "#3e4451",
    }),
  },
  {
    id: "monokai",
    label: "Monokai",
    colorScheme: "dark",
    foreground: "#f8f8f2",
    background: "#272822",
    cursor: "#f8f8f0",
    cursorAccent: "#272822",
    selectionBackground: "rgba(166, 226, 46, 0.28)",
    selectionInactiveBackground: "rgba(166, 226, 46, 0.16)",
    ansi: [
      "#272822", "#f92672", "#a6e22e", "#e6db74", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
      "#75715e", "#ff669d", "#beed5f", "#fff085", "#8be9fd", "#c29aff", "#a1efe4", "#ffffff",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#f8f8f2", background: "#272822",
      muted: "#75715e", accent: "#a6e22e", border: "#49483e",
    }),
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    colorScheme: "dark",
    foreground: "#c9d1d9",
    background: "#0d1117",
    cursor: "#58a6ff",
    cursorAccent: "#0d1117",
    selectionBackground: "rgba(56, 139, 253, 0.35)",
    selectionInactiveBackground: "rgba(56, 139, 253, 0.2)",
    ansi: [
      "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
      "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#c9d1d9", background: "#0d1117",
      muted: "#8b949e", accent: "#58a6ff", border: "#30363d",
    }),
  },
  {
    id: "github-light",
    label: "GitHub Light",
    colorScheme: "light",
    foreground: "#24292f",
    background: "#ffffff",
    cursor: "#0969da",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(9, 105, 218, 0.24)",
    selectionInactiveBackground: "rgba(9, 105, 218, 0.14)",
    ansi: [
      "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
      "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
    ],
    ui: generatedUi({
      colorScheme: "light", foreground: "#24292f", background: "#ffffff",
      muted: "#6e7781", accent: "#0969da", border: "#d0d7de",
    }),
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    colorScheme: "dark",
    foreground: "#e0def4",
    background: "#191724",
    cursor: "#e0def4",
    cursorAccent: "#191724",
    selectionBackground: "rgba(156, 207, 216, 0.28)",
    selectionInactiveBackground: "rgba(156, 207, 216, 0.18)",
    ansi: [
      "#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
      "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#e0def4", background: "#191724",
      muted: "#6e6a86", accent: "#c4a7e7", border: "#403d52",
    }),
  },
  {
    id: "ayu-dark",
    label: "Ayu Dark",
    colorScheme: "dark",
    foreground: "#bfbdb6",
    background: "#0d1017",
    cursor: "#e6b450",
    cursorAccent: "#0d1017",
    selectionBackground: "rgba(230, 180, 80, 0.26)",
    selectionInactiveBackground: "rgba(230, 180, 80, 0.16)",
    ansi: [
      "#11151c", "#ea6c73", "#7fd962", "#f9af4f", "#53bdfa", "#cda1fa", "#90e1c6", "#c7c7c7",
      "#686868", "#f07178", "#aad94c", "#ffb454", "#59c2ff", "#d2a6ff", "#95e6cb", "#ffffff",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#bfbdb6", background: "#0d1017",
      muted: "#565b66", accent: "#e6b450", border: "#1d2433",
    }),
  },
  {
    id: "everforest-dark",
    label: "Everforest Dark",
    colorScheme: "dark",
    foreground: "#d3c6aa",
    background: "#2d353b",
    cursor: "#d3c6aa",
    cursorAccent: "#2d353b",
    selectionBackground: "rgba(167, 192, 128, 0.28)",
    selectionInactiveBackground: "rgba(167, 192, 128, 0.18)",
    ansi: [
      "#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa",
      "#5d6b66", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa",
    ],
    ui: generatedUi({
      colorScheme: "dark", foreground: "#d3c6aa", background: "#2d353b",
      muted: "#859289", accent: "#a7c080", border: "#4f585e",
    }),
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    colorScheme: "light",
    foreground: "#4c4f69",
    background: "#eff1f5",
    cursor: "#dc8a78",
    cursorAccent: "#eff1f5",
    selectionBackground: "rgba(30, 102, 245, 0.2)",
    selectionInactiveBackground: "rgba(30, 102, 245, 0.12)",
    ansi: [
      "#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be",
      "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc",
    ],
    ui: generatedUi({
      colorScheme: "light", foreground: "#4c4f69", background: "#eff1f5",
      muted: "#8c8fa1", accent: "#1e66f5", border: "#bcc0cc",
    }),
  },
];

const THEMES = Object.fromEntries(THEME_LIST.map((t) => [t.id, t]));
const DEFAULT_THEME = 'myanso-dark';

// Map a theme entry to the object xterm's `theme` option expects. The `ansi`
// array is positional: 0-7 normal, 8-15 bright.
const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];
function xtermTheme(t) {
  const out = {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    selectionInactiveBackground: t.selectionInactiveBackground,
  };
  t.ansi.forEach((c, i) => { if (ANSI_KEYS[i]) out[ANSI_KEYS[i]] = c; });
  return out;
}
function themeFor(s) {
  return THEMES[s.theme] || THEMES[DEFAULT_THEME];
}

// Built-in monospace font choices (ASCII base; Myanmar fallback added at apply).
// Includes Windows-native fonts (Cascadia Code, Consolas) so the defaults look
// right on every platform.
const FONTS = {
  menlo: { name: 'Menlo', family: 'Menlo, Monaco, "Ubuntu Mono", "DejaVu Sans Mono"' },
  monaco: { name: 'Monaco', family: 'Monaco' },
  cascadia: { name: 'Cascadia Code', family: '"Cascadia Code", Consolas' },
  consolas: { name: 'Consolas', family: 'Consolas, "Courier New"' },
  courier: { name: 'Courier New', family: '"Courier New"' },
  sfmono: { name: 'SF Mono', family: '"SF Mono", Menlo' },
  custom: { name: 'Custom…', family: '' }
};

// Line spacing presets. Each value is a multiplier of the font size (xterm's
// lineHeight option). Bigger gives Myanmar stacked marks more vertical room.
const SPACINGS = {
  compact: { name: 'Compact', value: 1.2 },
  normal: { name: 'Normal', value: 22 / 14 },
  presentation: { name: 'Presentation', value: 2.0 }
};

const DEFAULTS = { theme: DEFAULT_THEME, font: IS_WIN ? 'cascadia' : 'menlo', customFont: '', fontSize: 14, spacing: 'normal' };

function loadSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('myanso-settings') || '{}'));
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function saveSettings(s) {
  localStorage.setItem('myanso-settings', JSON.stringify(s));
}

let settings = loadSettings();
// A theme id saved by an older build may no longer exist; fall back so the
// dropdown and panel show a valid selection.
if (!THEMES[settings.theme]) settings.theme = DEFAULT_THEME;

function fontFamilyFor(s) {
  const DEFAULT_BASE = IS_WIN ? 'Consolas' : 'Menlo';
  const base = s.font === 'custom'
    ? (s.customFont.trim() || DEFAULT_BASE)
    : (FONTS[s.font] || FONTS.menlo).family;
  return `${base}, ${MYANMAR_FALLBACK}`;
}

// --- Per-screen Myanmar mark width -----------------------------------------
// macOS's wcwidth (used by zsh's line editor on the normal screen) counts ALL
// Myanmar combining/vowel marks as width 0; modern TUIs (vim, Claude Code, agy)
// and iTerm2 use the Unicode-standard width: *non-spacing* marks (Mn: ◌ိ ◌ု ◌်…)
// = 0, but *spacing* marks (Mc: ◌ာ ◌း ◌ြ ◌ေ…) = 1. One fixed width breaks one
// side, so we switch per screen:
//   normal screen → 'myan-shell' (all marks 0) to match zsh.
//   alt screen    → 'myan-std' (standard Mn=0 / Mc=1) to match the TUIs.
// isMyanmarMark = the full mark range (used for the all-0 shell provider and to
// mirror MARK() in the xterm patch). isMyanmarNonspacing = just the Mn subset.
function isMyanmarMark(c) {
  return (c >= 0x102b && c <= 0x103e) || (c >= 0x1056 && c <= 0x1059) ||
         (c >= 0x105e && c <= 0x1060) || (c >= 0x1062 && c <= 0x1064) ||
         (c >= 0x1067 && c <= 0x106d) || (c >= 0x1071 && c <= 0x1074) ||
         (c >= 0x1082 && c <= 0x108d) || c === 0x108f ||
         (c >= 0x109a && c <= 0x109d);
}

// Myanmar non-spacing marks (general category Mn) — width 0 in standard wcwidth.
// Everything else in the Myanmar block (incl. spacing marks Mc like ◌ာ ◌း ◌ြ) is
// width 1. NOTE: xterm's stock '6' table gets several of these wrong (it gives
// the asat ◌် U+103A, the medials ◌ွ ◌ှ, and others width 1), which desyncs every
// ◌်-ending syllable — hence this explicit Mn list instead of trusting base.
function isMyanmarNonspacing(c) {
  return (c >= 0x102d && c <= 0x1030) || (c >= 0x1032 && c <= 0x1037) ||
         c === 0x1039 || c === 0x103a || c === 0x103d || c === 0x103e ||
         (c >= 0x1058 && c <= 0x1059) || (c >= 0x105e && c <= 0x1060) ||
         (c >= 0x1071 && c <= 0x1074) || c === 0x1082 ||
         (c >= 0x1085 && c <= 0x1086) || c === 0x108d || c === 0x109d;
}

// Pack a width into xterm's charProperties value, joining a width-0 mark onto the
// preceding cell (so it shapes as one cluster). Mirrors xterm's default packing.
function packMyanProps(width, preceding) {
  let join = width === 0 && preceding !== 0;
  if (join) {
    const w = (preceding >> 1) & 3;            // extractWidth(preceding)
    if (w === 0) join = false;
    else if (w > width) width = w;
  }
  return ((width & 3) << 1) | (join ? 1 : 0);
}

function setupMarkWidth(term) {
  let base;
  try {
    // PRIVATE API: reaches into xterm's _core to wrap the active width provider.
    // Pinned to xterm v6 internals — a version bump that restructures
    // unicodeService/_providers will land in the catch below and silently fall
    // back to default widths. Re-derive this path when bumping xterm.
    base = term._core.unicodeService._providers[term.unicode.activeVersion];
  } catch (e) {
    return; // internals changed; fall back to the default.
  }
  if (!base) return;

  // Normal screen (zsh): every Myanmar mark width 0, joined onto the base.
  term.unicode.register({
    version: 'myan-shell',
    wcwidth: (c) => (isMyanmarMark(c) ? 0 : base.wcwidth(c)),
    charProperties: (c, preceding) =>
      packMyanProps(isMyanmarMark(c) ? 0 : base.wcwidth(c), preceding),
  });

  // Alt screen (TUIs): standard widths — non-spacing marks 0 (joined), spacing
  // marks 1. Matches iTerm2 and the apps' own wcwidth, so column counts agree.
  term.unicode.register({
    version: 'myan-std',
    wcwidth: (c) => (isMyanmarNonspacing(c) ? 0 : base.wcwidth(c)),
    charProperties: (c, preceding) =>
      packMyanProps(isMyanmarNonspacing(c) ? 0 : base.wcwidth(c), preceding),
  });

  const apply = () => {
    term.unicode.activeVersion =
      term.buffer.active.type === 'alternate' ? 'myan-std' : 'myan-shell';
  };
  term.buffer.onBufferChange(apply);
  apply();
}

// Shift+Enter: xterm sends a bare CR (0x0d, same as Enter), so TUIs like Claude
// Code can't distinguish it and treat it as submit. Send ESC+CR (meta+return)
// instead, which Claude Code reads as "insert newline".
function attachShiftEnter(term, ptyId) {
  term.attachCustomKeyEventHandler((e) => {
    if (
      e.type === 'keydown' &&
      e.code === 'Enter' &&
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      ipcRenderer.send('pty-input', { id: ptyId, data: '\x1b\r' });
      return false; // stop xterm from also sending a plain CR
    }
    return true;
  });
}

// --- Panes: one xterm + one pty session each --------------------------------
// xterm.js 6 uses the DOM renderer by default (canvas/webgl are opt-in addons).
// Cluster shaping is handled by the span-merge patch (patches/patch-xterm-myanmar.js).

const panesByPtyId = new Map();   // ptyId -> pane
// pty-data that arrives for a pane that isn't mounted yet (its term has no DOM
// and scrollback hasn't replayed). Happens during cross-window tab transfer:
// the pty is repointed to this window before adopt-tab builds the pane. Buffer
// here, drain in mountPane (after scrollback) so nothing is dropped or
// reordered. ptyId -> array of data chunks.
const pendingData = new Map();
const tabs = [];                  // ordered list of open tabs
let currentTab = null;
let activePane = null;
let counter = 0;
const nextId = (p) => p + '_' + WID + '_' + (++counter);

// `reattach` (optional): { ptyId, cwd, title, scrollback } — rebuild a pane for
// an ALREADY-RUNNING pty (a tab moved in from another window). When present we
// reuse its id, skip pty-create, and replay the captured scrollback on mount.
function createPane(tabId, cwd, reattach) {
  const ptyId = reattach ? reattach.ptyId : nextId('pty');
  // Inherit the current pane's directory so new tabs/splits open where you are.
  if (cwd === undefined && activePane) cwd = activePane.cwd;
  const t = themeFor(settings);

  const el = document.createElement('div');
  el.className = 'pane';
  const host = document.createElement('div');
  host.className = 'pane-term';
  el.appendChild(host);

  const term = new Terminal({
    cursorBlink: true,
    allowProposedApi: true,   // required for term.unicode (mark-width provider)
    fontFamily: fontFamilyFor(settings),
    fontSize: settings.fontSize,
    lineHeight: (SPACINGS[settings.spacing] || SPACINGS.normal).value,
    theme: xtermTheme(t),
    // OSC 8 hyperlinks (e.g. Claude Code's clickable file paths). xterm draws
    // the underline but won't act on click without a handler, and blocks
    // non-http links by default — so handle file:// ourselves.
    linkHandler: {
      allowNonHttpProtocols: true,
      activate(event, uri) {
        if (uri.startsWith('file://')) {
          // fileURLToPath handles percent-decoding and Windows drive paths
          // (file:///C:/x → C:\x) correctly; manual pathname parsing got both
          // wrong. Guard it — a malformed file URI must not throw here.
          let p;
          try {
            p = fileURLToPath(uri);
          } catch (e) {
            return;
          }
          shell.openPath(p);
          return;
        }
        // OSC 8 links are controlled by whatever runs in the shell, and
        // allowNonHttpProtocols disables xterm's own allowlist — so vet the
        // protocol ourselves and silently drop anything unexpected
        // (javascript:, vbscript:, …) before handing it to the OS.
        let protocol;
        try {
          protocol = new URL(uri).protocol;
        } catch (e) {
          return;
        }
        const allowed = ['http:', 'https:', 'mailto:', 'ftp:', 'ssh:'];
        if (allowed.includes(protocol)) shell.openExternal(uri);
      }
    }
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  const serializeAddon = new SerializeAddon();
  term.loadAddon(serializeAddon);
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);
  // Keep the find bar's match count in sync while this pane is the search target.
  searchAddon.onDidChangeResults((r) => { if (activePane === pane) updateFindCount(r); });
  attachShiftEnter(term, ptyId);
  term.onData((data) => ipcRenderer.send('pty-input', { id: ptyId, data }));

  const pane = {
    ptyId, tabId, el, host, term, fitAddon, serializeAddon, searchAddon,
    opened: false,
    title: reattach ? reattach.title : '',
    cwd: reattach ? reattach.cwd : '',
    _restore: reattach ? reattach.scrollback : null
  };
  panesByPtyId.set(ptyId, pane);

  // Focus this pane when its element is clicked.
  el.addEventListener('mousedown', () => setActivePane(pane));

  // Right-click → custom context menu (Copy when text is selected, Paste, splits).
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setActivePane(pane);
    showPaneMenu(e.clientX, e.clientY, pane);
  });

  // Drag & drop a file (or folder) onto a pane → type its full path (no cd,
  // no Enter) so it works in the shell and in TUIs like Claude Code.
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer.files[0];
    // Electron 32+ removed File.path; use webUtils.getPathForFile instead.
    const fpath = f ? (webUtils.getPathForFile(f) || f.path) : '';
    if (!fpath) return;
    setActivePane(pane);
    // Use term.paste so xterm emits bracketed-paste markers — TUIs like Claude
    // Code then treat it as pasted text instead of typed input.
    pane.term.paste(' ' + quoteShellPath(fpath));
  });

  // Shell title via OSC 0 (icon+title) / OSC 2 (title) — xterm parses both.
  term.onTitleChange((title) => { pane.title = title; onPaneTitleChanged(pane); });
  // Working directory via OSC 7 (file://host/path) for the title fallback.
  term.parser.registerOscHandler(7, (data) => {
    pane.cwd = parseOsc7(data);
    onPaneTitleChanged(pane);
    return true;
  });

  // A reattached pane's pty is already running in main — don't spawn a new one.
  if (!reattach) {
    ipcRenderer.send('pty-create', { id: ptyId, cols: 80, rows: 24, cwd: cwd || undefined });
  }
  return pane;
}

// Use fileURLToPath so Windows drive-letter URIs (file:///C:/x) decode to the
// native path (C:\x) correctly. Falls back to manual URL parsing if it fails.
function parseOsc7(data) {
  try { return fileURLToPath(data); } catch (e) {
    try { return decodeURIComponent(new URL(data).pathname); } catch (_) { return ''; }
  }
}
function basename(p) {
  if (!p) return '';
  // Handle both POSIX (/) and Windows (\) path separators.
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || (IS_WIN ? '' : '/');
}

// Open the terminal only once its element is attached to the document. xterm
// measures a character's pixel size at open() time; opening on a detached node
// measures ~0 and the DOM renderer then spreads every glyph with a huge
// letter-spacing. So this is called from renderTab(), after the DOM is in place.
function mountPane(pane) {
  if (pane.opened) return;
  pane.opened = true;
  pane.term.open(pane.host);
  // Restore scrollback for a tab that moved in from another window.
  if (pane._restore) {
    try { pane.term.write(pane._restore); } catch (e) { }
    pane._restore = null;
  }
  // Drain any pty output that arrived before this pane mounted — strictly after
  // the scrollback above so order is preserved.
  const queued = pendingData.get(pane.ptyId);
  if (queued) {
    pendingData.delete(pane.ptyId);
    for (const d of queued) { try { pane.term.write(d); } catch (e) { } }
  }
  setupMarkWidth(pane.term);
  pane.term.textarea.addEventListener('focus', () => setActivePane(pane));
  // Refit (and tell the pty) whenever the host's box changes — covers window
  // resize, divider drags, and a tab becoming visible.
  const ro = new ResizeObserver(() => fitPane(pane));
  ro.observe(pane.host);
  pane._ro = ro;
}

function fitPane(pane) {
  if (!pane.host.clientWidth || !pane.host.clientHeight) return; // hidden tab
  try {
    pane.fitAddon.fit();
    ipcRenderer.send('pty-resize', { id: pane.ptyId, cols: pane.term.cols, rows: pane.term.rows });
  } catch (e) { /* terminal not measurable yet */ }
}

function disposePane(pane) {
  try { if (pane._ro) pane._ro.disconnect(); } catch (e) { }
  ipcRenderer.send('pty-kill', { id: pane.ptyId });
  panesByPtyId.delete(pane.ptyId);
  try { pane.term.dispose(); } catch (e) { }
}

// Like disposePane but leaves the pty ALIVE — used when a tab moves to another
// window (the pty is reattached there). Tears down this window's view only.
function releasePane(pane) {
  try { if (pane._ro) pane._ro.disconnect(); } catch (e) { }
  // Drop any data buffered for this pty — once released, nothing in this window
  // will ever mount it to drain the buffer (it lives on in the target window).
  pendingData.delete(pane.ptyId);
  panesByPtyId.delete(pane.ptyId);
  try { pane.term.dispose(); } catch (e) { }
}

// Capture a pane's screen + scrollback as a string that can be written back into
// a fresh terminal. SerializeAddon keeps colors/SGR; if it ever misbehaves with
// this xterm build, fall back to plain text via the public buffer API.
function captureScrollback(pane) {
  try {
    return pane.serializeAddon.serialize();
  } catch (e) {
    let out = '';
    try {
      const b = pane.term.buffer.active;
      for (let i = 0; i < b.length; i++) {
        const line = b.getLine(i);
        if (line) out += line.translateToString(true) + '\r\n';
      }
    } catch (e2) { }
    return out;
  }
}

function setActivePane(pane) {
  if (activePane === pane) return;
  if (activePane) {
    activePane.el.classList.remove('active');
    // drop the old pane's match marks (no-op/throws if it's being disposed)
    try { activePane.searchAddon.clearDecorations(); } catch (e) { }
  }
  activePane = pane;
  if (pane) {
    pane.el.classList.add('active');
    const tab = tabs.find((x) => x.id === pane.tabId);
    if (tab) {
      tab.activePtyId = pane.ptyId;
      refreshTabTitle(tab); // the tab follows its active pane's title
    }
    // Re-run the search against the newly-focused pane if the find bar is open.
    if (isFindOpen()) runFind(false);
  }
}

// --- Tab titles -------------------------------------------------------------
// A tab shows its active pane's title (shell OSC 0/2), falling back to the
// pane's cwd basename (OSC 7), then "shell".
function activePaneOf(tab) {
  return panesByPtyId.get(tab.activePtyId) || leavesOf(tab.root)[0];
}
// Full, untruncated name — used for the tooltip and the OS window title.
function tabFullName(tab) {
  const p = activePaneOf(tab);
  if (!p) return 'shell';
  return p.title || basename(p.cwd) || 'shell';
}
// Short label shown in the (narrow) tab. Shell titles are often the whole path
// (user@host:~/a/b/c); keep only the last segment ("c"). Plain titles set by
// TUIs (e.g. "vim") have no "/" and pass through unchanged.
function tabDisplayName(tab) {
  const full = tabFullName(tab);
  return full.includes('/') ? (basename(full) || full) : full;
}
function refreshTabTitle(tab) {
  if (tab.titleEl) tab.titleEl.textContent = tabDisplayName(tab);
  if (tab.btnEl) tab.btnEl.title = tabFullName(tab);
  if (tab === currentTab) document.title = tabFullName(tab);
}
function onPaneTitleChanged(pane) {
  const tab = tabs.find((x) => x.id === pane.tabId);
  if (tab && tab.activePtyId === pane.ptyId) refreshTabTitle(tab);
}

function focusPane(pane) {
  setActivePane(pane);
  pane.term.focus();
}

// --- Split tree -------------------------------------------------------------
// A tab's layout is a binary tree. Leaf: { leaf:true, pane }. Split:
// { leaf:false, dir:'row'|'col', a, b, ratio } where 'row' = side-by-side
// (vertical divider, "split right") and 'col' = stacked ("split down").

function leavesOf(node, out = []) {
  if (node.leaf) out.push(node.pane);
  else { leavesOf(node.a, out); leavesOf(node.b, out); }
  return out;
}

function findParentOf(node, pane) {
  if (node.leaf) return null;
  if (node.a.leaf && node.a.pane === pane) return { parent: node, side: 'a' };
  if (node.b.leaf && node.b.pane === pane) return { parent: node, side: 'b' };
  return findParentOf(node.a, pane) || findParentOf(node.b, pane);
}

function renderNode(node) {
  if (node.leaf) return node.pane.el;

  const container = document.createElement('div');
  container.className = 'split split-' + node.dir;

  const wrapA = document.createElement('div');
  wrapA.className = 'split-child';
  wrapA.style.flex = `${node.ratio} 1 0`;
  wrapA.appendChild(renderNode(node.a));

  const wrapB = document.createElement('div');
  wrapB.className = 'split-child';
  wrapB.style.flex = `${1 - node.ratio} 1 0`;
  wrapB.appendChild(renderNode(node.b));

  const divider = document.createElement('div');
  divider.className = 'divider';
  attachDivider(divider, container, node, wrapA, wrapB);

  container.appendChild(wrapA);
  container.appendChild(divider);
  container.appendChild(wrapB);
  return container;
}

function attachDivider(divider, container, node, wrapA, wrapB) {
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const horiz = node.dir === 'row';
    document.body.classList.add('resizing');
    const onMove = (ev) => {
      const rect = container.getBoundingClientRect();
      let r = horiz ? (ev.clientX - rect.left) / rect.width
                    : (ev.clientY - rect.top) / rect.height;
      r = Math.max(0.1, Math.min(0.9, r));
      node.ratio = r;
      wrapA.style.flex = `${r} 1 0`;
      wrapB.style.flex = `${1 - r} 1 0`;
    };
    const onUp = () => {
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function renderTab(tab) {
  tab.el.innerHTML = '';
  tab.el.appendChild(renderNode(tab.root));
  const leaves = leavesOf(tab.root);
  // Now that the panes are attached, open any new terminals (correct glyph
  // measurement), then let flexbox settle and size each one.
  leaves.forEach(mountPane);
  requestAnimationFrame(() => leaves.forEach(fitPane));
}

// `before` true puts the new pane ahead of the active one (Split Left / Split Up).
function splitActive(dir, before) {
  if (!currentTab || !activePane) return;
  const found = findParentOf(currentTab.root, activePane);
  // Locate the leaf node holding the active pane (root itself if unsplit).
  let leaf;
  if (currentTab.root.leaf && currentTab.root.pane === activePane) {
    leaf = currentTab.root;
  } else if (found) {
    leaf = found.parent[found.side];
  } else {
    return;
  }

  const oldPane = leaf.pane;
  const newPane = createPane(currentTab.id);
  // Mutate the leaf in place into a split so parent references stay valid even
  // when the leaf is the tab root.
  leaf.leaf = false;
  leaf.dir = dir;
  leaf.ratio = 0.5;
  const oldNode = { leaf: true, pane: oldPane };
  const newNode = { leaf: true, pane: newPane };
  leaf.a = before ? newNode : oldNode;
  leaf.b = before ? oldNode : newNode;
  delete leaf.pane;

  renderTab(currentTab);
  focusPane(newPane);
}

function closePane(pane) {
  const tab = tabs.find((x) => x.id === pane.tabId);
  if (!tab) return;

  // Last pane in the tab -> close the whole tab.
  if (tab.root.leaf && tab.root.pane === pane) {
    closeTab(tab);
    return;
  }

  const found = findParentOf(tab.root, pane);
  if (!found) return;
  disposePane(pane);

  // Collapse the parent split into the surviving sibling.
  const sib = found.side === 'a' ? found.parent.b : found.parent.a;
  const parent = found.parent;
  if (sib.leaf) {
    parent.leaf = true;
    parent.pane = sib.pane;
    delete parent.dir; delete parent.a; delete parent.b; delete parent.ratio;
  } else {
    parent.dir = sib.dir;
    parent.ratio = sib.ratio;
    parent.a = sib.a;
    parent.b = sib.b;
    delete parent.pane;
  }

  if (tab === currentTab) {
    renderTab(tab);
    focusPane(leavesOf(tab.root)[0]);
  } else {
    renderTab(tab);
  }
}

// Move focus between panes of the current tab (Cmd+[ / Cmd+]).
function cyclePane(dir) {
  if (!currentTab) return;
  const leaves = leavesOf(currentTab.root);
  if (leaves.length < 2) return;
  let i = leaves.indexOf(activePane);
  if (i < 0) i = 0;
  focusPane(leaves[(i + dir + leaves.length) % leaves.length]);
}

// --- Tabs -------------------------------------------------------------------

function newTab(cwd) {
  const tab = {
    id: nextId('tab'),
    el: document.createElement('div'),
    root: null,
    activePtyId: null
  };
  tab.el.className = 'tab-pane-area';
  document.getElementById('panes').appendChild(tab.el);

  const pane = createPane(tab.id, cwd);
  tab.root = { leaf: true, pane };
  tab.activePtyId = pane.ptyId;
  tabs.push(tab);

  renderTabBar();
  renderTab(tab);
  selectTab(tab);
  focusPane(pane);
}

function selectTab(tab) {
  currentTab = tab;
  for (const t of tabs) t.el.style.display = t === tab ? 'flex' : 'none';
  renderTabBar();
  refreshTabTitle(tab); // update the window title bar for the shown tab
  // Re-focus the tab's last-active pane (or its first).
  const pane = panesByPtyId.get(tab.activePtyId) || leavesOf(tab.root)[0];
  // Defer so the now-visible panes get measured before fitting/focusing.
  requestAnimationFrame(() => {
    leavesOf(tab.root).forEach(fitPane);
    if (pane) focusPane(pane);
  });
}

function closeTab(tab) {
  leavesOf(tab.root).forEach(disposePane);
  tab.el.remove();
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    ipcRenderer.send('close-window');
    return;
  }
  if (currentTab === tab) {
    selectTab(tabs[Math.min(idx, tabs.length - 1)]);
  } else {
    renderTabBar();
  }
}

// --- Moving a tab between windows -------------------------------------------
// A tab is serialized to a plain descriptor (no DOM/term refs) so it can cross
// the IPC boundary; the pty itself stays alive in main and is reattached in the
// destination window.

function serializeNode(node) {
  if (node.leaf) {
    const p = node.pane;
    return { leaf: true, pane: { ptyId: p.ptyId, cwd: p.cwd, title: p.title, scrollback: captureScrollback(p) } };
  }
  return { leaf: false, dir: node.dir, ratio: node.ratio, a: serializeNode(node.a), b: serializeNode(node.b) };
}

function buildTabDescriptor(tab) {
  return {
    tabId: tab.id,
    title: tabDisplayName(tab),
    tree: serializeNode(tab.root),
    ptyIds: leavesOf(tab.root).map((p) => p.ptyId)
  };
}

function rebuildTree(descNode, tabId) {
  if (descNode.leaf) return { leaf: true, pane: createPane(tabId, undefined, descNode.pane) };
  return {
    leaf: false, dir: descNode.dir, ratio: descNode.ratio,
    a: rebuildTree(descNode.a, tabId), b: rebuildTree(descNode.b, tabId)
  };
}

// Build a tab in THIS window from a descriptor moved in from another window.
function adoptTab(descriptor) {
  const tab = { id: nextId('tab'), el: document.createElement('div'), root: null, activePtyId: null };
  tab.el.className = 'tab-pane-area';
  document.getElementById('panes').appendChild(tab.el);
  tab.root = rebuildTree(descriptor.tree, tab.id);
  const first = leavesOf(tab.root)[0];
  tab.activePtyId = first ? first.ptyId : null;
  tabs.push(tab);
  renderTabBar();
  renderTab(tab);
  selectTab(tab);
  if (first) focusPane(first);
  // Ack with the SOURCE tab id so main can now tell the source to remove it.
  ipcRenderer.send('tab-adopted', { tabId: descriptor.tabId });
}

// Remove a tab that has moved to another window — tear down the view but leave
// its ptys running (they were reattached elsewhere).
function removeTabKeepPtys(tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  leavesOf(tab.root).forEach(releasePane);
  tab.el.remove();
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  if (tabs.length === 0) { ipcRenderer.send('close-window'); return; }
  if (currentTab === tab) selectTab(tabs[Math.min(idx, tabs.length - 1)]);
  else renderTabBar();
}

// Start a custom drag when a tab is pressed and the cursor moves past a small
// threshold. Cross-window routing is decided by main (screen coordinates); here
// we just announce the drag, follow the cursor with a ghost, and signal release.
function startTabDrag(tab, downEvent) {
  const startX = downEvent.clientX, startY = downEvent.clientY;
  let active = false;
  let ghost = null;

  const onMove = (e) => {
    if (!active) {
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 6) return;
      active = true;
      const descriptor = buildTabDescriptor(tab);
      ipcRenderer.send('tab-drag-start', { descriptor, ptyIds: descriptor.ptyIds });
      ghost = document.createElement('div');
      ghost.className = 'tab-drag-ghost';
      ghost.textContent = tabDisplayName(tab);
      document.body.appendChild(ghost);
    }
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (ghost) ghost.remove();
    if (active) ipcRenderer.send('tab-drag-end');
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function renderTabBar() {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === currentTab ? ' active' : '');

    const label = document.createElement('span');
    label.textContent = tabDisplayName(tab);
    el.appendChild(label);
    el.title = tabFullName(tab);
    tab.titleEl = label;   // refreshTabTitle() updates these in place
    tab.btnEl = el;

    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeTab(tab);
    });
    el.appendChild(close);

    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      selectTab(tab);
      startTabDrag(tab, e);
    });
    bar.appendChild(el);
  });
  // Keep the app menu's "Go to Tab N" list in sync with the open tabs.
  ipcRenderer.send('tab-count', tabs.length);
}

// --- Global pty + menu wiring ----------------------------------------------

ipcRenderer.on('pty-data', (event, { id, data }) => {
  const pane = panesByPtyId.get(id);
  if (pane && pane.opened) {
    pane.term.write(data);
  } else {
    // Pane not built or not mounted yet (cross-window transfer in flight).
    // Buffer; mountPane drains it after scrollback replay.
    let q = pendingData.get(id);
    if (!q) { q = []; pendingData.set(id, q); }
    q.push(data);
  }
});
ipcRenderer.on('pty-exit', (event, { id }) => {
  pendingData.delete(id);
  const pane = panesByPtyId.get(id);
  if (pane) closePane(pane);
});

ipcRenderer.on('adopt-tab', (event, { descriptor }) => adoptTab(descriptor));
ipcRenderer.on('remove-tab', (event, { tabId }) => removeTabKeepPtys(tabId));
ipcRenderer.on('tab-drag-over', (event, { active }) => {
  document.getElementById('tabbar').classList.toggle('drop-target', active);
});

// --- Pane right-click context menu ------------------------------------------
// A single floating menu element, reused for every pane. Built on demand.
function copyPane(pane) {
  const sel = pane && pane.term.getSelection();
  if (sel) clipboard.writeText(sel);
}
function pastePane(pane) {
  const text = clipboard.readText();
  // term.paste emits bracketed-paste markers so TUIs treat it as pasted text.
  if (text) pane.term.paste(text);
}

// Inline SVG icons (currentColor) for the menu rows. The split icons fill the
// half of a rounded rect that the new pane will occupy.
const MENU_ICONS = {
  copy: '<rect x="6" y="6" width="9" height="9" rx="2"/><path d="M11 3H5a2 2 0 0 0-2 2v6"/>',
  paste: '<rect x="4" y="4" width="11" height="12" rx="2"/><path d="M7 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/>',
  'split-right': '<rect x="3" y="4" width="13" height="11" rx="2"/><rect x="10" y="4" width="6" height="11" rx="2" fill="currentColor" stroke="none"/>',
  'split-left': '<rect x="3" y="4" width="13" height="11" rx="2"/><rect x="3" y="4" width="6" height="11" rx="2" fill="currentColor" stroke="none"/>',
  'split-down': '<rect x="3" y="4" width="13" height="11" rx="2"/><rect x="3" y="10" width="13" height="5" rx="2" fill="currentColor" stroke="none"/>',
  'split-up': '<rect x="3" y="4" width="13" height="11" rx="2"/><rect x="3" y="4" width="13" height="5" rx="2" fill="currentColor" stroke="none"/>'
};
const svgIcon = (name) =>
  '<svg class="pane-menu-icon" viewBox="0 0 19 19" fill="none" stroke="currentColor" stroke-width="1.4">' +
  (MENU_ICONS[name] || '') + '</svg>';

let paneMenuEl = null;
function hidePaneMenu() {
  if (paneMenuEl) { paneMenuEl.remove(); paneMenuEl = null; }
}
function showPaneMenu(x, y, pane) {
  hidePaneMenu();
  const hasSel = !!(pane.term.getSelection());
  const items = [];
  if (hasSel) items.push({ label: 'Copy', icon: 'copy', action: () => copyPane(pane) });
  items.push({ label: 'Paste', icon: 'paste', action: () => pastePane(pane) });
  items.push({ sep: true });
  items.push({ label: 'Split Right', icon: 'split-right', action: () => splitActive('row', false) });
  items.push({ label: 'Split Left', icon: 'split-left', action: () => splitActive('row', true) });
  items.push({ label: 'Split Down', icon: 'split-down', action: () => splitActive('col', false) });
  items.push({ label: 'Split Up', icon: 'split-up', action: () => splitActive('col', true) });

  const menu = document.createElement('div');
  menu.className = 'pane-menu';
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'pane-menu-sep';
      menu.appendChild(s);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'pane-menu-item';
    row.innerHTML = svgIcon(it.icon) + '<span>' + it.label + '</span>';
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hidePaneMenu();
      it.action();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  paneMenuEl = menu;

  // Keep the menu inside the viewport.
  const r = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 4);
  const py = Math.min(y, window.innerHeight - r.height - 4);
  menu.style.left = Math.max(4, px) + 'px';
  menu.style.top = Math.max(4, py) + 'px';
}
// Dismiss on any outside click, scroll, resize, or Escape.
window.addEventListener('mousedown', () => hidePaneMenu());
window.addEventListener('blur', () => hidePaneMenu());
window.addEventListener('resize', () => hidePaneMenu());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePaneMenu(); });

ipcRenderer.on('new-tab', () => newTab());
ipcRenderer.on('open-folder', (event, { path }) => newTab(path));
ipcRenderer.on('close-pane', () => { if (activePane) closePane(activePane); });
ipcRenderer.on('split-right', () => splitActive('row'));
ipcRenderer.on('split-down', () => splitActive('col'));
ipcRenderer.on('focus-prev', () => cyclePane(-1));
ipcRenderer.on('focus-next', () => cyclePane(1));
ipcRenderer.on('select-tab', (event, i) => { if (tabs[i]) selectTab(tabs[i]); });

// --- Settings panel ---------------------------------------------------------

function applySettings(s) {
  const t = themeFor(s);
  const family = fontFamilyFor(s);
  const lineHeight = (SPACINGS[s.spacing] || SPACINGS.normal).value;
  for (const pane of panesByPtyId.values()) {
    pane.term.options.theme = xtermTheme(t);
    pane.term.options.fontFamily = family;
    pane.term.options.fontSize = s.fontSize;
    pane.term.options.lineHeight = lineHeight;
  }
  // Match the surrounding chrome to the theme.
  document.documentElement.style.background = t.background;
  document.body.style.background = t.background;
  applyUiVars(t);
  // Refit the visible tab to the new metrics.
  if (currentTab) leavesOf(currentTab.root).forEach(fitPane);
}

// Push the theme's `ui` palette into CSS variables that the settings panel
// (index.html) reads, so the panel re-tints with the terminal.
function applyUiVars(t) {
  const ui = t.ui;
  const v = document.documentElement.style;
  v.setProperty('--overlay-bg', ui.modalOverlay);
  v.setProperty('--panel-top', ui.panelTop);
  v.setProperty('--panel-bottom', ui.panelBottom);
  v.setProperty('--panel-fg', t.foreground);
  v.setProperty('--panel-border', ui.border);
  v.setProperty('--panel-muted', ui.muted);
  v.setProperty('--control-bg', ui.controlBg);
  v.setProperty('--control-hover', ui.controlHover);
  v.setProperty('--accent', ui.accent);
  v.setProperty('--apply-bg', ui.applyBg);
  v.setProperty('--apply-bg-hover', ui.applyBgHover);
  v.setProperty('--apply-border', ui.applyBorder);
  v.setProperty('--apply-fg', ui.applyFg);
  // Chrome / tab bar / pane background.
  v.setProperty('--chrome-top', ui.chromeTop);
  v.setProperty('--tab-bg-active', ui.tabBgActive);
  v.setProperty('--term-bg', t.background);
  v.setProperty('--pane-dim', ui.paneDim);
}

// Tag the body so CSS can reserve space for the macOS traffic lights.
if (process.platform === 'darwin') document.body.classList.add('mac');

// Fix platform-specific shortcut labels in the UI.
const modKey = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
document.getElementById('tab-add').title = `New tab (${modKey}+T)`;

// Apply theme vars once on load (before any pane exists, so the chrome is themed).
applySettings(settings);

const overlay = document.getElementById('settings-overlay');
const themeSel = document.getElementById('set-theme');
const fontSel = document.getElementById('set-font');
const customFontRow = document.getElementById('custom-font-row');
const customFontInput = document.getElementById('set-custom-font');
const sizeInput = document.getElementById('set-size');
const sizeValue = document.getElementById('size-value');
const spacingSel = document.getElementById('set-spacing');

// Populate selects from the maps.
for (const t of THEME_LIST) {
  const o = document.createElement('option');
  o.value = t.id;
  o.textContent = t.label;
  themeSel.appendChild(o);
}
for (const [key, f] of Object.entries(FONTS)) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = f.name;
  fontSel.appendChild(o);
}
for (const [key, sp] of Object.entries(SPACINGS)) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = sp.name;
  spacingSel.appendChild(o);
}

// Edits are staged in `draft` while the panel is open and only committed to
// `settings` (saved + applied to the terminal) on "Save & Apply". Closing or
// Escape discards the draft.
let draft = settings;

function syncControls() {
  themeSel.value = draft.theme;
  fontSel.value = draft.font;
  customFontInput.value = draft.customFont;
  customFontRow.classList.toggle('hidden', draft.font !== 'custom');
  sizeInput.value = draft.fontSize;
  sizeValue.textContent = draft.fontSize;
  spacingSel.value = draft.spacing;
}

// Update the draft only — no save, no live apply.
function edit(patch) {
  draft = Object.assign({}, draft, patch);
  syncControls();
}

themeSel.addEventListener('change', () => edit({ theme: themeSel.value }));
fontSel.addEventListener('change', () => edit({ font: fontSel.value }));
customFontInput.addEventListener('input', () => edit({ customFont: customFontInput.value }));
sizeInput.addEventListener('input', () => {
  // An empty/non-numeric slider value yields NaN, which would poison
  // localStorage and set xterm fontSize = NaN. Drop it.
  const n = parseInt(sizeInput.value, 10);
  if (!isNaN(n)) edit({ fontSize: n });
});
spacingSel.addEventListener('change', () => edit({ spacing: spacingSel.value }));

// --- System monospaced fonts ------------------------------------------------
// Populate the Font dropdown from the fonts actually installed on this machine
// (via the Local Font Access API), keeping only monospaced families. Falls back
// to the built-in FONTS list when unsupported / denied / no user gesture.
let systemFontsLoaded = false;
let measureCtx = null;

// A family is monospaced when narrow and wide glyphs render at the same width.
function isMonospaceFamily(family) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  const ctx = measureCtx;
  ctx.font = `48px "${family.replace(/"/g, '')}"`;
  const w = (ch) => ctx.measureText(ch).width;
  const widths = [w('i'), w('l'), w('W'), w('m'), w('@')];
  const max = Math.max(...widths), min = Math.min(...widths);
  return max > 0 && (max - min) < 0.5;
}

// Map a saved built-in key (e.g. 'menlo') to the matching system family name
// now that the dropdown lists real families.
function migrateFontKey(key, families) {
  if (key === 'custom') return 'custom';
  if (families.includes(key)) return key;
  const f = FONTS[key];
  if (f && families.includes(f.name)) return f.name;
  return families.length ? families[0] : key;
}

function rebuildFontOptions(families) {
  // Register each family so fontFamilyFor() resolves it (Myanmar fallback added
  // there, same as the built-ins).
  for (const fam of families) FONTS[fam] = { name: fam, family: `"${fam}"` };
  fontSel.innerHTML = '';
  for (const fam of families) {
    const o = document.createElement('option');
    o.value = fam;
    o.textContent = fam;
    fontSel.appendChild(o);
  }
  const co = document.createElement('option');
  co.value = 'custom';
  co.textContent = 'Custom…';
  fontSel.appendChild(co);
}

async function loadSystemFonts() {
  if (systemFontsLoaded) return;
  if (typeof window.queryLocalFonts !== 'function') return; // unsupported
  let fonts;
  try {
    fonts = await window.queryLocalFonts();
  } catch (e) {
    return; // denied or no user gesture — keep the built-in list
  }
  const families = [...new Set(fonts.map((f) => f.family))]
    .filter(isMonospaceFamily)
    .sort((a, b) => a.localeCompare(b));
  if (!families.length) return;
  systemFontsLoaded = true;
  rebuildFontOptions(families);
  // Reflect the (possibly migrated) selection in the now-rebuilt dropdown.
  draft = Object.assign({}, draft, { font: migrateFontKey(draft.font, families) });
  syncControls();
}

function openSettings() {
  draft = Object.assign({}, settings); // start from the active settings
  syncControls();
  overlay.classList.add('open');
  loadSystemFonts(); // lazily replace built-ins with installed monospaced fonts
}
function applyAndClose() {
  settings = Object.assign({}, draft);
  saveSettings(settings);
  applySettings(settings);
  closeSettings();
}
function closeSettings() {
  overlay.classList.remove('open');
  if (activePane) activePane.term.focus();
}

document.getElementById('settings-apply').addEventListener('click', applyAndClose);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-x').addEventListener('click', closeSettings);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlay.classList.contains('open')) closeSettings();
});

// A drop landing outside a pane would otherwise make Electron navigate the
// whole window to the file. Swallow those.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

ipcRenderer.on('open-settings', openSettings);

// --- Font size shortcuts (Cmd+= / Cmd+- / Cmd+0) ----------------------------
// Adjust the live font size, persist it, and keep the settings panel in sync.
const MIN_FONT = 6;
const MAX_FONT = 72;
function changeFontSize(next) {
  const size = Math.max(MIN_FONT, Math.min(MAX_FONT, next));
  if (size === settings.fontSize) return;
  settings.fontSize = size;
  saveSettings(settings);
  applySettings(settings);
  // Keep the settings panel in sync if it's open (its draft is committed on Save).
  if (overlay.classList.contains('open')) edit({ fontSize: size });
}
ipcRenderer.on('font-inc', () => changeFontSize(settings.fontSize + 1));
ipcRenderer.on('font-dec', () => changeFontSize(settings.fontSize - 1));
ipcRenderer.on('font-reset', () => changeFontSize(DEFAULTS.fontSize));

// --- Find (Cmd+F) -----------------------------------------------------------
// A floating bar that searches the ACTIVE pane via @xterm/addon-search. Match
// highlighting uses the addon's decorations (separate overlay nodes, so the
// Myanmar span-merge patch doesn't interfere).
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
const FIND_DECORATIONS = {
  matchBackground: '#5c4b00',
  matchBorder: '#b89500',
  matchOverviewRuler: '#b89500',
  activeMatchBackground: '#e0a000',
  activeMatchBorder: '#ffffff',
  activeMatchColorOverviewRuler: '#e0a000'
};
const findOpts = () => ({ caseSensitive: false, decorations: FIND_DECORATIONS });

const isFindOpen = () => findBar.classList.contains('open');

function updateFindCount(r) {
  const term = findInput.value;
  if (!term) { findCount.textContent = ''; return; }
  if (!r || r.resultCount === 0) { findCount.textContent = 'No results'; return; }
  findCount.textContent = (r.resultIndex >= 0 ? r.resultIndex + 1 : 1) + '/' + r.resultCount;
}

// Run the search on the active pane. `forward` true = findNext, false = re-run
// from the current position (used when the term changes or the pane switches).
function runFind(forward) {
  if (!activePane) return;
  const term = findInput.value;
  if (!term) { activePane.searchAddon.clearDecorations(); updateFindCount(null); return; }
  activePane.searchAddon.findNext(term, findOpts());
}

function findNext() { if (activePane && findInput.value) activePane.searchAddon.findNext(findInput.value, findOpts()); }
function findPrev() { if (activePane && findInput.value) activePane.searchAddon.findPrevious(findInput.value, findOpts()); }

function openFind() {
  findBar.classList.add('open');
  // Seed with the terminal's selection, if any.
  const sel = activePane && activePane.term.getSelection();
  if (sel && !sel.includes('\n')) findInput.value = sel;
  findInput.focus();
  findInput.select();
  runFind(false);
}

function closeFind() {
  findBar.classList.remove('open');
  if (activePane) activePane.searchAddon.clearDecorations();
  findCount.textContent = '';
  if (activePane) activePane.term.focus();
}

findInput.addEventListener('input', () => runFind(false));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? findPrev() : findNext(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
document.getElementById('find-next').addEventListener('click', findNext);
document.getElementById('find-prev').addEventListener('click', findPrev);
document.getElementById('find-close').addEventListener('click', closeFind);

ipcRenderer.on('find', openFind);

// Drop the traffic-light padding when fullscreen (lights are hidden then).
ipcRenderer.on('fullscreen', (event, on) => {
  document.body.classList.toggle('fullscreen', on);
});

// "+" in the tab bar opens a new tab.
document.getElementById('tab-add').addEventListener('click', () => newTab());

// Open the first tab. If launched by dropping a folder on the dock icon, main
// passes it via --myanso-open= so the first tab starts there instead of $HOME.
const openArg = (process.argv.find((a) => a.startsWith('--myanso-open=')) || '').split('=').slice(1).join('=');
newTab(openArg || undefined);
