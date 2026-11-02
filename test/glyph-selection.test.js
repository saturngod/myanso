'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRowMap, graphemeBoundaries, columnForOffset, snapOffset } = require('../lib/glyph-selection');

const cells = (arr) => arr.map(([chars, width]) => ({ chars, width: width === undefined ? 1 : width }));

test('row map mirrors the DOM renderer text', () => {
  // မြ with ြ as its own width-1 cell, an empty cell, then a wide char.
  const m = buildRowMap(cells([['မ'], ['ြ'], [''], ['界', 2], ['', 0], ['a']]));
  assert.equal(m.text, 'မြ 界a');
  assert.deepEqual(m.colStart, [0, 1, 2, 3, 4, 4, 5]);
});

test('standalone width-0 Myanmar marks stay in the text', () => {
  const m = buildRowMap(cells([['န'], ['်', 0], ['x', 0], ['a']]));
  assert.equal(m.text, 'န်a');
  assert.deepEqual(m.colStart, [0, 1, 2, 2, 3]);
});

test('grapheme boundaries keep Myanmar clusters whole', () => {
  const b = graphemeBoundaries('မြန်a');
  assert.equal(b[0], 0);
  assert.equal(b[b.length - 1], 5);
  assert.ok(!b.includes(1), 'no boundary inside မြ');
});

test('offset helpers snap to boundaries', () => {
  assert.equal(snapOffset([0, 2, 4], 3, false), 2);
  assert.equal(snapOffset([0, 2, 4], 3, true), 4);
  assert.equal(columnForOffset([0, 1, 1, 3], 1), 1);
  assert.equal(columnForOffset([0, 1, 1, 3], 2), 3);
});
