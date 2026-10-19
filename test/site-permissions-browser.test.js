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
import { commands } from '../src/commands.js';
import { electronEnv } from '../scripts/electron-env.js';
import { budget } from './time-budget.js';

const child = process.argv.includes('--permissions-smoke');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Condition timed out', attempts = 1200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check();
    if (value) return value;
    await pause(25);
  }
  throw new Error(message);
}

const page = body => `<!doctype html><meta charset="utf-8"><title>ready</title><button id="b" style="position:fixed;left:0;top:0;width:300px;height:300px">go</button><script>${body}</script>`;
const PAGES = {
  '/camera': page(`document.getElementById('b').onclick = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach(t => t.stop()); document.title = 'cam:granted'; }
    catch (e) { document.title = 'cam:' + e.name; } };`),
  '/notify': page(`document.getElementById('b').onclick = async () => { document.title = 'notify:' + await Notification.requestPermission(); };
    window.state = () => Notification.permission;`),
  '/share': page(`document.getElementById('b').onclick = async () => {
    try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); s.getTracks().forEach(t => t.stop()); document.title = 'share:granted'; }
    catch (e) { document.title = 'share:' + e.name; } };`),
  // Delayed window.open after a click (an OAuth-style flow waiting on a network call), returning by postMessage.
  '/opener': page(`addEventListener('message', event => { document.title = 'got:' + event.data; });
    document.getElementById('b').onclick = () => setTimeout(() => window.open('/oauth', '_blank', 'width=500,height=600'), 2500);`),
  '/oauth': '<!doctype html><title>oauth</title><script>window.opener && window.opener.postMessage("token-ok", "*"); setTimeout(() => window.close(), 300);</script>',
  // An unrequested popup (no input) stays blocked.
  '/spam': '<!doctype html><title>spam</title><script>setTimeout(() => window.open("/spam-target"), 200);</script>',
  '/spam-target': '<!doctype html><title>spam-target</title><script>document.title = "spam-target:" + Boolean(window.opener);</script>',
  '/to-blocked': page(`document.getElementById('b').onclick = () => window.open('http://blocked.localhost:' + location.port + '/x');`),
};

async function smoke() {
  const { app, BrowserWindow } = electron;
  const profile = process.env.WEFT_TEST_PROFILE;
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(PAGES[request.url] ?? `<!doctype html><title>${request.url}</title>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = (path, host = 'site.localhost') => `http://${host}:${server.address().port}${path}`;
  const workspace = new WorkspaceService({ directory: join(profile, 'records') });
  const window = new BrowserWindow({ show: true, width: 1000, height: 800 });
  const browser = new Browser({ window, workspaceService: workspace });
  workspace.attachBrowser(browser);
  const audits = [];
  browser.onAudit = entry => audits.push(entry);
  const human = { actor: 'human' };
  const automation = { actor: 'automation' };
  const report = {};
  // A page needs a rendered frame before native input hits its button.
  const click = async tabId => {
    const contents = browser.tab(tabId).view.webContents;
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await pause(150);
    contents.focus();
    contents.sendInputEvent({ type: 'mouseMove', x: 40, y: 40 });
    contents.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
  };
  const title = (tabId, prefix) => until(() => { const value = browser.tab(tabId).view.webContents.getTitle(); return value.startsWith(prefix) && value; }, `title ${prefix}`);
  const prompt = tabId => until(() => browser.describe(browser.tab(tabId)).protection.permissionPrompt, 'permission prompt');
  const load = async (tabId, target) => { await browser.execute('page.navigate', { tabId, url: target }, human); await until(() => browser.tab(tabId).view.webContents.getTitle() === 'ready' || !PAGES[new URL(target).pathname]?.includes('ready')); };
  try {
    await browser.restore();
    browser.setLayout({ x: 0, y: 0, width: 900, height: 700, visible: true });
    const tab = browser.activeId;

    // Camera: a click asks; Block holds until the site closes; revoke asks again; Allow once grants this page.
    await load(tab, url('/camera'));
    await click(tab);
    let pending = await prompt(tab);
    assert.deepEqual(pending.permissions, ['camera']);
    assert.equal(pending.origin, new URL(url('/')).origin);
    await assert.rejects(browser.execute('permissions.respond', { promptId: pending.id, decision: 'allow-always' }, automation), /trusted browser interface/);
    assert.equal(commands['permissions.respond'].humanOnly, true);
    await browser.execute('permissions.respond', { promptId: pending.id, decision: 'block' }, human);
    assert.equal(await title(tab, 'cam:'), 'cam:NotAllowedError');
    assert.equal(browser.describe(browser.tab(tab)).protection.permissionUserDenials.camera, 1);
    await browser.tab(tab).view.webContents.executeJavaScript('document.title = "ready"');
    await click(tab);
    assert.equal(await title(tab, 'cam:'), 'cam:NotAllowedError', 'block holds while the site is open');
    assert.equal(browser.permissions.prompts.size, 0);
    await browser.execute('permissions.set', { origin: new URL(url('/')).origin, permission: 'camera', decision: 'ask' }, human);
    await browser.tab(tab).view.webContents.executeJavaScript('document.title = "ready"');
    await pause(100);
    await click(tab);
    pending = await prompt(tab);
    await browser.execute('permissions.respond', { promptId: pending.id, decision: 'allow-once' }, human);
    assert.equal(await title(tab, 'cam:'), 'cam:granted');
    assert.deepEqual(browser.describe(browser.tab(tab)).protection.permissionUses, ['camera']);
    // Allow once ends with the page.
    await load(tab, url('/camera'));
    assert.equal(browser.permissions.decisionFor(browser.tab(tab), new URL(url('/')).origin, 'camera'), null);

    // Notifications: Allow always is remembered for the site, reported by the permission check, and revocable without restart.
    await load(tab, url('/notify'));
    await click(tab);
    pending = await prompt(tab);
    await browser.execute('permissions.respond', { promptId: pending.id, decision: 'allow-always' }, human);
    assert.equal(await title(tab, 'notify:'), 'notify:granted');
    await load(tab, url('/notify'));
    assert.equal(await browser.tab(tab).view.webContents.executeJavaScript('state()'), 'granted');
    const listed = await browser.execute('permissions.list', {}, automation);
    assert.ok(listed.decisions.some(item => item.permission === 'notifications' && item.decision === 'allow' && item.scope === 'always'));
    await browser.execute('permissions.set', { origin: new URL(url('/')).origin, permission: 'notifications', decision: 'ask' }, human);
    assert.notEqual(await browser.tab(tab).view.webContents.executeJavaScript('state()'), 'granted', 'revocation applies without restart');

    // Another workspace has its own decisions.
    await browser.execute('permissions.set', { origin: new URL(url('/')).origin, permission: 'notifications', decision: 'allow' }, human);
    const home = browser.workspaceId;
    const other = await workspace.execute('workspaces.create', { name: 'Other' });
    if (workspace.activeWorkspaceId !== home) { await workspace.execute('workspaces.switch', { id: home }); await browser.switchWorkspace(home); }
    const otherTab = await browser.newTab(url('/notify'), other.id);
    await until(() => browser.tab(otherTab.id).view.webContents.getTitle() === 'ready');
    assert.notEqual(await browser.tab(otherTab.id).view.webContents.executeJavaScript('state()'), 'granted', 'decisions are per workspace');
    assert.equal(await browser.tab(tab).view.webContents.executeJavaScript('state()'), 'granted');
    browser.closeTab(otherTab.id);

    // Background, agent-driven and headless tabs are denied without a prompt.
    await load(tab, url('/camera'));
    const second = await browser.newTab(url('/'), browser.workspaceId);
    const background = await browser.tab(tab).view.webContents.executeJavaScript('navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "ok", e => e.name)', true);
    assert.equal(background, 'NotAllowedError');
    assert.equal(browser.permissions.prompts.size, 0);
    assert.ok(browser.describe(browser.tab(tab)).protection.permissionDenials.microphone >= 1, 'auto-denied counter');
    browser.activate(tab);
    browser.tab(tab).controller = 'agent-1';
    browser.tab(tab).lastHumanInput = 0;
    assert.equal(await browser.tab(tab).view.webContents.executeJavaScript('navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "ok", e => e.name)', true), 'NotAllowedError');
    assert.equal(browser.permissions.prompts.size, 0, 'agent-only input never prompts');
    browser.tab(tab).controller = 'available';
    browser.hidden = true;
    assert.equal(browser.permissions.ineligible(browser.tab(tab)), 'headless');
    browser.hidden = false;
    browser.closeTab(second.id);

    // Never ask: prompted requests are denied without a prompt.
    await browser.execute('permissions.configure', { neverAsk: true }, human);
    await browser.tab(tab).view.webContents.executeJavaScript('document.title = "ready"');
    await click(tab);
    assert.equal(await title(tab, 'cam:'), 'cam:NotAllowedError');
    await browser.execute('permissions.configure', { neverAsk: false }, human);

    // Screen sharing uses Weft's source picker; it is never remembered as "always".
    await load(tab, url('/share'));
    await click(tab);
    const share = await Promise.race([prompt(tab), until(() => browser.tab(tab).view.webContents.getTitle().startsWith('share:') && 'denied')]);
    if (share === 'denied') report.display = `no capture sources on this display (${browser.tab(tab).view.webContents.getTitle()})`;
    else {
      assert.equal(share.display, true);
      assert.ok(share.sources.length >= 1);
      await assert.rejects(browser.execute('permissions.respond', { promptId: share.id, decision: 'allow-always' }, human), /one page at a time/);
      await browser.execute('permissions.respond', { promptId: share.id, decision: 'allow-once', sourceId: share.sources[0].id }, human);
      report.display = await title(tab, 'share:');
      if (report.display === 'share:granted') assert.ok(browser.describe(browser.tab(tab)).protection.sharing, 'sharing indicator');
    }

    // Clearing the site's data forgets its decisions.
    await browser.execute('storage.clear', { url: url('/') }, human);
    assert.equal((await browser.execute('permissions.list', {}, human)).decisions.length, 0);
    assert.ok(audits.some(entry => entry.reason === 'site_permission_allowed'));
    assert.ok(audits.some(entry => entry.reason === 'site_permission_denied'));
    assert.ok(audits.some(entry => entry.reason === 'site_permission_revoked'));

    // Popups: a delayed window.open after a click opens a tab that keeps its opener and closes itself.
    await load(tab, url('/opener'));
    const before = browser.tabs.size;
    await click(tab);
    await until(() => browser.tabs.size === before + 1, 'popup tab opened');
    const popup = [...browser.tabs.values()].find(item => item.openerTabId === tab);
    assert.equal(browser.describe(popup).opener.scriptable, true);
    assert.equal(browser.describe(popup).controller, 'available');
    assert.equal(await title(tab, 'got:'), 'got:token-ok', 'popup reached its opener with postMessage');
    await until(() => !browser.tabs.has(popup.id), 'window.close() closed the popup tab');
    browser.activate(tab);

    // An unrequested popup is blocked and audited; Allow once opens it; Always allows the site's next popups with an opener.
    await load(tab, url('/spam'));
    const blocked = await until(() => browser.describe(browser.tab(tab)).protection.blockedPopups[0]);
    assert.match(blocked.id, /^pop_\d+$/);
    assert.ok(audits.some(entry => entry.reason === 'popup_without_input'));
    await assert.rejects(browser.execute('popups.allow', { tabId: tab, popupId: blocked.id }, automation), /trusted browser interface/);
    const opened = await browser.execute('popups.allow', { tabId: tab, popupId: blocked.id, always: true }, human);
    assert.equal(await title(opened.opened.id, 'spam-target:'), 'spam-target:false');
    browser.closeTab(opened.opened.id);
    browser.activate(tab);
    await load(tab, url('/spam'));
    const allowedPopup = await until(() => [...browser.tabs.values()].find(item => item.openerTabId === tab && item.popup));
    assert.equal(await title(allowedPopup.id, 'spam-target:'), 'spam-target:true');
    browser.closeTab(allowedPopup.id);
    browser.activate(tab);

    // Site rules still apply to a popup's destination.
    await workspace.execute('siteRules.create', { hostname: 'blocked.localhost', mode: 'navigation', reason: 'Fixture' });
    await load(tab, url('/to-blocked'));
    const count = browser.tabs.size;
    await click(tab);
    await until(() => browser.tab(tab).error, 'blocked popup destination');
    assert.equal(browser.tabs.size, count);
    console.log(`WEFT_PERMISSIONS_REPORT ${JSON.stringify(report)}`);
    console.log('WEFT_PERMISSIONS_OK');
  } finally {
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
  test('real Chromium site permission prompts, popup opener handling and blocked popups', { timeout: budget(120000), skip }, async t => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-permissions-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const run = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), '--permissions-smoke'], { env: electronEnv({ WEFT_TEST_PROFILE: profile }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    run.stdout.on('data', chunk => { output += chunk; });
    run.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => run.kill('SIGKILL'), budget(100000));
    const code = await new Promise(resolve => run.once('exit', resolve));
    clearTimeout(timer);
    assert.equal(code, 0, output);
    assert.match(output, /WEFT_PERMISSIONS_OK/);
    const report = output.match(/WEFT_PERMISSIONS_REPORT (.*)/)?.[1];
    if (report) t.diagnostic(`Observed: ${report}`);
  });
}
