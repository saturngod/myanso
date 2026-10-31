'use strict';

const ALL_ONE_NAMES = ['claude'];
const ALL_ONE_TITLE = /claude/i;
const STD_MODE_NAMES = ['codex'];
// Apps that measure text by grapheme cluster (every Myanmar mark width 0).
const ZERO_MARK_NAMES = ['opencode'];
const SEMVER_FG = /^\d+\.\d+\.\d+/;
const SHELL_FG = /^-?(zsh|bash|fish|dash|sh|ksh|tcsh|csh|pwsh|powershell)(\.exe)?$/;

function isMyanmarMark(c) {
  return (c >= 0x102b && c <= 0x103e) || (c >= 0x1056 && c <= 0x1059) ||
    (c >= 0x105e && c <= 0x1060) || (c >= 0x1062 && c <= 0x1064) ||
    (c >= 0x1067 && c <= 0x106d) || (c >= 0x1071 && c <= 0x1074) ||
    (c >= 0x1082 && c <= 0x108d) || c === 0x108f ||
    (c >= 0x109a && c <= 0x109d);
}

function isMyanmarNonspacing(c) {
  return (c >= 0x102d && c <= 0x1030) || (c >= 0x1032 && c <= 0x1037) ||
    c === 0x1039 || c === 0x103a || c === 0x103d || c === 0x103e ||
    (c >= 0x1058 && c <= 0x1059) || (c >= 0x105e && c <= 0x1060) ||
    (c >= 0x1071 && c <= 0x1074) || c === 0x1082 ||
    (c >= 0x1085 && c <= 0x1086) || c === 0x108d || c === 0x109d;
}

function executableName(name) {
  return String(name || '').split(/[\\/]/).pop().toLowerCase();
}

function isShellForeground(name, configuredShell = '') {
  const fg = executableName(name);
  const configured = executableName(configuredShell);
  return SHELL_FG.test(fg) ||
    (!!configured && fg.replace(/^-/, '') === configured.replace(/^-/, ''));
}

function appWidthModeForContext({ platform = process.platform, foreground = '', title = '', configuredShell = '' }) {
  const fg = String(foreground || '').toLowerCase();
  if (fg === '' || isShellForeground(fg, configuredShell)) return null;
  // opencode (OpenTUI) gives each grapheme cluster one cell, so ကာ and မြန်မာ
  // count as 1 and 3. Standard widths (Mc 1) push its text out of place.
  if (ZERO_MARK_NAMES.some((name) => fg.includes(name))) return 'myan-shell';
  if (SEMVER_FG.test(fg) || ALL_ONE_NAMES.some((name) => fg.includes(name)) || ALL_ONE_TITLE.test(title || '')) {
    // Current Claude Code (2.1.3xx) uses Unicode-standard widths (Mn 0, Mc 1) on
    // every platform. Forcing all-one gives each Mn mark (◌် ◌ူ …) its own cell,
    // and Claude's next character overwrites it (မြန်မာ → မြနမာ).
    return 'myan-std';
  }
  if (STD_MODE_NAMES.some((name) => fg.includes(name))) return 'myan-std';
  return null;
}

function widthModeForContext({ platform, screen = 'normal', foreground = '', title = '', configuredShell = '' }) {
  const appMode = appWidthModeForContext({ platform, foreground, title, configuredShell });
  if (appMode) return appMode;
  if (screen === 'alternate') return 'myan-std';
  return platform === 'linux' ? 'myan-std' : 'myan-shell';
}

module.exports = { isMyanmarMark, isMyanmarNonspacing, isShellForeground, appWidthModeForContext, widthModeForContext };
