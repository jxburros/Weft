import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';

const secrets = ['my private query', 'hunter2-pass'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Recording condition timed out') {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await wait(20); }
  throw new Error(message);
}

if (process.argv.includes('--recording-smoke')) {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  app.on('window-all-closed', () => {});
  (async () => {
    await app.whenReady();
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Supplier</title><main>
<label>Search <input id="q" name="q"></label>
<label>Password <input id="pw" type="password" name="password"></label>
<button id="go" onclick="document.title = 'went'">Go</button>
<button id="evil">Trap</button>
<script>
  // Page scripts try to inject steps: synthetic (untrusted) events and forged console reports.
  setInterval(() => {
    document.getElementById('evil').click();
    document.getElementById('q').dispatchEvent(new Event('change', { bubbles: true }));
    console.log('weft-record:guess:' + JSON.stringify({ type: 'click', selector: '#evil' }));
  }, 50);
</script></main>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const workspace = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, 'records') });
    const window = new BrowserWindow({ show: true, width: 1000, height: 800 });
    const admission = new AutomationAdmission();
    const browser = new Browser({ window, workspaceService: workspace, admission });
    workspace.attachBrowser(browser);
    const providers = { close() {}, stopAll() {}, execute() { throw new Error('No provider'); } };
    const dispatch = createDispatcher({ workspace, browser, providers, admission });
    const human = { actor: 'human', source: 'gui' };
    const run = async (command, args) => { const outcome = await dispatch(command, args, human); if (outcome.error) throw new Error(`${command}: ${outcome.error.message}`); return outcome.result; };
    try {
      await browser.restore();
      const tabId = browser.activeId;
      await run('page.navigate', { tabId, url: `${origin}/start?token=abc` });
      const contents = browser.tab(tabId).view.webContents;
      await until(() => contents.executeJavaScript('!!document.getElementById("go")'));
      const started = await run('workflows.recordStart', { tabId, title: 'Supplier search' });
      assert.equal(started.pageCapture, true);
      await wait(300);
      const center = async selector => contents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      const click = async selector => {
        const { x, y } = await center(selector);
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await wait(100);
      };
      const type = async text => { for (const keyCode of text) contents.sendInputEvent({ type: 'char', keyCode }); await wait(50); };
      const tab = async () => { contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' }); await wait(100); };
      await click('#q'); await type(secrets[0]); await tab();
      await click('#pw'); await type(secrets[1]); await tab();
      await click('#go');
      await until(() => contents.executeJavaScript('document.title === "went"'));
      assert.equal(await contents.executeJavaScript('document.getElementById("q").value'), secrets[0], 'the person really typed into the page');
      const stopped = await run('workflows.recordStop', { tabId });
      assert.equal(stopped.saved, true);
      const workflow = workspace.data.workflows.find(item => item.id === stopped.workflow.id);
      const json = JSON.stringify(workflow);
      for (const secret of [...secrets, 'abc']) assert.equal(json.includes(secret), false, `recorded workflow contains ${secret}`);
      assert.equal(json.includes('#evil'), false, 'untrusted page events and forged reports are not recorded');
      const summary = workflow.steps.map(step => `${step.kind}:${step.command ?? ''}:${step.args?.selector ?? ''}:${step.args?.value ?? ''}`);
      assert.deepEqual(summary, [`command:page.navigate::`, 'command:page.fill:#q:{{field_1}}', 'command:credentials.fill::', 'command:page.click:#go:'], JSON.stringify(summary));
      assert.equal(workflow.steps[2].args.id, '{{field_2}}', 'the password field becomes a protected login step bound to a saved sign-in chosen at run time');
      assert.equal(workflow.steps[0].args.url, `${origin}/start`);
      assert.equal(workflow.enabled, false);
      assert.deepEqual(workflow.parameters.map(item => item.type), ['string', 'credential']);
      console.log('WORKFLOW_RECORDING_OK');
    } finally {
      browser.close();
      window.destroy();
      server.closeAllConnections(); server.close();
      workspace.close();
      app.quit();
    }
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  test('real Chromium recording captures trusted clicks and field changes without values; page scripts cannot inject steps', {
    timeout: 60000,
    skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display; run xvfb-run -a npm test on headless Linux' : false,
  }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-recording-'));
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', fileURLToPath(import.meta.url), '--recording-smoke'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WEFT_TEST_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 50000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      assert.match(output, /WORKFLOW_RECORDING_OK/);
    } finally { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); }
  });
}
