import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { electronEnv } from '../scripts/electron-env.js';
import { budget } from './time-budget.js';

const PASSPHRASE = 'gui encryption passphrase';
const TOKEN = 'encryption-gui-token';
const phase = process.argv.find(arg => arg.startsWith('--encryption-gui='))?.split('=')[1];

if (phase) {
  // Electron main process: drive the real app (real safeStorage, real GUI, real API server).
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  (async () => {
    await import('../src/main.js');
    await app.whenReady();
    let window;
    for (let i = 0; i < 300; i++) {
      window = BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoading()) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const run = expression => window.webContents.executeJavaScript(expression);
    const until = async (expression, label = expression) => {
      for (let i = 0; i < 300; i++) { if (await run(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
      throw new Error(`GUI timed out: ${label} STATUS: ${await run('document.getElementById("status").textContent')}`);
    };
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const api = async (command, args = {}) => {
      const response = await fetch(`http://127.0.0.1:${process.env.WEFT_PORT}/v1/execute`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) });
      return { status: response.status, outcome: await response.json() };
    };
    const data = join(process.env.WEFT_TEST_PROFILE, 'workspace-data');
    const plaintextHits = needle => {
      const hits = [];
      const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) walk(file); else if (readFileSync(file).includes(needle)) hits.push(file); } };
      walk(data);
      return hits;
    };
    /** Submit the lock-screen form; resolves to 'unlocked' or the error shown to the person. */
    const attemptUnlock = async (method, secret) => {
      await until('document.getElementById("lock-screen") !== null', 'lock screen');
      await run('document.getElementById("unlock-error").textContent = ""');
      await run(`(() => { const form = document.getElementById("unlock-form"); form.querySelector("[name=method]").value = ${JSON.stringify(method)}; form.querySelector("[name=secret]").value = ${JSON.stringify(secret)}; form.requestSubmit(); })()`);
      await until('document.getElementById("lock-screen") === null || document.getElementById("unlock-error").textContent.length > 0', 'unlock attempt');
      return run('document.getElementById("lock-screen") === null ? "unlocked" : document.getElementById("unlock-error").textContent');
    };
    if (phase === 'enable') {
      await until('document.getElementById("content")?.textContent.includes("Make room")', 'home');
      // Real Electron safeStorage: report the backend and whether Weft treats it as protection.
      const status = await run('window.weft.execute("encryption.status", {})');
      console.log(`WEFT_SAFESTORAGE ${JSON.stringify({ platform: process.platform, ...status.methods.os })}`);
      if (process.platform === 'linux') {
        assert.equal(status.methods.os.protects, status.methods.os.available && /^(gnome_libsecret|kwallet\d?)$/.test(String(status.methods.os.backend)));
        if (status.methods.os.backend === 'basic_text') assert.match(status.methods.os.reason, /hard-coded key/);
      }
      assert.equal(status.enabled, false);
      await run('window.weft.execute("materials.create", { title: "GUI encrypted note", content: "GUI-NEEDLE-CONTENT" })');
      assert.ok(plaintextHits('GUI-NEEDLE-CONTENT').length > 0);
      await click('#settings-button');
      await until('document.querySelector("[data-action=encryption-enable]") !== null', 'encryption settings');
      await click('[data-action="encryption-enable"]');
      await until('document.querySelector("#edit-form [name=acknowledgeKeyLoss]") !== null', 'enable dialog');
      await run(`(() => { const form = document.getElementById("edit-form"); form.querySelector("[name=unlockMode]").value = "manual"; form.querySelector("[name=passphrase]").value = ${JSON.stringify(PASSPHRASE)}; form.querySelector("[name=passphrase2]").value = ${JSON.stringify(PASSPHRASE)}; form.querySelector("[name=acknowledgeKeyLoss]").checked = true; form.requestSubmit(); })()`);
      await until('document.getElementById("recovery-key")?.textContent.length > 0', 'recovery key');
      const recoveryKey = await run('document.getElementById("recovery-key").textContent');
      assert.equal(await run('document.getElementById("recovery-done").disabled'), true, 'Done waits for the person to confirm');
      await run('document.getElementById("recovery-saved").click()');
      await click('#recovery-done');
      await until('document.getElementById("recovery-key") === null', 'recovery key removed from the page');
      await until('document.getElementById("encryption-settings")?.textContent.includes("On (AES-256-GCM)")', 'encryption on');
      // Only the metadata-minimized activity log (character counts, ids) stays plaintext; it never holds content.
      assert.deepEqual(plaintextHits('GUI-NEEDLE-CONTENT'), []);
      assert.deepEqual(plaintextHits(recoveryKey), []);
      // Lock from Settings: the lock screen covers the window and the API answers 423.
      await click('[data-action="encryption-lock"]');
      await until('document.getElementById("lock-screen") !== null', 'lock screen');
      const locked = await api('materials.list');
      assert.equal(locked.status, 423);
      assert.equal(locked.outcome.error.code, 'locked');
      assert.match(await attemptUnlock('passphrase', 'not the passphrase'), /passphrase does not unlock/);
      assert.equal(await attemptUnlock('passphrase', PASSPHRASE), 'unlocked');
      const notes = await run('window.weft.execute("materials.list", {})');
      assert.equal(notes.find(item => item.title === 'GUI encrypted note').content, 'GUI-NEEDLE-CONTENT');
      console.log(`WEFT_RECOVERY_KEY=${recoveryKey}`);
    } else {
      // Restart in manual unlock mode: the app opens on the lock screen; the recovery key unlocks it.
      await until('document.getElementById("lock-screen") !== null', 'lock screen at startup');
      assert.equal((await api('workspace.snapshot')).status, 423);
      assert.equal((await api('encryption.status')).outcome.result.locked, true);
      assert.equal(await attemptUnlock('recovery', process.env.WEFT_RECOVERY_KEY), 'unlocked');
      await until('document.getElementById("content")?.textContent.length > 0', 'workspace rendered');
      const notes = (await api('materials.list')).outcome.result;
      assert.equal(notes.find(item => item.title === 'GUI encrypted note').content, 'GUI-NEEDLE-CONTENT');
    }
    console.log(`WEFT_ENCRYPTION_GUI_${phase.toUpperCase()}_OK`);
    app.quit();
  })().catch(error => {
    console.error(error);
    app.exit(1);
  });
} else {
  const skip = process.platform === 'linux' && !process.env.DISPLAY ? 'Requires DISPLAY or xvfb-run' : false;
  const launch = async (profile, flag, env = {}) => {
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), `--encryption-gui=${flag}`], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile, WEFT_PORT: String(port), WEFT_TOKEN: TOKEN, ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 55000);
    try { return { code: await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }), output }; }
    finally { clearTimeout(timer); }
  };
  test('Settings turns on encryption with the real OS key-store backend reported; lock and restart require a person to unlock', { timeout: budget(150000), skip }, async t => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-encryption-gui-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const first = await launch(profile, 'enable');
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /WEFT_ENCRYPTION_GUI_ENABLE_OK/);
    const backend = JSON.parse(/WEFT_SAFESTORAGE (\{.*\})/.exec(first.output)[1]);
    t.diagnostic(`Electron safeStorage on ${backend.platform}: backend=${backend.backend} available=${backend.available} protects=${backend.protects}`);
    assert.ok(existsSync(join(profile, 'workspace-data', 'encryption-keyring.json')));
    const recoveryKey = /WEFT_RECOVERY_KEY=(\S+)/.exec(first.output)[1];
    const second = await launch(profile, 'restart', { WEFT_RECOVERY_KEY: recoveryKey });
    assert.equal(second.code, 0, second.output);
    assert.match(second.output, /WEFT_ENCRYPTION_GUI_RESTART_OK/);
  });
}
