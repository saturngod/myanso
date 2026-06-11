// Quick driver for myanso WebGL Myanmar experiment (macOS).
import { _electron as electron } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = '/Users/bonjoy/Downloads/myanterm';
const SHOT_DIR = '/tmp/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let app = null, page = null;
const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const COMMANDS = {
  async launch(arg) {
    if (app) return console.log('already launched');
    const env = { ...process.env };
    env.MYAN_DEV_INSTANCE = '1';
    if (arg !== 'dom') env.MYAN_WEBGL = '1';
    else delete env.MYAN_WEBGL;
    app = await electron.launch({
      executablePath: electronBin,
      args: ['--no-sandbox', APP_DIR],
      env,
      timeout: 30_000,
    });
    page = await app.firstWindow();
    page.on('console', m => console.log('[page]', m.text()));
    await page.waitForSelector('.pane-term', { timeout: 15_000 });
    await new Promise(r => setTimeout(r, 2000));
    console.log('launched (' + (arg === 'dom' ? 'DOM' : 'WEBGL') + ').', app.windows().length, 'windows');
  },
  async ss(name) {
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },
  async type(text) { await page.keyboard.type(text, { delay: 20 }); console.log('typed'); },
  async press(key) { await page.keyboard.press(key); console.log('pressed', key); },
  async send(text) {
    // Write a full line directly to the active pane's pty (bypasses keyboard).
    const r = await page.evaluate((t) => {
      const { ipcRenderer } = require('electron');
      const ta = document.querySelector('.xterm-helper-textarea');
      // find the pane id from the console-logged map: use the global hook if present
      const id = window.__activePtyId || 'pty_1_2';
      ipcRenderer.send('pty-input', { id, data: t + '\r' });
      return id;
    }, text);
    console.log('sent to', r);
  },
  async focusterm() {
    await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
    console.log('focused');
  },
  async eval(expr) {
    try { console.log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { console.log('ERROR:', e.message); }
  },
  async quit() { if (app) await app.close().catch(() => {}); app = null; page = null; },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });
rl.on('line', async line => {
  line = line.trim();
  const sp = line.indexOf(' ');
  const cmd = sp === -1 ? line : line.slice(0, sp);
  const rest = sp === -1 ? '' : line.slice(sp + 1);
  if (!cmd) return rl.prompt();
  const fn = COMMANDS[cmd];
  if (!fn) { console.log('unknown:', cmd); return rl.prompt(); }
  try { await fn(rest); } catch (e) { console.log('ERROR:', e.message); }
  if (cmd === 'quit') { rl.close(); process.exit(0); }
  rl.prompt();
});
rl.on('close', async () => { await COMMANDS.quit(); process.exit(0); });
console.log('myanso driver ready — "launch" (webgl) / "launch dom"');
rl.prompt();
