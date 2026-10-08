'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SIZE = { width: 900, height: 600 };

function validSize(size) {
  return size && Number.isSafeInteger(size.width) && size.width > 0 &&
    Number.isSafeInteger(size.height) && size.height > 0;
}

function normalBounds(bounds) {
  const result = { width: bounds.width, height: bounds.height };
  if (Number.isSafeInteger(bounds.x) && Number.isSafeInteger(bounds.y)) {
    result.x = bounds.x;
    result.y = bounds.y;
  }
  return result;
}

function loadWindowBounds(file) {
  try {
    const size = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (validSize(size)) return normalBounds(size);
  } catch (_) { }
  return { ...DEFAULT_SIZE };
}

function fitWindowBounds(size, workArea) {
  const normal = validSize(size) ? size : DEFAULT_SIZE;
  const bounds = {
    width: Math.min(normal.width, workArea.width),
    height: Math.min(normal.height, workArea.height)
  };
  if (Number.isSafeInteger(normal.x) && Number.isSafeInteger(normal.y)) {
    bounds.x = Math.max(workArea.x, Math.min(normal.x, workArea.x + workArea.width - bounds.width));
    bounds.y = Math.max(workArea.y, Math.min(normal.y, workArea.y + workArea.height - bounds.height));
  }
  return bounds;
}

function saveWindowBounds(file, bounds) {
  if (!validSize(bounds)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Persist normal size and position, never fullscreen/maximized state.
    fs.writeFileSync(file + '.tmp', JSON.stringify(normalBounds(bounds)));
    fs.renameSync(file + '.tmp', file);
    return true;
  } catch (_) {
    return false;
  }
}

// getNormalBounds can retain the creation bounds after native window movement.
// Keep our own normal geometry from the live window, before close/fullscreen
// transitions can change the native frame.
function trackNormalWindowBounds(win) {
  let bounds = normalBounds(win.getBounds());
  const update = () => {
    if (win.isDestroyed() || win.isFullScreen() || win.isMaximized() || win.isMinimized()) return;
    bounds = normalBounds(win.getBounds());
  };
  win.on('move', update);
  win.on('resize', update);
  return () => ({ ...bounds });
}

module.exports = { loadWindowBounds, fitWindowBounds, saveWindowBounds, trackNormalWindowBounds };
