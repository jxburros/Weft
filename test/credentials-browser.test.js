import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { CredentialService } from '../src/credentials.js';
import { electronEnv } from '../scripts/electron-env.js';

const SECRET = 'Tr0ub4dor-and-3-staples';
const USERNAME = 'ada.lovelace@example.com';
const FRAME_SECRET = 'frame-only-secret-5512';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)).then(() => `http://127.0.0.1:${server.address().port}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Condition timed out') {
  for (let attempt = 0; attempt < 250; attempt++) { if (await check()) return; await delay(20); }
  throw new Error(message);
}

/** Test-only stand-in for OS-protected storage (Electron safeStorage needs a desktop keyring that CI does not have). */
function testProtector() {
  const wrapKey = randomBytes(32);
  return {
    status: () => ({ available: true, backend: 'test-keychain', protected: true }),
    wrap(text) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', wrapKey, iv); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    unwrap(bytes) { const decipher = createDecipheriv('aes-256-gcm', wrapKey, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
}

const form = (extra = '') => `<form action="/session" method="post"><label>Email <input id="user" name="user" autocomplete="username"></label>
<label>Password <input id="pw" name="pw" type="password" autocomplete="current-password"></label>
<input type="password" name="trap" tabindex="-1" style="display:none"><button type="submit">Sign in</button>${extra}</form>`;

if (process.argv.includes('--credentials-smoke')) {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  app.on('window-all-closed', () => {});
  (async () => {
    await app.whenReady();
    const received = { authorized: [], attacker: [] };
    const record = (bucket, request) => new Promise(resolve => { let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => { bucket.push(`${request.method} ${request.url} ${body}`); resolve(body); }); });
    const attacker = createServer(async (request, response) => {
      await record(received.attacker, request);
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Totally the real sign-in</title>${form()}`);
    });
    const attackerOrigin = await listen(attacker);
    const authorized = createServer(async (request, response) => {
      const body = await record(received.authorized, request);
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const path = request.url.split('?')[0];
      if (path === '/session') return response.end(`<!doctype html><title>Signed in</title><main>Welcome back ${body.length ? 'user' : ''}</main>`);
      if (path === '/framed') return response.end(`<!doctype html><title>Embedded sign-in</title><main>Use the embedded form</main><iframe id="login-frame" src="${attackerOrigin}/frame" width="420" height="260"></iframe>`);
      if (path === '/two') return response.end(`<!doctype html><title>Two forms</title>${form()}${form()}`);
      if (path === '/hidden') return response.end('<!doctype html><title>Honeypot only</title><form><input id="user"><input type="password" style="display:none"></form>');
      // A page script that reveals the password and copies it into another field once it is filled.
      if (path === '/reveal') return response.end(`<!doctype html><title>Reveal</title>${form('<input id="mirror" aria-label="Mirror">')}
<script>document.getElementById('pw').addEventListener('input', event => setTimeout(() => { document.getElementById('mirror').value = event.target.value; event.target.type = 'text'; }, 0));</script>`);
      response.end(`<!doctype html><title>Sign in</title><main><h1>Sign in</h1>${form()}</main>`);
    });
    const origin = await listen(authorized);
    const profile = process.env.WEFT_TEST_PROFILE;
    const workspace = new WorkspaceService({ directory: join(profile, 'workspace-data') });
    const workspaceId = workspace.activeWorkspaceId;
    const window = new BrowserWindow({ show: true, width: 1200, height: 900 });
    const browser = new Browser({ window, workspaceService: workspace, protectedCooldownMs: 700 });
    workspace.attachBrowser(browser);
    const secretQueue = [];
    const credentials = new CredentialService({ directory: join(profile, 'credentials'), protector: testProtector(), browser, workspace, promptSecret: async () => secretQueue.shift() });
    const events = [];
    const dispatch = createDispatcher({ workspace, browser, providers: { execute() {}, close() {} }, credentials, admission: new AutomationAdmission(), onEvent: event => events.push(event) });
    const outcomes = [];
    const human = { actor: 'human', source: 'gui' };
    const agent = { actor: 'automation' };
    const run = async (command, args, context) => { const outcome = await dispatch(command, args, context); outcomes.push(outcome); return outcome; };
    const leaks = value => [SECRET, USERNAME, FRAME_SECRET, 'redirect-secret'].filter(secret => JSON.stringify(value).includes(secret));
    try {
      await browser.restore();
      const tabId = browser.activeId;
      const tab = browser.tab(tabId);
      const contents = tab.view.webContents;
      const go = async path => {
        await run('page.navigate', { tabId, url: `${path.startsWith('http') ? '' : origin}${path}` }, human);
        await until(() => !contents.isLoading() && !browser.protectedReason(tab), `load ${path}`);
      };
      const fieldValues = (frame = contents.mainFrame) => frame.executeJavaScript('[...document.querySelectorAll("input")].map(input => input.value)');
      const inspect = async () => (await run('page.inspect', { tabId }, agent)).result.version;
      /** An agent fill: first call queues an exact approval, the person approves once, the identical retry runs. */
      const agentFill = async (args = {}) => {
        const request = { id: args.id ?? c1, tabId, workspaceId, expectedVersion: await inspect(), ...args };
        const pending = await run('credentials.fill', request, agent);
        assert.equal(pending.error?.code, 'approval_required', JSON.stringify(pending.error));
        await run('approvals.approve', { id: pending.error.details.authority.approvalId, mode: 'once' }, human);
        return run('credentials.fill', request, agent);
      };

      await go('/login');
      secretQueue.push({ username: USERNAME, password: SECRET });
      const created = await run('credentials.create', { workspaceId, label: 'Fixture account', purpose: 'Sign in to the fixture', origins: [origin] }, human);
      assert.equal(created.error, null, JSON.stringify(created.error));
      const c1 = created.result.id;
      assert.equal(created.result.account, 'a***e@example.com');

      // 1. Protected window: while the broker is releasing the secret and filling, every automation route on the tab is refused.
      const realCall = credentials.call.bind(credentials);
      let releasing = null;
      credentials.call = async (type, payload, options) => {
        if (type === 'release') { releasing?.(); await delay(400); }
        return realCall(type, payload, options);
      };
      const entered = new Promise(resolve => { releasing = resolve; });
      const fill = agentFill();
      await entered;
      const observation = {
        'page.snapshot': {}, 'page.readable': {}, 'page.content': {}, 'page.title': {}, 'page.screenshot': {}, 'page.pdf': {}, 'page.find': { text: 'Sign' },
        'page.evaluate': { expression: 'document.getElementById("pw").value' }, 'page.click': { selector: '#pw', expectedVersion: tab.version },
      };
      for (const [command, args] of Object.entries(observation)) {
        const outcome = await run(command, { tabId, ...args }, agent);
        assert.equal(outcome.error?.code, 'permission_required', `${command} during the protected operation: ${JSON.stringify(outcome.error)}`);
        assert.equal(outcome.error.details?.credential, 'protected_operation', command);
      }
      const capture = await run('artifacts.capture', { workspaceId, tabId, kind: 'bundle', title: 'During sign-in' }, agent);
      assert.equal(capture.error?.code, 'permission_required', 'artifact capture of the tab is refused');
      const archive = await run('artifacts.capture', { workspaceId, tabId, kind: 'archive', title: 'Archive during sign-in' }, agent);
      assert.equal(archive.error?.details?.credential, 'protected_operation', `resource archive capture of the tab is refused: ${JSON.stringify(archive.error)}`);
      const inspected = await run('page.inspect', { tabId }, agent);
      assert.equal(inspected.result.protectedOperation, 'credential fill');
      assert.equal(inspected.result.title, '[protected operation]');
      assert.equal((await run('page.title', { tabId }, human)).result, 'Sign in', 'the person is never blocked');
      assert.equal((await run('cookies.list', { workspaceId }, agent)).error.code, 'permission_required', 'cookie export stays human-only');
      const filled = await fill;
      credentials.call = realCall;
      assert.equal(filled.error, null, JSON.stringify(filled.error));
      assert.equal(filled.result.status, 'filled');
      assert.deepEqual(filled.result.fields, ['username', 'password']);
      assert.equal(filled.result.frame, 'top');
      assert.deepEqual(await fieldValues(), [USERNAME, SECRET, ''], 'username and the visible password field were filled; the hidden trap field was not');
      // Cooldown: still refused right after the operation.
      assert.equal((await run('page.snapshot', { tabId }, agent)).error?.details?.credential, 'protected_operation', 'cooldown');
      await delay(800);

      // 2. After the cooldown: observation redacts the filled fields; page.evaluate stays refused on this document.
      const snapshot = await run('page.snapshot', { tabId }, agent);
      assert.equal(snapshot.error, null);
      assert.deepEqual(leaks(snapshot), [], 'snapshot withholds both filled values');
      assert.equal(snapshot.result.nodes.filter(node => node.redacted === 'sensitive-field' && node.hasValue).length, 2);
      for (const command of ['page.readable', 'page.content', 'page.screenshot', 'page.pdf']) {
        const outcome = await run(command, { tabId }, agent);
        assert.equal(outcome.error, null, `${command}: ${JSON.stringify(outcome.error)}`);
        assert.deepEqual(leaks(outcome), [], command);
      }
      const evaluate = await run('page.evaluate', { tabId, expectedVersion: await inspect(), expression: 'document.getElementById("pw").value' }, agent);
      assert.equal(evaluate.error?.details?.credential, 'credential_residue', JSON.stringify(evaluate.error));
      const saved = await run('artifacts.capture', { workspaceId, tabId, kind: 'text', title: 'After sign-in' }, agent);
      assert.equal(saved.error, null);
      assert.deepEqual(leaks(saved), []);

      // 3. A page that reveals and copies the password: snapshots, screenshots and PDFs of it are refused.
      await go('/reveal');
      const revealFill = await agentFill();
      assert.equal(revealFill.error, null, JSON.stringify(revealFill.error));
      await until(async () => (await fieldValues())[3] === SECRET, 'page copied the value');
      await delay(800);
      for (const command of ['page.snapshot', 'page.screenshot', 'page.pdf']) {
        const outcome = await run(command, { tabId }, agent);
        assert.equal(outcome.error?.details?.credential, 'credential_revealed', command);
      }
      const revealedArchive = await run('artifacts.capture', { workspaceId, tabId, kind: 'archive', title: 'Revealed' }, agent);
      assert.equal(revealedArchive.error?.details?.credential, 'credential_revealed', 'the serialized page would carry the revealed secret');
      assert.deepEqual(leaks(await run('page.readable', { tabId }, agent)), [], 'readable text never includes form fields');

      // 4. Wrong top-level origin (phishing page): refused even with a human approval; nothing reaches the page.
      await go(`${attackerOrigin}/phish`);
      const phish = await agentFill();
      assert.equal(phish.error?.code, 'target_mismatch');
      assert.equal(phish.error.details.credential, 'origin_mismatch');
      assert.deepEqual(await fieldValues(), ['', '', '']);

      // 5. Cross-origin iframe on the authorized page: refused unless that frame origin is explicitly authorized.
      await go('/framed');
      await until(() => contents.mainFrame.framesInSubtree.length === 2, 'frame loaded');
      const frame = contents.mainFrame.framesInSubtree.find(item => item !== contents.mainFrame);
      await until(async () => (await frame.executeJavaScript('document.readyState')) === 'complete', 'frame ready');
      const framed = await agentFill();
      assert.equal(framed.error?.code, 'target_mismatch');
      assert.equal(framed.error.details.credential, 'frame_origin_not_authorized');
      assert.deepEqual(await fieldValues(frame), ['', '', '']);
      secretQueue.push({ username: 'frame-user', password: FRAME_SECRET });
      const c2 = (await run('credentials.create', { workspaceId, label: 'Embedded login', purpose: 'Sign in through the embedded provider', origins: [origin], frameOrigins: [attackerOrigin] }, human)).result.id;
      const frameFill = await run('credentials.fill', { id: c2, tabId, workspaceId }, human);
      assert.equal(frameFill.error, null, JSON.stringify(frameFill.error));
      assert.equal(frameFill.result.frame, 'subframe');
      assert.deepEqual((await fieldValues(frame)).slice(0, 2), ['frame-user', FRAME_SECRET]);
      await delay(800);

      // 6. Redirect between the origin check and the fill: the secret is released but never written into the new page.
      await go('/login');
      const redirected = await browser.credentialFill({ tabId, workspaceId }, human, { credential: { origins: [origin], frameOrigins: [] },
        release: async () => { await contents.loadURL(`${attackerOrigin}/redirected`); return { username: 'x', password: 'redirect-secret' }; } }).then(() => null, error => error);
      assert.equal(redirected?.details?.credential, 'navigated');
      assert.equal(new URL(contents.getURL()).origin, attackerOrigin);
      assert.deepEqual(await fieldValues(), ['', '', '']);
      await delay(800);

      // 7. Login-field verification: honeypot-only and ambiguous pages are refused; a snapshot ref selects one form.
      await go('/hidden');
      assert.equal((await run('credentials.fill', { id: c1, tabId, workspaceId }, human)).error?.details?.credential, 'no_login_form');
      await go('/two');
      assert.equal((await run('credentials.fill', { id: c1, tabId, workspaceId }, human)).error?.details?.credential, 'ambiguous_login_form');
      const twoSnapshot = await run('page.snapshot', { tabId }, agent);
      const passwordRef = twoSnapshot.result.nodes.find(node => node.role === 'textbox' && node.redacted === 'sensitive-field' && node.name === 'Password').ref;
      const refFill = await agentFill({ ref: passwordRef, snapshotId: twoSnapshot.result.snapshotId });
      assert.equal(refFill.error, null, JSON.stringify(refFill.error));
      assert.deepEqual((await fieldValues()).filter(Boolean), [USERNAME, SECRET], 'only the referenced form was filled');
      await delay(800);

      // 8. Submit: only the authorized origin receives the secret, as the form post it was meant for.
      await go('/login');
      const submitted = await agentFill({ submit: true });
      assert.equal(submitted.error, null, JSON.stringify(submitted.error));
      assert.equal(submitted.result.status, 'submitted');
      await until(() => contents.getTitle() === 'Signed in', 'post-submit navigation');
      await delay(800);
      const after = await run('page.evaluate', { tabId, expectedVersion: await inspect(), expression: 'document.title' }, agent);
      assert.equal(after.result.value, 'Signed in', 'a new document without credential fields is ordinary again');
      assert.ok(received.authorized.some(entry => entry.startsWith('POST /session') && entry.includes(encodeURIComponent(SECRET))), 'the authorized site received the form post');
      assert.ok(!received.attacker.some(entry => [SECRET, encodeURIComponent(SECRET), 'redirect-secret', encodeURIComponent(USERNAME)].some(value => entry.includes(value))), 'the attacker origin never received a secret');
      await delay(800);

      // 9. Revocation applies to the next use.
      await run('credentials.revoke', { id: c1 }, human);
      await go('/login');
      assert.equal((await run('credentials.fill', { id: c1, tabId, workspaceId }, human)).error?.details?.credential, 'revoked');

      // 10. Nothing agent- or GUI-facing ever carried a secret: command outcomes (what GUI IPC returns), live events, activity and approvals.
      assert.deepEqual(leaks(outcomes), [], 'command outcomes');
      assert.deepEqual(leaks(events), [], 'live events');
      for (const name of readdirSync(join(profile, 'workspace-data'))) {
        let text = '';
        try { text = readFileSync(join(profile, 'workspace-data', name), 'latin1'); } catch { continue; }
        assert.deepEqual(leaks(text), [], name);
      }
      assert.deepEqual(leaks(readFileSync(join(profile, 'credentials', 'vault', 'vault.json'), 'utf8')), [], 'vault file holds ciphertext only');
      console.log('CREDENTIALS_BROWSER_OK');
    } finally {
      credentials.close();
      browser.close();
      window.destroy();
      for (const server of [authorized, attacker]) { server.closeAllConnections(); server.close(); }
      workspace.close();
      app.quit();
    }
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  test('real Chromium protected login: exact origins and frames, exclusive protection, redaction and no secret egress', {
    timeout: 90000,
    skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display; run xvfb-run -a npm test on headless Linux' : false,
  }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-credentials-browser-'));
    mkdirSync(profile, { recursive: true });
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', fileURLToPath(import.meta.url), '--credentials-smoke'], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 80000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      assert.match(output, /CREDENTIALS_BROWSER_OK/);
    } finally { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); }
  });
}
