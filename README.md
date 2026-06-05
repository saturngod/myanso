# Myanso

![Myanso icon](icon.png)

A desktop terminal that renders **Myanmar (Burmese) text correctly** — something
stock terminals and stock xterm.js get wrong because they split a Burmese
grapheme cluster (base + medials + asat + vowel signs) across separate cells, so
the font can never shape it.

Myanso is a normal PTY terminal — tabs, split panes, multiple windows, search,
clickable links — built on **Electron** + **xterm.js 6**. Its one special trick
is getting Myanmar shaping *and* column alignment right across the shell, full
‑screen TUIs (vim), and AI CLIs (Claude Code, agy).

> Goal: **correct Myanmar text over perfect monospace alignment.** Where the two
> conflict, Myanso favors readable text.

## Features

- **Correct Myanmar rendering** — full clusters (e.g. `မြန်မာ`, `ဘူး`, `တို့`)
  shape as one unit instead of breaking into `မ ြ န ်`.
- **Per-app width handling** — different programs disagree on how wide a Myanmar
  mark is; Myanso detects the foreground app and matches it, so the cursor and
  columns stay aligned in zsh, vim, agy, and Claude Code (see below).
- **Tabs & split panes** — split any pane right/down into a binary tree, with
  draggable dividers.
- **Multiple windows** — `Cmd+N`, and you can **drag a tab between windows** (or
  drop it on the desktop to tear it into a new window). PTYs survive the move.
- **Search** — `Cmd+F` floating find bar, per-pane, with match decorations.
- **Clickable links** — OSC 8 hyperlinks and URLs open on click (`file://` via
  the OS, others in the browser).
- **Smart titles** — tab titles follow the working directory via OSC 7.
- **Settings** — theme, font, font size, letter-spacing; live-applied and
  persisted.
- **macOS niceties** — drop a folder on the dock icon to open a terminal there;
  drop an image into a session to paste its path.
- **Cross-platform builds** — macOS (DMG), Windows (NSIS), Linux (AppImage).

## How Myanmar rendering works

There are two independent problems — **shaping** and **width** — solved in two
different places.

### 1. Shaping (the xterm patch)

`patches/patch-xterm-myanmar.js` patches the minified `@xterm/xterm` build so the
DOM renderer collapses a run of same-style cells into a **single `<span>`**,
letting the browser shape the whole Burmese cluster. (Stock xterm gives every
cell its own span with its own `letter-spacing`, which cuts clusters apart.) The
patch is idempotent and re-runs on every `npm install`. It is **pinned to xterm
v6.0.0** — a version bump changes the minified identifiers and the patch will
hard-fail until the find/replace strings are re-derived.

### 2. Width (per-app, in the renderer)

Apps disagree on how many columns a Myanmar mark takes, and **no single width
satisfies all of them**, so Myanso registers three width providers per terminal
and switches between them based on the screen and the foreground process:

| Provider | Marks | Used for |
|---|---|---|
| `myan-shell` | all marks width **0** (joined onto the base) | zsh / shell (macOS `wcwidth` counts marks as 0) |
| `myan-std` | non-spacing (Mn) **0**, spacing (Mc, e.g. `ာ း ြ`) **1** | vim, agy, iTerm2 — the Unicode standard |
| `myan-allone` | every mark width **1** (own cell) | Claude Code (it counts all marks as 1) |

The main process polls each PTY's foreground process (`node-pty`'s `.process`)
and tells the renderer; the renderer picks the provider. Claude Code is detected
by its terminal title (`Claude Code`) or its version-string process title (e.g.
`2.1.165`), with a guard so a stale title doesn't stick after it exits.

### 3. Synchronized output

Some TUIs wrap each keystroke echo in DEC mode **2026** (synchronized output).
xterm.js 6 has a bug where a combining mark that joins a cell *inside* a 2026
block doesn't repaint, so the mark silently disappears while typing. Myanso
**strips the 2026 markers** from PTY output, which sidesteps the bug; the
rAF-debounced renderer already batches frames, so there's no flicker cost.

### Known limits

- **vim `'maxcombine'`** defaults to **2** — it only *draws* 2 combining marks
  per base, so a 3-mark syllable like `တို့` shows as `တို` (the file is still
  correct). Fix it in vim: `set maxcombine=6`.
- Column alignment of wide/proportional glyphs can drift slightly — the
  deliberate trade-off for correct shaping.

## Architecture

Four files, no build step:

```
keystroke → renderer.js (xterm onData) → IPC pty-input → main.js → node-pty
node-pty data → main.js (coalesce + strip 2026) → IPC pty-data → renderer.js → xterm
```

- **`main.js`** — Electron main process. One `node-pty` per pane in a module-level
  `ptys` map; PTYs **outlive** their window so tabs can move between windows.
  Handles multi-window, the app menu (accelerators work even while xterm holds
  focus), cross-window tab drag (by screen coordinates, since HTML5 DnD can't
  cross windows), the foreground-process poller, and the mode-2026 strip. Uses
  `nodeIntegration` so the renderer can `require()` node-pty/xterm directly.
- **`renderer.js`** — the entire UI: tab bar, split-pane tree, settings, find,
  links, and all xterm wiring, including the per-app Myanmar width logic
  (`setupMarkWidth`, `paneWantsAllOne`).
- **`index.html`** — markup and styles.
- **`patches/patch-xterm-myanmar.js`** — the shaping patch (see above).

For a deeper, code-level tour see [CLAUDE.md](CLAUDE.md).

## Commands

```bash
npm install          # deps + postinstall (electron-rebuild + apply the patch)
npm start            # launch the app
npm run rebuild      # rebuild node-pty against Electron's ABI
npm run patch-xterm  # re-apply the Myanmar shaping patch (idempotent)
npm run dist         # build a distributable (DMG / NSIS / AppImage)
```

There are no tests or linter — verification is manual: type and paste Myanmar
text in the shell, in vim, and in a TUI like Claude Code or agy.

## Install

Grab the latest build from the [Releases](../../releases) page.

**macOS** (unsigned): drag `Myanso.app` to `/Applications`, then clear the
quarantine flag:

```bash
xattr -d com.apple.quarantine /Applications/Myanso.app
```

## Development

Requires [Node.js](https://nodejs.org/) 18+.

```bash
git clone https://github.com/saturngod/myanso.git
cd myanso
npm install
npm start
```

> Never run `npm install` with `sudo` — it leaves `~/Library/Caches/electron`
> and `node_modules/node-pty/build` owned by `root`. If Electron fails to launch,
> `sudo rm -rf ~/Library/Caches/electron`, then `npm install` again.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+N` | New window |
| `Cmd+T` | New tab |
| `Cmd+W` | Close pane / tab |
| `Cmd+D` | Split right |
| `Cmd+Shift+D` | Split down |
| `Cmd+[` / `Cmd+]` | Previous / next pane |
| `Cmd+1`–`9` | Go to tab |
| `Cmd+F` | Find |
| `Cmd+,` | Settings |
| `Cmd+ +` / `Cmd+ -` / `Cmd+0` | Font size up / down / reset |

(`Ctrl` on Windows/Linux.)

## Contributing

Contributions welcome — especially **Linux/Windows testing** and Myanmar edge
cases. If you hit a cluster that renders wrong, note the app you were in (shell /
vim / which CLI) and the exact text — width bugs are almost always app-specific.

## License

MIT
