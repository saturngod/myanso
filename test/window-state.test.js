'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { loadWindowBounds, fitWindowBounds, saveWindowBounds, trackNormalWindowBounds } = require('../lib/window-state');

function stateFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myanso-window-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'user-data', 'window-size.json');
}

test('window size and position survive reopening without persisting fullscreen', t => {
  const file = stateFile(t);
  assert.deepEqual(loadWindowBounds(file), { width: 900, height: 600 });
  assert.equal(saveWindowBounds(file, { width: 1200, height: 800, x: 42, y: 50, fullscreen: true }), true);
  assert.deepEqual(loadWindowBounds(file), { width: 1200, height: 800, x: 42, y: 50 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { width: 1200, height: 800, x: 42, y: 50 });
  assert.equal(saveWindowBounds(file, { width: 1000, height: 700 }), true);
  assert.deepEqual(loadWindowBounds(file), { width: 1000, height: 700 });
});

test('missing, corrupt, or invalid saved dimensions fall back safely', t => {
  const file = stateFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const data of ['broken json', 'null', '{}', '{"width":0,"height":600}',
    '{"width":900,"height":-1}', '{"width":"900","height":600}', '{"width":900.5,"height":600}']) {
    fs.writeFileSync(file, data);
    assert.deepEqual(loadWindowBounds(file), { width: 900, height: 600 });
  }
  assert.equal(saveWindowBounds(file, { width: NaN, height: 600 }), false);
});

test('restored sizes fit smaller displays without changing stored dimensions', () => {
  const saved = { width: 1600, height: 1000 };
  assert.deepEqual(fitWindowBounds(saved, { width: 1280, height: 720 }), { width: 1280, height: 720 });
  assert.deepEqual(fitWindowBounds(saved, { width: 1920, height: 1080 }), saved);
});

test('closing saves normal bounds even in fullscreen; cancelled close does not save', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf("  win.on('close', (e) => {");
  const source = main.slice(start, main.indexOf("  win.on('closed'", start));
  let closeListener;
  let busy = false;
  let saves = [];
  let prevented = false;
  const normal = { width: 1100, height: 750, x: -1200, y: 80 };
  const win = {
    id: 1, on: (_, fn) => { closeListener = fn; },
    getNormalBounds: () => normal, isFullScreen: () => true
  };
  vm.runInNewContext(source, {
    win, windowSizeFile: 'window-size.json', console, currentNormalBounds: () => normal,
    busyLabelsForWindow: () => busy ? ['shell'] : [],
    confirmBusyClose: async () => false,
    saveWindowBounds: (file, bounds) => { saves.push([file, bounds]); return true; }
  });
  closeListener({ preventDefault: () => { prevented = true; } });
  assert.deepEqual(saves, [['window-size.json', normal]]);
  saves = [];
  busy = true;
  closeListener({ preventDefault: () => { prevented = true; } });
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.deepEqual(saves, []);
  win._readyToClose = true;
  closeListener({ preventDefault() { assert.fail('confirmed close must proceed'); } });
  assert.deepEqual(saves, [['window-size.json', normal]]);
});


test('positions restore on negative-coordinate displays and fit changed work areas', () => {
  const saved = { width: 1000, height: 700, x: -1500, y: 100 };
  assert.deepEqual(fitWindowBounds(saved, { x: -1920, y: 0, width: 1920, height: 1080 }), saved);
  assert.deepEqual(fitWindowBounds(saved, { x: 0, y: 25, width: 1280, height: 720 }),
    { width: 1000, height: 700, x: 0, y: 45 });
  assert.deepEqual(fitWindowBounds({ width: 1600, height: 1000, x: 2000, y: 900 },
    { x: 0, y: 25, width: 1280, height: 720 }),
    { width: 1280, height: 720, x: 0, y: 25 });
});

test('old size-only preferences still load; invalid coordinates are ignored', t => {
  const file = stateFile(t);
  for (const position of [{}, { x: '20', y: 30 }, { x: 20 }, { x: 20, y: null }]) {
    assert.equal(saveWindowBounds(file, { width: 1100, height: 750, ...position }), true);
    assert.deepEqual(loadWindowBounds(file), { width: 1100, height: 750 });
  }
  assert.equal(saveWindowBounds(file, { width: 1100, height: 750, x: -1500, y: 0 }), true);
  assert.deepEqual(loadWindowBounds(file), { width: 1100, height: 750, x: -1500, y: 0 });
});

test('window creation restores saved position while explicit tab-drop positions take priority', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('  const windowSizeFile =');
  const source = '{\n' + main.slice(start, main.indexOf('  const win = new BrowserWindow', start)) + '\nbounds;\n}';
  const saved = { width: 1000, height: 700, x: -1500, y: 100 };
  const area = { x: -1920, y: 0, width: 1920, height: 1080 };
  let matched = 0;
  let nearest = 0;
  const context = {
    path, app: { getPath: () => '/test' }, pos: undefined,
    loadWindowBounds: () => saved, fitWindowBounds,
    screen: {
      getDisplayMatching: bounds => { assert.equal(bounds, saved); matched++; return { workArea: area }; },
      getDisplayNearestPoint: point => { assert.equal(point, context.pos); nearest++; return { workArea: area }; },
      getPrimaryDisplay: () => { throw new Error('saved position must choose its display'); }
    }
  };
  assert.deepEqual(vm.runInNewContext(source, context), saved);
  context.pos = { x: -1800, y: 50 };
  assert.deepEqual(vm.runInNewContext(source, context), { width: 1000, height: 700, x: -1800, y: 50 });
  assert.equal(matched, 1);
  assert.equal(nearest, 1);
});


test('native movement and resizing replace stale creation bounds before close', () => {
  const listeners = {};
  const centered = { x: 510, y: 176, width: 900, height: 600 };
  let actual = centered;
  let special = '';
  const win = {
    getBounds: () => actual,
    getNormalBounds: () => centered,
    on: (event, handler) => { listeners[event] = handler; },
    isDestroyed: () => special === 'destroyed',
    isFullScreen: () => special === 'fullscreen',
    isMaximized: () => special === 'maximized',
    isMinimized: () => special === 'minimized'
  };
  const currentNormalBounds = trackNormalWindowBounds(win);
  actual = { x: 20, y: 40, width: 900, height: 600 };
  listeners.move();
  actual = { x: 20, y: 40, width: 500, height: 350 };
  listeners.resize();
  assert.deepEqual(currentNormalBounds(), actual);
  for (const state of ['fullscreen', 'maximized', 'minimized', 'destroyed']) {
    special = state;
    actual = { x: 0, y: 0, width: 1920, height: 1080 };
    listeners.move();
    listeners.resize();
    assert.deepEqual(currentNormalBounds(), { x: 20, y: 40, width: 500, height: 350 });
  }
});
