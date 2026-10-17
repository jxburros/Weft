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
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { electronEnv } from '../scripts/electron-env.js';

/*
 * Real Chromium idle-tab suspension and restoration (#30): eligibility, scroll restoration on use,
 * memory-pressure suspension, restart with unloaded tabs, a suspend/restore workload without leaked
 * renderers, and tasks that are never silently completed.
 */
const harness = process.argv.includes('--suspension-harness');
const human = { actor: 'human', source: 'gui' };
const agent = { actor: 'automation', source: 'api' };
async function until(check, message = 'condition') {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${message}`);
}

if (harness) {
  const { app, BrowserWindow, webContents } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  app.on('window-all-closed', () => {});
  (async () => {
    await app.whenReady();
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/form') { response.end('<!doctype html><title>Form</title><main><input name="q" value=""></main>'); return; }
      // A cross-site subframe (localhost vs 127.0.0.1): Chromium puts it in its own process.
      if (request.url === '/frame-host') { response.end(`<!doctype html><title>Framed</title><main><iframe src="http://localhost:${server.address().port}/inner"></iframe></main>`); return; }
      if (request.url === '/inner') { response.end('<!doctype html><title>Inner</title><input name="inner" value="">'); return; }
      response.end(`<!doctype html><title>Page ${request.url.slice(1)}</title><main style="height:5000px">Long page ${request.url}</main>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const workspace = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, 'records') });
    const window = new BrowserWindow({ show: true, width: 1000, height: 800 });
    const admission = new AutomationAdmission();
    let browser = new Browser({ window, workspaceService: workspace, admission });
    workspace.attachBrowser(browser);
    let dispatch = createDispatcher({ workspace, browser, admission, providers: { close() {} } });
    try {
      await browser.restore();
      await dispatch('settings.update', { resources: { idleSuspendMinutes: 1 } }, human);
      const open = async path => (await dispatch('tabs.new', { url: `${origin}${path}` }, human)).result;
      const scroll = await open('/scroll');
      const form = await open('/form');
      const leased = await open('/leased');
      const tasked = await open('/tasked');
      // Subframes, including cross-origin ones, are checked for unsaved input too (#30).
      const framed = await open('/frame-host');
      const framedContents = () => browser.tab(framed.id).view.webContents;
      const innerFrame = () => framedContents().mainFrame.framesInSubtree.find(frame => frame !== framedContents().mainFrame && /\/inner$/.test(frame.url));
      await until(() => innerFrame(), 'cross-origin frame loaded');
      assert.notEqual(innerFrame().origin, framedContents().mainFrame.origin, 'the subframe is cross-origin');
      assert.deepEqual(await browser.pageStateBlockers(framedContents()), [], 'an untouched framed page has nothing to lose');
      await innerFrame().executeJavaScript('document.querySelector("input").value = "draft typed in a cross-origin frame"');
      assert.deepEqual(await browser.pageStateBlockers(framedContents()), ['unsaved_input'], 'edited input inside a cross-origin frame blocks suspension');
      await dispatch('tabs.close', { tabId: framed.id }, human);
      const current = await open('/current');
      await dispatch('page.evaluate', { tabId: scroll.id, expression: 'scrollTo(0, 1200); scrollY' }, human);
      await dispatch('page.evaluate', { tabId: form.id, expression: 'document.querySelector("input").value = "unsent draft"' }, human);
      const claim = await dispatch('tabs.claim', { tabId: leased.id }, agent);
      assert.equal(claim.error, null);
      const task = (await dispatch('tasks.create', { title: 'Compare', tabIds: [tasked.id], status: 'running' }, human)).result;
      const renderers = () => webContents.getAllWebContents().length;
      const before = renderers();
      // Idle beyond the limit: only the eligible tab is suspended, each refusal names its reason.
      const results = await browser.suspendIdle({ now: Date.now() + 2 * 60000 });
      const reason = id => results.find(item => item.tabId === id);
      assert.equal(reason(scroll.id).suspended, true);
      assert.deepEqual(reason(form.id).blockedBy, ['unsaved_input']);
      assert.ok(reason(leased.id).blockedBy.includes('agent_lease'));
      assert.ok(reason(tasked.id).blockedBy.includes('active_task'));
      assert.ok(reason(current.id).blockedBy.includes('active'));
      await until(() => renderers() <= before - results.filter(item => item.suspended).length, 'renderers released');
      const suspended = (await dispatch('tabs.list', {}, human)).result.find(tab => tab.id === scroll.id);
      assert.equal(suspended.suspended.reason, 'idle');
      assert.equal(suspended.suspended.scrollY, 1200);
      assert.equal(suspended.title, 'Page scroll');
      // Using the tab restores it: same id, reloaded page, scroll position back, new version.
      const read = await dispatch('page.readable', { tabId: scroll.id }, agent);
      assert.match(read.result.text, /Long page \/scroll/);
      const restored = (await dispatch('page.inspect', { tabId: scroll.id }, agent)).result;
      assert.ok(restored.version > suspended.version, 'restoration is a state boundary');
      assert.match(restored.restored.notice, /sign(ing)? in again/);
      await until(async () => (await dispatch('page.evaluate', { tabId: scroll.id, expression: 'scrollY' }, human)).result === 1200, 'scroll restored');
      // A capture of a suspended tab restores it first (PDF needs no visible view).
      assert.equal((await dispatch('tabs.suspend', { tabId: scroll.id }, agent)).result.suspended, true);
      const pdf = await dispatch('page.pdf', { tabId: scroll.id }, agent);
      assert.equal(pdf.result.mimeType, 'application/pdf');
      // Memory pressure: least recently used eligible tabs are suspended until renderers fit the budget.
      await dispatch('tasks.transition', { id: task.id, status: 'completed' }, human);
      await dispatch('tabs.release', { tabId: leased.id }, agent);
      await dispatch('settings.update', { resources: { idleSuspendMinutes: 0, memoryBudgetMb: 100 } }, human);
      browser.tab(tasked.id).lastActiveAt = 1;
      browser.tab(leased.id).lastActiveAt = 2;
      browser.tab(scroll.id).lastActiveAt = 3;
      const live = () => [...browser.tabs.values()].filter(tab => !tab.suspended).length;
      browser.rendererMemoryMb = async () => 45 * live();
      const pressure = await browser.suspendIdle();
      assert.deepEqual(pressure.filter(item => item.suspended).map(item => item.tabId), [tasked.id, leased.id, scroll.id], 'least recently used first, until under budget');
      assert.equal(browser.memoryStatus.overBudget, false);
      assert.ok(browser.tab(form.id).suspended === undefined || browser.tab(form.id).suspended === null, 'edited pages stay loaded even under pressure');
      // Restart: suspended tabs come back unloaded and load only when opened.
      browser.close();
      await new Promise(resolve => setTimeout(resolve, 100));
      browser = new Browser({ window, workspaceService: workspace, admission });
      workspace.attachBrowser(browser);
      dispatch = createDispatcher({ workspace, browser, admission, providers: { close() {} } });
      await browser.restore();
      const after = (await dispatch('tabs.list', {}, human)).result;
      assert.ok(after.find(tab => tab.id === tasked.id).suspended, 'suspended tabs stay unloaded after restart');
      assert.equal(after.find(tab => tab.id === leased.id).controller, 'available');
      browser.activate(tasked.id);
      await until(() => browser.tab(tasked.id).view.webContents.getTitle?.() === 'Page tasked', 'activation reloads the tab');
      // Split view (#24): both panes render and the saved focused pane receives keyboard focus.
      browser.activate(form.id);
      window.focus();
      browser.setLayout({ x: 0, y: 0, width: 1000, height: 700, visible: true, splitTabId: current.id, focusedPane: 'secondary' });
      await until(() => browser.attachedViews.size === 2, 'two panes attached');
      await until(() => browser.tab(current.id).view.webContents.isFocused(), 'secondary pane focused');
      browser.setLayout({ x: 0, y: 0, width: 1000, height: 700, visible: true, splitTabId: current.id, focusedPane: 'primary' });
      await until(() => browser.tab(form.id).view.webContents.isFocused(), 'primary pane focused');
      browser.setLayout({ x: 0, y: 0, width: 1, height: 1, visible: false });
      // Workload: repeated suspend/restore cycles release every renderer they create.
      const baseline = renderers();
      for (let i = 0; i < 20; i++) {
        const cycle = (await dispatch('tabs.suspend', { tabId: tasked.id }, human)).result;
        assert.equal(cycle.suspended, true, `suspend/restore cycle ${i} refused: ${JSON.stringify(cycle.blockedBy)}`);
        await dispatch('page.readable', { tabId: tasked.id }, agent);
      }
      await until(() => renderers() <= baseline, 'no leaked renderers');
      assert.equal(workspace.data.tasks.find(item => item.id === task.id).status, 'completed', 'suspension never changes task state');
      console.log('WEFT_SUSPENSION_OK');
    } finally {
      browser.close();
      workspace.close();
      server.close();
      app.quit();
    }
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  test('real Chromium idle-tab suspension, restoration, memory pressure, restart and workload', {
    timeout: 90000, skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires DISPLAY or xvfb-run' : false,
  }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-suspension-'));
    mkdirSync(profile, { recursive: true });
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), '--suspension-harness'], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 80000);
    try {
      const code = await new Promise(resolve => child.on('exit', resolve));
      assert.equal(code, 0, output);
      assert.match(output, /WEFT_SUSPENSION_OK/);
    } finally {
      clearTimeout(timer);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}
