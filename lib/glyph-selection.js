'use strict';

// Glyph-accurate selection for the DOM renderer.
//
// The xterm patch merges Myanmar runs into one <span> so the browser can shape
// them, which means glyphs no longer sit on the cell grid. xterm still draws the
// selection highlight and maps the mouse to columns using the grid, so both
// drift away from the text. This module keeps xterm's selection model (what is
// copied stays the same) but:
//   1. draws the highlight from the real glyph positions (DOM Range rects), and
//   2. maps a mouse x to the nearest grapheme boundary of the rendered text.

const { isMyanmarMark } = require('./myanmar-width');

const NON_ASCII = /[^\x00-\x7f]/;
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

// Rebuild the text the DOM renderer writes for a buffer line, plus where each
// column starts in that text. Mirrors the patched row factory: width-0 cells are
// skipped unless they hold a Myanmar mark, empty cells render as a space.
// `cells` is an array of { width, chars }.
function buildRowMap(cells) {
  let text = '';
  const colStart = new Array(cells.length + 1);
  for (let x = 0; x < cells.length; x++) {
    colStart[x] = text.length;
    const { width, chars } = cells[x];
    if (width === 0) {
      if (chars && isMyanmarMark(chars.codePointAt(0))) text += chars;
      continue;
    }
    text += chars || ' ';
  }
  colStart[cells.length] = text.length;
  return { text, colStart };
}

// Grapheme boundaries (offsets) of `text`, always including 0 and text.length.
function graphemeBoundaries(text) {
  const out = [0];
  if (segmenter) {
    for (const s of segmenter.segment(text)) if (s.index > 0) out.push(s.index);
  } else {
    for (let i = 1; i < text.length; i++) out.push(i);
  }
  if (out[out.length - 1] !== text.length) out.push(text.length);
  return out;
}

// First column whose start offset is >= `offset`.
function columnForOffset(colStart, offset) {
  for (let c = 0; c < colStart.length; c++) if (colStart[c] >= offset) return c;
  return colStart.length - 1;
}

// Snap `offset` to a grapheme boundary: down (start of a selection) or up (end).
function snapOffset(bounds, offset, up) {
  let prev = 0;
  for (const b of bounds) {
    if (b === offset) return b;
    if (b > offset) return up ? b : prev;
    prev = b;
  }
  return prev;
}

function readCells(line, cols) {
  const cells = new Array(cols);
  for (let x = 0; x < cols; x++) {
    const cell = line && line.getCell(x);
    cells[x] = cell ? { width: cell.getWidth(), chars: cell.getChars() } : { width: 1, chars: '' };
  }
  return cells;
}

// Locate (textNode, localOffset) for a global offset inside `el`.
function nodeAt(el, offset) {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
  let node;
  let last = null;
  while ((node = walker.nextNode())) {
    const len = node.data.length;
    if (offset <= len) return { node, offset };
    offset -= len;
    last = node;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

function attachGlyphSelection(term) {
  const core = term._core;
  const screen = term.element && term.element.querySelector('.xterm-screen');
  const rowsEl = term.element && term.element.querySelector('.xterm-rows');
  const mouse = core && core._mouseService;
  if (!screen || !rowsEl || !mouse || typeof mouse.getCoords !== 'function') return null;

  const overlay = document.createElement('div');
  overlay.className = 'myanso-selection';
  screen.appendChild(overlay);
  term.element.classList.add('myanso-glyph-select');

  function cellWidth() {
    try {
      const w = core._renderService.dimensions.css.cell.width;
      if (w > 0) return w;
    } catch (e) { /* fall through */ }
    return screen.clientWidth / term.cols;
  }

  // Per-row geometry: x (relative to the screen) of any column boundary.
  // Returns null when the DOM text doesn't match the buffer (then use the grid).
  function rowGeometry(viewportRow) {
    const rowEl = rowsEl.children[viewportRow];
    const buf = term.buffer.active;
    const line = buf.getLine(buf.viewportY + viewportRow);
    if (!rowEl || !line) return null;
    const rendered = rowEl.textContent.replace(/ /g, ' ');
    if (!NON_ASCII.test(rendered)) return null;
    const map = buildRowMap(readCells(line, term.cols));
    if (!map.text.startsWith(rendered)) return null;

    const len = rendered.length;
    const bounds = graphemeBoundaries(rendered);
    const screenLeft = screen.getBoundingClientRect().left;
    const range = document.createRange();
    const cache = new Map();
    // x of a grapheme boundary inside the rendered text.
    const boundaryX = (b) => {
      if (cache.has(b)) return cache.get(b);
      let x = 0;
      if (len > 0) {
        const idx = bounds.indexOf(b);
        const from = b < len ? b : bounds[Math.max(0, idx - 1)];
        const to = b < len ? bounds[idx + 1] : len;
        const a = nodeAt(rowEl, from);
        const z = nodeAt(rowEl, to);
        if (a && z) {
          range.setStart(a.node, a.offset);
          range.setEnd(z.node, z.offset);
          const r = range.getBoundingClientRect();
          x = (b < len ? r.left : r.right) - screenLeft;
        }
      }
      cache.set(b, x);
      return x;
    };
    const renderedCols = columnForOffset(map.colStart, len);
    const cw = cellWidth();
    const endX = boundaryX(len);
    return {
      // x of the left edge of column `c` (0..cols); `up` snaps forward.
      colX(c, up) {
        if (c >= renderedCols) return endX + (c - renderedCols) * cw;
        return boundaryX(snapOffset(bounds, map.colStart[c], up));
      },
      // Nearest column boundary to screen-relative x.
      hit(px) {
        if (px > endX) return Math.min(term.cols, renderedCols + Math.round((px - endX) / cw));
        let best = 0;
        let bestD = Infinity;
        for (const b of bounds) {
          const d = Math.abs(boundaryX(b) - px);
          if (d < bestD) { bestD = d; best = b; }
        }
        return columnForOffset(map.colStart, best);
      }
    };
  }

  // 1) Mouse → column, using glyph positions for selection gestures.
  const origGetCoords = mouse.getCoords.bind(mouse);
  mouse.getCoords = (event, element, colCount, rowCount, isSelection) => {
    const res = origGetCoords(event, element, colCount, rowCount, isSelection);
    if (!res || !isSelection) return res;
    try {
      const geo = rowGeometry(res[1] - 1);
      if (geo) {
        const px = event.clientX - screen.getBoundingClientRect().left;
        res[0] = Math.min(Math.max(geo.hit(px) + 1, 1), colCount + 1);
      }
    } catch (e) { /* keep xterm's grid result */ }
    return res;
  };

  // 2) Draw the highlight.
  let frame = 0;
  function draw() {
    frame = 0;
    overlay.textContent = '';
    const pos = term.getSelectionPosition();
    if (!pos) return;
    const buf = term.buffer.active;
    const top = buf.viewportY;
    const columnMode = !!(core._selectionService && core._selectionService._activeSelectionMode === 3);
    const cw = cellWidth();
    const screenRect = screen.getBoundingClientRect();
    const focused = term.element.classList.contains('focus') || document.activeElement === term.textarea;
    const theme = term.options.theme || {};
    const color = (focused ? theme.selectionBackground : theme.selectionInactiveBackground) ||
      theme.selectionBackground || 'rgba(128,128,128,0.4)';
    const startCol = Math.min(pos.start.x, pos.end.x);
    const endCol = Math.max(pos.start.x, pos.end.x);
    const frag = document.createDocumentFragment();
    for (let r = 0; r < term.rows; r++) {
      const y = top + r;
      if (y < pos.start.y || y > pos.end.y) continue;
      let a;
      let b;
      if (columnMode) {
        a = startCol; b = endCol;
      } else {
        a = y === pos.start.y ? pos.start.x : 0;
        b = y === pos.end.y ? pos.end.x : term.cols;
      }
      if (b <= a) continue;
      const rowEl = rowsEl.children[r];
      if (!rowEl) continue;
      const rr = rowEl.getBoundingClientRect();
      const baseX = rr.left - screenRect.left;
      let geo = null;
      try { geo = rowGeometry(r); } catch (e) { geo = null; }
      const x1 = geo ? geo.colX(a, false) : baseX + a * cw;
      let x2 = geo ? geo.colX(b, true) : baseX + b * cw;
      // A line that continues onto the next selected row fills to the edge.
      if (!columnMode && b >= term.cols) x2 = Math.max(x2, baseX + term.cols * cw);
      if (x2 <= x1) continue;
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;left:${x1}px;top:${rr.top - screenRect.top}px;` +
        `width:${x2 - x1}px;height:${rr.height}px;background:${color};`;
      frag.appendChild(d);
    }
    overlay.appendChild(frag);
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

  const disposables = [
    term.onRender(schedule),
    term.onScroll(schedule),
    term.onSelectionChange(schedule),
    term.onResize(schedule)
  ];
  term.textarea.addEventListener('focus', schedule);
  term.textarea.addEventListener('blur', schedule);

  return {
    refresh: schedule,
    dispose() {
      disposables.forEach((d) => d.dispose());
      if (frame) cancelAnimationFrame(frame);
      mouse.getCoords = origGetCoords;
      overlay.remove();
      term.element.classList.remove('myanso-glyph-select');
    }
  };
}

module.exports = { attachGlyphSelection, buildRowMap, graphemeBoundaries, columnForOffset, snapOffset };
