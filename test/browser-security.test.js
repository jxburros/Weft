import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Browser, applyEngineHardening } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { CommunityLists } from '../src/community-lists.js';
import { executeOutcome } from '../src/commands.js';
import { electronEnv } from '../scripts/electron-env.js';

const mode = ['--security-smoke', '--security-crash', '--security-recover'].find(flag => process.argv.includes(flag));
const sha = value => createHash('sha256').update(value).digest('hex');
const LISTED_DOWNLOAD = 'Weft listed download fixture';
async function until(check, message = 'Browser security condition timed out') {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const probe = `<!doctype html><title>probe</title><script>(async () => {
  const r = {};
  try { localStorage.setItem('probe', 'stored'); r.localStorage = 'ok'; } catch (e) { r.localStorage = e.name; }
  try { sessionStorage.setItem('probe', 'stored'); r.sessionStorage = 'ok'; } catch (e) { r.sessionStorage = e.name; }
  try { document.cookie = 'script=1; path=/; max-age=86400'; r.cookie = document.cookie; } catch (e) { r.cookie = e.name; }
  try { await new Promise((resolve, reject) => { const open = indexedDB.open('probe', 1); open.onupgradeneeded = () => open.result.createObjectStore('s'); open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error); }); r.indexedDB = 'ok'; } catch (e) { r.indexedDB = e.name; }
  try { await (await caches.open('probe')).put('/cached', new Response('x')); r.caches = 'ok'; } catch (e) { r.caches = e.name; }
  try { await navigator.serviceWorker.register('/sw.js'); r.serviceWorker = 'ok'; } catch (e) { r.serviceWorker = e.name; }
  r.origin = origin; document.title = 'done:' + JSON.stringify(r);
})()</script>`;
const reader = `<!doctype html><title>read</title><script>(async () => {
  const r = {};
  try { r.localStorage = localStorage.getItem('probe'); } catch (e) { r.localStorage = e.name; }
  try { r.cookie = document.cookie; } catch (e) { r.cookie = e.name; }
  try { r.indexedDB = (await indexedDB.databases()).map(item => item.name); } catch (e) { r.indexedDB = e.name; }
  try { r.caches = await caches.keys(); } catch (e) { r.caches = e.name; }
  try { r.serviceWorkers = (await navigator.serviceWorker.getRegistrations()).length; } catch (e) { r.serviceWorkers = e.name; }
  document.title = 'done:' + JSON.stringify(r);
})()</script>`;

function fixtureServers() {
  const hits = [];
  const connections = [];
  const html = (response, body) => { response.setHeader('content-type', 'text/html'); response.end(body); };
  const server = createServer((request, response) => {
    const host = String(request.headers.host || '').replace(/:\d+$/, '');
    const path = request.url;
    hits.push({ host, path, cookie: request.headers.cookie ?? null, method: request.method });
    const port = server.address().port;
    const blocked = `http://blocked.localhost:${port}`;
    const control = `http://allowed.localhost:${port}`;
    if (path === '/sw.js') { response.setHeader('content-type', 'text/javascript'); response.end('self.addEventListener("fetch", () => {});'); return; }
    if (path === '/sw-fetch.js') { response.setHeader('content-type', 'text/javascript'); response.end(`self.addEventListener('install', event => event.waitUntil(Promise.all([fetch('${blocked}/sw-fetch').catch(() => {}), fetch('${control}/sw-fetch', { mode: 'no-cors' }).catch(() => {})])));`); return; }
    if (path === '/worker.js') { response.setHeader('content-type', 'text/javascript'); response.end(`for (const base of ['${blocked}', '${control}']) fetch(base + '/worker-fetch', { mode: 'no-cors' }).catch(() => {}); for (const host of ['blocked', 'allowed']) try { new WebSocket('ws://' + host + '.localhost:${port}/worker-socket'); } catch {}`); return; }
    if (path === '/shared-worker.js') { response.setHeader('content-type', 'text/javascript'); response.end(`for (const base of ['${blocked}', '${control}']) fetch(base + '/shared-worker-fetch', { mode: 'no-cors' }).catch(() => {});`); return; }
    if (path.startsWith('/download')) {
      const body = path === '/download-listed' ? LISTED_DOWNLOAD : path === '/download-bad' ? 'payload WEFT-TEST-MALWARE' : `download ${path}`;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename=${path.slice(1).replace(/\W/g, '_')}.bin` });
      response.end(body); return;
    }
    if (path === '/probe') { response.setHeader('set-cookie', 'server=1; Path=/; Max-Age=86400'); html(response, probe); return; }
    if (path === '/read') { html(response, reader); return; }
    // SameSite=None cookies are the ones Chromium itself would send cross-site.
    if (path.startsWith('/set-cookie')) { response.setHeader('set-cookie', 'tracker=1; Path=/; Max-Age=86400; SameSite=None; Secure'); response.end('pixel'); return; }
    if (path === '/set-first') { response.setHeader('set-cookie', 'firstparty=1; Path=/; Max-Age=86400; SameSite=None; Secure'); html(response, '<title>first</title>'); return; }
    if (path === '/echo') { html(response, `<title>${request.headers.cookie ? 'cookie' : 'none'}</title>`); return; }
    if (path.startsWith('/embed-tracker')) { html(response, `<title>embed</title><img src="http://tracker.localhost:${port}/set-cookie?${Date.now()}"><img src="http://tracker.localhost:${port}/echo-image?${Date.now()}">`); return; }
    if (path === '/paths') {
      html(response, `<title>paths</title>
        <link rel="preconnect" href="http://preconnect.localhost:${connections.port}"><link rel="dns-prefetch" href="//preconnect.localhost:${connections.port}">
        <link rel="prefetch" href="${blocked}/prefetch"><link rel="prefetch" href="${control}/prefetch"><link rel="preload" as="image" href="${blocked}/preload">
        <script type="speculationrules">{"prefetch":[{"source":"list","urls":["${blocked}/speculative","${control}/speculative"]}],"prerender":[{"source":"list","urls":["${control}/prerender"]}]}</script>
        <iframe src="${blocked}/frame"></iframe><iframe src="${control}/frame"></iframe><img src="${blocked}/image"><link rel="stylesheet" href="${blocked}/style.css">
        <script>
          new Worker('/worker.js');
          try { new SharedWorker('/shared-worker.js'); } catch {}
          for (const host of ['blocked', 'allowed']) {
            const base = 'http://' + host + '.localhost:${port}';
            try { new WebSocket('ws://' + host + '.localhost:${port}/socket'); } catch {}
            try { new EventSource(base + '/events'); } catch {}
            navigator.sendBeacon(base + '/beacon', 'x');
            fetch(base + '/fetch', { mode: 'no-cors' }).catch(() => {});
          }
          navigator.serviceWorker.register('/sw-fetch.js').catch(() => {});
        </script>`);
      return;
    }
    if (path === '/form') { html(response, `<title>form</title><form id="f" method="post" action="${blocked}/form-post"><input name="a" value="1"></form>`); return; }
    if (path === '/frame-top') { html(response, '<title>frame-top</title><iframe src="/inner-top"></iframe>'); return; }
    if (path === '/inner-top') { html(response, `<script>setTimeout(() => { top.location = '${blocked}/top-nav'; }, 20)</script>`); return; }
    if (path === '/replace') { html(response, `<title>replace</title><script>setTimeout(() => location.replace('${blocked}/replace'), 20)</script>`); return; }
    if (path === '/exception') { html(response, `<title>exception</title><img src="${blocked}/exception-subresource">`); return; }
    if (path === '/popup-auto') { html(response, `<title>popup-auto</title><script>setTimeout(() => window.open('/second'), 30)</script>`); return; }
    if (path === '/popup-link') { html(response, '<title>popup-link</title><a id="pop" target="_blank" href="/second" style="display:block;position:fixed;left:0;top:0;width:300px;height:300px">Open</a>'); return; }
    if (path === '/launch') { html(response, '<title>launch</title><script>setTimeout(() => { location.href = "weft-test-app://open?item=1"; }, 20)</script>'); return; }
    if (path === '/launch-frame') { html(response, '<title>launch-frame</title><iframe src="weft-test-app://frame"></iframe>'); return; }
    if (path === '/launch-dangerous') { html(response, '<title>launch-dangerous</title><script>setTimeout(() => { location.href = "ms-msdt:/id PCWDiagnostic"; }, 20)</script>'); return; }
    if (path === '/permissions') {
      html(response, `<title>permissions</title><script>(async () => {
        const r = {};
        r.notification = await Notification.requestPermission();
        r.notification2 = await Notification.requestPermission();
        r.geolocation = await new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('granted'), error => resolve('denied:' + error.code)));
        try { await navigator.mediaDevices.getUserMedia({ video: true }); r.media = 'granted'; } catch (e) { r.media = e.name; }
        try { await navigator.clipboard.readText(); r.clipboard = 'granted'; } catch (e) { r.clipboard = e.name; }
        document.title = 'done:' + JSON.stringify(r);
      })()</script>`);
      return;
    }
    if (path === '/auto-download-frame') { html(response, '<title>frame-download</title><iframe src="/download-frame"></iframe>'); return; }
    if (path === '/repeat-download') {
      html(response, `<title>repeat</title><script>
        const get = href => { const a = document.createElement('a'); a.href = href; a.download = ''; document.body.append(a); a.click(); };
        for (let i = 0; i < 3; i++) setTimeout(() => get('/download-same'), i * 40);
        for (let i = 0; i < 7; i++) setTimeout(() => get('/download-burst-' + i), 200 + i * 40);
      </script>`);
      return;
    }
    if (path === '/threat-frame') { html(response, `<title>threat-frame</title><iframe src="http://threat.localhost:${port}/frame"></iframe>`); return; }
    html(response, `<!doctype html><title>${host}${path}</title><main>fixture</main>`);
  });
  server.on('upgrade', (request, socket) => { hits.push({ host: String(request.headers.host || '').replace(/:\d+$/, ''), path: request.url, upgrade: true }); socket.destroy(); });
  const counter = createServer((request, response) => { response.end('preconnect'); });
  counter.on('connection', () => connections.push(Date.now()));
  return { hits, connections, server, counter };
}

async function startServers() {
  const fixture = fixtureServers();
  await new Promise(resolve => fixture.server.listen(Number(process.env.WEFT_FIXTURE_PORT) || 0, '127.0.0.1', resolve));
  await new Promise(resolve => fixture.counter.listen(0, '127.0.0.1', resolve));
  fixture.connections.port = fixture.counter.address().port;
  fixture.port = fixture.server.address().port;
  fixture.url = (host, path = '/') => `http://${host}:${fixture.port}${path}`;
  fixture.close = () => { fixture.server.closeAllConnections(); fixture.server.close(); fixture.counter.closeAllConnections(); fixture.counter.close(); };
  return fixture;
}

async function titled(browser, tabId, prefix = 'done:') {
  const title = await until(() => { const value = browser.tab(tabId).view.webContents.getTitle(); return value.startsWith(prefix) && value; });
  return JSON.parse(title.slice(prefix.length));
}

async function securitySmoke() {
  const { app, BrowserWindow } = electron;
  const profile = process.env.WEFT_TEST_PROFILE;
  app.setPath('userData', profile);
  mkdirSync(join(profile, 'downloads'), { recursive: true });
  app.setPath('downloads', join(profile, 'downloads'));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const fixture = await startServers();
  const { hits, url } = fixture;
  const workspace = new WorkspaceService({ directory: join(profile, 'records') });
  const window = new BrowserWindow({ show: true, width: 1000, height: 800 });
  const browser = new Browser({ window, workspaceService: workspace });
  workspace.attachBrowser(browser);
  const launched = [];
  browser.openExternal = async target => { launched.push(target); };
  const report = {};
  const hit = (host, path) => hits.some(item => item.host === host && item.path === path);
  try {
    await browser.restore();
    browser.setLayout({ x: 0, y: 0, width: 900, height: 700, visible: true });
    const tab = browser.activeId;
    const workspaceId = workspace.activeWorkspaceId;
    const human = { actor: 'human' };
    const automation = { actor: 'automation' };
    const navigate = target => browser.execute('page.navigate', { tabId: tab, url: target });

    // #18: default "remember" allows storage; "block" refuses it in Chromium itself.
    await navigate(url('127.0.0.1', '/probe'));
    assert.deepEqual(Object.values(await titled(browser, tab)).slice(0, 6), ['ok', 'ok', 'server=1; script=1', 'ok', 'ok', 'ok']);
    await browser.execute('storage.setSiteMode', { hostname: 'blocked-storage.localhost', mode: 'block' }, human);
    await assert.rejects(browser.execute('storage.setSiteMode', { hostname: 'x.localhost', mode: 'remember' }, automation), /trusted/);
    await navigate(url('blocked-storage.localhost', '/probe'));
    const blockedProbe = await titled(browser, tab);
    for (const key of ['localStorage', 'sessionStorage', 'cookie', 'indexedDB', 'caches', 'serviceWorker']) assert.equal(blockedProbe[key], 'SecurityError', `${key} is refused in block mode`);
    assert.equal(blockedProbe.origin, 'null');
    assert.equal((await browser.execute('cookies.list', { url: url('blocked-storage.localhost') })).length, 0, 'Set-Cookie was not accepted');
    assert.ok(browser.describe(browser.tab(tab)).protection.storageActivity.documentsSandboxed >= 1);
    assert.equal(browser.describe(browser.tab(tab)).protection.storageMode.mode, 'block');
    await browser.execute('cookies.set', { url: url('blocked-storage.localhost'), name: 'late', value: '1' });
    await until(async () => (await browser.execute('cookies.list', { url: url('blocked-storage.localhost') })).length === 0, 'cookies created by other paths are deleted');
    // Cross-site cookies are removed from requests and responses by default.
    await navigate(url('tracker.localhost', '/set-first'));
    await navigate(url('tracker.localhost', '/echo'));
    assert.equal(hits.filter(item => item.host === 'tracker.localhost' && item.path === '/echo').at(-1).cookie, 'firstparty=1', 'first-party cookies are sent');
    await navigate(url('127.0.0.1', '/embed-tracker'));
    await until(() => hits.some(item => item.host === 'tracker.localhost' && item.path.startsWith('/echo-image')) && hits.some(item => item.host === 'tracker.localhost' && item.path.startsWith('/set-cookie')));
    const imageHits = hits.filter(item => item.host === 'tracker.localhost' && item.path.startsWith('/echo-image'));
    assert.equal(imageHits.at(-1).cookie, null, `cross-site cookie header removed; image hits ${JSON.stringify(imageHits)}; protection ${JSON.stringify(browser.describe(browser.tab(tab)).protection.storageActivity)}`);
    assert.equal((await browser.execute('cookies.list', { url: url('tracker.localhost') })).some(cookie => cookie.name === 'tracker'), false, 'cross-site Set-Cookie removed');
    assert.ok(browser.describe(browser.tab(tab)).protection.storageActivity.crossSiteCookiesBlocked >= 2);
    await browser.execute('storage.setSiteMode', { hostname: 'tracker.localhost', mode: 'remember' }, human);
    await navigate(url('127.0.0.1', '/embed-tracker?again'));
    await until(async () => (await browser.execute('cookies.list', { url: url('tracker.localhost') })).some(cookie => cookie.name === 'tracker'), 'an explicit exception allows cross-site cookies');
    // Session-only storage is erased at clean exit (crash recovery is tested in a separate process).
    await browser.execute('storage.setSiteMode', { hostname: 'session.localhost', mode: 'session' }, human);
    await navigate(url('session.localhost', '/probe'));
    assert.equal((await titled(browser, tab)).localStorage, 'ok');
    const policy = await browser.execute('storage.policy', {}, automation);
    assert.ok(policy.temporaryData.pendingEntries >= 1);
    assert.ok(policy.coverage.some(row => /IndexedDB/.test(row.path)));
    report.storage = { blockedProbe };

    // #19 / #41: request-level checks run before contact across engine paths.
    const rule = await workspace.execute('siteRules.create', { hostname: 'blocked.localhost', mode: 'connection', reason: 'Fixture', evidence: ['https://evidence.example/report'] });
    await workspace.execute('siteRules.create', { hostname: 'preconnect.localhost', mode: 'connection' });
    fixture.connections.length = 0;
    await navigate(url('127.0.0.1', '/paths'));
    assert.equal(browser.tab(tab).blocked, null, 'speculative and embedded requests never replace the page with a stop page');
    await pause(1500);
    const leaked = hits.filter(item => item.host === 'blocked.localhost').map(item => item.path);
    assert.deepEqual(leaked, [], `blocked host contacted via ${leaked.join(', ')}`);
    // Positive controls prove each mechanism really ran against an allowed host.
    const controls = new Set(hits.filter(item => item.host === 'allowed.localhost').map(item => item.path));
    for (const path of ['/frame', '/worker-fetch', '/worker-socket', '/shared-worker-fetch', '/socket', '/events', '/beacon', '/fetch', '/sw-fetch']) assert.ok(controls.has(path), `control ${path} did not run: ${[...controls].join(', ')}`);
    for (const path of ['/prefetch', '/speculative', '/prerender']) assert.equal(controls.has(path), false, `speculative ${path} must be cancelled for every destination`);
    report.preconnectConnections = fixture.connections.length;
    assert.equal(fixture.connections.length, 0, 'observed: link rel=preconnect opened no connection in this engine build');
    assert.ok(browser.describe(browser.tab(tab)).protection.storageActivity.speculativeLoadsCancelled >= 2);
    for (const [route, destination] of [['/form', '/form-post'], ['/frame-top', '/top-nav'], ['/replace', '/replace']]) {
      await navigate(url('127.0.0.1', route));
      if (route === '/form') await browser.execute('page.evaluate', { tabId: tab, expression: 'document.getElementById("f").submit()' }).catch(() => {});
      await until(() => browser.tab(tab).blocked?.url === url('blocked.localhost', destination), `${route} was not stopped`);
      assert.equal(hit('blocked.localhost', destination), false, `${route} reached the blocked destination`);
    }
    // Structured blocked results reach agents through the shared outcome contract.
    await navigate(url('127.0.0.1', '/'));
    const claimed = await browser.execute('tabs.claim', { tabId: tab }, automation);
    const outcome = await executeOutcome((name, args) => browser.execute(name, args, automation), 'page.navigate', { tabId: tab, expectedVersion: claimed.version, url: url('blocked.localhost', '/agent') });
    assert.equal(outcome.execution, 'failed');
    assert.equal(outcome.error.code, 'site_blocked');
    assert.equal(outcome.error.details.blocked.ruleId, rule.id);
    assert.equal(outcome.error.details.blocked.kind, 'preference');
    assert.equal(hit('blocked.localhost', '/agent'), false);
    await assert.rejects(browser.execute('page.allowOnce', { tabId: tab }, automation), /trusted/);
    await browser.execute('tabs.release', { tabId: tab }, automation);
    const explained = await browser.execute('siteRules.explain', { url: url('blocked.localhost', '/agent'), tabId: tab }, automation);
    assert.equal(explained.decision, 'block');
    assert.equal(explained.matches[0].evidence[0], 'https://evidence.example/report');
    // Exact-visit exception: one destination, one tab, one visit.
    await workspace.execute('siteRules.update', { id: rule.id, changes: { mode: 'navigation' } });
    await workspace.execute('siteRules.create', { hostname: 'blocked.localhost', path: '/exception-subresource', mode: 'connection' });
    await assert.rejects(navigate(url('blocked.localhost', '/exception')), { code: 'site_blocked' });
    await browser.execute('page.allowOnce', { tabId: tab }, human);
    await until(() => hit('blocked.localhost', '/exception'));
    assert.doesNotMatch(JSON.stringify(workspace.snapshot().browserSession), /allowUrl|allowSecurity/, 'exceptions are never persisted, so a restart ends them');
    await pause(300);
    assert.equal(hit('blocked.localhost', '/exception-subresource'), false, 'the exception does not cover embedded destinations');
    const during = await browser.execute('siteRules.explain', { url: url('blocked.localhost', '/exception'), tabId: tab });
    assert.equal(during.decision, 'allow-exception');
    assert.equal(during.exception.kind, 'exact-visit');
    const other = await browser.execute('tabs.new', { url: 'about:blank' });
    await assert.rejects(browser.execute('page.navigate', { tabId: other.id, url: url('blocked.localhost', '/exception') }), { code: 'site_blocked' }, 'other tabs are not covered');
    await browser.execute('tabs.close', { tabId: other.id });
    await assert.rejects(navigate(url('blocked.localhost', '/elsewhere')), { code: 'site_blocked' }, 'other destinations are not covered');
    assert.equal((await workspace.execute('siteRules.get', { id: rule.id })).enabled, true, 'the permanent rule remains');
    await browser.execute('page.back', { tabId: tab });

    // Popups: page-initiated windows need input in this tab.
    await navigate(url('127.0.0.1', '/popup-auto'));
    await until(() => browser.tab(tab).blockedPopups?.length, 'page-initiated popup was not recorded');
    assert.equal((await browser.execute('tabs.list')).length, 1, 'no tab was opened without input');
    assert.equal(browser.describe(browser.tab(tab)).protection.blockedPopups[0].url, url('127.0.0.1', '/second'));
    await navigate(url('127.0.0.1', '/popup-link'));
    await browser.tab(tab).view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    browser.tab(tab).view.webContents.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
    browser.tab(tab).view.webContents.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
    await until(async () => (await browser.execute('tabs.list')).length === 2, 'a human click may open a popup');
    const popup = (await browser.execute('tabs.list')).find(item => item.id !== tab);
    assert.equal(browser.tab(popup.id).openerTabId, tab);
    assert.equal(browser.tab(popup.id).openedBy, 'human');
    await browser.execute('tabs.close', { tabId: popup.id });
    await browser.execute('tabs.activate', { tabId: tab });

    // #20: external application launches are browser-owned requests.
    await navigate(url('127.0.0.1', '/launch'));
    const launch = await until(async () => (await browser.execute('launches.list')).find(item => item.scheme === 'weft-test-app' && item.frame === 'main-frame'), 'main-frame launch was not recorded');
    assert.equal(launch.state, 'pending');
    assert.equal(launch.sourceUrl, url('127.0.0.1', '/launch'));
    assert.equal(launched.length, 0, 'nothing launched without approval');
    await navigate(url('127.0.0.1', '/launch-frame'));
    await pause(500);
    report.frameLaunch = (await browser.execute('launches.list')).find(item => item.frame === 'subframe') ?? null;
    await navigate(url('127.0.0.1', '/launch-dangerous'));
    const dangerous = await until(async () => (await browser.execute('launches.list')).find(item => item.scheme === 'ms-msdt'));
    assert.equal(dangerous.state, 'refused');
    await assert.rejects(browser.execute('launches.approve', { launchId: dangerous.id }, human), /refused/);
    await assert.rejects(browser.execute('launches.approve', { launchId: launch.id }, automation), /trusted/);
    const approved = await browser.execute('launches.approve', { launchId: launch.id }, human);
    assert.equal(approved.state, 'launched');
    assert.deepEqual(launched, ['weft-test-app://open?item=1']);
    await assert.rejects(browser.execute('launches.approve', { launchId: launch.id }, human), /launched/, 'approval is single use');
    // Deceptive or repeated permission prompts are denied without reaching the person.
    await navigate(url('127.0.0.1', '/permissions'));
    const permissions = await titled(browser, tab);
    assert.equal(permissions.notification, 'denied');
    assert.equal(permissions.notification2, 'denied');
    assert.match(permissions.geolocation, /^denied/);
    assert.notEqual(permissions.media, 'granted');
    assert.notEqual(permissions.clipboard, 'granted');
    report.permissionDenials = browser.describe(browser.tab(tab)).protection.permissionDenials;

    // Threat intelligence is a separate security layer with staleness reporting.
    const generatedAt = new Date(Date.now() - 10 * 86400000).toISOString();
    const threatList = JSON.stringify({ format: 'weft-threat-list', version: 1, publisher: 'Fixture CERT', generatedAt, entries: [
      { type: 'host', value: 'threat.localhost', category: 'phishing' }, { type: 'sha256', value: sha(LISTED_DOWNLOAD), category: 'harmful-download' }] });
    await assert.rejects(browser.execute('threats.install', { id: 'fixture', source: 'test', sha256: sha(threatList), bytes: Buffer.byteLength(threatList), data: threatList }, automation), /trusted/);
    await browser.execute('threats.install', { id: 'fixture', source: 'test', sha256: sha(threatList), bytes: Buffer.byteLength(threatList), data: threatList, maxAgeHours: 72 }, human);
    assert.equal((await browser.execute('threats.status', {}, automation)).lists[0].freshness, 'stale');
    await assert.rejects(navigate(url('threat.localhost', '/landing')), error => error.code === 'site_blocked' && error.details.kind === 'security' && error.details.stale === true);
    assert.equal(browser.tab(tab).blocked.kind, 'security');
    await assert.rejects(browser.execute('page.allowOnce', { tabId: tab }, human), /acknowledgeSecurityRisk/);
    await browser.execute('page.allowOnce', { tabId: tab, acknowledgeSecurityRisk: true }, human);
    await until(() => hit('threat.localhost', '/landing'));
    await navigate(url('127.0.0.1', '/threat-frame'));
    await pause(400);
    assert.equal(hit('threat.localhost', '/frame'), false, 'embedded frames are checked');
    const threatExplain = await browser.execute('siteRules.explain', { url: url('threat.localhost', '/x') });
    assert.equal(threatExplain.decidedBy, 'security');
    assert.equal(threatExplain.security[0].kind, 'security');

    // Downloads: frames, repeats, bursts, scanner statuses, origin metadata and quarantine.
    await navigate(url('127.0.0.1', '/auto-download-frame'));
    const frameDownload = await until(async () => (await browser.execute('downloads.list')).find(item => item.url.endsWith('/download-frame')));
    assert.equal(frameDownload.state, 'blocked');
    assert.equal(frameDownload.sourcePage, url('127.0.0.1', '/auto-download-frame'));
    await navigate(url('127.0.0.1', '/repeat-download'));
    const accounted = list => list.filter(item => /download-burst/.test(item.url)).reduce((sum, item) => sum + item.attempts + (item.suppressedAttempts ?? 0), 0);
    await until(async () => accounted(await browser.execute('downloads.list')) === 7 && (await browser.execute('downloads.list')).find(item => item.url.endsWith('/download-same'))?.attempts === 3, 'repeated downloads were not all observed');
    const downloads = await browser.execute('downloads.list');
    const repeated = downloads.find(item => item.url.endsWith('/download-same'));
    assert.equal(repeated.state, 'blocked');
    assert.equal(repeated.attempts, 3, 'repeated attempts collapse into one request');
    const burst = downloads.filter(item => /download-burst/.test(item.url));
    assert.ok(burst.length <= 4, `burst records are capped (${burst.length})`);
    assert.ok(burst.at(-1).suppressedAttempts >= 1);
    const scanner = join(profile, 'scanner.sh');
    writeFileSync(scanner, '#!/bin/sh\ngrep -q WEFT-TEST-MALWARE "$1" && exit 1\nexit 0\n', { mode: 0o700 });
    await browser.execute('downloads.configureScanner', { command: '/bin/sh', args: [scanner] }, human);
    // The burst limiter now suppresses further unsolicited records from that tab; use a fresh one.
    const downloadTab = (await browser.execute('tabs.new', { url: url('127.0.0.1', '/files-home') })).id;
    const approveDownload = async (path, expected) => {
      await browser.execute('page.navigate', { tabId: downloadTab, url: url('127.0.0.1', `/start${path}`) });
      await browser.tab(downloadTab).view.webContents.executeJavaScript(`fetch('/x').then(() => { const a = document.createElement('a'); a.href = '${path}'; a.download = ''; document.body.append(a); a.click(); })`);
      const blocked = await until(async () => (await browser.execute('downloads.list')).find(item => item.url.endsWith(path) && item.state === 'blocked'));
      await browser.execute('downloads.approve', { downloadId: blocked.id }, human);
      return until(async () => (await browser.execute('downloads.list')).find(item => item.url.endsWith(path) && item.state === 'completed' && expected.includes(item.scanStatus)));
    };
    const clean = await approveDownload('/download-clean', ['clean']);
    assert.equal(clean.sha256.length, 64);
    assert.ok(['applied', 'unsupported', 'failed'].includes(clean.originMetadata.status));
    report.linuxOriginMetadata = clean.originMetadata;
    const infected = await approveDownload('/download-bad', ['infected']);
    assert.equal(infected.quarantined, true);
    const listed = await approveDownload('/download-listed', ['known-malicious']);
    assert.equal(listed.securityFinding.category, 'harmful-download');
    const quarantine = readdirSync(join(profile, 'downloads', 'Weft', 'quarantine'));
    assert.equal(quarantine.length, 2);
    assert.ok(quarantine.every(name => name.endsWith('.quarantined')));
    await browser.execute('downloads.configureScanner', { command: null }, human);
    const unscanned = await approveDownload('/download-plain', ['unscanned']);
    assert.deepEqual([unscanned.category, unscanned.risky, unscanned.mimeType], ['executable', true, 'application/octet-stream'], 'file type is shown with the record');

    // Clean exit erases session-only data before the process ends.
    const closing = browser.close();
    assert.ok(closing, 'temporary data cleanup runs at exit');
    await closing;
    assert.equal(JSON.parse(readFileSync(join(profile, 'records', 'temporary-storage-journal.json'), 'utf8')).entries.length, 0);
    assert.equal((await browser.partition(workspaceId).cookies.get({ domain: 'session.localhost' })).length, 0);
    console.log(`WEFT_SECURITY_REPORT ${JSON.stringify(report)}`);
    console.log('WEFT_SECURITY_OK');
  } finally {
    browser.close();
    window.destroy();
    fixture.close();
    app.quit();
  }
}

async function crashPhase(recover) {
  const { app, BrowserWindow } = electron;
  const profile = process.env.WEFT_TEST_PROFILE;
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const fixture = await startServers();
  const workspace = new WorkspaceService({ directory: join(profile, 'records') });
  const window = new BrowserWindow({ show: true, width: 900, height: 700 });
  const browser = new Browser({ window, workspaceService: workspace });
  workspace.attachBrowser(browser);
  const journal = join(profile, 'records', 'temporary-storage-journal.json');
  const session = () => browser.partition(workspace.activeWorkspaceId);
  if (!recover) {
    await browser.restore();
    const tab = browser.activeId;
    await browser.execute('storage.setSiteMode', { hostname: 'session.localhost', mode: 'session' });
    await browser.execute('storage.setSiteMode', { hostname: 'kept.localhost', mode: 'remember' });
    for (const host of ['session.localhost', 'kept.localhost']) {
      await browser.execute('page.navigate', { tabId: tab, url: fixture.url(host, '/probe') });
      assert.equal((await titled(browser, tab)).serviceWorker, 'ok');
    }
    session().flushStorageData();
    await session().cookies.flushStore();
    await pause(1500);
    assert.ok(JSON.parse(readFileSync(journal, 'utf8')).entries.some(entry => entry.hostname === 'session.localhost'));
    console.log('WEFT_CRASH_READY');
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  try {
    assert.ok(JSON.parse(readFileSync(journal, 'utf8')).entries.length > 0, 'the crash left a journal');
    assert.ok((await session().cookies.get({ domain: 'session.localhost' })).length > 0, 'temporary cookies survived the crash on disk');
    await browser.restore();
    assert.equal(JSON.parse(readFileSync(journal, 'utf8')).entries.length, 0);
    const tab = browser.activeId;
    const read = async host => { await browser.execute('page.navigate', { tabId: tab, url: fixture.url(host, '/read') }); return titled(browser, tab); };
    const temporary = await read('session.localhost');
    assert.deepEqual(temporary, { localStorage: null, cookie: '', indexedDB: [], caches: [], serviceWorkers: 0 }, 'temporary data erased at startup');
    const kept = await read('kept.localhost');
    assert.equal(kept.localStorage, 'stored');
    assert.match(kept.cookie, /server=1/);
    assert.deepEqual(kept.indexedDB, ['probe']);
    assert.deepEqual(kept.caches, ['probe']);
    assert.equal(kept.serviceWorkers, 1);
    const policy = await browser.execute('storage.policy', {});
    assert.equal(policy.temporaryData.lastStartupRecovery.reason, 'startup');
    assert.ok(policy.temporaryData.lastStartupRecovery.cleared >= 1);
    console.log('WEFT_RECOVER_OK');
  } finally {
    await browser.close();
    window.destroy();
    fixture.close();
    app.quit();
  }
}

if (mode) {
  applyEngineHardening(electron.app);
  const run = mode === '--security-smoke' ? securitySmoke() : crashPhase(mode === '--security-recover');
  run.catch(error => { console.error(error); electron.app.exit(1); });
} else {
  const skip = process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display; run xvfb-run -a npm test on headless Linux' : false;
  const launch = (flag, profile, port = 0) => {
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), flag], { env: electronEnv({ WEFT_TEST_PROFILE: profile, WEFT_FIXTURE_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 80000);
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, output }); }); });
  };
  test('real Chromium site storage modes, engine-path rule coverage, popups, launches, threat intelligence and downloads', { timeout: 90000, skip }, async t => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-security-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const { code, output } = await launch('--security-smoke', profile);
    assert.equal(code, 0, output);
    assert.match(output, /WEFT_SECURITY_OK/);
    const report = output.match(/WEFT_SECURITY_REPORT (.*)/)?.[1];
    if (report) t.diagnostic(`Observed engine behavior: ${report}`);
  });
  test('temporary site data is erased at the next startup after a crash; remembered data is kept', { timeout: 90000, skip }, async t => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-crash-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    // Storage is keyed by origin (including port), so both runs share one fixture port.
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const crashed = await launch('--security-crash', profile, port);
    assert.match(crashed.output, /WEFT_CRASH_READY/, crashed.output);
    assert.equal(crashed.signal, 'SIGKILL', crashed.output);
    // The documented crash recovery step: the person verifies no Weft process remains, then removes the stale lock.
    const lock = join(profile, 'records', '.workspace.lock');
    assert.ok(existsSync(lock));
    rmSync(lock);
    const recovered = await launch('--security-recover', profile, port);
    assert.equal(recovered.code, 0, recovered.output);
    assert.match(recovered.output, /WEFT_RECOVER_OK/);
  });
}
