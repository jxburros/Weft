import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { createClient } from '../src/client.js';
import { electronEnv } from '../scripts/electron-env.js';

/*
 * Real Electron headless lifecycle (#11): the shipped main process started with --headless, driven
 * over the authenticated API like an agent, with a stdin channel that lets the test act as the person
 * in the (hidden or shown) trusted window.
 */
if (process.argv.includes('--headless-harness')) {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  mkdirSync(join(process.env.WEFT_TEST_PROFILE, 'downloads'), { recursive: true });
  app.setPath('downloads', join(process.env.WEFT_TEST_PROFILE, 'downloads'));
  await import('../src/main.js');
  // The person: run code in the trusted GUI renderer (window.weft is its preload API).
  createInterface({ input: process.stdin }).on('line', async line => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    try {
      const window = BrowserWindow.getAllWindows()[0];
      const value = await window.webContents.executeJavaScript(request.js);
      console.log(`HARNESS ${JSON.stringify({ id: request.id, ok: true, value })}`);
    } catch (error) { console.log(`HARNESS ${JSON.stringify({ id: request.id, ok: false, error: String(error.message) })}`); }
  });
} else {
  const display = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const harness = fileURLToPath(import.meta.url);

  async function freePort() {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
  }
  function launch({ profile, port, token, headless }) {
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', harness, '--headless-harness', ...(headless ? ['--headless'] : [])], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile, WEFT_PORT: String(port), WEFT_TOKEN: token }), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const waiters = new Map();
    let next = 1;
    child.stdout.on('data', chunk => {
      output += chunk;
      for (const line of String(chunk).split('\n')) {
        if (!line.startsWith('HARNESS ')) continue;
        const reply = JSON.parse(line.slice(8));
        waiters.get(reply.id)?.(reply);
      }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    return {
      child, exited, get output() { return output; },
      /** Act as the person in the trusted window. */
      gui(js) {
        const id = next++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`GUI step timed out: ${js}`)), 15000);
          waiters.set(id, reply => { clearTimeout(timer); waiters.delete(id); reply.ok ? resolve(reply.value) : reject(new Error(reply.error)); });
          child.stdin.write(`${JSON.stringify({ id, js })}\n`);
        });
      },
    };
  }
  async function until(check, message, attempts = 200) {
    for (let i = 0; i < attempts; i++) {
      const value = await check().catch(() => null);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${message}`);
  }

  test('headless sessions keep one profile, policies and contracts; a person attaches, approves and detaches; restarts keep tabs and human ownership only',
    { timeout: 150000, skip: display ? 'Requires a display server or xvfb-run (Electron has no supported windowless mode; see ADR 015)' : false }, async () => {
      const fixture = createServer((request, response) => {
        response.setHeader('content-type', 'text/html');
        const title = request.url.startsWith('/b') ? 'Bravo page' : 'Alpha page';
        response.end(`<!doctype html><title>${title}</title><main style="height:3000px;background:#fafafa"><h1>${title}</h1><p>Headless evidence text.</p></main>`);
      });
      await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${fixture.address().port}`;
      const profile = mkdtempSync(join(tmpdir(), 'weft-headless-'));
      const token = 'headless-fixture-token-0123456789abcdef';
      const port = await freePort();
      const api = createClient({ url: `http://127.0.0.1:${port}`, token });
      const run = async (command, args = {}) => {
        const outcome = await api.executeOutcome(command, args);
        if (outcome.error) throw Object.assign(new Error(`${command}: ${outcome.error.code} ${outcome.error.message}`), { outcome });
        return outcome.result;
      };
      const expectedFingerprint = createHash('sha256').update(realpathSync(profile)).digest('hex').slice(0, 16);
      let weft;
      try {
        // ---- Phase 1: start headless ---------------------------------------------------------
        weft = launch({ profile, port, token, headless: true });
        const status = await until(() => run('display.status'), 'headless API ready');
        assert.equal(status.mode, 'headless');
        assert.equal(status.windowVisible, false);
        assert.equal(status.launchedHeadless, true);
        assert.equal(status.renderMode, 'offscreen');
        assert.equal(status.profile.fingerprint, expectedFingerprint, 'the session runs on the configured profile, not a new one');
        assert.equal(status.profile.userData, undefined, 'automation never receives the profile path');
        await until(async () => weft.output.includes('Weft is running headless'), 'headless banner');
        const [first] = await run('workspaces.list');
        const a1 = await run('tabs.new', { url: `${origin}/a`, workspaceId: first.id });
        const a2 = await run('tabs.new', { url: `${origin}/b`, workspaceId: first.id });
        assert.equal(a1.renderMode, 'offscreen');
        // Commands work without a window: read, capture (viewport and region), save an artifact.
        const readable = await run('page.readable', { tabId: a1.id, workspaceId: first.id });
        assert.match(readable.text, /Headless evidence text/);
        const shot = await run('page.screenshot', { tabId: a1.id, workspaceId: first.id });
        assert.ok(shot.data.length > 1000);
        assert.ok(shot.capture.image.width > 100 && shot.capture.image.height > 100, JSON.stringify(shot.capture.image));
        assert.ok(shot.capture.limitations.some(item => /offscreen/.test(item)));
        const region = await run('page.screenshot', { tabId: a2.id, workspaceId: first.id, rect: { x: 0, y: 0, width: 200, height: 100 } });
        assert.equal(region.capture.mode, 'region');
        assert.ok(region.capture.image.width >= 200);
        const artifact = await run('artifacts.capture', { tabId: a1.id, workspaceId: first.id, title: 'Headless capture' });
        assert.ok(artifact.versions[0].components.some(component => component.type === 'image/png'), 'artifact captures include the image while headless');
        // Session state and an agent lease.
        const inspected = await run('page.inspect', { tabId: a1.id, workspaceId: first.id });
        await run('page.evaluate', { tabId: a1.id, workspaceId: first.id, expectedVersion: inspected.version, expression: 'document.cookie = "isolated=alpha; max-age=3600"; document.cookie' });
        const leased = await run('tabs.claim', { tabId: a1.id, workspaceId: first.id, expectedVersion: (await run('page.inspect', { tabId: a1.id, workspaceId: first.id })).version });
        assert.equal(leased.controlMode, 'agent-drives');
        // The person holds the second tab (trusted window, still hidden).
        assert.equal(await weft.gui(`window.weft.execute('tabs.takeover', { tabId: ${a2.id} }).then(tab => tab.controlMode)`), 'you-drive');
        const found = await run('tabs.search', { query: 'alpha', workspaceId: first.id });
        assert.equal(found.results[0].tabId, a1.id);
        assert.equal(found.results[0].control.label, 'Agent drives: automation');
        // A second workspace has its own cookie container even while headless.
        const second = await run('workspaces.create', { name: 'Isolated project' });
        const b1 = await run('tabs.new', { url: `${origin}/a`, workspaceId: second.id });
        const bInspect = await run('page.inspect', { tabId: b1.id, workspaceId: second.id });
        assert.deepEqual(await run('page.evaluate', { tabId: b1.id, workspaceId: second.id, expectedVersion: bInspect.version, expression: 'document.cookie' }), { value: '', contentTrust: 'untrusted' });
        // The person lowers the second workspace to "assist"; opening a page there then needs a human decision.
        await weft.gui(`window.weft.execute('autonomy.update', { workspaceId: ${JSON.stringify(second.id)}, level: 'assist' })`);
        const opening = { url: `${origin}/b`, workspaceId: second.id };
        const navigate = await api.executeOutcome('tabs.new', opening);
        assert.equal(navigate.error.code, 'approval_required');
        const waiting = await run('display.status');
        assert.equal(waiting.pendingApprovals, 1);
        assert.match(waiting.humanAttention, /weft attach/);
        await until(async () => /1 agent request needs a human decision/.test(weft.output), 'headless approval notice on stdout');
        const denied = await api.executeOutcome('display.hide', { confirmReload: true });
        assert.equal(denied.error.code, 'permission_required', 'agents cannot hide the window');

        // ---- Display handoff without restart: launching Weft again shows this session -------------
        const again = launch({ profile, port: await freePort(), token, headless: false });
        assert.equal(await again.exited, 0, again.output);
        assert.match(again.output, /already running with this profile/);
        const attached = await until(async () => { const value = await run('display.status'); return value.windowVisible && value.transitions.length && value; }, 'window shown after relaunch');
        assert.equal(attached.mode, 'headed');
        assert.equal(attached.transitions.at(-1).source, 'relaunch');
        assert.equal(attached.profile.fingerprint, expectedFingerprint);
        // The person sees the pending request in the window and approves it once.
        await until(() => weft.gui(`document.getElementById('safety-notices').textContent.includes('needs your decision')`), 'approval notice in the window');
        const approvalId = navigate.error.details.authority.approvalId;
        await weft.gui(`window.weft.execute('approvals.approve', { id: ${JSON.stringify(approvalId)}, mode: 'once' })`);
        const approved = await run('tabs.new', opening);
        assert.equal(approved.renderMode, 'onscreen', 'pages opened while a window is shown render on screen');
        await weft.gui(`window.weft.execute('autonomy.update', { workspaceId: ${JSON.stringify(second.id)}, level: null })`);
        // The tab shown at attach moved on screen; tabs in other workspaces convert when opened.
        const shownTabs = await run('tabs.list', { workspaceId: second.id });
        assert.equal(shownTabs.find(tab => tab.id === b1.id).renderMode, 'onscreen');
        assert.equal((await run('tabs.list', { workspaceId: first.id })).find(tab => tab.id === a1.id).renderMode, 'offscreen');
        // The person detaches; captures keep working headless again.
        const detached = await weft.gui(`window.weft.execute('display.hide', { confirmReload: true })`);
        assert.equal(detached.mode, 'headless');
        assert.ok(detached.transition.reloadedTabs.includes(b1.id));
        const after = await run('page.screenshot', { tabId: b1.id, workspaceId: second.id });
        assert.ok(after.capture.image.width > 100);
        assert.equal((await run('display.status')).transitions.length, 2);
        // The person's last view is saved for the workspace (#24).
        await weft.gui('document.querySelector(\'[data-section="tasks"]\').click()');
        await until(async () => (await run('resume.get', { workspaceId: second.id })).view.section === 'tasks', 'resume record saved');
        const databaseBefore = statSync(join(profile, 'workspace-data', 'workspace.sqlite')).ino;
        await run('browser.close');
        assert.equal(await weft.exited, 0, weft.output);

        // ---- Phase 2: restart headless on the same profile ------------------------------------
        weft = launch({ profile, port, token, headless: true });
        const restarted = await until(() => run('display.status'), 'restarted API ready');
        assert.equal(restarted.profile.fingerprint, expectedFingerprint);
        assert.equal(statSync(join(profile, 'workspace-data', 'workspace.sqlite')).ino, databaseBefore, 'the same workspace database is reopened');
        // The trusted window (still hidden) reopens the saved section and discloses what a restore cannot bring back.
        await until(() => weft.gui('document.getElementById("breadcrumb-section").textContent === "Tasks"'), 'saved section restored');
        assert.match(await weft.gui('document.getElementById("safety-notices").textContent'), /restored.*sign in again.*Unsent form input/s);
        const tabs = await run('tabs.list', { workspaceId: first.id });
        assert.ok([a1.id, a2.id].every(id => tabs.some(tab => tab.id === id && tab.url.startsWith(origin))), 'tabs are restored from the checkpoint');
        assert.equal(tabs.find(tab => tab.id === a1.id).controller, 'available', 'agent leases end with the session');
        assert.equal(tabs.find(tab => tab.id === a2.id).controlMode, 'you-drive', 'human ownership persists');
        const cookie = await run('page.evaluate', { tabId: a1.id, workspaceId: first.id, expectedVersion: (await run('page.inspect', { tabId: a1.id, workspaceId: first.id })).version, expression: 'document.cookie' });
        assert.match(cookie.value, /isolated=alpha/, 'the persistent workspace container survives restart');
        const isolated = await run('page.evaluate', { tabId: b1.id, workspaceId: second.id, expectedVersion: (await run('page.inspect', { tabId: b1.id, workspaceId: second.id })).version, expression: 'document.cookie' });
        assert.equal(isolated.value, '', 'the other workspace never sees the cookie');
        // Only this profile's workspace containers exist: no unrelated browser profile was created.
        const partitions = readdirSync(join(profile, 'Partitions')).sort();
        assert.deepEqual(partitions, [`weft-${first.id}`, `weft-${second.id}`].map(name => name.toLowerCase()).sort());
        await run('browser.close');
        assert.equal(await weft.exited, 0, weft.output);
      } catch (error) {
        throw Object.assign(error, { message: `${error.message}\n--- Weft output ---\n${weft?.output.slice(-4000)}` });
      } finally {
        if (weft && weft.child.exitCode === null) { weft.child.kill('SIGKILL'); await weft.exited; }
        fixture.close();
        try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Chromium may still flush the profile */ }
      }
    });
}
