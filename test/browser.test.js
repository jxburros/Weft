import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Browser, safeUrl } from '../src/browser.js';
import electron from 'electron';

const smoke = process.argv.includes('--weft-browser-smoke');
const mainSmoke = process.argv.includes('--weft-main-smoke');
const profile = process.env.WEFT_TEST_PROFILE;

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Browser condition timed out');
}

async function runSmoke() {
  const { app, BrowserWindow, session } = electron;
  const directory = profile;
  if (!directory) throw new Error('WEFT_TEST_PROFILE is required for the browser smoke subprocess');
  mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
  app.setPath('temp', directory);
  mkdirSync(`${directory}/downloads`, { recursive: true });
  app.setPath('downloads', `${directory}/downloads`);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const server = createServer((request, response) => {
    if (request.url === '/slow-download') {
      response.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"');
      response.setHeader('Content-Length', '10000000');
      response.setHeader('Content-Type', 'application/octet-stream');
      response.write('first chunk');
      const timer = setInterval(() => response.write('more data'), 100);
      response.on('close', () => clearInterval(timer));
      return;
    }
    if (request.url === '/download') {
      response.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"');
      response.end('Weft download fixture');
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>${request.url === '/second' ? 'Second page' : 'Weft smoke'}</title><input id="field"><button id="button" onclick="document.title=document.querySelector('input').value">Set</button><a id="download" href="/download" download>Download</a><a id="slow-download" href="/slow-download" download>Slow download</a><div style="height:2000px">Long page</div>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: true, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const browser = new Browser({ window, session: session.fromPartition('weft-test') });
  try {
    const first = await browser.execute('tabs.new', { url: origin });
    assert.equal((await browser.execute('browser.info')).electron, '44.9.0');
    assert.equal(first.title, 'Weft smoke');
    assert.equal((await browser.execute('tabs.list')).length, 1);
    await browser.execute('page.fill', { selector: '#field', value: 'Chromium works' });
    await browser.execute('page.click', { selector: '#button' });
    assert.equal(await browser.execute('page.title'), 'Chromium works');
    assert.match(await browser.execute('page.content'), /Long page/);
    assert.deepEqual(await browser.execute('page.evaluate', { expression: '({node: typeof process, bridge: typeof window.weft, answer: 42})' }), {
      node: 'undefined', bridge: 'undefined', answer: 42,
    });
    assert.equal(await browser.execute('page.evaluate', { expression: 'undefined' }), null);
    await assert.rejects(browser.execute('page.evaluate', { expression: '({value: 1n})' }));
    await assert.rejects(browser.execute('page.click', { selector: '#missing' }));
    await assert.rejects(browser.execute('page.fill', { selector: 'title', value: 'no' }));
    await browser.execute('page.navigate', { url: `${origin}/second` });
    assert.equal(await browser.execute('page.title'), 'Second page');
    await browser.execute('page.back');
    await until(async () => (await browser.execute('page.title')) === 'Weft smoke');
    await browser.execute('page.forward');
    await until(async () => (await browser.execute('page.title')) === 'Second page');
    await browser.execute('page.reload');
    await until(() => !browser.tab().view.webContents.isLoading());
    await browser.execute('page.stop');
    assert.equal(await browser.execute('page.evaluate', { expression: 'Notification.requestPermission()' }), 'denied');
    const shot = await browser.execute('page.screenshot');
    assert.equal(Buffer.from(shot.data, 'base64').subarray(1, 4).toString(), 'PNG');
    const full = await browser.execute('page.screenshot', { fullPage: true });
    assert.ok(Buffer.from(full.data, 'base64').readUInt32BE(20) >= 2000);
    const pdf = await browser.execute('page.pdf');
    assert.equal(Buffer.from(pdf.data, 'base64').subarray(0, 4).toString(), '%PDF');
    await browser.execute('cookies.set', { url: origin, name: 'weft-test', value: 'yes' });
    assert.equal((await browser.execute('cookies.list', { url: origin }))[0].value, 'yes');
    await browser.execute('page.evaluate', { expression: 'localStorage.setItem("keep", "yes")' });
    await browser.execute('cookies.clear');
    assert.equal((await browser.execute('cookies.list')).length, 0);
    assert.equal(await browser.execute('page.evaluate', { expression: 'localStorage.getItem("keep")' }), 'yes');
    const downloadDone = new Promise(resolve => browser.session.once('will-download', (_event, item) => item.once('done', (_event, state) => resolve(state))));
    const startDownload = selector => browser.execute('page.click', { selector });
    await startDownload('#download');
    assert.equal(await downloadDone, 'completed');
    const downloads = await browser.execute('downloads.list');
    assert.equal(downloads[0].state, 'completed');
    assert.equal(downloads[0].filename, 'fixture.txt');
    assert.equal(readdirSync(`${directory}/downloads/Weft`).length, 1);
    const pendingDownload = new Promise(resolve => browser.session.once('will-download', (_event, item) => resolve(item)));
    await startDownload('#slow-download');
    const item = await pendingDownload;
    const cancelled = new Promise(resolve => item.once('done', (_event, state) => resolve(state)));
    await browser.execute('downloads.cancel', { downloadId: 2 });
    assert.equal(await cancelled, 'cancelled');
    assert.equal((await browser.execute('downloads.list'))[1].state, 'cancelled');
    assert.equal(readdirSync(`${directory}/downloads/Weft`).length, 2, 'duplicate filenames do not overwrite');
    await browser.execute('page.evaluate', { expression: `window.open(${JSON.stringify(origin)}) === null` });
    await until(async () => (await browser.execute('tabs.list')).length === 2 && browser.tab().view.webContents.getTitle() === 'Weft smoke');
    const popup = browser.activeId;
    await browser.execute('page.evaluate', { expression: 'window.open("file:///etc/passwd")' });
    assert.equal((await browser.execute('tabs.list')).length, 2, 'unsafe popups are blocked');
    await browser.execute('tabs.close', { tabId: popup });
    const second = await browser.execute('tabs.new');
    assert.equal(second.active, true);
    await browser.execute('tabs.activate', { tabId: first.id });
    assert.equal((await browser.execute('tabs.list')).find(tab => tab.active).id, first.id);
    await browser.execute('tabs.close', { tabId: second.id });
    await assert.rejects(browser.execute('page.navigate', { url: 'file:///etc/passwd' }), /Only HTTP/);
    await assert.rejects(browser.execute('tabs.activate', { tabId: 999 }), /not found/);
    window.close();
    await until(() => window.isDestroyed());
    browser.close();
    assert.equal(browser.tabs.size, 0);
    console.log('WEFT_BROWSER_SMOKE_OK');
  } finally {
    browser.close();
    if (!window.isDestroyed()) window.destroy();
    server.close();
    app.quit();
  }
}

if (mainSmoke) {
  (async () => {
    await import('../src/main.js');
    await electron.app.whenReady();
    const fixture = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>GUI fixture</title><main>Visible browser capture</main>'); });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    electron.app.on('before-quit', () => fixture.close());
    const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
    for (let attempt = 0; attempt < 200; attempt++) {
      const window = electron.BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoading()) {
        const count = await window.webContents.executeJavaScript('document.getElementById("command")?.options.length ?? 0');
        if (count > 0 && await window.webContents.executeJavaScript('document.getElementById("status")?.textContent === "Ready"')) {
          const { commands, executeOutcome } = await import('../src/commands.js');
          assert.equal(count, Object.keys(commands).length);
          const guiInfo = await window.webContents.executeJavaScript('window.weft.executeOutcome("browser.info")');
          const rawInfo = await window.webContents.executeJavaScript('window.weft.execute("browser.info")');
          assert.deepEqual(guiInfo, await executeOutcome(() => rawInfo, 'browser.info'));
          const invalidInput = { tab_id: -1 };
          const guiInvalid = await window.webContents.executeJavaScript(`window.weft.executeOutcome('tabs.close', ${JSON.stringify(invalidInput)})`);
          assert.deepEqual(guiInvalid, await executeOutcome(() => assert.fail('invalid input must not execute'), 'tabs.close', invalidInput));
          const preferences = window.webContents.getLastWebPreferences();
          assert.equal(preferences.sandbox, true);
          assert.equal(preferences.contextIsolation, true);
          assert.equal(preferences.nodeIntegration, false);
          assert.equal(await window.webContents.executeJavaScript('typeof window.weft.execute'), 'function');
          assert.equal(await window.webContents.executeJavaScript('window.weft.execute("page.evaluate", {expression: "typeof process"})'), 'undefined');
          await window.webContents.executeJavaScript('document.getElementById("new-tab").click()');
          await until(async () => (await window.webContents.executeJavaScript('window.weft.execute("tabs.list")')).length === 2);
          await until(async () => (await window.webContents.executeJavaScript('document.querySelectorAll("#tabs .tab").length')) === 2);
          await until(async () => (await window.webContents.executeJavaScript('document.getElementById("status").textContent')) === 'Done');
          await window.webContents.executeJavaScript('document.getElementById("address").value = "about:blank"; document.getElementById("navigation").requestSubmit()');
          await until(async () => (await window.webContents.executeJavaScript('document.getElementById("status").textContent')) === 'Done');
          await window.webContents.executeJavaScript('document.getElementById("command").value = "browser.info"; document.getElementById("command").dispatchEvent(new Event("change")); document.getElementById("run").click()');
          await until(async () => (await window.webContents.executeJavaScript('document.getElementById("result").textContent')).includes('chromium'));
          await window.webContents.executeJavaScript('document.querySelector("#tabs .tab.active button:last-child").click()');
          await until(async () => (await window.webContents.executeJavaScript('window.weft.execute("tabs.list")')).length === 1);
          await until(async () => (await window.webContents.executeJavaScript('document.querySelectorAll("#tabs .tab").length')) === 1);
          assert.equal(await window.webContents.executeJavaScript('typeof process'), 'undefined');
          await assert.rejects(window.webContents.executeJavaScript('window.weft.execute("tabs.close", {tabId: 0})'));
          await assert.rejects(window.webContents.executeJavaScript('window.weft.execute("page.navigate", {url: "file:///etc/passwd"})'));
          assert.equal(await window.webContents.executeJavaScript('window.open("https://example.com") === null'), true);
          assert.equal(electron.BrowserWindow.getAllWindows().length, 1);
          assert.equal(await window.webContents.executeJavaScript(`(() => {
            globalThis.cspProbe = false;
            const script = document.createElement('script');
            script.textContent = 'globalThis.cspProbe = true';
            document.head.append(script);
            return globalThis.cspProbe;
          })()`), false, 'GUI CSP blocks inline scripts');
          const guiUrl = new URL('../src/gui.html', import.meta.url).href;
          const impostor = new electron.BrowserWindow({
            show: false, webPreferences: {
              preload: fileURLToPath(new URL('../src/preload.cjs', import.meta.url)),
              sandbox: true, nodeIntegration: false, contextIsolation: true,
            },
          });
          try {
            await impostor.loadURL(guiUrl);
            await assert.rejects(impostor.webContents.executeJavaScript('window.weft.commands()'));
            await assert.rejects(impostor.webContents.executeJavaScript('window.weft.execute("tabs.list")'));
            await assert.rejects(impostor.webContents.executeJavaScript('window.weft.layout({x:0,y:0,width:100,height:100,visible:true})'));
          } finally { impostor.destroy(); }
          await window.loadURL('about:blank');
          await assert.rejects(window.webContents.executeJavaScript('window.weft.commands()'));
          await assert.rejects(window.webContents.executeJavaScript('window.weft.execute("tabs.list")'));
          await window.loadURL(guiUrl);
          await until(async () => (await window.webContents.executeJavaScript('document.getElementById("command").options.length')) === Object.keys(commands).length);
          // Restoring the application opens its workspace overview. Use the actual
          // browser controls to show a live page before exercising MCP capture.
          await until(async () => (await window.webContents.executeJavaScript('document.getElementById("status").textContent')) === 'Ready');
          await window.webContents.executeJavaScript(`document.getElementById('address').value = ${JSON.stringify(fixtureUrl)}; document.getElementById('navigation').requestSubmit()`);
          await until(async () => (await window.webContents.executeJavaScript('window.weft.execute("page.title")')) === 'GUI fixture');
          await until(() => window.contentView.children.length > 0);
          console.log('WEFT_GUI_SMOKE_OK');
          if (process.argv.includes('--weft-close-gui')) window.close();
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('GUI did not initialize');
  })().catch(error => { console.error(error); electron.app.exit(1); });
} else if (smoke) {
  runSmoke().catch(error => { console.error(error); electron.app.exit(1); });
} else {
  test('browser cleanup tolerates a destroyed GUI and disposed tab views without reactivation', () => {
    const session = new EventEmitter();
    session.setPermissionRequestHandler = () => {};
    session.setPermissionCheckHandler = () => {};
    const window = new EventEmitter();
    window.isDestroyed = () => true;
    Object.defineProperty(window, 'contentView', {
      get() { throw new Error('Destroyed window must never be accessed'); },
    });
    const browser = new Browser({ window, session, electronApi: {} });
    const closed = [];
    browser.tabs.set(1, { id: 1, view: { webContents: {
      isDestroyed: () => false, close: () => closed.push(1),
    } } });
    browser.tabs.set(2, { id: 2, view: { webContents: undefined } });
    browser.tabs.set(3, { id: 3, view: { webContents: {
      isDestroyed: () => true, close: () => { throw new Error('Disposed tab must not close again'); },
    } } });
    browser.activeId = 1;
    browser.activate = () => { throw new Error('Cleanup must not reactivate tabs'); };
    browser.close();
    browser.close();
    assert.deepEqual(closed, [1]);
    assert.equal(browser.tabs.size, 0);
    assert.equal(window.listenerCount('resize'), 0);
    assert.equal(session.listenerCount('will-download'), 0);
  });

  test('URL policy permits web URLs and rejects local, executable and credential URLs', () => {
    assert.equal(safeUrl('https://example.com'), 'https://example.com/');
    assert.equal(safeUrl('http://localhost:9222'), 'http://localhost:9222/');
    assert.equal(safeUrl('about:blank'), 'about:blank');
    const credentials = new URL('https://example.com');
    credentials.username = 'user';
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'about:config', credentials.href]) {
      assert.throws(() => safeUrl(url));
    }
  });

  test('real Chromium browser operations and remote-content isolation', {
    timeout: 60000,
    skip: process.platform === 'linux' && !process.env.DISPLAY
      ? 'Requires a display; run xvfb-run -a npm test on headless Linux'
      : false,
  }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-test-'));
    // CI lacks a configured setuid sandbox helper; production startup never uses these flags.
    const testFlags = ['--no-sandbox', '--disable-gpu'];
    const child = spawn(electron, [...testFlags, fileURLToPath(import.meta.url), '--weft-browser-smoke'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WEFT_TEST_PROFILE: profile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 50000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      assert.match(output, /WEFT_BROWSER_SMOKE_OK/);
      const portReservation = createServer();
      await new Promise(resolve => portReservation.listen(0, '127.0.0.1', resolve));
      const port = portReservation.address().port;
      await new Promise(resolve => portReservation.close(resolve));
      const token = 'browser-integration-test-token';
      const main = spawn(electron, [...testFlags, `--user-data-dir=${profile}/main`, fileURLToPath(import.meta.url), '--weft-main-smoke'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WEFT_PORT: String(port), WEFT_TOKEN: token, WEFT_TEST_PROFILE: profile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let mainOutput = '';
      main.stdout.on('data', chunk => { mainOutput += chunk; });
      main.stderr.on('data', chunk => { mainOutput += chunk; });
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(mainOutput || 'Main startup timed out')), 10000);
          main.once('exit', code => { clearTimeout(timeout); reject(new Error(`Main exited ${code}: ${mainOutput}`)); });
          main.stdout.on('data', () => {
            if (mainOutput.includes('Weft API:') && mainOutput.includes('WEFT_GUI_SMOKE_OK')) { clearTimeout(timeout); resolve(); }
          });
        });
        const url = `http://127.0.0.1:${port}/v1/execute`;
        assert.equal((await fetch(url)).status, 401);
        const request = (command, args = {}) => fetch(url, {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, args }),
        });
        assert.equal((await (await request('browser.info')).json()).result.electron, '44.9.0');
        assert.equal((await (await request('tabs.list')).json()).result.length, 1);
        const cliTab = (await (await request('page.inspect')).json()).result;
        const cli = await promisify(execFile)(process.execPath, [
          fileURLToPath(new URL('../bin/weft.js', import.meta.url)), 'page.evaluate', JSON.stringify({ tabId: cliTab.id, expectedVersion: cliTab.version, expression: '6 * 7' }),
        ], { env: { ...process.env, WEFT_API_URL: `http://127.0.0.1:${port}`, WEFT_TOKEN: token } });
        assert.equal(JSON.parse(cli.stdout).result, 42);
        assert.equal(JSON.parse(cli.stdout).execution, 'succeeded');
        const mcp = new Client({ name: 'chromium-smoke', version: '1.0.0' });
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [fileURLToPath(new URL('../bin/weft.js', import.meta.url)), 'mcp'],
          env: { WEFT_API_URL: `http://127.0.0.1:${port}`, WEFT_TOKEN: token },
        });
        try {
          await mcp.connect(transport);
          const { mcpTools } = await import('../src/mcp.js');
          assert.deepEqual((await mcp.listTools()).tools.map(tool => tool.name), mcpTools.map(tool => tool.name));
          const mcpTab = (await (await request('page.inspect')).json()).result;
          const answer = await mcp.callTool({ name: 'weft_page', arguments: { action: 'page.evaluate', args: { tabId: mcpTab.id, expectedVersion: mcpTab.version, expression: '21 * 2' } } });
          assert.equal(JSON.parse(answer.content[0].text).result, 42);
          assert.equal(answer.structuredContent.execution, 'succeeded');
          const screenshot = await mcp.callTool({ name: 'weft_page', arguments: { action: 'page.screenshot', args: { tabId: mcpTab.id } } });
          assert.equal(screenshot.content[0].type, 'text');
          assert.equal(screenshot.content[1].type, 'image');
          assert.equal(Buffer.from(screenshot.content[1].data, 'base64').subarray(1, 4).toString(), 'PNG');
        } finally { await mcp.close(); }
        assert.equal((await request('browser.close')).status, 200);
        await new Promise(resolve => main.once('exit', resolve));
        const lifecycle = spawn(electron, [...testFlags, `--user-data-dir=${profile}/gui-close`, fileURLToPath(import.meta.url), '--weft-main-smoke', '--weft-close-gui'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WEFT_PORT: String(port), WEFT_TOKEN: token, WEFT_TEST_PROFILE: profile },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let lifecycleOutput = '';
        lifecycle.stdout.on('data', chunk => { lifecycleOutput += chunk; });
        lifecycle.stderr.on('data', chunk => { lifecycleOutput += chunk; });
        const lifecycleTimeout = setTimeout(() => lifecycle.kill('SIGKILL'), 10000);
        try {
          const code = await new Promise((resolve, reject) => {
            lifecycle.once('exit', resolve);
            lifecycle.once('error', reject);
          });
          assert.equal(code, 0, lifecycleOutput);
          assert.match(lifecycleOutput, /WEFT_GUI_SMOKE_OK/);
          assert.doesNotMatch(lifecycleOutput, /TypeError|Object has been destroyed/);
        } finally { clearTimeout(lifecycleTimeout); }
      } finally {
        if (main.exitCode === null && main.signalCode === null) {
          const exited = new Promise(resolve => main.once('exit', resolve));
          main.kill();
          const force = setTimeout(() => main.kill('SIGKILL'), 3000);
          await exited;
          clearTimeout(force);
        }
      }
    } finally {
      clearTimeout(timer);
      rmSync(profile, { recursive: true, force: true });
    }
  });
}
