import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

// Exercises the real Electron net transport against a loopback fixture (no internet):
// redirects are surfaced to UpdateService instead of followed, bodies stream, and
// cookies set by a server are never sent back.
if (process.argv.includes('--weft-update-transport')) {
  const { app, net } = electron;
  const { createElectronTransport } = await import('../src/updater.js');
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const seen = [];
    const server = createServer((request, response) => {
      seen.push({ url: request.url, cookie: request.headers.cookie ?? null, agent: request.headers['user-agent'] });
      if (request.url === '/redirect') { response.writeHead(302, { location: '/asset', 'set-cookie': 'tracker=1; Path=/' }); response.end(); return; }
      if (request.url === '/asset') { response.writeHead(200, { 'set-cookie': 'tracker=2; Path=/' }); response.write('weft-'); setTimeout(() => response.end('payload'), 20); return; }
      response.writeHead(404); response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const transport = createElectronTransport(net);
    const headers = { 'user-agent': 'Weft/1.0.0 (test; x64) update-check' };
    const redirect = await transport({ url: `${base}/redirect`, headers });
    assert.equal(redirect.status, 302);
    assert.equal(new URL(redirect.location, base).pathname, '/asset');
    assert.equal(redirect.body, null);
    for (let i = 0; i < 2; i++) {
      const response = await transport({ url: `${base}/asset`, headers });
      assert.equal(response.status, 200);
      const chunks = [];
      for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).toString(), 'weft-payload');
    }
    assert.equal((await transport({ url: `${base}/missing`, headers })).status, 404);
    assert.deepEqual(seen.map(entry => entry.cookie), [null, null, null, null], 'update requests never carry cookies');
    assert.ok(seen.every(entry => entry.agent === headers['user-agent']));
    await assert.rejects(createElectronTransport(net, { headerTimeoutMs: 1 })({ url: 'http://127.0.0.1:9/', headers }));
    server.close();
    console.log('WEFT_UPDATE_TRANSPORT_OK');
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  test('Electron update transport surfaces redirects, streams bodies and omits cookies', {
    timeout: 30000,
    skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display; run xvfb-run -a npm test on headless Linux' : false,
  }, async () => {
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), '--weft-update-transport'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      assert.match(output, /WEFT_UPDATE_TRANSPORT_OK/);
    } finally { clearTimeout(timer); }
  });
}
