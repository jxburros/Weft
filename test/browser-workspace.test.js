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
import { Knowledge } from '../src/knowledge.js';

const smoke = process.argv.includes('--workspace-smoke');
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Browser security condition timed out');
}
if (smoke) {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  mkdirSync(join(process.env.WEFT_TEST_PROFILE, 'downloads'), { recursive: true });
  app.setPath('downloads', join(process.env.WEFT_TEST_PROFILE, 'downloads'));
  app.on('window-all-closed', () => {});
  (async () => {
    await app.whenReady();
    const hits = [];
    const server = createServer((request, response) => {
      hits.push(request.url);
      if (request.url === '/download') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=fixture.txt' }); response.end('Approved download'); return; }
      if (request.url === '/blocked/redirect') { response.writeHead(302, { location: '/blocked/next' }); response.end(); return; }
      if (request.url === '/redirect') { response.writeHead(302, { location: '/blocked/destination' }); response.end(); return; }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/meta') { response.end('<meta http-equiv="refresh" content="0;url=/blocked/meta">'); return; }
      if (request.url === '/script') { response.end('<script>setTimeout(() => location.href="/blocked/script", 20)</script>'); return; }
      response.end('<!doctype html><title>Workspace fixture</title><main>Saved evidence<input type="password" value="password-secret"><input autocomplete="cc-number" value="card-secret"><textarea autocomplete="one-time-code">otp-secret</textarea></main><button id="change" onclick="document.title=\'Changed\'">Change</button>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const workspace = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, 'records') });
    const window = new BrowserWindow({ show: true });
    let browser = new Browser({ window, workspaceService: workspace });
    workspace.attachBrowser(browser);
    try {
      await browser.restore();
      const firstWorkspace = workspace.activeWorkspaceId;
      const firstTab = browser.activeId;
      await browser.execute('page.navigate', { url: origin });
      await browser.execute('cookies.set', { url: origin, name: 'isolated', value: 'first' });
      await browser.execute('page.evaluate', { expression: 'localStorage.setItem("project", "first")' });
      assert.ok((await workspace.execute('history.list')).some(visit => visit.url === `${origin}/`));
      const bookmark = await workspace.execute('bookmarks.create', { title: 'Fixture', url: origin });
      assert.equal((await workspace.execute('bookmarks.list'))[0].id, bookmark.id);
      await workspace.execute('bookmarks.delete', { id: bookmark.id });
      assert.equal((await workspace.execute('bookmarks.list')).length, 0);
      await assert.rejects(workspace.execute('history.clear', {}, { actor: 'automation' }), /human/);
      const secondWorkspace = await workspace.execute('workspaces.create', { name: 'Second project' });
      // Context sharing between the workspaces (#21) must leave their browser containers isolated; the checks below run with it enabled.
      const knowledge = new Knowledge({ workspace });
      const shared = await knowledge.execute('collections.create', { workspaceId: firstWorkspace, name: 'Shared facts' }, { actor: 'human' });
      await knowledge.execute('collections.grant', { id: shared.id, memberWorkspaceId: secondWorkspace.id, role: 'write' }, { actor: 'human' });
      assert.equal((await knowledge.execute('collections.list', { workspaceId: secondWorkspace.id }, { actor: 'human' }))[0].sessionSharing, 'separate');
      await workspace.execute('workspaces.switch', { id: secondWorkspace.id });
      await browser.execute('page.navigate', { url: origin });
      const secondTab = browser.activeId;
      assert.equal((await browser.execute('cookies.list', { url: origin })).length, 0);
      assert.equal(await browser.execute('page.evaluate', { expression: 'localStorage.getItem("project")' }), null);
      await browser.execute('cookies.set', { url: origin, name: 'isolated', value: 'second' });
      await browser.execute('storage.clear', { workspaceId: secondWorkspace.id, url: origin });
      assert.equal((await browser.execute('cookies.list', { url: origin })).length, 0);
      await workspace.execute('workspaces.switch', { id: firstWorkspace });
      assert.equal((await browser.execute('cookies.list', { url: origin }))[0].value, 'first');
      assert.equal(await browser.execute('page.evaluate', { expression: 'localStorage.getItem("project")' }), 'first');
      assert.equal((await browser.execute('page.readable')).text, 'Saved evidence');
      assert.doesNotMatch(await browser.execute('page.content'), /password-secret|card-secret|otp-secret/);
      await assert.rejects(browser.execute('page.evaluate', { tabId: firstTab, expectedVersion: browser.tab(firstTab).version, expression: '42' }, { actor: 'automation' }),
        error => error.code === 'stale_state' && error.details.reason === 'inspection_required', 'a guessed current version is not an inspection after navigation');
      await browser.execute('page.inspect', { tabId: firstTab }, { actor: 'automation' });
      const currentVersion = browser.tab(firstTab).version;
      await assert.rejects(browser.execute('page.evaluate', { tabId: firstTab, expression: '42' }, { actor: 'automation' }), /expectedVersion/);
      const pending = browser.execute('page.evaluate', { tabId: firstTab, expectedVersion: currentVersion, expression: 'new Promise(resolve => setTimeout(() => resolve(42), 150))' }, { actor: 'automation' });
      await assert.rejects(browser.execute('page.evaluate', { tabId: firstTab, expectedVersion: browser.tab(firstTab).version, expression: '43' }, { actor: 'automation' }), { code: 'tab_busy' });
      await browser.execute('tabs.takeover', { tabId: firstTab });
      await assert.rejects(pending, { code: 'action_interrupted' });
      await browser.execute('tabs.release', { tabId: firstTab });
      assert.equal((await browser.execute('tabs.list')).length, 1);
      await browser.execute('tabs.pin', { tabId: firstTab, pinned: true });
      const claimed = await browser.execute('tabs.claim', { tabId: firstTab }, { actor: 'automation' });
      await assert.rejects(browser.execute('page.click', { tabId: firstTab, selector: '#change' }, { actor: 'automation' }), /expectedVersion/);
      await browser.execute('page.click', { tabId: firstTab, selector: '#change', expectedVersion: claimed.version }, { actor: 'automation' });
      await assert.rejects(browser.execute('page.click', { tabId: firstTab, selector: '#change', expectedVersion: claimed.version }, { actor: 'automation' }), /Stale/);
      const takeover = await browser.execute('tabs.takeover', { tabId: firstTab });
      await assert.rejects(browser.execute('page.navigate', { tabId: firstTab, url: origin, expectedVersion: takeover.version }, { actor: 'automation' }), /held/);
      await assert.rejects(browser.execute('tabs.takeover', { tabId: firstTab }, { actor: 'automation' }), /trusted/);
      await assert.rejects(browser.execute('cookies.list', {}, { actor: 'automation' }), /trusted/);
      await browser.execute('tabs.release', { tabId: firstTab });
      await workspace.execute('siteRules.create', { hostname: '127.0.0.1', path: '/blocked', mode: 'connection', behavior: 'block' });
      await assert.rejects(browser.execute('page.navigate', { url: `${origin}/blocked/direct` }), /Blocked/);
      assert.equal(browser.describe(browser.tab()).blocked.url, `${origin}/blocked/direct`);
      await assert.rejects(browser.execute('page.allowOnce', { tabId: firstTab }, { actor: 'automation' }), /trusted/);
      await browser.execute('page.allowOnce', { tabId: firstTab });
      assert.equal(browser.describe(browser.tab()).blocked, null);
      assert.ok(hits.includes('/blocked/direct'));
      await browser.execute('page.navigate', { url: origin });
      await assert.rejects(browser.execute('page.navigate', { url: `${origin}/blocked/direct` }), /Blocked/, 'override expires after leaving the destination');
      await assert.rejects(browser.execute('page.navigate', { url: `${origin}/blocked/redirect` }), /Blocked/);
      await assert.rejects(browser.execute('page.allowOnce', { tabId: firstTab }), { code: 'site_blocked' }, 'a redirect from the excepted destination is reported as a structured block');
      assert.equal(hits.includes('/blocked/next'), false, 'override does not permit a redirect chain');
      assert.equal(browser.describe(browser.tab()).blocked.url, `${origin}/blocked/next`);
      await browser.execute('page.back');
      assert.equal(browser.describe(browser.tab()).blocked, null);

      await assert.rejects(browser.execute('page.navigate', { url: `${origin}/redirect` }), error => error.code === 'site_blocked' && error.details.url === `${origin}/blocked/destination`);
      assert.equal(hits.includes('/blocked/destination'), false, 'redirect target is blocked before contact');
      await browser.execute('page.navigate', { url: origin });
      assert.equal(await browser.execute('page.evaluate', { expression: `fetch(${JSON.stringify(`${origin}/blocked/background`)}).then(()=>true,()=>false)` }), false);
      assert.equal(hits.includes('/blocked/background'), false, 'background connection is blocked');
      for (const route of ['meta', 'script']) {
        await browser.execute('page.navigate', { url: `${origin}/${route}` }).catch(error => { if (!/Blocked|ERR_ABORTED|ERR_FAILED/.test(error.message)) throw error; });
        await until(() => browser.tab().blocked?.url === `${origin}/blocked/${route}`);
        assert.equal(hits.includes(`/blocked/${route}`), false, `${route} redirect blocked before contact`);
        await browser.execute('page.navigate', { url: origin });
      }
      await browser.execute('page.evaluate', { expression: `document.body.insertAdjacentHTML("beforeend", '<a id="blocked-link" href="/blocked/click">Blocked link</a>')` });
      const click = await browser.execute('page.click', { selector: '#blocked-link' }).catch(error => ({ error }));
      assert.ok(click.submitted || click.error?.code === 'site_blocked');
      assert.notEqual(click.success, true);
      await until(() => browser.tab().blocked?.url === `${origin}/blocked/click`);
      assert.equal(hits.includes('/blocked/click'), false, 'link destination blocked before contact');
      await browser.execute('page.navigate', { url: origin });
      await browser.execute('page.evaluate', { expression: `window.open(${JSON.stringify(`${origin}/blocked/popup`)})` });
      assert.equal((await browser.execute('tabs.list')).length, 1);
      assert.throws(() => browser.setLayout({ x: -1, y: 0, width: 500, height: 500, visible: true }), /Invalid/);
      browser.setLayout({ x: 250, y: 100, width: 2000, height: 2000, visible: true });
      assert.equal(browser.attachedViews.size, 1);
      await browser.tab().view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const visibleShot = await browser.execute('page.screenshot');
      assert.equal(Buffer.from(visibleShot.data, 'base64').subarray(1, 4).toString(), 'PNG');
      browser.setLayout({ x: 250, y: 100, width: 500, height: 500, visible: false });
      assert.equal(browser.attachedViews.size, 0, 'modal hides native pages');
      const capture = await browser.captureArtifact({ tabId: firstTab, kind: 'bundle' });
      assert.equal(capture.text, 'Saved evidence');
      if (capture.pngBase64) assert.equal(Buffer.from(capture.pngBase64, 'base64').subarray(1, 4).toString(), 'PNG');
      else assert.ok(capture.limitations.some(value => value.startsWith('Screenshot unavailable:')));
      browser.close();
      const restoredWorkspace = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, 'records') });
      browser = new Browser({ window, workspaceService: restoredWorkspace });
      restoredWorkspace.attachBrowser(browser);
      await browser.restore();
      assert.equal(browser.tabs.size, 2);
      assert.equal(browser.describe(browser.tab(firstTab)).pinned, true);
      assert.equal(browser.tab(secondTab).workspaceId, secondWorkspace.id);
      assert.equal((await browser.execute('cookies.list', { url: origin }))[0].value, 'first');
      const moved = await browser.execute('tabs.move', { tabId: firstTab, workspaceId: secondWorkspace.id });
      assert.equal(moved.workspaceId, secondWorkspace.id);
      assert.equal(browser.tabs.has(firstTab), false);
      assert.equal(await browser.execute('page.evaluate', { tabId: moved.id, expression: 'localStorage.getItem("project")' }), null, 'move uses destination container');
      const unsolicited = new Promise(resolve => browser.sessionFor(secondWorkspace.id).once('will-download', () => resolve()));
      browser.tab(moved.id).view.webContents.downloadURL(`${origin}/download`);
      await unsolicited;
      const blockedDownload = [...browser.downloads.values()].at(-1).record;
      assert.equal(blockedDownload.state, 'blocked');
      await assert.rejects(browser.execute('downloads.approve', { downloadId: blockedDownload.id }, { actor: 'automation' }), /trusted/);
      const approved = new Promise(resolve => browser.sessionFor(secondWorkspace.id).once('will-download', (_event, item) => item.once('done', (_event, state) => resolve(state))));
      await browser.execute('downloads.approve', { downloadId: blockedDownload.id });
      assert.equal(await approved, 'completed');
      const lease = await browser.execute('tabs.claim', { tabId: moved.id }, { actor: 'automation' });
      await assert.rejects(browser.execute('browser.emergencyStop', {}, { actor: 'automation' }), /trusted/);
      const stopped = await browser.execute('browser.emergencyStop');
      assert.equal(stopped.stopped, true);
      await assert.rejects(browser.execute('page.navigate', { tabId: moved.id, expectedVersion: lease.version, url: origin }, { actor: 'automation' }), { code: 'emergency_stop' });
      await assert.rejects(browser.execute('tabs.new', {}, { actor: 'automation' }), { code: 'emergency_stop' });
      await browser.execute('browser.resumeAutomation');
      assert.equal((await browser.execute('browser.info')).automation.stopped, false);
      assert.ok((await restoredWorkspace.execute('history.list', { workspaceId: firstWorkspace })).length);
      await restoredWorkspace.execute('history.clear', { workspaceId: firstWorkspace });
      assert.equal((await restoredWorkspace.execute('history.list', { workspaceId: firstWorkspace })).length, 0);
      console.log('WORKSPACE_BROWSER_OK');
    } finally {
      browser.close();
      window.destroy();
      server.closeAllConnections();
      server.close();
      app.quit();
    }
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  test('real Chromium workspace isolation, persistence, control leases, site rules, and native layout', { timeout: 45000 }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-workspace-integration-'));
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', ...(!process.env.DISPLAY && process.platform === 'linux' ? ['--ozone-platform=headless'] : []), fileURLToPath(import.meta.url), '--workspace-smoke'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WEFT_TEST_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 35000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      assert.match(output, /WORKSPACE_BROWSER_OK/);
    } finally { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); }
  });
}
