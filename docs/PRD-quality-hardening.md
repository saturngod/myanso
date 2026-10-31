# Myanso Quality and Security Hardening PRD

**Status:** Phases 1–4 implemented; cross-platform CI/manual verification pending  
**Target:** Myanso 0.5.x  
**Last updated:** 2026-07-29  
**Owner:** Myanso maintainers

### Implementation record

Phases 1–4 were implemented on 2026-07-29. Phase 5 remains intentionally
deferred because signing and notarization require maintainer-owned certificates
and CI secrets. Local verification completed with 29 automated tests, a clean
production dependency audit, an arm64 macOS DMG build, and a five-second
isolated-user-data application smoke run.

The full development audit currently reports 16 high-severity findings in the
Electron Builder toolchain, all rooted in the upstream `brace-expansion` chain.
Myanso is on the current Electron Builder v26 release line (26.15.7), and npm
offers no non-breaking remediation; its suggested forced remediation is a
builder downgrade. These packages are build-time dependencies and are not
production dependencies (`npm audit --omit=dev` reports zero findings). Recheck
the full audit on future builder releases. Linux, Windows, and the complete
interactive Myanmar matrix remain release-candidate checks, exercised by CI and
maintainer test machines rather than this macOS implementation session.

## 1. Summary

Myanso is already reliable for daily use and its Myanmar rendering behavior is the product's primary advantage. This project improves the safety of future releases without redesigning the terminal or changing its established Myanmar shaping and width behavior.

The work has four goals:

1. Make dependency and release failures visible before publishing.
2. Add automated regression coverage around the fragile terminal-specific logic.
3. Reduce the impact of a compromised renderer and reject invalid cross-window IPC.
4. Preserve current behavior through a staged rollout and manual Myanmar test matrix.

This is primarily a hardening and maintainability release. It does not add a new terminal feature, change the UI, or replace xterm.js.

## 2. Background

The current application has strong defensive handling in several difficult areas:

- PTY output is coalesced and flow-controlled.
- DEC synchronized-output mode 2026 markers are stripped across chunk boundaries.
- Native `node-pty` operations are guarded against exit races.
- Cross-window tab moves preserve PTYs, scrollback, custom titles, colors, and foreground-process width selection.
- Myanmar mark width is selected per platform, screen, and foreground application.
- The xterm DOM-renderer patch is idempotent and fails when its minified targets no longer match.
- OSC 8 links use an explicit protocol allowlist.
- A Content Security Policy blocks remote scripts and network connections.

These behaviors should be treated as protected compatibility requirements.

The main remaining risks are not reported daily-use bugs. They are change-management and trust-boundary risks:

- The xterm patch expects exactly xterm 6.0.0, but `package.json` permits any compatible 6.x version.
- There are no automated tests for the mode-2026 stream transform, Myanmar-width tables, process selection, or utility parsing.
- The installed packaging toolchain has audit findings even though production dependencies are clean.
- The renderer currently runs with Node integration enabled and context isolation disabled.
- PTY IPC handlers trust the supplied PTY id instead of checking sender ownership and input shape.
- Release artifact upload is configured to ignore missing files.

## 3. Product objective

Ship a hardening release that behaves identically to the current version during normal terminal use while making accidental rendering regressions, invalid IPC, incomplete artifacts, and unsafe renderer behavior substantially harder to introduce.

## 4. Success metrics

The project is complete when all of the following are true:

- `npm test` runs deterministic unit tests without launching Electron.
- Every legal split of `ESC[?2026h` and `ESC[?2026l` is tested and removed correctly.
- Representative Myanmar Mn and Mc code points are tested in all three width modes.
- Shell, Claude Code, Codex CLI, alternate-screen, and platform-default selection paths are tested.
- `@xterm/xterm` is pinned to exactly 6.0.0.
- `npm audit --omit=dev` reports zero known production advisories.
- The packaging dependency chain is updated to a version that resolves the applicable `electron-builder` advisories.
- A renderer can operate only on PTYs owned by its `BrowserWindow`, except during the explicit main-process tab-transfer transaction.
- Unexpected navigation and popup creation are denied.
- The application runs with `nodeIntegration: false` and `contextIsolation: true`, or the security migration is explicitly deferred after the earlier phases ship.
- CI fails if any expected platform artifact is absent.
- Manual Myanmar verification passes on macOS, Linux, and Windows release candidates where runners or test machines are available.
- Normal keystroke latency and bulk-output behavior show no observable regression.

## 5. Non-goals

This project will not:

- Upgrade `@xterm/xterm` beyond 6.0.0.
- Rewrite or generalize the Myanmar DOM-renderer patch.
- Change the mark-width rules or app-detection policy.
- Introduce a framework, TypeScript conversion, or broad UI rewrite.
- Replace `node-pty`.
- Add session persistence, profiles, SSH management, command palettes, or other unrelated terminal features.
- Split `main.js` or `renderer.js` solely to reduce line count.
- Require code signing or notarization for local/personal builds.

## 6. Compatibility requirements

The following behavior is release-blocking and must remain unchanged:

| Context | Expected width provider |
| --- | --- |
| macOS normal shell screen | `myan-shell` |
| Linux normal shell screen | `myan-std` |
| Alternate screen, including vim and agy | `myan-std` |
| Claude Code | `myan-std` |
| Codex CLI on the normal screen | `myan-std` |

Additional protected behavior:

- Mode-2026 set/reset sequences never reach xterm, including when split across PTY chunks.
- A chunk ending in a partial non-2026 CSI sequence is not incorrectly lost.
- A noisy PTY is paused above the high watermark and resumed below the low watermark.
- Moving a tab does not kill its PTY or leave it permanently paused.
- Closing a busy pane, window, or application still requires confirmation.
- File drops paste one safely quoted path without executing it.
- OSC 8 `file://` links and approved external protocols keep working.
- Custom tab titles, colors, scrollback, cwd, and split layout survive a window transfer.

## 7. Delivery plan

The work is divided into independently releasable phases. Each phase should be committed and manually verified before beginning the next one.

### Phase 1 — Dependency and CI hygiene

#### 7.1 Exact xterm version

**File:** `package.json`

Change:

```json
"@xterm/xterm": "6.0.0"
```

Replace the current caret range. The patch uses minifier-specific strings and therefore does not follow semantic-version compatibility. The lockfile should be regenerated with the same xterm version and reviewed to ensure no unrelated production dependency changed.

**File:** `package-lock.json`

- Regenerate after the package change.
- Confirm both the root declaration and resolved package remain 6.0.0.
- Run `npm ci` from a clean dependency directory in CI to prove reproducibility.

#### 7.2 Packaging dependency refresh

**Files:** `package.json`, `package-lock.json`

- Update `electron-builder` from the currently locked 26.8.1 to at least 26.15.0; use the newest verified 26.x release at implementation time.
- Update `@electron/rebuild` within its current major version.
- Keep Electron itself on the current pinned version during this phase. An Electron major upgrade must be a separate change because it affects Chromium rendering and `node-pty` ABI compatibility.
- Run both `npm audit --omit=dev` and the full `npm audit` after regenerating the lockfile.
- Document any remaining dev-only advisory that cannot be removed without a major toolchain change.

The audit result must be interpreted by runtime reachability. Build-only findings should still be fixed when a compatible toolchain update exists, but they should not be described as a vulnerability in the shipped terminal unless the affected package is included and reachable at runtime.

#### 7.3 Package scripts

**File:** `package.json`

Add scripts equivalent to:

```json
"test": "node --test test/**/*.test.js",
"check": "node --check main.js && node --check renderer.js && node --check patches/patch-xterm-myanmar.js && npm test && npm run patch-xterm",
"audit:prod": "npm audit --omit=dev"
```

The existing `postinstall`, `patch-xterm`, `rebuild`, and `dist` behavior remains unchanged.

#### 7.4 Release artifact enforcement

**File:** `.github/workflows/release.yml`

Changes:

- Set workflow default permissions to `contents: read`.
- Set `contents: write` only on the release job.
- Add a platform-specific verification step after packaging.
- Change artifact upload from `if-no-files-found: ignore` to `if-no-files-found: error`.
- Keep the matrix and architectures unchanged.

The verification step should check the exact required outputs:

| Matrix target | Required output |
| --- | --- |
| macOS arm64 | at least one `.dmg` |
| Linux x64 | `.AppImage`, `.deb`, and `.rpm` |
| Linux arm64 | `.AppImage`, `.deb`, and `.rpm` |
| Windows | at least one NSIS `.exe` |

Do not rely only on the upload action: a broad path can succeed when one of three Linux formats is missing. A small shell step should count each extension and exit non-zero if any required format is absent.

Add `npm run check` before packaging. The build continues to run the patch explicitly as defense in depth.

**Acceptance criteria for Phase 1**

- A clean `npm ci` succeeds on all matrix platforms.
- The xterm patch reports `6/6` targets patched or already patched.
- Deleting or renaming any expected artifact makes its matrix job fail.
- Build jobs cannot write repository contents.
- The released application starts and opens a PTY on each supported platform.

### Phase 2 — Regression test foundation

Use the built-in `node:test` and `node:assert/strict` modules. No test framework dependency is needed.

#### 7.5 Extract the mode-2026 stream transform

**New file:** `lib/sync-output.js`

Move only the pure marker/carry logic out of `main.js`:

```js
function stripSynchronizedOutput(data, carry = '') {
  // returns { data, carry }
}

module.exports = { stripSynchronizedOutput };
```

The function owns the prefix constants and must remain state-free. `spawnPty` keeps the per-PTY `rec.syncCarry` value:

```js
const result = stripSynchronizedOutput(data, rec.syncCarry);
rec.syncCarry = result.carry;
data = result.data;
```

No output buffering, IPC, or `node-pty` behavior moves into this module.

**New file:** `test/sync-output.test.js`

Test cases:

- Complete set and reset markers are removed.
- Both markers embedded between printable strings are removed without joining errors.
- Every split position from 1 through marker length minus 1 reconstructs and removes the marker.
- Multiple markers in one chunk are removed.
- A trailing `ESC`, `ESC[`, and longer valid marker prefix is carried.
- A carried prefix followed by unrelated data is emitted without loss on the next call.
- Ordinary SGR/CSI sequences are preserved byte-for-byte.
- Empty input and marker-only input return correct data and carry.
- Myanmar and non-ASCII output around markers is preserved exactly.

#### 7.6 Extract Myanmar classification and app selection

**New file:** `lib/myanmar-width.js`

Move or expose pure functions and constants:

- `isMyanmarMark(codePoint)`
- `isMyanmarNonspacing(codePoint)`
- `isShellForeground(name, configuredShell)`
- `widthModeForContext({ platform, screen, foreground, title, configuredShell })`

Return one of `myan-shell`, `myan-std`, or `myan-allone`. Keep xterm registration and buffer event handling in `renderer.js`; only the decision becomes pure.

`renderer.js` should pass explicit inputs instead of allowing the module to read global `process` state. This makes platform cases testable from any development machine.

**New file:** `test/myanmar-width.test.js`

Include table-driven cases for:

- Boundaries of every Myanmar mark range.
- At least one code point immediately before and after every range.
- Known Mn marks including U+103A, U+103D, and U+103E.
- Known spacing marks including U+102C and U+1038.
- Plain Myanmar base letters returning false for both mark predicates.
- macOS and Linux normal-shell defaults.
- Alternate-screen override.
- Claude foreground name, version-style foreground name, and Claude title fallback.
- Codex CLI in a resolved `node:<command>` foreground string.
- Stale Claude/Codex titles while a plain shell is foreground.
- Unknown foreground applications.

The xterm patch has an inline copy of the mark ranges. Add a test that extracts or reproduces the patch predicate against the same boundary table so divergence is caught during review.

#### 7.7 Extract small terminal utilities

**New file:** `lib/terminal-utils.js`

Move pure helpers where practical:

- `quoteShellPath(path, platform)`
- `parseOsc7(data, platform)` if a platform parameter is necessary
- `basename(path, platform)`
- `baseName`/busy-label token parsing where it does not depend on a PTY object

**New file:** `test/terminal-utils.test.js`

Cover:

- POSIX paths containing spaces, single quotes, newlines, and leading dashes.
- PowerShell paths containing spaces and single quotes.
- POSIX and Windows OSC 7 file URLs.
- Percent-encoded Unicode/Myanmar directory names.
- Malformed OSC 7 data returning an empty string rather than throwing.
- Busy labels for normal executables and resolved Node commands.

#### 7.8 Patch verification tests

**New file:** `test/patch-xterm.test.js`

The test should operate on a temporary fixture, not mutate the working `node_modules` tree. Refactor the patch script just enough to export an `applyPatch(baseDirectory)` function while preserving its CLI behavior under `require.main === module`.

Verify:

- All six expected replacements apply.
- A second invocation is idempotent.
- A missing file fails.
- A changed target fails with a message naming the xterm version expectation.
- Partial success cannot be silently reported as `6/6`.

**Acceptance criteria for Phase 2**

- `npm test` is deterministic and completes without Electron or a display server.
- Production code calls the extracted functions rather than maintaining duplicate logic, except for the deliberately inlined xterm patch predicate.
- Manual shell, vim, agy, Claude Code, and Codex CLI Myanmar checks remain unchanged.

### Phase 3 — Low-risk Electron and IPC hardening

This phase improves boundaries while retaining the current renderer execution model. It should ship before the larger context-isolation migration.

#### 7.9 Navigation and window creation policy

**File:** `main.js`, inside `createWindow`

After creating the window:

```js
win.webContents.on('will-navigate', (event, url) => {
  if (url !== expectedIndexUrl) event.preventDefault();
});

win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
```

Calculate the expected local URL from `index.html`; do not use a broad `file:` allow rule. External URLs already flow through the vetted OSC 8 handler and `shell.openExternal`, so the web contents should never navigate away from the application document.

#### 7.10 Permission policy

**File:** `main.js`

The current session handler grants `local-fonts` based only on permission name. Change both request and check handlers to verify:

- permission is exactly `local-fonts`;
- requesting `webContents` belongs to a live Myanso window;
- requesting origin is the local `index.html` origin.

All other permissions are denied.

Because the default session handler is session-wide, install it once during application startup or ensure every installation uses the same strict predicate.

#### 7.11 IPC schema validation

**New file:** `lib/ipc-validation.js`

Use small handwritten validators rather than adding a schema dependency. Enforce:

- PTY id is a bounded string matching the generated id format.
- `cols` and `rows` are finite integers within reasonable terminal bounds, for example 1–1000.
- input data is a string with a bounded per-message size.
- cwd is absent or a string with a reasonable maximum length.
- arrays such as `ptyIds` contain only valid ids and have a pane-count limit.
- tab descriptors have a maximum serialized scrollback size and valid tree depth.
- tab count and selected-tab index are finite bounded integers.

Invalid messages should be ignored and optionally logged in development mode. They must never throw an uncaught main-process exception.

#### 7.12 PTY ownership checks

**File:** `main.js`

Add helpers:

```js
function senderWindow(event) { /* BrowserWindow.fromWebContents */ }
function ownedPty(event, id) { /* validate id and ownerWinId */ }
```

Use `ownedPty` for:

- `pty-input`
- `pty-resize`
- `pty-kill`
- `pty-pause`
- `pty-resume`
- `confirm-close-ptys`
- cwd inheritance during `pty-create`

`pty-create` must reject an id already present in the map. Without this check, a duplicate id could replace the map record and orphan the original native PTY.

Cross-window transfer remains a main-process transaction:

1. Validate that every `ptyId` belongs to the drag source.
2. Validate that the serialization reply comes from the same source.
3. Repoint ownership in `moveTabToWindow`.
4. Send the adoption descriptor to the target.
5. Accept `tab-adopted` only from the recorded target window.
6. Remove the source view after the valid acknowledgement.

Change `pendingRemoval` entries from a source window alone to a record containing source window, target window, tab id, and expected PTY ids. This prevents an unrelated window from acknowledging another transfer.

#### 7.13 Renderer message validation

**File:** `renderer.js`

Main-process messages should also be treated defensively:

- Ignore unknown PTY ids except for the deliberate pending adoption path.
- Bound pending transfer data and descriptor scrollback.
- Check that incoming tab descriptors have a valid split-tree shape and maximum depth before recursively rebuilding them.
- Continue using `textContent` for terminal-controlled titles and paths.
- Keep the OSC 8 allowlist unchanged.

**New file:** `test/ipc-validation.test.js`

Add unit tests for accepted and rejected ids, dimensions, input sizes, descriptor depth, scrollback limits, and ownership helper behavior using lightweight fake window ids.

**Acceptance criteria for Phase 3**

- One window cannot write to, resize, pause, resume, kill, or approve closure of another window's PTY by sending its id.
- A normal tab transfer still changes ownership exactly once and retains output.
- Duplicate PTY creation is rejected without leaking or replacing the original process.
- Navigating the web contents or opening a popup is denied.
- Local font enumeration still works; microphone, camera, geolocation, notifications, and other permissions are denied.

### Phase 4 — Context isolation migration

This phase has the greatest compatibility risk and should be implemented only after Phases 1–3 provide regression coverage.

The preferred low-complexity design keeps the existing UI code in an Electron preload isolated world rather than adding a web bundler.

#### 7.14 Preload bootstrap

**New file:** `preload.js`

The preload waits for the DOM before loading the existing renderer module:

```js
window.addEventListener('DOMContentLoaded', () => {
  require('./renderer.js');
}, { once: true });
```

This allows `renderer.js` to continue using xterm, addons, Electron IPC, `webUtils`, clipboard, and URL helpers from the isolated preload context while preventing scripts in the page's main JavaScript world from gaining `require` or Electron access.

This design must be prototyped against Electron 42 before merging. If xterm or a browser API behaves incorrectly across isolated worlds, fall back to a narrow `contextBridge` API plus a renderer bundling step; do not disable isolation to make the test pass.

#### 7.15 BrowserWindow preferences

**File:** `main.js`

Change `webPreferences` to:

```js
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: false,
  additionalArguments: extraArgs
}
```

`sandbox: false` is explicit because the preload needs normal Node `require` access for the local xterm packages. This is not Chromium renderer sandboxing, but it is still a meaningful improvement: page-world script no longer receives Node or IPC primitives, and the preload lives in an isolated JavaScript world.

#### 7.16 Remove page-world renderer loading

**File:** `index.html`

Remove:

```html
<script src="renderer.js"></script>
```

Keep the CSP. After the change, there should be no application script executing in the page main world.

**File:** `electron-builder.yml`

Add `preload.js` to packaged files. Keep `renderer.js` because the preload requires it.

**Files:** `README.md`, `README_MM.md`, `AGENTS.md`

Update architecture documentation to explain that `renderer.js` executes from the isolated preload bootstrap. Preserve the PTY data-flow diagram because the channel behavior remains the same.

#### 7.17 Isolation smoke checks

During development, verify in DevTools:

- `window.require` is undefined in the page main world.
- `window.process` is undefined in the page main world.
- UI event handlers registered by the isolated renderer still work.
- xterm input, composition, selection, search decorations, OSC handlers, drag/drop, local fonts, and settings storage still work.

**Acceptance criteria for Phase 4**

- `nodeIntegration` is false and `contextIsolation` is true.
- No page-world JavaScript has direct Node or Electron API access.
- The CSP contains no new `unsafe-eval`, remote source, or broad connect permission.
- All existing terminal features and the manual Myanmar matrix pass.

### Phase 5 — Optional distribution trust

This phase is needed only when Myanso is distributed broadly to non-technical users.

#### 7.18 macOS

**Files:** `electron-builder.yml`, `.github/workflows/release.yml`

- Configure Developer ID signing.
- Enable hardened runtime.
- Add the minimum entitlements required by Electron and `node-pty`.
- Notarize and staple the DMG.
- Keep unsigned local builds possible when credentials are absent.

#### 7.19 Windows

- Sign the NSIS installer and executable with a trusted code-signing certificate.
- Verify signatures in CI before upload.

Signing secrets must be environment/CI secrets and must never be committed.

## 8. Manual verification matrix

Every phase that changes runtime code must run the applicable portion of this matrix. Phase 4 requires the complete matrix.

### 8.1 General terminal behavior

- Start the application and create/close multiple tabs.
- Split horizontally and vertically; resize split dividers rapidly.
- Move focus with keyboard commands.
- Tear a tab into a new window and move a split tab between windows.
- Verify custom title, color, cwd, split structure, and recent scrollback survive.
- Run a high-output command and confirm UI responsiveness and later PTY resume.
- Run a long-lived process and confirm close/quit prompts appear.
- Confirm a returned shell prompt does not produce a stale busy prompt.
- Search English and Myanmar text with next/previous navigation.
- Drop paths containing spaces and quotes into both shell and a TUI.
- Open allowed OSC 8 links and verify blocked protocols do nothing.

### 8.2 Myanmar rendering

Use words containing base letters, medials, asat, spacing vowels, non-spacing vowels, and three or more marks. Include `မြန်မာ`, `ဘူး`, and `တို့`, plus representative daily-use samples.

For each relevant platform:

- Type and paste in the normal shell screen.
- Edit in the middle of an existing quoted command.
- Move the cursor left/right across clusters and insert/delete characters.
- Test vim on the alternate screen with `set maxcombine=6`.
- Test agy typing and paste behavior.
- Test Claude Code and confirm all-one mode.
- Test Codex CLI on the normal screen and confirm standard mode.
- Switch from each TUI back to the shell and confirm stale title/process detection does not persist.

### 8.3 Platform packaging

- macOS arm64: install from DMG, launch, Dock folder drop, Finder open-file path.
- Linux x64/arm64: launch each applicable package, test frameless controls, desktop menu entry, and folder argument.
- Windows: install with NSIS, test PowerShell selection, Unicode cwd, and file-path quoting.

## 9. Performance requirements

- Interactive echo should not add a full event-loop turn beyond the current coalescing behavior.
- The process poll cadence remains 600 ms active and 2000 ms idle unless measurements justify a change.
- The mode-2026 transform remains linear in chunk size and does not repeatedly scan more than the bounded trailing prefix for carry detection.
- IPC validators should be constant-time except for bounded arrays/descriptors.
- Tab transfer serialization remains capped at 2000 scrollback lines.
- No test or security change may remove the existing high/low flow-control watermarks.

For performance-sensitive changes, compare:

- time to display a large local file;
- renderer memory during sustained output;
- input responsiveness while output is active;
- tab-transfer time with deep scrollback and multiple panes.

The goal is no observable regression, not a new benchmark claim.

## 10. Rollout and recovery

1. Merge and release Phase 1 independently.
2. Merge Phase 2 and require `npm run check` on every pull request.
3. Merge Phase 3 in small commits: navigation, validation, ownership, then transfer acknowledgement.
4. Produce a prerelease build for Phase 4 and use it daily before promoting it.
5. Keep the last stable installer available throughout the rollout.

If a regression appears:

- Revert only the latest phase or sub-phase.
- Do not change Myanmar ranges or width modes as a generic workaround.
- Capture platform, foreground process, screen type, code points, PTY output, and reproduction steps.
- Add a regression test before reapplying the fix when the issue can be represented without visual shaping.

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Dependency refresh changes packaging output | Missing or broken installer | Update builder separately; verify every extension in CI; smoke-test installers |
| Pure-function extraction subtly changes stream state | Dropped or leaked mode-2026 bytes | Exhaustively test every marker split before replacing inline logic |
| Ownership checks reject legitimate transfer traffic | Frozen or disconnected moved tab | Model transfer as a main-owned transaction and test source/target ids |
| Context isolation changes event or DOM behavior | Terminal UI failure | Implement after test phases; use prerelease daily; keep migration revertable |
| Width tables diverge from patch ranges | Shaping or cursor regression | Shared boundary test and explicit review checklist |
| Over-refactoring stable code | New bugs without user value | Move only pure, testable logic; keep PTY lifecycle and UI model in place |
| Signing work blocks community/local builds | Harder contributor workflow | Make signing conditional on CI credentials |

## 12. Definition of done

- All phase acceptance criteria selected for the release are satisfied.
- `npm run check` passes from a clean checkout.
- Production audit is clean and packaging audit findings are resolved or documented.
- CI proves all expected artifacts exist.
- The working application passes the full manual Myanmar matrix for any phase touching renderer execution, xterm dependencies, PTY data, or IPC.
- Architecture documentation reflects the final security model.
- No unrelated feature or visual redesign is included in the hardening pull request.

## 13. Recommended pull-request sequence

To keep review and rollback simple, use separate pull requests:

1. **Build hygiene:** exact xterm pin, builder refresh, audit/check scripts, strict artifacts.
2. **Regression tests:** pure helper extraction and `node:test` coverage.
3. **IPC hardening:** validation, PTY ownership, transfer acknowledgement checks.
4. **Renderer isolation:** preload bootstrap and BrowserWindow preference changes.
5. **Signing/notarization:** optional distribution project.

Each pull request should include its own manual-test results and should avoid mixing cleanup or feature work with the stated scope.
