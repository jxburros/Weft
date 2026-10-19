import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Browser, applyEngineHardening } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { PasswordService } from '../src/passwords.js';
import { electronEnv } from '../scripts/electron-env.js';
import { budget } from './time-budget.js';

const child = process.argv.includes('--passwords-smoke');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Condition timed out') {
  for (let attempt = 0; attempt < 400; attempt++) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error(message);
}
const login = '<!doctype html><title>login</title><form action="/welcome" method="post"><input name="user" id="user" autocomplete="username"><input type="password" name="pass" id="pass"><button id="go" style="position:fixed;left:0;top:0;width:300px;height:200px">Sign in</button></form>';
const PAGES = {
  '/login': login,
  '/welcome': '<!doctype html><title>welcome</title>',
  '/signup': '<!doctype html><title>signup</title><form><input name="email"><input type="password" id="p1" autocomplete="new-password"><input type="password" id="p2" autocomplete="new-password"></form>',
};

async function smoke() {
  const { app, BrowserWindow } = electron;
  const profile = process.env.WEFT_TEST_PROFILE;
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const server = createServer((request, response) => {
    const path = request.url.split('?')[0];
    response.setHeader('content-type', 'text/html');
    if (path === '/framed') { response.end(`<!doctype html><title>framed</title><iframe src="http://other.localhost:${server.address().port}/login"></iframe>`); return; }
    response.end(PAGES[path] ?? `<!doctype html><title>${path}</title>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = (path, host = 'site.localhost') => `http://${host}:${server.address().port}${path}`;
  const workspace = new WorkspaceService({ directory: join(profile, 'records') });
  const window = new BrowserWindow({ show: true, width: 900, height: 700 });
  const browser = new Browser({ window, workspaceService: workspace });
  workspace.attachBrowser(browser);
  const protector = { status: () => ({ protected: true, backend: 'test' }), wrap: text => Buffer.from(`w:${text}`), unwrap: bytes => Buffer.from(bytes).toString().slice(2) };
  const passwords = new PasswordService({ directory: join(profile, 'passwords'), protector, browser, workspace, confirmReveal: async () => true });
  const human = { actor: 'human' };
  const automation = { actor: 'automation' };
  try {
    await browser.restore();
    browser.setLayout({ x: 0, y: 0, width: 900, height: 700, visible: true });
    const tab = browser.activeId;
    const contents = () => browser.tab(tab).view.webContents;
    const go = async target => { await browser.execute('page.navigate', { tabId: tab, url: target }, human); await pause(300); };

    // A person submits a sign-in: Weft offers to save it, and saves only when the person says so.
    await go(url('/login'));
    await contents().executeJavaScript('document.getElementById("user").value = "alice"; document.getElementById("pass").value = "s3cret-value"');
    await pause(300);
    contents().focus();
    contents().sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
    contents().sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
    const offer = await until(() => browser.describe(browser.tab(tab)).protection.passwordOffer, 'save offer after sign-in');
    assert.deepEqual([offer.username, offer.kind, offer.origin], ['alice', 'save', new URL(url('/')).origin]);
    assert.doesNotMatch(JSON.stringify(browser.describe(browser.tab(tab))), /s3cret/);
    await assert.rejects(browser.execute('passwords.respondOffer', { offerId: offer.id, action: 'save' }, automation), /only to the person/);
    await browser.execute('passwords.respondOffer', { offerId: offer.id, action: 'save' }, human);
    const [entry] = (await browser.execute('passwords.list', {}, human)).entries;
    assert.equal(entry.username, 'alice');

    // A script-submitted form without human input is never captured.
    await go(url('/login'));
    browser.tab(tab).lastHumanInput = 0;
    await contents().executeJavaScript('document.getElementById("user").value = "mallory"; document.getElementById("pass").value = "x"; document.querySelector("form").requestSubmit()');
    await pause(800);
    assert.equal(browser.describe(browser.tab(tab)).protection.passwordOffer, null);

    // Autofill happens only when the person chooses it, only on the saved origin; then automation cannot read the page with code.
    await go(url('/login'));
    assert.equal(browser.describe(browser.tab(tab)).protection.savedLogins, 1);
    await assert.rejects(browser.execute('passwords.fill', { id: entry.id, tabId: tab }, automation), /only to the person/);
    const filled = await browser.execute('passwords.fill', { id: entry.id, tabId: tab }, human);
    assert.deepEqual(filled.filled, ['username', 'password']);
    assert.equal(await contents().executeJavaScript('document.getElementById("pass").value'), 's3cret-value');
    const claimed = await browser.execute('tabs.claim', { tabId: tab }, automation);
    await assert.rejects(browser.execute('page.evaluate', { tabId: tab, expectedVersion: claimed.version, expression: 'document.getElementById("pass").value' }, automation), /refused/);
    await browser.execute('tabs.release', { tabId: tab }, automation);
    const readable = JSON.stringify(await browser.execute('page.readable', { tabId: tab }, automation));
    assert.doesNotMatch(readable, /s3cret/);

    // Wrong site: refused. A login form in a frame from another origin is never filled.
    await go(url('/login', 'other.localhost'));
    await assert.rejects(browser.execute('passwords.fill', { id: entry.id, tabId: tab }, human), error => error.code === 'target_mismatch');
    await go(url('/framed'));
    await pause(500);
    await assert.rejects(browser.execute('passwords.fill', { id: entry.id, tabId: tab }, human), error => error.code === 'not_found');
    assert.equal(await browser.tab(tab).view.webContents.mainFrame.framesInSubtree.find(frame => frame.origin.includes('other.localhost')).executeJavaScript('document.getElementById("pass").value'), '');

    // The generator fills both new-password fields with one strong value.
    await go(url('/signup'));
    const generated = await browser.execute('passwords.generate', { tabId: tab }, human);
    assert.equal(generated.filled, 2);
    const [a, b] = await contents().executeJavaScript('[p1.value, p2.value]');
    assert.equal(a, b);
    assert.ok(a.length >= 20);
    console.log('WEFT_PASSWORDS_OK');
  } finally {
    passwords.close();
    await browser.close();
    window.destroy();
    server.closeAllConnections();
    server.close();
    app.quit();
  }
}

if (child) {
  applyEngineHardening(electron.app);
  smoke().catch(error => { console.error(error); electron.app.exit(1); });
} else {
  const skip = process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display; run xvfb-run -a npm test on headless Linux' : false;
  test('real Chromium saved passwords: offer after a person signs in, fill only on the saved origin, generator', { timeout: budget(90000), skip }, async t => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-passwords-browser-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const run = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), '--passwords-smoke'], { env: electronEnv({ WEFT_TEST_PROFILE: profile }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    run.stdout.on('data', chunk => { output += chunk; });
    run.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => run.kill('SIGKILL'), budget(80000));
    const code = await new Promise(resolve => run.once('exit', resolve));
    clearTimeout(timer);
    assert.equal(code, 0, output);
    assert.match(output, /WEFT_PASSWORDS_OK/);
  });
}
