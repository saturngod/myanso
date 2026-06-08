#!/usr/bin/env node
/*
 * Myanmar (and other complex-script) shaping fix for xterm.js 6 DOM renderer.
 *
 * Problem: the DOM renderer measures every glyph and sets a per-glyph
 * `letter-spacing` to force it onto the monospace grid. Because each Myanmar
 * glyph (base + medial ◌ြ + asat ◌် + vowel signs) measures a different width,
 * every cell gets its OWN <span> with its OWN letter-spacing. That cuts a
 * grapheme cluster across span boundaries, so the font can never shape it:
 *   <span>မ</span><span>ြ</span><span>န</span><span>်</span>...
 *
 * Fix: force the per-glyph spacing variable to `this.defaultSpacing`. Then
 *   - no per-glyph letter-spacing is applied, and
 *   - the span-merge gate (spacing === previousSpacing) is always true,
 * so consecutive same-style cells collapse into a single span and the browser
 * shapes the whole cluster:  <span>မြန်မာ</span>
 *
 * Trade-off: width-compensation is disabled, so proportional/wide glyphs are
 * no longer nudged onto the grid (column alignment can drift). That is the
 * intended trade — correct text over perfect monospace alignment.
 *
 * Idempotent. Run after every `npm install` (wired into postinstall).
 */
const path = require('path');
const file = require('fs');

const base = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib');

// NOTE: Myanmar mark *width* is NOT patched here. The shell (main screen) and
// vim (alt screen) disagree on whether spacing marks are width 0 or 1, so the
// width is chosen at runtime per active screen in renderer.js. This file only
// handles the renderer-level span collapse needed for cluster shaping.

// Inline test: is codepoint `c` a Myanmar combining/vowel mark? (the ranges the
// system wcwidth treats as zero-width). Used to keep a mark in its base's span.
const MARK = (cellVar) =>
  '(c=>c>=0x102b&&c<=0x103e||c>=0x1056&&c<=0x1059||c>=0x105e&&c<=0x1060||' +
  'c>=0x1062&&c<=0x1064||c>=0x1067&&c<=0x106d||c>=0x1071&&c<=0x1074||' +
  'c>=0x1082&&c<=0x108d||c===0x108f||c>=0x109a&&c<=0x109d)(' + cellVar + '.codePointAt(0))';

const targets = [
  // 1) Collapse a same-style cell run into ONE span so the font can shape the
  //    whole Myanmar cluster (otherwise per-glyph letter-spacing splits it).
  {
    name: 'xterm.js',
    find: 'M=C*c-u.get(j,F.isBold(),F.isItalic())',
    replace: 'M=this.defaultSpacing',
  },
  {
    name: 'xterm.mjs',
    find: 'Ke=T*a-u.get(ze,x.isBold(),x.isItalic())',
    replace: 'Ke=this.defaultSpacing',
  },
  // 2) Keep a combining-mark cell in its base's span even when the cell's style
  //    differs (e.g. a TUI app draws an inverse-video cursor on a trailing mark
  //    like ◌း). Without this the mark splits into its own span and can't shape.
  //    The mark inherits the base style (the lone highlight on it is dropped),
  //    but the cluster renders correctly. Selection/cursor safety flags are kept.
  {
    name: 'xterm.js',
    find: 'y&&(W&&k||!W&&!k&&F.bg===D)&&(W&&k&&S.selectionForeground||F.fg===L)&&F.extended.ext===R&&K===A&&M===T',
    replace: 'y&&(' + MARK('j') + '||(W&&k||!W&&!k&&F.bg===D)&&(W&&k&&S.selectionForeground||F.fg===L)&&F.extended.ext===R&&K===A)&&M===T',
  },
  {
    name: 'xterm.mjs',
    find: 'A&&(N&&Pe||!N&&!Pe&&x.bg===I)&&(N&&Pe&&p.selectionForeground||x.fg===k)&&x.extended.ext===P&&te===oe&&Ke===Me',
    replace: 'A&&(' + MARK('ze') + '||(N&&Pe||!N&&!Pe&&x.bg===I)&&(N&&Pe&&p.selectionForeground||x.fg===k)&&x.extended.ext===P&&te===oe)&&Ke===Me',
  },
  // 3) Render a STANDALONE width-0 Myanmar mark instead of dropping it. The DOM
  //    row factory skips every width-0 cell (`if(width===0)continue`) — fine for
  //    real combining marks, which xterm stores INSIDE their base cell. But a mark
  //    only gets folded into its base when xterm's `precedingJoinState` points at
  //    that base. bash/readline redraws a line being edited mid-line (e.g. inside
  //    "") as `<char>"<backspace>` per keystroke, and the backspace (a C0 control)
  //    RESETS precedingJoinState to 0 — so the next keystroke's mark (◌် ◌ိ …) is
  //    written as its OWN width-0 cell, which the row factory then skips. The text
  //    is still in the buffer (copy/selection show it), but the screen drops it.
  //    Fix: when a skipped width-0 cell holds a Myanmar mark, append its glyph to
  //    the current span so it shapes onto the preceding base. (Selection column
  //    mapping for that mark is approximate — same "correct text first" trade-off.)
  {
    name: 'xterm.js',
    find: 'e.loadCell(x,this._workCell);let C=this._workCell.getWidth();if(0===C)continue;',
    replace: 'e.loadCell(x,this._workCell);let C=this._workCell.getWidth();if(0===C){if(b&&y>0){var _mc=this._workCell.getChars();_mc&&(' + MARK('_mc') + ')&&(w+=_mc);}continue;}',
  },
  {
    name: 'xterm.mjs',
    find: 't.loadCell(y,this._workCell);let T=this._workCell.getWidth();if(T===0)continue;',
    replace: 't.loadCell(y,this._workCell);let T=this._workCell.getWidth();if(T===0){if(f&&A>0){var _mc=this._workCell.getChars();_mc&&(' + MARK('_mc') + ')&&(R+=_mc);}continue;}',
  },
];

let ok = 0;
for (const t of targets) {
  const p = path.join(base, t.name);
  if (!file.existsSync(p)) {
    console.error(`[patch-xterm] missing ${p} — is @xterm/xterm installed?`);
    process.exit(1);
  }
  let src = file.readFileSync(p, 'utf8');
  if (src.includes(t.replace)) {
    console.log(`[patch-xterm] ${t.name}: already patched`);
    ok++;
    continue;
  }
  if (!src.includes(t.find)) {
    console.error(`[patch-xterm] ${t.name}: target not found — xterm version changed? Expected v6.0.0`);
    process.exit(1);
  }
  src = src.replace(t.find, t.replace);
  file.writeFileSync(p, src);
  console.log(`[patch-xterm] ${t.name}: patched ✔`);
  ok++;
}
console.log(`[patch-xterm] done (${ok}/${targets.length})`);
