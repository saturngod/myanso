'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../lib/ipc-validation');

const leaf = (id = 'pty_1_2') => ({ leaf: true, pane: { ptyId: id, cwd: '/tmp', title: 'shell', scrollback: '' } });
const descriptor = () => ({ tabId: 'tab_1_1', title: 'tab', tree: leaf(), ptyIds: ['pty_1_2'] });

test('validates generated PTY and tab ids', () => {
  assert.equal(v.validPtyId('pty_12_34'), true);
  assert.equal(v.validPtyId('pty_other'), false);
  assert.equal(v.validTabId('tab_12_34'), true);
  assert.equal(v.validTabId('../tab_1_2'), false);
  assert.equal(v.validTransferId('transfer_12_34'), true);
  assert.equal(v.validTransferId('transfer_bad'), false);
});

test('validates individual pane transfer payloads', () => {
  const pane = { ptyId: 'pty_1_2', cwd: '/tmp', title: 'shell', scrollback: '', cols: 80, rows: 24, foreground: 'zsh' };
  const transfer = { transferId: 'transfer_1_3', tabId: 'tab_1_1', ptyId: 'pty_1_2', descriptor: pane };
  assert.equal(v.validPaneDescriptor(pane), true);
  assert.equal(v.validPaneTransfer(transfer, true), true);
  assert.equal(v.validPaneTransfer({ ...transfer, ptyId: 'pty_1_9' }, true), false);
  assert.equal(v.validPaneTransfer({ ...transfer, transferId: '../bad' }, true), false);
  assert.equal(v.validPaneTransfer({ ...transfer, descriptor: { ...pane, cols: 0 } }, true), false);
});

test('bounds PTY creation, resize, input, and references', () => {
  assert.equal(v.validPtyCreate({ id: 'pty_1_1', cols: 80, rows: 24, cwd: '/tmp' }), true);
  assert.equal(v.validPtyCreate({ id: 'pty_1_1', cols: 0, rows: 24 }), false);
  assert.equal(v.validPtyResize({ id: 'pty_1_1', cols: 1001, rows: 24 }), false);
  assert.equal(v.validPtyInput({ id: 'pty_1_1', data: 'x'.repeat(v.MAX_INPUT_LENGTH) }), true);
  assert.equal(v.validPtyInput({ id: 'pty_1_1', data: 'x'.repeat(v.MAX_INPUT_LENGTH + 1) }), false);
  assert.equal(v.validPtyReference({ id: 'pty_1_1' }), true);
});

test('accepts valid tab descriptors and rejects mismatched ids', () => {
  assert.equal(v.validTabDescriptor(descriptor()), true);
  const bad = descriptor();
  bad.ptyIds = ['pty_1_3'];
  assert.equal(v.validTabDescriptor(bad), false);
});

test('rejects duplicate panes, excessive depth, and oversized scrollback', () => {
  const duplicate = descriptor();
  duplicate.tree = { leaf: false, dir: 'row', ratio: 0.5, a: leaf(), b: leaf() };
  duplicate.ptyIds = ['pty_1_2'];
  assert.equal(v.validTabDescriptor(duplicate), false);

  const deep = descriptor();
  for (let i = 0; i < 34; i++) deep.tree = { leaf: false, dir: 'row', ratio: 0.5, a: deep.tree, b: leaf(`pty_2_${i + 1}`) };
  deep.ptyIds = Array.from({ length: 35 }, (_, i) => i === 0 ? 'pty_1_2' : `pty_2_${i}`);
  assert.equal(v.validTabDescriptor(deep), false);

  const huge = descriptor();
  huge.tree.pane.scrollback = 'x'.repeat(8 * 1024 * 1024 + 1);
  assert.equal(v.validTabDescriptor(huge), false);
});

test('validates bounded unique close requests', () => {
  assert.equal(v.validCloseRequest({ ptyIds: ['pty_1_1', 'pty_1_2'] }), true);
  assert.equal(v.validCloseRequest({ ptyIds: ['pty_1_1', 'pty_1_1'] }), false);
  assert.equal(v.validCloseRequest({ ptyIds: 'pty_1_1' }), false);
});

test('validates tab drag outcomes', () => {
  for (const outcome of ['reordered', 'transferring', 'cancelled']) {
    assert.equal(v.validTabDragResult({ tabId: 'tab_1_1', outcome }), true);
  }
  assert.equal(v.validTabDragResult({ tabId: 'tab_1_1', outcome: 'unknown' }), false);
  assert.equal(v.validTabDragResult({ tabId: '../tab_1_1', outcome: 'cancelled' }), false);
  assert.equal(v.validTabDragResult(['tab_1_1', 'cancelled']), false);
});
