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
 * Only Myanmar text skips the width correction. Every other glyph (Latin,
 * spaces, box drawing, block elements) keeps xterm's normal per-glyph spacing,
 * so it stays on the cell grid even when the font isn't monospace. Without
 * this, a row of background-colored spaces in a proportional fallback font
 * (e.g. Noto Sans Myanmar as `monospace`) renders narrower than the row and
 * TUIs like opencode show unpainted gaps on the right.
 * Trade-off: Myanmar glyphs aren't nudged onto the grid, so Myanmar text can
 * drift slightly — correct shaping over perfect monospace alignment.
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
    legacy: [
      'M=this.defaultSpacing',
      'M=/[\\u2500-\\u259f]/.test(j)?C*c-u.get(j,F.isBold(),F.isItalic()):this.defaultSpacing',
    ],
    replace: 'M=/[\\u1000-\\u109f\\ua9e0-\\ua9ff\\uaa60-\\uaa7f]/.test(j)?this.defaultSpacing:C*c-u.get(j,F.isBold(),F.isItalic())',
  },
  {
    name: 'xterm.mjs',
    find: 'Ke=T*a-u.get(ze,x.isBold(),x.isItalic())',
    legacy: [
      'Ke=this.defaultSpacing',
      'Ke=/[\\u2500-\\u259f]/.test(ze)?T*a-u.get(ze,x.isBold(),x.isItalic()):this.defaultSpacing',
    ],
    replace: 'Ke=/[\\u1000-\\u109f\\ua9e0-\\ua9ff\\uaa60-\\uaa7f]/.test(ze)?this.defaultSpacing:T*a-u.get(ze,x.isBold(),x.isItalic())',
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

function applyPatch(baseDirectory = base, log = console.log) {
  const files = new Map();
  const statuses = [];

  // Validate and stage every replacement in memory before writing either file.
  // A minifier mismatch therefore cannot leave node_modules half-patched.
  for (const t of targets) {
    const p = path.join(baseDirectory, t.name);
    let state = files.get(p);
    if (!state) {
      if (!file.existsSync(p)) {
        throw new Error(`[patch-xterm] missing ${p} — is @xterm/xterm installed?`);
      }
      const src = file.readFileSync(p, 'utf8');
      state = { original: src, staged: src };
      files.set(p, state);
    }
    if (state.staged.includes(t.replace)) {
      statuses.push({ name: t.name, status: 'already patched' });
      continue;
    }
    // Upgrade installations carrying an older version of this patch.
    const legacy = [].concat(t.legacy || []).find((old) => state.staged.includes(old));
    if (legacy) {
      state.staged = state.staged.replace(legacy, t.replace);
      statuses.push({ name: t.name, status: 'upgraded ✔' });
      continue;
    }
    if (!state.staged.includes(t.find)) {
      throw new Error(`[patch-xterm] ${t.name}: target not found — xterm version changed? Expected v6.0.0`);
    }
    state.staged = state.staged.replace(t.find, t.replace);
    statuses.push({ name: t.name, status: 'patched ✔' });
  }

  for (const [p, state] of files) {
    if (state.staged !== state.original) file.writeFileSync(p, state.staged);
  }
  for (const item of statuses) log(`[patch-xterm] ${item.name}: ${item.status}`);
  log(`[patch-xterm] done (${statuses.length}/${targets.length})`);
  return statuses.length;
}

if (require.main === module) {
  try {
    applyPatch();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { applyPatch, targets };
