'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyPatch, targets } = require('../patches/patch-xterm-myanmar');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myanso-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const installed = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib');
  for (const name of new Set(targets.map((target) => target.name))) {
    let src = fs.readFileSync(path.join(installed, name), 'utf8');
    for (const target of [...targets].reverse().filter((item) => item.name === name)) {
      src = src.replace(target.replace, target.find);
      for (const old of [].concat(target.legacy || [])) src = src.replace(old, target.find);
    }
    fs.writeFileSync(path.join(dir, name), src);
  }
  return dir;
}

test('applies all targets and is idempotent', (t) => {
  const dir = fixture(t);
  assert.equal(applyPatch(dir, () => {}), 6);
  const once = new Map([...new Set(targets.map((target) => target.name))].map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
  assert.equal(applyPatch(dir, () => {}), 6);
  for (const [name, src] of once) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), src);
});

test('fails when an expected file is missing', (t) => {
  const dir = fixture(t);
  fs.rmSync(path.join(dir, targets[0].name));
  assert.throws(() => applyPatch(dir, () => {}), /missing/);
});

test('upgrades every older spacing patch', (t) => {
  const legacyTargets = targets.filter((item) => item.legacy);
  const versions = Math.max(...legacyTargets.map((item) => [].concat(item.legacy).length));
  for (let i = 0; i < versions; i++) {
    const dir = fixture(t);
    for (const target of legacyTargets) {
      const old = [].concat(target.legacy)[i];
      if (!old) continue;
      const p = path.join(dir, target.name);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(target.find, old));
    }
    applyPatch(dir, () => {});
    for (const target of legacyTargets) {
      const src = fs.readFileSync(path.join(dir, target.name), 'utf8');
      assert.ok(src.includes(target.replace), `legacy #${i} of ${target.name}`);
    }
  }
});

test('only Myanmar skips width compensation', () => {
  // Latin, spaces and graphics keep their measured compensation so rows of
  // background-colored spaces fill the cell grid even with proportional fonts.
  // Myanmar takes the default-spacing path so adjacent cells can shape together.
  for (const target of targets.slice(0, 2)) {
    const [, lhs, glyph, cellW, width, measure, attrs] =
      target.replace.match(/^(\w+)=.*\.test\((\w+)\)\?this\.defaultSpacing:(\w+)\*(\w+)-(\w+)\.get\(\w+,(\w+)\./);
    const spacing = new Function(glyph, cellW, width, measure, attrs, `let ${lhs}; ${target.replace}; return ${lhs};`);
    const style = { isBold: () => false, isItalic: () => false };
    const ctx = { defaultSpacing: 0 };
    for (const g of [' ', 'a', 'W', '█', '▀', '▄', '│', '─']) {
      assert.equal(spacing.call(ctx, g, 1, 10, { get: () => 8 }, style), 2, `${target.name} ${JSON.stringify(g)}`);
    }
    for (const g of ['မြ', 'န်', 'ꩠ', 'ꧠ']) {
      assert.equal(spacing.call(ctx, g, 1, 10, { get: () => 8 }, style), 0, `${target.name} ${g}`);
    }
  }
});

test('validates all targets before writing any file', (t) => {
  const dir = fixture(t);
  const firstFile = path.join(dir, targets[0].name);
  const before = fs.readFileSync(firstFile, 'utf8');
  const broken = targets.find((target) => target.name !== targets[0].name);
  const brokenFile = path.join(dir, broken.name);
  fs.writeFileSync(brokenFile, fs.readFileSync(brokenFile, 'utf8').replace(broken.find, 'changed-minifier-target'));
  assert.throws(() => applyPatch(dir, () => {}), /Expected v6\.0\.0/);
  assert.equal(fs.readFileSync(firstFile, 'utf8'), before);
});
