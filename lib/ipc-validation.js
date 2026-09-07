'use strict';

const MAX_ID_LENGTH = 80;
const MAX_INPUT_LENGTH = 16 * 1024 * 1024;
const MAX_PATH_LENGTH = 8192;
const MAX_TEXT_LENGTH = 1024;
const MAX_SCROLLBACK_LENGTH = 8 * 1024 * 1024;
const MAX_PANES = 64;
const MAX_TREE_DEPTH = 32;
const PTY_ID = /^pty_\d+_\d+$/;
const TAB_ID = /^tab_\d+_\d+$/;
const TRANSFER_ID = /^transfer_\d+_\d+$/;
const TAB_DRAG_OUTCOMES = new Set(['reordered', 'transferring', 'cancelled']);

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value, max, optional = false) =>
  (optional && value === undefined) || (typeof value === 'string' && value.length <= max);

function validPtyId(value) {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && PTY_ID.test(value);
}

function validTabId(value) {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && TAB_ID.test(value);
}

function validTransferId(value) {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && TRANSFER_ID.test(value);
}

function validDimensions(cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && cols <= 1000 && rows >= 1 && rows <= 1000;
}

function validPtyIds(value) {
  return Array.isArray(value) && value.length <= MAX_PANES &&
    value.every(validPtyId) && new Set(value).size === value.length;
}

function validPtyCreate(value) {
  return object(value) && validPtyId(value.id) && validDimensions(value.cols, value.rows) &&
    boundedString(value.cwd, MAX_PATH_LENGTH, true) &&
    (value.inheritPtyId === undefined || validPtyId(value.inheritPtyId));
}

function validPtyInput(value) {
  return object(value) && validPtyId(value.id) &&
    typeof value.data === 'string' && value.data.length <= MAX_INPUT_LENGTH;
}

function validPtyResize(value) {
  return object(value) && validPtyId(value.id) && validDimensions(value.cols, value.rows);
}

function validPtyReference(value) {
  return object(value) && validPtyId(value.id);
}

function validateTree(node, depth, ids) {
  if (!object(node) || depth > MAX_TREE_DEPTH) return false;
  if (node.leaf === true) {
    if (!object(node.pane) || !validPtyId(node.pane.ptyId) || ids.has(node.pane.ptyId)) return false;
    if (!boundedString(node.pane.cwd, MAX_PATH_LENGTH, true) ||
        !boundedString(node.pane.title, MAX_TEXT_LENGTH, true) ||
        !boundedString(node.pane.scrollback, MAX_SCROLLBACK_LENGTH, true) ||
        !boundedString(node.pane.foreground, MAX_TEXT_LENGTH, true) ||
        (node.pane.cols !== undefined && !validDimensions(node.pane.cols, node.pane.rows))) return false;
    ids.add(node.pane.ptyId);
    return ids.size <= MAX_PANES;
  }
  if (node.leaf !== false || !['row', 'col'].includes(node.dir)) return false;
  if (node.ratio !== undefined && (!Number.isFinite(node.ratio) || node.ratio < 0.05 || node.ratio > 0.95)) return false;
  return validateTree(node.a, depth + 1, ids) && validateTree(node.b, depth + 1, ids);
}

function validPaneDescriptor(value) {
  if (!object(value) || !validPtyId(value.ptyId) ||
      !boundedString(value.cwd, MAX_PATH_LENGTH, true) ||
      !boundedString(value.title, MAX_TEXT_LENGTH, true) ||
      !boundedString(value.scrollback, MAX_SCROLLBACK_LENGTH, true) ||
      !boundedString(value.foreground, MAX_TEXT_LENGTH, true)) return false;
  return validDimensions(value.cols, value.rows);
}

function validPaneTransfer(value, descriptorRequired = false) {
  return object(value) && validTransferId(value.transferId) && validTabId(value.tabId) &&
    validPtyId(value.ptyId) && (!descriptorRequired ||
      (validPaneDescriptor(value.descriptor) && value.descriptor.ptyId === value.ptyId));
}

function validTabDescriptor(value) {
  if (!object(value) || !validTabId(value.tabId) || !validPtyIds(value.ptyIds) ||
      !boundedString(value.title, MAX_TEXT_LENGTH, true) ||
      !boundedString(value.customTitle, MAX_TEXT_LENGTH, true) ||
      !boundedString(value.color, 64, true)) return false;
  const ids = new Set();
  if (!validateTree(value.tree, 0, ids)) return false;
  return ids.size === value.ptyIds.length && value.ptyIds.every((id) => ids.has(id));
}

function validCloseRequest(value) {
  return object(value) && validPtyIds(value.ptyIds);
}

function validTabDragResult(value) {
  return object(value) && validTabId(value.tabId) && TAB_DRAG_OUTCOMES.has(value.outcome);
}

module.exports = {
  MAX_INPUT_LENGTH,
  validPtyId,
  validTabId,
  validTransferId,
  validDimensions,
  validPtyIds,
  validPtyCreate,
  validPtyInput,
  validPtyResize,
  validPtyReference,
  validTabDescriptor,
  validPaneDescriptor,
  validPaneTransfer,
  validCloseRequest,
  validTabDragResult
};
