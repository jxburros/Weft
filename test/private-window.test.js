import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Browser, applyEngineHardening } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { PrivateWindows, privateTarget } from '../src/private-window.js';
import { electronEnv } from '../scripts/electron-env.js';
import { budget } from './time-budget.js';

const mode = ['--private-smoke', '--private-crash'].find(flag => process.argv.includes(flag));
const MARKER = 'weftprivatemarker7f3c';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Condition timed out') {
  for (let attempt = 0; attempt < 1200; attempt++) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error(message);
}
const PAGES = {
  '/store': `<!doctype html><title>store</title><script>localStorage.setItem('k', '${MARKER}'); document.cookie = 'script=${MARKER}; max-age=86400'; indexedDB.open('${MARKER}');
    caches.open('${MARKER}').then(cache => cache.put('/cached', new Response('${MARKER}'))).finally(() => { document.title = 'stored'; });</script>`,
  '/read': `<!doctype html><title>read</title><script>document.title = 'read:' + (localStorage.getItem('k') || 'none') + ':' + (document.cookie.includes('${MARKER}') ? 'cookie' : 'nocookie');</script>`,
  '/opener': '<!doctype html><title>opener</title><button id="b" style="position:fixed;left:0;top:0;width:300px;height:300px" onclick="window.open(\'/read\')">open</button>',
  '/auto-download': '<!doctype html><title>auto-download</title><script>const a = document.createElement("a"); a.href = "/file"; a.download = ""; document.body.append(a); a.click();</script>',
};

async function start() {
  const server = createServer((request, response) => {
    if (request.url === '/file') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=f.bin' }); response.end('x'); return; }
    if (request.url === '/store') response.setHeader('set-cookie', `server=${MARKER}; Path=/; Max-Age=86400`);
    response.setHeader('content-type', 'text/html');
    response.end(PAGES[request.url] ?? `<!doctype html><title>${request.url}</title>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: (path, host = 'private.localhost') => `http://${host}:${server.address().port}${path}` };
}

async function setup() {
  const { app, BrowserWindow } = electron;
  const profile = process.env.WEFT_TEST_PROFILE;
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const fixture = await start();
  const workspace = new WorkspaceService({ directory: join(profile, 'records') });
  const window = new BrowserWindow({ show: true, width: 900, height: 700 });
  const browser = new Browser({ window, workspaceService: workspace });
  workspace.attachBrowser(browser);
  await browser.restore();
  const audits = [];
  const windows = new PrivateWindows({ browser, audit: entry => audits.push(entry), siteRuleFor: url => workspace.matchSiteRule(url, 'weft-private-window') });
  return { app, profile, fixture, workspace, window, browser, windows, audits };
}
const title = (item, prefix) => until(() => { const value = item.view.webContents.getTitle(); return value.startsWith(prefix) && value; }, `title ${prefix}`);

async function smoke() {
  const { app, fixture, workspace, window, browser, windows, audits } = await setup();
  const { url } = fixture;
  try {
    const opened = windows.open();
    const item = windows.windows.get(opened.id);
    await item.window.webContents.executeJavaScript('new Promise(r => document.readyState === "complete" ? r() : addEventListener("load", r))');
    assert.match(item.window.getTitle(), /Private window/);
    assert.equal(item.view.webContents.session.isPersistent(), false, 'in-memory partition');
    await windows.navigate(item, url('/store'));
    await title(item, 'stored');
    const cookies = await item.view.webContents.session.cookies.get({});
    assert.ok(cookies.some(cookie => cookie.value === MARKER));

    // Nothing reaches the workspace: no tab, no history, and agents are refused by id.
    assert.equal(browser.tabs.has(opened.id), false);
    assert.equal((await browser.execute('tabs.list', {}, { actor: 'automation' })).some(tab => tab.id === opened.id), false);
    assert.equal(workspace.snapshot().history.some(visit => String(visit.url).includes('private.localhost')), false);
    await assert.rejects(browser.execute('page.readable', { tabId: opened.id }, { actor: 'automation' }), error => error.code === 'permission_required' && /private window/.test(error.message));
    await assert.rejects(browser.execute('tabs.close', { tabId: opened.id }, { actor: 'automation' }), /private window/);
    assert.ok(audits.some(entry => entry.reason === 'private_window_opened'));
    assert.ok(!JSON.stringify(audits).includes('private.localhost'), 'activity records only that a private window existed');

    // A popup after a click opens another private window on the same in-memory session.
    await windows.navigate(item, url('/opener'));
    await title(item, 'opener');
    await pause(300);
    item.view.webContents.focus();
    item.view.webContents.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
    item.view.webContents.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
    await until(() => windows.count === 2, 'private popup window');
    const popup = [...windows.windows.values()].find(candidate => candidate.id !== opened.id);
    assert.equal(popup.sessionKey, item.sessionKey);
    assert.equal(await title(popup, 'read:'), `read:${MARKER}:cookie`);

    // Downloads without a gesture are cancelled; nothing is listed anywhere.
    await windows.navigate(item, url('/auto-download'));
    await pause(500);
    assert.equal((await browser.execute('downloads.list', {})).length, 0);

    // Global site rules apply; non-web schemes are refused.
    await workspace.execute('siteRules.create', { hostname: 'blocked.localhost', mode: 'navigation', reason: 'Fixture', scope: 'global' });
    const refused = await windows.navigate(item, url('/x', 'blocked.localhost'));
    assert.ok(refused.error);
    assert.throws(() => privateTarget('file:///etc/passwd'), /http and https/);
    assert.equal(privateTarget('example.com'), 'https://example.com/');
    assert.match(privateTarget('two words'), /^https:\/\/duckduckgo\.com\/\?q=two%20words$/);

    // Closing the last window of the session erases its data; a new private window starts empty.
    popup.window.close();
    item.window.close();
    await until(() => windows.count === 0 && windows.sessions.size === 0, 'private windows closed');
    const fresh = windows.windows.get(windows.open().id);
    await windows.navigate(fresh, url('/read'));
    assert.equal(await title(fresh, 'read:'), 'read:none:nocookie');
    windows.closeAll();
    console.log('WEFT_PRIVATE_OK');
  } finally {
    await browser.close();
    window.destroy();
    fixture.server.closeAllConnections();
    fixture.server.close();
    app.quit();
  }
}

async function crash() {
  const { fixture, windows } = await setup();
  const item = windows.windows.get(windows.open().id);
  await windows.navigate(item, fixture.url('/store'));
  await title(item, 'stored');
  // Give Chromium time to flush anything it would write for a persistent profile.
  await pause(1500);
  console.log('WEFT_PRIVATE_READY');
}

function filesUnder(directory) {
  const out = [];
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return out; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

if (mode) {
  applyEngineHardening(electron.app);
  (mode === '--private-smoke' ? smoke() : crash()).catch(error => { console.error(error); electron.app.exit(1); });
} else {
  const skip = process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display; run xvfb-run -a npm test on headless Linux' : false;
  const launch = (flag, profile, onOutput) => {
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), flag], { env: electronEnv({ WEFT_TEST_PROFILE: profile }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = chunk => { output += chunk; onOutput?.(output, child); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), budget(80000));
    return new Promise(resolve => child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); }));
  };
  test('real Chromium private windows: in-memory sessions, no workspace records, agents refused, popups and erase on close', { timeout: budget(90000), skip }, async t => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-private-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const { code, output } = await launch('--private-smoke', profile);
    assert.equal(code, 0, output);
    assert.match(output, /WEFT_PRIVATE_OK/);
  });
  test('a crash leaves no private-window data on disk', { timeout: budget(90000), skip }, async t => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-private-crash-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const { signal, output } = await launch('--private-crash', profile, (text, child) => { if (text.includes('WEFT_PRIVATE_READY')) child.kill('SIGKILL'); });
    assert.equal(signal, 'SIGKILL', output);
    assert.match(output, /WEFT_PRIVATE_READY/, 'the private page stored its data before the crash');
    const holding = filesUnder(profile).filter(file => {
      // Chromium children may finish an atomic rename after the parent exits.
      try { return statSync(file).size < 64 * 1024 * 1024 && readFileSync(file).includes(MARKER); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    assert.deepEqual(holding, [], 'no file in the profile contains private-window data');
  });
}
