# Myanso

![](icon_small.png)

A Myanmar-aware desktop terminal emulator built with **Electron**, **xterm.js**, and **TypeScript**. Myanso provides first-class support for Myanmar (Burmese) Unicode text rendering with correct glyph layout for multi-codepoint syllables.

## Features

- **Myanmar text rendering** — Custom HTML-based renderer that correctly handles Myanmar combining marks (U+102B–U+109C) so syllables display as single cells
- **Tabs** — Multiple terminal sessions in a single window
- **Split panes** — Horizontally or vertically split any pane, with draggable dividers
- **Drag-and-drop** — Drop a folder onto the dock icon to open a terminal there, or drop an image into a session (macOS)
- **Clickable links** — `Cmd`-hover highlights URLs in terminal output; `Cmd`-click opens them
- **Search** — Find text within the terminal buffer
- **Cross-platform builds** — macOS (DMG), Windows (NSIS), Linux (AppImage)

> **Note:** Performance is not the primary focus — the goal is correct Myanmar text display.

## How Myanso Works

Myanso uses Electron's three-process model. Each process is a separate TypeScript module with its own config.

```
Keystroke → TabManager → window.pty.write() → IPC → pty.ts → node-pty shell
node-pty output → pty.ts (setImmediate coalesce) → IPC → TabManager → PaneSession → HTML render
```

### Main process (`src/main/`)

- **index.ts** — Creates the `BrowserWindow`, the application menu (new tab, split, close pane), and handles app lifecycle.
- **pty.ts** — The PTY host. Spawns `node-pty` shell sessions keyed by string IDs, coalesces burst output with `setImmediate`, and multiplexes the streams over IPC.

### Preload script (`src/preload/index.ts`)

Exposes a typed `window.pty` API to the renderer through `contextBridge` — `spawn`, `ready`, `write`, `resize`, `kill`, plus `onData` / `onExit` / `onMenu` listeners. This is the only bridge between the sandboxed renderer and Node.

### Renderer process (`src/renderer/myanso.ts`)

All terminal UI logic lives here:

- **PaneSession** — Wraps an xterm.js `Terminal` in a *hidden* div used only for ANSI parsing and cursor tracking. It then mirrors the parsed output into a *visible* `.output` div as HTML spans with inline colors/styles. This custom HTML rendering — instead of xterm's built-in DOM — is what makes correct Myanmar glyph layout possible.
- **Leaf / Branch** — A recursive pane tree. A `Leaf` holds one `PaneSession`; a `Branch` holds left/right or top/bottom children separated by a draggable divider (Pointer Capture API).
- **Tab** — Manages one pane tree and handles splits and pane removal.
- **TabManager** — Owns all tabs, routes incoming PTY data to the correct `Leaf` by `ptyId`, and handles keyboard shortcuts.

### Myanmar text support

The `Unicode11Addon` is loaded with a custom `wcwidth` override: combining marks in the range **U+102B–U+109C** return width `0`, so a multi-codepoint Myanmar syllable renders inside a single cell. The font stack prioritizes *Noto Sans Myanmar*, *Myanmar Sangam MN*, then *Myanmar MN*.

## Installation

### Download

Grab the latest release from the [Releases](../../releases) page.

### macOS

Drag `Myanso.app` to `/Applications`, then run:

```bash
xattr -d com.apple.quarantine /Applications/Myanso.app
```

**This is required because the app is unsigned.**

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- macOS (Linux contributors welcome)

### Setup

```bash
git clone https://github.com/saturngod/myanso.git
cd myanso
npm install       # installs deps + auto-rebuilds node-pty native module
```

### Commands

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile all modules to `out/` |
| `npm run typecheck` | Type-check all TypeScript |
| `npm run dist` | Build distributable (DMG / NSIS / AppImage) |
| `npm run rebuild` | Manually rebuild node-pty native module |

### Troubleshooting

**`Error: Electron uninstall`** when running `npm run dev`

This means the Electron binary failed to download/extract — usually because
`~/Library/Caches/electron` (macOS) is owned by `root` from a previous
`sudo npm install`. Remove the cache and reinstall so it's recreated under
your user:

```bash
sudo rm -rf ~/Library/Caches/electron
node node_modules/electron/install.js   # re-download + extract the binary
npm run rebuild                          # rebuild node-pty for this Electron
```

> Never run `npm install` with `sudo` — that's what leaves the cache (and
> `node_modules/node-pty/build`) owned by `root` and causes this in the first
> place.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+T` | New tab |
| `Cmd+W` | Close pane |
| `Cmd+D` | Split pane right |
| `Cmd+Shift+D` | Split pane down |
| `Cmd+1`–`9` | Jump to tab by index |
| `Cmd+Option+Arrow` | Navigate to nearest pane |

## Contributing

Contributions are welcome — especially for **Linux support**!

## License

MIT
