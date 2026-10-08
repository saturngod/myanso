'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');

// Run the actual input listener with Electron substitutes, including Linux
// events on non-Linux test hosts.
test('Linux clipboard shortcuts are intercepted once; plain Ctrl+C/V reach the shell', () => {
  let listener;
  const sent = [];
  const context = {
    process: { platform: 'linux' },
    win: { webContents: {
      on: (_, fn) => { listener = fn; },
      send: (...args) => sent.push(args)
    } }
  };
  const start = main.indexOf("  if (process.platform === 'linux') {\n    win.webContents.on('before-input-event'");
  vm.runInNewContext(main.slice(start, main.indexOf('  // Chromium persists', start)), context);
  for (const [key, code, channel] of [['C', 'KeyC', 'terminal-copy'], ['V', 'KeyV', 'terminal-paste'], ['က', 'KeyC', 'terminal-copy']]) {
    let prevented = 0;
    const event = { preventDefault: () => prevented++ };
    const input = { type: 'keyDown', control: true, shift: true, key, code };
    listener(event, input);
    assert.equal(prevented, 1);
    assert.deepEqual(sent.pop(), [channel]);
    for (const override of [{ shift: false }, { alt: true }, { meta: true }, { type: 'keyUp' }, { isAutoRepeat: true }]) {
      prevented = 0;
      listener(event, { ...input, ...override });
      assert.equal(prevented, 0);
      assert.equal(sent.length, 0);
    }
  }
});

function clipboardContext() {
  const calls = [];
  const pane = { term: {
    getSelection: () => 'မြန်မာ\nselected text',
    paste: text => calls.push(['paste', text]),
    focus: () => calls.push(['focus'])
  } };
  const context = {
    activePane: pane,
    clipboard: {
      writeText: text => calls.push(['copy', text]),
      readText: () => 'မြန်မာ\nclipboard text'
    },
    document: { activeElement: null },
    ipcRenderer: { send: (...args) => calls.push(args) }
  };
  const start = renderer.indexOf('function copyPane(');
  vm.runInNewContext(renderer.slice(start, renderer.indexOf('// Inline SVG icons', start)), context);
  return { context, pane, calls };
}

test('terminal clipboard copies selection and pastes through xterm with focus restored', () => {
  const { context, calls, pane } = clipboardContext();
  context.document.activeElement = {
    classList: { contains: () => true }, matches: () => true
  };
  context.editClipboard('copy');
  context.editClipboard('paste');
  assert.deepEqual(calls, [
    ['copy', 'မြန်မာ\nselected text'],
    ['paste', 'မြန်မာ\nclipboard text'], ['focus']
  ]);
  calls.length = 0;
  pane.term.getSelection = () => '';
  context.editClipboard('copy');
  context.activePane = null;
  context.editClipboard('paste');
  assert.deepEqual(calls, []);
});

test('clipboard shortcuts use native editing in find/settings fields', () => {
  const { context, calls } = clipboardContext();
  for (const contentEditable of [false, true]) {
    context.document.activeElement = {
      classList: { contains: () => false },
      matches: () => !contentEditable,
      isContentEditable: contentEditable
    };
    context.editClipboard('copy');
    context.editClipboard('paste');
  }
  assert.deepEqual(calls, [
    ['clipboard-edit', 'copy'], ['clipboard-edit', 'paste'],
    ['clipboard-edit', 'copy'], ['clipboard-edit', 'paste']
  ]);
});

test('Linux right-click opens the pane menu in capture phase before xterm changes its textarea', () => {
  for (const linux of [true, false]) {
    let listener;
    let capture;
    const pane = { term: { getSelection: () => 'selected' } };
    const calls = [];
    const start = renderer.indexOf('  // Right-click → custom context menu');
    vm.runInNewContext(renderer.slice(start, renderer.indexOf('  // Drag & drop', start)), {
      IS_LINUX: linux, pane,
      el: { addEventListener: (_, fn, option) => { listener = fn; capture = option; } },
      setActivePane: p => assert.equal(p, pane),
      showPaneMenu: (x, y, p) => calls.push([x, y, p.term.getSelection()])
    });
    let prevented = false;
    let stopped = false;
    listener({ clientX: 20, clientY: 30,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; }
    });
    assert.equal(capture, linux);
    assert.equal(stopped, linux);
    assert.equal(prevented, true);
    assert.deepEqual(calls, [[20, 30, 'selected']]);
  }
});

test('Linux Edit menu exposes terminal clipboard accelerators and targets the focused window', () => {
  let template;
  const sent = [];
  const window = { id: 1, isDestroyed: () => false,
    webContents: { send: channel => sent.push(channel) } };
  const context = {
    process: { platform: 'linux' }, app: { name: 'Myanso', isPackaged: true },
    BrowserWindow: { getFocusedWindow: () => window, getAllWindows: () => [] },
    tabCounts: new Map(), settingsMenuIcon: null,
    Menu: { buildFromTemplate: t => { template = t; return t; }, setApplicationMenu: () => {} }
  };
  const start = main.indexOf('function buildMenu()');
  vm.runInNewContext(main.slice(start, main.indexOf("app.on('ready'", start)), context);
  context.buildMenu();
  const edit = template.find(item => item.label === 'Edit');
  for (const [label, accelerator, channel] of [
    ['Copy', 'Ctrl+Shift+C', 'terminal-copy'], ['Paste', 'Ctrl+Shift+V', 'terminal-paste']
  ]) {
    const item = edit.submenu.find(item => item.label === label);
    assert.equal(item.accelerator, accelerator);
    item.click();
    assert.equal(sent.pop(), channel);
  }
});

test('Linux context menu offers Copy only for a selection and displays clipboard shortcuts', () => {
  const { context, pane, calls } = clipboardContext();
  function element() {
    return {
      children: [], handlers: {}, style: {},
      appendChild(child) { this.children.push(child); },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      getBoundingClientRect: () => ({ width: 300, height: 200 })
    };
  }
  context.IS_LINUX = true;
  context.hidePaneMenu = () => {};
  context.svgIcon = () => '';
  context.document.createElement = element;
  context.document.body = element();
  context.window = { innerWidth: 800, innerHeight: 600 };
  const start = renderer.indexOf('function showPaneMenu(');
  vm.runInNewContext(renderer.slice(start, renderer.indexOf('// Dismiss on any outside', start)), context);
  context.showPaneMenu(20, 30, pane);
  const menu = context.document.body.children[0];
  const copy = menu.children.find(row => row.innerHTML === '<span>Copy</span>');
  const paste = menu.children.find(row => row.innerHTML === '<span>Paste</span>');
  assert.equal(copy.children[0].textContent, 'Ctrl+Shift+C');
  assert.equal(paste.children[0].textContent, 'Ctrl+Shift+V');
  const event = { preventDefault() {}, stopPropagation() {} };
  copy.handlers.mousedown(event);
  paste.handlers.mousedown(event);
  assert.deepEqual(calls, [
    ['copy', 'မြန်မာ\nselected text'], ['paste', 'မြန်မာ\nclipboard text'], ['focus']
  ]);
  pane.term.getSelection = () => '';
  context.showPaneMenu(20, 30, pane);
  const emptyMenu = context.document.body.children[1];
  assert.equal(emptyMenu.children.some(row => row.innerHTML === '<span>Copy</span>'), false);
  assert.equal(emptyMenu.children.some(row => row.innerHTML === '<span>Paste</span>'), true);
});
