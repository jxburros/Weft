import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { encodePng } from '../src/png.js';
import { electronEnv } from '../scripts/electron-env.js';

async function until(check, message = 'Archive condition timed out', attempts = 250) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)).then(() => `http://127.0.0.1:${server.address().port}`);
const stop = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

if (process.argv.includes('--archive-smoke')) {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  mkdirSync(join(process.env.WEFT_TEST_PROFILE, 'downloads'), { recursive: true });
  app.setPath('downloads', join(process.env.WEFT_TEST_PROFILE, 'downloads'));
  app.on('window-all-closed', () => {});
  (async () => {
    await app.whenReady();
    let price = '42';
    const hits = [];
    const logo = encodePng({ width: 40, height: 20, data: Buffer.alloc(40 * 20 * 4, 120) });
    const big = encodePng({ width: 300, height: 300, data: randomBytes(300 * 300 * 4) });
    const source = createServer((request, response) => {
      hits.push(request.url);
      if (request.url === '/logo.png') { response.setHeader('content-type', 'image/png'); response.end(logo); return; }
      if (request.url === '/big.png') { response.setHeader('content-type', 'image/png'); response.end(big); return; }
      if (request.url === '/style.css') { response.setHeader('content-type', 'text/css'); response.end('h1 { color: rgb(200, 0, 0); } body { background: url(/logo.png) no-repeat; }'); return; }
      if (request.url === '/missing.png') { response.statusCode = 404; response.end('gone'); return; }
      if (request.url === '/app.js') { response.setHeader('content-type', 'text/javascript'); response.end('document.title = "Script ran";'); return; }
      if (request.url === '/frame') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><p>Framed evidence</p>'); return; }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><head><title>Archive fixture</title><link rel="stylesheet" href="/style.css"></head><body><main><h1>Prices</h1>
<p>Price ${price} today</p>
<img src="/logo.png" alt="Logo"><img src="/missing.png" alt="Missing"><img src="/big.png" alt="Big">
<label>Password <input type="password" value="pw-archive-secret"></label><input type="hidden" name="csrf" value="csrf-archive-secret">
<iframe src="/frame" title="Frame"></iframe></main><script src="/app.js"></script><script>fetch('/beacon').catch(() => {});</script></body></html>`);
    });
    const origin = await listen(source);
    const workspace = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, 'records') });
    const window = new BrowserWindow({ show: true, width: 1200, height: 900 });
    const browser = new Browser({ window, workspaceService: workspace });
    workspace.attachBrowser(browser);
    const beaconHits = [];
    const beacon = createServer((request, response) => { beaconHits.push(`${request.method} ${request.url}`); response.end('tracked'); });
    const beaconOrigin = await listen(beacon);
    try {
      await browser.restore();
      await browser.execute('page.navigate', { tabId: browser.activeId, url: origin });
      const contents = browser.tab().view.webContents;
      await until(async () => !contents.isLoading() && (await contents.executeJavaScript('document.title')) === 'Script ran' && hits.includes('/beacon'));

      // #16: bounded archive capture with a manifest and explicit missing-resource report.
      const first = await workspace.execute('artifacts.capture', { kind: 'archive', title: 'Prices', maxResourceBytes: 64 * 1024, readyTimeoutMs: 3000 });
      const v1 = workspace.data.artifacts[0].versions[0];
      const resources = Object.fromEntries(v1.archive.resources.map(item => [new URL(item.url).pathname, item]));
      assert.equal(v1.archive.resources[0].role, 'document');
      assert.equal(resources['/style.css'].status, 'stored');
      assert.equal(resources['/logo.png'].status, 'stored');
      assert.equal(resources['/frame'].role, 'frame');
      assert.equal(resources['/missing.png'].status, 'failed');
      assert.equal(resources['/missing.png'].httpStatus, 404);
      assert.equal(resources['/big.png'].status, 'omitted-size');
      assert.equal(resources['/app.js'].status, 'not-archived-script');
      assert.equal(resources['/beacon'].status, 'not-archived-script');
      const documentHtml = Buffer.from(v1.archive.resources[0].bodyBase64, 'base64').toString('utf8');
      assert.equal(/<script/i.test(documentHtml), false, 'Chromium serialization removes scripts');
      for (const secret of ['pw-archive-secret', 'csrf-archive-secret']) assert.equal(documentHtml.includes(secret), false, secret);
      assert.equal(v1.capture.readiness.state, 'ready');
      assert.ok(v1.capture.durationMs >= 0 && v1.capture.durationMs < 30000);
      assert.equal(v1.capture.originalUrl, `${origin}/`);
      assert.equal(v1.capture.finalUrl, `${origin}/`);
      assert.ok(v1.capture.viewport.width > 0);
      assert.ok(v1.capture.resourceFailures.some(item => item.httpStatus === 404));
      assert.equal(v1.capture.complete, false);
      assert.ok(v1.capture.incomplete.includes('resources-not-stored'));
      assert.match(v1.text, /Price 42 today/);
      assert.ok(v1.pngBase64, `no screenshot in the first capture: ${JSON.stringify({ incomplete: v1.capture?.incomplete, limitations: v1.capture?.limitations ?? v1.limitations ?? null })}`);
      assert.equal((await workspace.execute('artifacts.verify', { id: first.id })).status, 'verified');

      // Changed-page recapture is a new immutable version; comparison shows what changed.
      price = '45';
      await browser.execute('page.reload', { tabId: browser.activeId });
      await until(async () => !contents.isLoading() && /Price 45/.test(await contents.executeJavaScript('document.body.innerText')));
      await workspace.execute('artifacts.capture', { kind: 'archive', artifactId: first.id, maxResourceBytes: 64 * 1024 });
      const [a, b] = workspace.data.artifacts[0].versions;
      assert.equal(a.id, v1.id);
      const comparison = await workspace.execute('artifacts.compare', { id: first.id, fromVersionId: a.id, toVersionId: b.id });
      assert.deepEqual(comparison.text.hunks.flatMap(hunk => hunk.lines).filter(line => line.op !== 'context').map(line => line.text), ['Price 42 today', 'Price 45 today']);
      assert.ok(comparison.resources.changed.some(item => item.url === `${origin}/`));
      assert.ok(comparison.pixels.available, `pixel comparison unavailable: ${comparison.pixels.reason}; limitations: ${JSON.stringify([a, b].map(version => version.capture?.limitations ?? version.limitations ?? null))}`);

      // Source closed and network gone: the archive still previews offline, from stored components only.
      await stop(source);
      const before = hits.length;
      const preview = await workspace.execute('artifacts.preview', { id: first.id, versionId: a.id });
      assert.equal(preview.open, true);
      assert.equal(preview.javascript, 'disabled');
      const view = browser.preview.view.webContents;
      await until(() => !view.isLoading());
      // The archive is the rendered DOM at capture time (the page's own script had already set this title); nothing runs in the preview.
      assert.equal(view.getTitle(), 'Script ran');
      assert.ok(browser.describePreview().stats.served >= 4, 'document, stylesheet, image and frame are served from the archive');
      assert.ok(browser.describePreview().stats.refused >= 1, 'the failed image is refused, not fetched');
      const image = await view.capturePage();
      assert.equal(image.isEmpty(), false);
      assert.equal(hits.length, before, 'the closed source receives nothing');
      workspace.execute('artifacts.closePreview', {});
      await until(() => !browser.preview);

      // Hostile archived content: scripts, event handlers, meta refresh, forms, links and external resources stay inert.
      const hostile = `<!doctype html><html><head><title>Hostile archive</title><meta http-equiv="refresh" content="0;url=${beaconOrigin}/refresh">
<link rel="stylesheet" href="${beaconOrigin}/style.css"><script>document.title = 'executed'; fetch('${beaconOrigin}/fetch'); new Image().src = '${beaconOrigin}/image';</script></head>
<body onload="document.title='onload ran'"><img src="${beaconOrigin}/pixel.png" onerror="document.title='onerror ran'">
<a id="link" href="${beaconOrigin}/clicked" style="position:fixed;left:0;top:0;width:300px;height:60px;display:block;background:#ccc">Follow</a>
<form action="${beaconOrigin}/submit" method="post"><input name="a" value="b"><button style="position:fixed;left:0;top:100px;width:300px;height:60px">Submit</button></form>
<iframe src="${beaconOrigin}/frame"></iframe><object data="${beaconOrigin}/object"></object></body></html>`;
      await browser.openArchivePreview({ artifactId: 'artifact_fixture', versionId: 'version_fixture', title: 'Hostile', documentUrl: 'https://hostile.example/',
        resources: [{ url: 'https://hostile.example/', role: 'document', mimeType: 'text/html', bytes: Buffer.from(hostile) }] });
      const hostileView = browser.preview.view.webContents;
      await until(() => !hostileView.isLoading());
      await new Promise(resolve => setTimeout(resolve, 700));
      const click = async (x, y) => {
        hostileView.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        hostileView.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await new Promise(resolve => setTimeout(resolve, 400));
      };
      await click(20, 20);
      await click(20, 120);
      assert.equal(hostileView.getTitle(), 'Hostile archive', 'no archived script or handler ran');
      assert.equal(hostileView.getURL(), 'https://hostile.example/', 'navigation, refresh and form submission were blocked');
      assert.deepEqual(beaconHits, [], 'nothing reached the network');
      const stats = browser.describePreview().stats;
      assert.ok(stats.refused >= 3, JSON.stringify(stats));
      const closed = browser.closeArchivePreview();
      assert.equal(closed.closed, true);
      console.log('ARCHIVE_SMOKE_OK');
    } finally {
      browser.close();
      window.destroy();
      await stop(beacon);
      if (source.listening) await stop(source);
      workspace.close();
      app.quit();
    }
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  test('real Chromium resource archives: capture, recapture comparison, offline preview after source closure, hostile content inert', {
    timeout: 90000,
    skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display; run xvfb-run -a npm test on headless Linux' : false,
  }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-archive-browser-'));
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', fileURLToPath(import.meta.url), '--archive-smoke'], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 80000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      assert.match(output, /ARCHIVE_SMOKE_OK/);
    } finally { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); }
  });
}
