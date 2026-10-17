import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { electronEnv } from '../scripts/electron-env.js';

const secrets = ['pw-secret-1', '4111111111111111', 'otp-secret-3', 'otp-secret-4', 'frame-secret-5', '5555555555554444'];
const leaked = value => secrets.filter(secret => JSON.stringify(value).includes(secret));
async function until(check, message = 'Observation condition timed out') {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)).then(() => `http://127.0.0.1:${server.address().port}`);

if (process.argv.includes('--observation-smoke')) {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  mkdirSync(join(process.env.WEFT_TEST_PROFILE, 'downloads'), { recursive: true });
  app.setPath('downloads', join(process.env.WEFT_TEST_PROFILE, 'downloads'));
  app.on('window-all-closed', () => {});
  (async () => {
    await app.whenReady();
    const hits = [];
    const foreign = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><button>Pay now</button><input autocomplete="cc-number" value="5555555555554444">');
    });
    const foreignOrigin = await listen(foreign);
    const server = createServer((request, response) => {
      hits.push(request.url);
      if (request.url === '/lazy.png') return; // Never answered: a lazy image that has not loaded.
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url !== '/') { response.end('<!doctype html><title>Other page</title><main>Other</main>'); return; }
      const inner = '<button id=inner-button onclick="parent.document.title=\'inner clicked\'">Inner button</button><input type=password value=frame-secret-5><label>Inner text <input id=inner-text value=inner></label>';
      response.end(`<!doctype html><title>Observation ‮fixture‬</title>
<script>Element.prototype.remove = function () {}; HTMLElement.prototype.remove = function () {};</script>
<main><h1>Account settings</h1><p>Plain evidence text</p>
<a id="next" href="/second">Next page</a> <a id="blocked-link" href="/blocked/target">Restricted</a>
<button id="go" onclick="document.title = 'clicked:' + document.getElementById('name').value">Go</button>
<button id="rename-me">Rename me</button><button id="remove-me">Remove me</button>
<label>Name <input id="name" value="Ada"></label>
<label>Password <input id="pw" type="password" value="pw-secret-1"></label>
<label>Card <input id="cc" autocomplete="cc-number" value="4111111111111111"></label>
<label>Code <input id="otp" autocomplete="one-time-code" value="otp-secret-3"></label>
<textarea aria-label="Backup code" autocomplete="one-time-code">otp-secret-4</textarea>
<div hidden><button>Hidden button</button></div>
<x-widget></x-widget>
<ul aria-label="Results"><li aria-setsize="500" aria-posinset="1">Row 1</li><li aria-setsize="500" aria-posinset="2">Row 2</li></ul>
<div aria-busy="true">Loading more</div><canvas width="20" height="20"></canvas>
<iframe id="inner" title="Inner form" srcdoc="${inner.replaceAll('"', '&quot;')}"></iframe>
<iframe id="foreign" title="Payments" src="${foreignOrigin}/frame"></iframe>
<div style="height: 3000px"></div><img loading="lazy" src="/lazy.png" alt="Lazy chart" width="10" height="10"></main>
<script>customElements.define('x-widget', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow action</button>'; } });</script>`);
    });
    const origin = await listen(server);
    const workspace = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, 'records') });
    const window = new BrowserWindow({ show: true, width: 1200, height: 900 });
    const browser = new Browser({ window, workspaceService: workspace });
    workspace.attachBrowser(browser);
    const agent = { actor: 'automation' };
    const run = (command, args = {}, context = agent) => browser.execute(command, { tabId: browser.activeId, ...args }, context);
    const fails = async (promise, check, message) => { const error = await promise.then(() => null, value => value); assert.ok(error, `${message}: expected a failure`); check(error); };
    const node = (snapshot, role, name) => snapshot.nodes.find(item => item.role === role && item.name === name);
    try {
      await browser.restore();
      await run('page.navigate', { url: origin }, { actor: 'human' });
      const tab = browser.tab();
      const contents = tab.view.webContents;
      await until(() => contents.mainFrame.framesInSubtree.length === 3 && contents.executeJavaScript('document.getElementById("inner").contentDocument?.getElementById("inner-button") !== null && !!document.querySelector("x-widget").shadowRoot'));
      await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

      // #15: semantic snapshot, frame-scoped refs, coverage and redaction.
      const snapshot = await run('page.snapshot', {});
      assert.equal(snapshot.contentTrust, 'untrusted');
      assert.equal(snapshot.navigationVersion, tab.version);
      assert.equal(snapshot.title, 'Observation fixture', 'page-sourced bidi controls are removed');
      assert.equal(node(snapshot, 'heading', 'Account settings').level, 1);
      assert.match(node(snapshot, 'link', 'Next page').href, /\/second$/);
      const go = node(snapshot, 'button', 'Go');
      assert.match(go.ref, /^f0e\d+$/);
      assert.ok(go.box.width > 0 && go.inViewport);
      assert.equal(node(snapshot, 'textbox', 'Name').value, 'Ada');
      for (const name of ['Password', 'Card', 'Code', 'Backup code']) {
        const field = node(snapshot, 'textbox', name);
        assert.equal(field.value, null, name);
        assert.equal(field.redacted, 'sensitive-field');
        assert.equal(field.hasValue, true);
      }
      assert.ok(node(snapshot, 'button', 'Shadow action'), 'open shadow roots are included');
      assert.equal(snapshot.nodes.some(item => item.name === 'Hidden button'), false);
      const innerButton = node(snapshot, 'button', 'Inner button');
      assert.match(innerButton.ref, /^f[1-9]\d*e\d+$/, 'same-origin frame content has frame-scoped refs');
      assert.equal(snapshot.frames.find(frame => frame.frameId === innerButton.frame).accessible, true);
      const foreignFrame = snapshot.coverage.inaccessibleFrames[0];
      assert.equal(foreignFrame.reason, 'cross-origin');
      assert.equal(foreignFrame.origin, foreignOrigin);
      assert.equal(snapshot.nodes.some(item => item.name === 'Pay now'), false, 'cross-origin content is reported, not read');
      assert.deepEqual(snapshot.coverage.virtualized.map(item => [item.rendered, item.declared]), [[2, 500]]);
      assert.ok(snapshot.coverage.lazy.pendingImages >= 1);
      assert.equal(snapshot.coverage.lazy.busyRegions, 1);
      assert.ok(snapshot.coverage.opaque >= 1);
      assert.equal(snapshot.coverage.redacted.sensitiveFields, 5);
      assert.equal(snapshot.coverage.complete, false);
      assert.deepEqual(leaked(snapshot), []);
      const again = await run('page.snapshot', {});
      assert.equal(node(again, 'button', 'Go').ref, go.ref, 'refs are stable for the same element');
      const truncated = await run('page.snapshot', { maxNodes: 5 });
      assert.equal(truncated.nodes.length, 5);
      assert.equal(truncated.coverage.truncated.reason, 'maxNodes');
      assert.ok(truncated.coverage.truncated.omitted > 0);

      // #41: readable/content never emit sensitive values, even when the page patches DOM methods.
      const readable = await run('page.readable', {});
      assert.match(readable.text, /Plain evidence text/);
      assert.equal(readable.contentTrust, 'untrusted');
      assert.deepEqual(leaked(readable), []);
      const html = await run('page.content', {});
      assert.deepEqual(leaked(html), []);
      assert.doesNotMatch(html, /<input|autocomplete=/i);
      assert.equal(await run('page.title', {}), 'Observation fixture');
      assert.equal(browser.describe(tab).title, 'Observation fixture');

      // #15/#41: agent actions bind to refs from the actor's latest snapshot and fail on changed targets.
      let lease = await run('tabs.claim', {});
      let view = await run('page.snapshot', {});
      await run('page.fill', { expectedVersion: lease.version, ref: node(view, 'textbox', 'Name').ref, value: 'Grace' });
      view = await run('page.snapshot', {});
      await run('page.click', { expectedVersion: view.navigationVersion, ref: node(view, 'button', 'Go').ref, snapshotId: view.snapshotId });
      await until(() => contents.getTitle() === 'clicked:Grace', 'ref click did not reach the page');
      view = await run('page.snapshot', {});
      await run('page.fill', { expectedVersion: view.navigationVersion, ref: node(view, 'textbox', 'Inner text').ref, value: 'inside frame' });
      assert.equal(await contents.executeJavaScript('document.getElementById("inner").contentDocument.getElementById("inner-text").value'), 'inside frame');
      view = await run('page.snapshot', {});
      await contents.executeJavaScript('document.getElementById("rename-me").textContent = "Delete account"'); // The page's own script changes the target.
      await fails(run('page.click', { expectedVersion: view.navigationVersion, ref: node(view, 'button', 'Rename me').ref }), error => assert.equal(error.details.reason, 'element_changed'), 'renamed target');
      view = await run('page.snapshot', {});
      await contents.executeJavaScript('Node.prototype.removeChild.call(document.querySelector("main"), document.getElementById("remove-me"))');
      await fails(run('page.click', { expectedVersion: view.navigationVersion, ref: node(view, 'button', 'Remove me').ref }), error => assert.equal(error.details.reason, 'element_detached'), 'removed target');
      view = await run('page.snapshot', {});
      await fails(run('page.click', { expectedVersion: view.navigationVersion - 1, ref: node(view, 'button', 'Go').ref }), error => assert.equal(error.code, 'stale_state'), 'stale version');

      // #41: a blocked click is reported as blocked, never as done.
      await workspace.execute('siteRules.create', { hostname: '127.0.0.1', path: '/blocked', behavior: 'block' });
      view = await run('page.snapshot', {});
      await fails(run('page.click', { expectedVersion: view.navigationVersion, ref: node(view, 'link', 'Restricted').ref }), error => { assert.equal(error.code, 'site_blocked'); assert.deepEqual([error.details.kind, error.details.explain], ['preference', 'siteRules.explain'], 'input and navigation share one blocked-details structure'); }, 'blocked link');
      assert.equal(hits.includes('/blocked/target'), false);
      await run('tabs.release', {});
      await run('page.back', {}, { actor: 'human' });
      assert.equal(browser.tab().blocked, null);

      // #15: element/region/full-page screenshots with geometry metadata, limits and masking.
      view = await run('page.snapshot', {});
      const element = await run('page.screenshot', { ref: node(view, 'button', 'Go').ref });
      assert.equal(element.capture.mode, 'element');
      assert.equal(element.capture.navigationVersion, view.navigationVersion);
      assert.equal(element.capture.url, `${origin}/`);
      assert.ok(Math.abs(element.capture.image.width - Math.round(element.capture.clip.width * element.capture.devicePixelRatio)) <= 1);
      assert.ok(element.capture.viewport.width > 0 && element.capture.document.height > 3000 && element.capture.scroll.y === 0);
      assert.match(element.capture.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
      const region = await run('page.screenshot', { rect: { x: 0, y: 0, width: 100, height: 50 } });
      assert.deepEqual(region.capture.image, { width: Math.round(100 * region.capture.devicePixelRatio), height: Math.round(50 * region.capture.devicePixelRatio) });
      const limited = await run('page.screenshot', { rect: { x: 0, y: 0, width: 400, height: 50 }, maxWidth: 64 });
      assert.equal(limited.capture.cropped, true);
      assert.ok(limited.capture.image.width <= 64);
      const full = await run('page.screenshot', { fullPage: true, maxHeight: 600 });
      assert.equal(full.capture.cropped, true);
      assert.ok(full.capture.image.height <= 600);
      assert.ok(full.capture.limitations.some(text => /maxHeight/.test(text)));
      const viewport = await run('page.screenshot', {});
      assert.equal(viewport.capture.mode, 'viewport');
      assert.equal(viewport.capture.redaction.applied, true);
      // Masking: a filled and an emptied card field render identically, while ordinary fields do not.
      const cardRef = node(view, 'textbox', 'Card').ref, nameRef = node(view, 'textbox', 'Name').ref;
      const shots = async () => [(await run('page.screenshot', { ref: cardRef })).data, (await run('page.screenshot', { ref: nameRef })).data];
      const [cardFilled, nameFilled] = await shots();
      await contents.executeJavaScript('document.getElementById("cc").value = ""; document.getElementById("name").value = ""');
      const [cardEmpty, nameEmpty] = await shots();
      assert.equal(cardFilled, cardEmpty, 'card digits are masked in captures');
      assert.notEqual(nameFilled, nameEmpty, 'the comparison can detect rendered text');
      await contents.executeJavaScript('document.getElementById("pw").focus()');
      await fails(run('page.screenshot', {}), error => assert.equal(error.code, 'permission_required'), 'sensitive focus');
      assert.ok((await run('page.screenshot', {}, { actor: 'human' })).data);
      await contents.executeJavaScript('document.activeElement.blur()');

      // #41/#15: coordinate and keyboard input need human permission and current geometry.
      lease = await run('tabs.claim', {});
      view = await run('page.snapshot', {});
      const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await fails(run('page.clickAt', { expectedVersion: view.navigationVersion, ...center(node(view, 'button', 'Go').box), observationId: view.snapshotId }), error => assert.equal(error.code, 'permission_required'), 'raw input without permission');
      await run('tabs.setControlMode', { mode: 'agent-drives', agent: 'automation', allowRawInput: true }, { actor: 'human' });
      await contents.executeJavaScript('document.getElementById("name").value = "Coordinates"; document.title = "before"');
      view = await run('page.snapshot', {});
      await run('page.clickAt', { expectedVersion: view.navigationVersion, ...center(node(view, 'button', 'Go').box), observationId: view.snapshotId });
      await until(() => contents.getTitle() === 'clicked:Coordinates', 'coordinate click did not reach the page');
      assert.equal(browser.tab().controller, 'automation', 'agent coordinate input is not mistaken for human takeover');
      assert.equal(browser.downloadGrants.has(tab.id), false, 'agent input is not a human download gesture');
      view = await run('page.snapshot', {});
      await run('page.click', { expectedVersion: view.navigationVersion, ref: node(view, 'textbox', 'Name').ref });
      const before = await run('page.inspect', {});
      await run('page.press', { expectedVersion: before.version, key: 'Z' });
      await until(async () => (await contents.executeJavaScript('document.getElementById("name").value')).includes('Z'), 'key press did not reach the focused field');
      view = await run('page.snapshot', {});
      browser.setLayout({ x: 0, y: 112, width: 700, height: 600, visible: true });
      await until(async () => (await contents.executeJavaScript('innerWidth')) === 700);
      await fails(run('page.clickAt', { expectedVersion: view.navigationVersion, x: 5, y: 5, observationId: view.snapshotId }), error => {
        assert.equal(error.details.reason, 'geometry_changed');
        assert.ok(error.details.changed.includes('width'));
      }, 'outdated geometry');
      browser.setLayout({ x: 0, y: 112, width: 840, height: 600, visible: true });

      // #9: real human input invalidates refs; a takeover during an action is reported and recorded.
      await run('tabs.setControlMode', { mode: 'agent-drives' }, { actor: 'human' });
      view = await run('page.snapshot', {});
      contents.sendInputEvent({ type: 'mouseDown', x: 600, y: 500, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x: 600, y: 500, button: 'left', clickCount: 1 });
      await until(() => (tab.inputSerial ?? 0) > 0);
      await fails(run('page.click', { expectedVersion: view.navigationVersion, ref: node(view, 'button', 'Go').ref }), error => assert.equal(error.details.reason, 'human_input'), 'human input');
      lease = await run('tabs.claim', {});
      const pending = run('page.evaluate', { expectedVersion: lease.version, expression: 'new Promise(resolve => setTimeout(() => resolve(1), 400))' });
      await new Promise(resolve => setTimeout(resolve, 50));
      const takeover = await run('tabs.takeover', {}, { actor: 'human' });
      assert.deepEqual(takeover.lastBoundary.interrupted.map(item => item.command), ['page.evaluate']);
      await fails(pending, error => assert.equal(error.code, 'action_interrupted'), 'interrupted action');
      await until(() => (workspace.data.handoffs ?? []).some(item => item.kind === 'takeover' && item.interrupted.length));
      const handoff = await workspace.executeHandoff('handoffs.create', { to: 'automation', objective: 'Finish the settings form', nextStep: 'Press Go again', tabIds: [tab.id], findings: ['The form accepted a name'] }, { actor: 'human' });
      await run('tabs.setControlMode', { mode: 'agent-drives', agent: 'automation' }, { actor: 'human' });
      const accepted = await workspace.executeHandoff('handoffs.accept', { id: handoff.id }, agent);
      assert.equal(accepted.resume[0].inspectionRequired, true);
      await fails(run('page.click', { expectedVersion: browser.tab().version, selector: '#go' }), error => assert.equal(error.details.reason, 'inspection_required'), 'resume without inspection');
      const current = await run('page.inspect', {});
      await run('page.click', { expectedVersion: current.version, selector: '#go' });
      assert.equal((await workspace.executeHandoff('handoffs.complete', { id: handoff.id, note: 'Pressed Go' }, agent)).status, 'completed');
      console.log('PAGE_OBSERVATION_OK');
    } finally {
      browser.close();
      window.destroy();
      for (const value of [server, foreign]) { value.closeAllConnections(); value.close(); }
      workspace.close();
      app.quit();
    }
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  test('real Chromium semantic snapshots, grounded element actions, region capture, redaction and handoffs', {
    timeout: 60000,
    skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display; run xvfb-run -a npm test on headless Linux' : false,
  }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-observation-'));
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', fileURLToPath(import.meta.url), '--observation-smoke'], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 50000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      assert.match(output, /PAGE_OBSERVATION_OK/);
    } finally { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); }
  });
}
