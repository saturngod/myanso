# Myanso

![](icon_small.png)

A Myanmar-aware desktop terminal emulator built with **Electron**, **xterm.js**, and **TypeScript**. Myanso provides first-class support for Myanmar (Burmese) Unicode text rendering with correct glyph layout for multi-codepoint syllables.

## Features

- **Myanmar text rendering** — Custom HTML-based renderer that correctly handles Myanmar combining marks (U+102B–U+109C) so syllables display as single cells
- **Tabs** — Multiple terminal sessions in a single window
- **Split panes** — Horizontally or vertically split any pane, with draggable dividers
- **Drag-and-drop folders** — Drop a folder onto the dock icon to open a terminal there (macOS)
- **Clickable links** — URLs in terminal output are clickable
- **Cross-platform builds** — macOS (DMG), Windows (NSIS), Linux (AppImage)

> **Note:** Performance is not the primary focus — the goal is correct Myanmar text display.

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
