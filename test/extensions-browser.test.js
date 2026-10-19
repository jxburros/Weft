import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { WorkspaceExtensions } from '../src/extensions.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { electronEnv } from '../scripts/electron-env.js';
import { budget } from './time-budget.js';

// Compatibility evidence for docs/decisions/007-extension-compatibility.md:
// a real Electron/Chromium run of a fixture MV3 extension in workspace sessions.
const smoke = process.argv.includes('--extension-smoke');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/extensions.json', import.meta.url), 'utf8')).extensions;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (smoke) {
  const { app, BrowserWindow } = electron;
  const profile = process.env.WEFT_TEST_PROFILE;
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  (async () => {
    await app.whenReady();
    const hits = [];
    const server = createServer((request, response) => {
      hits.push(request.url);
      if (/^\/(allowed|blocked|ungranted)/.test(request.url)) { response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }); response.end('ok'); return; }
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['visible=page-cookie; Path=/', 'secret=http-only; Path=/; HttpOnly'] });
      response.end(`<!doctype html><title>Extension fixture</title><body data-urls='${JSON.stringify(urls)}'>Workspace page</body>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const urls = { granted: `${origin}/allowed`, siteBlocked: `${origin}/blocked/worker`, ungranted: `http://localhost:${port}/ungranted` };
    const materialize = name => {
      const target = join(profile, 'sources', name);
      mkdirSync(target, { recursive: true });
      for (const [file, contents] of Object.entries(fixtures[name])) writeFileSync(join(target, file), contents);
      return target;
    };
    const workspace = new WorkspaceService({ directory: join(profile, 'records') });
    const window = new BrowserWindow({ show: true, width: 900, height: 700 });
    const admission = new AutomationAdmission();
    const browser = new Browser({ window, workspaceService: workspace, admission });
    workspace.attachBrowser(browser);
    const extensions = new WorkspaceExtensions({ directory: profile, workspace, browser });
    const decisions = [];
    const decide = browser.extensionRequestAllowed;
    browser.extensionRequestAllowed = (target, details) => { const allowed = decide(target, details); decisions.push({ url: details.url, allowed }); return allowed; };
    const dispatch = createDispatcher({ workspace, browser, extensions, providers: { close() {} }, admission });
    const human = { actor: 'human', source: 'gui' };
    const ok = outcome => { if (outcome.error) throw new Error(JSON.stringify(outcome.error)); return outcome.result; };
    const matrix = { electron: process.versions.electron, chromium: process.versions.chrome, serverOrigin: origin };
    try {
      await browser.restore();
      const first = workspace.activeWorkspaceId;
      const session = browser.sessionFor(first);
      await workspace.execute('siteRules.create', { workspaceId: first, hostname: '127.0.0.1', path: '/blocked', mode: 'navigation', reason: 'Fixture policy' }, human);
      matrix.hostileRefused = {};
      for (const name of ['native-messaging', 'overprivileged', 'all-urls', 'mv2']) {
        const path = materialize(name);
        const report = ok(await dispatch('extensions.audit', { path }, human));
        const install = await dispatch('extensions.install', { path, sha256: report.sha256 }, human);
        matrix.hostileRefused[name] = !report.ok && install.error?.code === 'permission_required';
      }
      matrix.loadedAfterHostile = session.extensions.getAllExtensions().length;
      const path = materialize('probe');
      matrix.automationAudit = (await dispatch('extensions.audit', { path }, { actor: 'automation' })).error?.code;
      const report = ok(await dispatch('extensions.audit', { path, hostGrants: ['http://127.0.0.1/*'] }, human));
      const installed = ok(await dispatch('extensions.install', { path, hostGrants: ['http://127.0.0.1/*'], sha256: report.sha256 }, human));
      matrix.automationEnable = (await dispatch('extensions.enable', { id: installed.id }, { actor: 'automation' })).error?.code;
      ok(await dispatch('extensions.enable', { id: installed.id }, human));
      const second = await workspace.execute('workspaces.create', { name: 'Second project' }, human);
      const otherTab = await browser.newTab(`${origin}/?workspace=second`, second.id);
      const tab = await browser.newTab(`${origin}/?workspace=first`, first);
      const read = id => browser.tab(id).view.webContents.executeJavaScript('document.documentElement.dataset.weftProbe || null');
      let probe = null;
      for (let attempt = 0; attempt < 200 && !probe; attempt++) { await sleep(50); probe = await read(tab.id); }
      Object.assign(matrix, { probe: probe ? JSON.parse(probe) : null, otherWorkspaceInjected: await read(otherTab.id) });
      matrix.decisions = decisions;
      matrix.serverHits = hits.filter(url => /^\/(allowed|blocked|ungranted)/.test(url));
      ok(await dispatch('extensions.disable', { id: installed.id }, human));
      matrix.loadedAfterDisable = session.extensions.getAllExtensions().length;
      // Wait for the reload itself rather than a fixed 1.5 s (#121); document_idle scripts run by shortly after
      // load, so a short settle after it is enough to show that none ran.
      const reloaded = new Promise(resolve => browser.tab(tab.id).view.webContents.once('did-finish-load', resolve));
      browser.tab(tab.id).view.webContents.reload();
      await reloaded;
      await sleep(300);
      matrix.injectedAfterDisable = await read(tab.id);
      ok(await dispatch('extensions.enable', { id: installed.id }, human));
      browser.tab(tab.id).view.webContents.reload();
      let again = null;
      for (let attempt = 0; attempt < 200 && !again; attempt++) { await sleep(50); again = await read(tab.id); }
      matrix.injectedAfterReEnable = Boolean(again);
      // Toolbar button, action popup and options page (#98): human-only, browser-owned windows, allowlist unchanged.
      const toolbarPath = materialize('toolbar');
      const toolbarReport = ok(await dispatch('extensions.audit', { path: toolbarPath }, human));
      matrix.toolbarUi = toolbarReport.scope.ui;
      const toolbar = ok(await dispatch('extensions.install', { path: toolbarPath, sha256: toolbarReport.sha256 }, human));
      ok(await dispatch('extensions.enable', { id: toolbar.id }, human));
      matrix.toolbarActions = ok(await dispatch('extensions.actions', {}, human)).map(item => ({ name: item.name, title: item.title, popup: item.popup, options: item.options }));
      matrix.automationActions = (await dispatch('extensions.actions', { workspaceId: first }, { actor: 'automation' })).error?.code;
      matrix.automationOpen = (await dispatch('extensions.openPage', { id: toolbar.id, page: 'popup' }, { actor: 'automation' })).error?.code;
      const pageTitle = async (page, prefix) => {
        const opened = ok(await dispatch('extensions.openPage', { id: toolbar.id, page }, human));
        const view = [...extensions.pages.get(toolbar.id)].at(-1);
        // Committed navigations (the popup tries to leave the extension 50 ms after it is ready).
        const started = [];
        view.webContents.on('did-navigate', (_event, url) => started.push(url));
        let seen = view.webContents.getTitle();
        view.webContents.on('page-title-updated', (_event, title) => { seen = title; });
        let value = '';
        for (let attempt = 0; attempt < 400 && !value.startsWith(prefix); attempt++) { await sleep(25); value = view.isDestroyed() ? seen : view.webContents.getTitle(); }
        await sleep(300);
        // A popup also closes when another window takes focus (as on a busy shared display); that is not a navigation.
        return { url: opened.url, title: value, stayed: started.every(url => url.startsWith('chrome-extension://')) && (view.isDestroyed() || view.webContents.getURL().startsWith('chrome-extension://')) };
      };
      matrix.popup = await pageTitle('popup', 'popup:');
      matrix.options = await pageTitle('options', 'options:');
      matrix.toolbarPermissions = extensions.records.find(item => item.id === toolbar.id).permissions;
      matrix.dnrRefused = !ok(await dispatch('extensions.audit', { path: materialize('toolbar-dnr') }, human)).ok;
      ok(await dispatch('extensions.remove', { id: toolbar.id }, human));
      matrix.pagesClosedOnRemove = !extensions.pages.has(toolbar.id);
      ok(await dispatch('extensions.remove', { id: installed.id }, human));
      matrix.loadedAfterRemove = session.extensions.getAllExtensions().length;
      matrix.copyRemoved = !existsSync(join(profile, 'extensions', installed.id));
      console.log(`EXTENSION_MATRIX ${JSON.stringify(matrix)}`);
    } finally {
      browser.close();
      window.destroy();
      server.closeAllConnections();
      server.close();
      app.quit();
    }
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  test('real Chromium: MV3 extension support, workspace isolation, egress limits and revocation', { timeout: budget(60000) }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-extension-integration-'));
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', ...(!process.env.DISPLAY && process.platform === 'linux' ? ['--ozone-platform=headless'] : []), fileURLToPath(import.meta.url), '--extension-smoke'], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 50000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      const line = output.split('\n').find(item => item.startsWith('EXTENSION_MATRIX '));
      assert.ok(line, output);
      const matrix = JSON.parse(line.slice('EXTENSION_MATRIX '.length));
      // Overprivileged fixtures never load; installation and enablement need a human.
      assert.deepEqual(matrix.hostileRefused, { 'native-messaging': true, overprivileged: true, 'all-urls': true, mv2: true });
      assert.equal(matrix.loadedAfterHostile, 0);
      // The shared authority gate refuses extension administration for automation (typed human_only denial).
      assert.equal(matrix.automationAudit, 'permission_required');
      assert.equal(matrix.automationEnable, 'permission_required');
      // Supported in a workspace session (observed, not inferred from types).
      const { probe } = matrix;
      assert.ok(probe, output);
      assert.equal(probe.storage, 'stored');
      assert.equal(probe.worker.scripting, '/');
      // The first workspace has its restored blank tab and the fixture tab; the second workspace's tab is invisible.
      assert.deepEqual([...probe.worker.tabs].sort(), ['about:blank', `${new URL(matrix.serverOrigin).origin}/?workspace=first`].sort(), 'tabs.query sees only this workspace');
      // Unsupported or blocked APIs fail clearly.
      assert.match(probe.worker.nativeMessaging, /^error: .*connectNative is not a function/);
      assert.equal(probe.worker.cookies, 'undefined');
      assert.equal(probe.worker.webRequest, 'undefined');
      assert.equal(probe.worker.debuggerApi, 'undefined');
      // Egress: granted host allowed; site-rule and ungranted destinations cancelled before reaching the server.
      assert.equal(probe.worker.fetchGranted, 200);
      assert.match(String(probe.worker.fetchSiteBlocked), /^error: /);
      assert.match(String(probe.worker.fetchUngranted), /^error: /);
      assert.deepEqual(matrix.serverHits, ['/allowed']);
      assert.ok(matrix.decisions.some(item => item.url.includes('/ungranted') && !item.allowed));
      // Residual risk is real: content scripts see what the page sees (non-HttpOnly cookies).
      assert.equal(probe.cookie, 'visible=page-cookie');
      assert.equal(matrix.otherWorkspaceInjected, null, 'other workspace sessions are untouched');
      // Revocation.
      assert.equal(matrix.loadedAfterDisable, 0);
      assert.equal(matrix.injectedAfterDisable, null);
      assert.equal(matrix.injectedAfterReEnable, true);
      assert.equal(matrix.loadedAfterRemove, 0);
      assert.equal(matrix.copyRemoved, true);
      // Toolbar (#98).
      assert.deepEqual(matrix.toolbarUi, { title: 'Fixture button', popup: 'popup.html', options: 'options.html', icon: null });
      assert.deepEqual(matrix.toolbarActions, [{ name: 'Weft toolbar fixture', title: 'Fixture button', popup: true, options: true }]);
      assert.equal(matrix.automationActions, 'permission_required');
      assert.equal(matrix.automationOpen, 'permission_required');
      assert.equal(matrix.popup.title, 'popup:object:undefined:undefined', 'storage works; cookies and debugger stay unavailable');
      assert.equal(matrix.popup.stayed, true, 'the popup cannot navigate away from the extension');
      assert.equal(matrix.options.title, 'options:true');
      assert.deepEqual(matrix.toolbarPermissions, ['storage']);
      assert.equal(matrix.dnrRefused, true);
      assert.equal(matrix.pagesClosedOnRemove, true);
      if (process.env.WEFT_EXTENSION_MATRIX) writeFileSync(process.env.WEFT_EXTENSION_MATRIX, JSON.stringify(matrix, null, 2));
    } finally { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); }
  });
}
