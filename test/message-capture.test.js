import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { electronEnv } from '../scripts/electron-env.js';
import { messageCaptureScript, capturedMessageMaterial } from '../src/message-capture.js';

if (process.argv.includes('--capture-child')) {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  (async () => {
    await app.whenReady();
    const win = new BrowserWindow({ show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    let html = '<h2 class="hP">Renewal</h2><div>Inbox list should never be copied</div><div class="adn"><span email="first@example.test">First</span><div class="a3s">First expanded message.</div></div><div class="adn"><span email="second@example.test">Second</span><span class="g3" title="2026-10-18">Today</span><div class="a3s">Renewal costs $99. &lt;script&gt;ignored&lt;/script&gt;</div></div><div class="adn" hidden><div class="a3s">Secret hidden message</div></div>';
    // Intercept this session's HTTPS completely: no live account or external network.
    await win.webContents.session.protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    await win.loadURL('https://mail.google.com/mail/u/0/#inbox/fixture');
    const capture = mode => win.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: messageCaptureScript(mode) }]);
    const detected = await capture('detect'); assert.equal(detected.messages, 2); assert.equal(detected.available, true); assert.equal(detected.body, undefined);
    const message = await capture('message'); assert.equal(message.sender, 'second@example.test'); assert.match(message.body, /\$99/); assert.ok(!message.body.includes('Inbox list')); assert.ok(!message.body.includes('First expanded')); assert.ok(!message.body.includes('Secret hidden'));
    const thread = await capture('thread'); assert.equal(thread.messages, 2); assert.match(thread.body, /First expanded/);
    const material = capturedMessageMaterial({ ...message, capturedAt: '2026-10-18T12:00:00Z', navigationVersion: 2 }, { workspaceId: 'ws-fixture' });
    assert.equal(material.localOnly, true); assert.ok(material.tags.includes('mailbox')); assert.match(material.content, /<script>/);
    html = '<main role="main"><h2 role="heading" aria-level="2">Outlook subject</h2><div data-item-id="123"><span data-testid="message-sender">sender@example.test</span><div role="document">Outlook body</div></div></main>';
    await win.loadURL('https://outlook.office.com/mail/inbox/id/123');
    assert.equal((await capture('message')).body, 'Outlook body');
    html = '<h1>Unsupported site</h1><p id="selected">Only selected evidence</p><p>Other private content</p>';
    await win.loadURL('https://mail.google.com.evil.test/mail');
    assert.equal((await capture('detect')).available, false);
    await win.webContents.executeJavaScript('const r=document.createRange();r.selectNodeContents(document.getElementById("selected"));getSelection().removeAllRanges();getSelection().addRange(r)');
    const selected = await capture('selection'); assert.equal(selected.body, 'Only selected evidence'); assert.equal(selected.adapter, 'selection');
    console.log('CAPTURE_OK'); win.destroy(); app.quit();
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  test('real Chromium extracts only visible Gmail/Outlook message bodies and explicit selections', { timeout: 30000, skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires DISPLAY' : false }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-message-'));
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), '--capture-child'], { env: electronEnv({ WEFT_TEST_PROFILE: profile }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25000);
    try { const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }); assert.equal(code, 0, output); assert.match(output, /CAPTURE_OK/); }
    finally { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); }
  });
}
