'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isMyanmarMark,
  isMyanmarNonspacing,
  isShellForeground,
  appWidthModeForContext,
  widthModeForContext
} = require('../lib/myanmar-width');

const markRanges = [
  [0x102b, 0x103e], [0x1056, 0x1059], [0x105e, 0x1060],
  [0x1062, 0x1064], [0x1067, 0x106d], [0x1071, 0x1074],
  [0x1082, 0x108d], [0x108f, 0x108f], [0x109a, 0x109d]
];

test('Myanmar mark boundaries are exact', () => {
  for (const [start, end] of markRanges) {
    assert.equal(isMyanmarMark(start), true, `start U+${start.toString(16)}`);
    assert.equal(isMyanmarMark(end), true, `end U+${end.toString(16)}`);
    if (!markRanges.some(([a, b]) => start - 1 >= a && start - 1 <= b)) assert.equal(isMyanmarMark(start - 1), false);
    if (!markRanges.some(([a, b]) => end + 1 >= a && end + 1 <= b)) assert.equal(isMyanmarMark(end + 1), false);
  }
  assert.equal(isMyanmarMark(0x1000), false);
});

test('standard mode distinguishes known Mn and Mc marks', () => {
  for (const cp of [0x102d, 0x103a, 0x103d, 0x103e, 0x108d]) assert.equal(isMyanmarNonspacing(cp), true);
  for (const cp of [0x102b, 0x102c, 0x1038, 0x1056]) assert.equal(isMyanmarNonspacing(cp), false);
});

test('recognizes common and configured shells', () => {
  assert.equal(isShellForeground('/bin/zsh'), true);
  assert.equal(isShellForeground('powershell.exe'), true);
  assert.equal(isShellForeground('/opt/bin/nu', '/opt/bin/nu'), true);
  assert.equal(isShellForeground('codex', '/bin/zsh'), false);
});

const mode = (overrides) => widthModeForContext({
  platform: 'darwin', screen: 'normal', foreground: 'zsh', title: '', configuredShell: '/bin/zsh', ...overrides
});

test('selects platform and alternate-screen defaults', () => {
  assert.equal(mode({ platform: 'darwin' }), 'myan-shell');
  assert.equal(mode({ platform: 'linux' }), 'myan-std');
  assert.equal(mode({ platform: 'win32' }), 'myan-shell');
  assert.equal(mode({ screen: 'alternate' }), 'myan-std');
});

test('selects Claude all-one mode from process, semver, or title', () => {
  assert.equal(mode({ foreground: 'claude' }), 'myan-allone');
  assert.equal(mode({ foreground: '2.1.165' }), 'myan-allone');
  assert.equal(mode({ foreground: 'node', title: 'Claude Code' }), 'myan-allone');
  assert.equal(mode({ platform: 'win32', foreground: 'claude' }), 'myan-allone');
});

test('selects standard mode for Claude on Linux', () => {
  assert.equal(mode({ platform: 'linux', foreground: 'claude' }), 'myan-std');
  assert.equal(mode({ platform: 'linux', foreground: '2.1.316' }), 'myan-std');
  assert.equal(mode({ platform: 'linux', foreground: 'node', title: 'Claude Code' }), 'myan-std');
});

test('selects zero-width marks for opencode on every platform and screen', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const screen of ['normal', 'alternate']) {
      assert.equal(mode({ platform, screen, foreground: 'opencode' }), 'myan-shell');
    }
  }
  assert.equal(mode({ foreground: '/home/u/.opencode/bin/opencode' }), 'myan-shell');
});

test('selects standard mode for resolved Codex CLI process', () => {
  assert.equal(mode({ foreground: 'node:123 /usr/bin/node /usr/local/bin/codex' }), 'myan-std');
});

test('ignores stale app titles after returning to a shell', () => {
  assert.equal(mode({ foreground: 'zsh', title: 'Claude Code' }), 'myan-shell');
  assert.equal(mode({ platform: 'linux', foreground: 'bash', title: 'Codex' }), 'myan-std');
});

test('app-only selection does not force the platform default', () => {
  assert.equal(appWidthModeForContext({ foreground: 'bash', title: 'Claude Code', configuredShell: '/bin/bash' }), null);
  assert.equal(appWidthModeForContext({ foreground: 'unknown-tui', configuredShell: '/bin/bash' }), null);
  assert.equal(appWidthModeForContext({ foreground: 'codex', configuredShell: '/bin/bash' }), 'myan-std');
});
