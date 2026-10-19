import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { electronEnv } from '../scripts/electron-env.js';
import { budget } from './time-budget.js';

const EVERYTHING = 'ws_e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0';
const launch = (args, env) => spawn(typeof electron === 'string' ? electron : process.execPath, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), ...args], { env: electronEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });

if (process.argv.includes('--second-launch')) {
  // A second launch with the same profile hands its link to the running session (#99) and exits.
  const { app } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  await import('../src/main.js');
} else if (process.argv.includes('--windows-smoke')) {
  const { app, BrowserWindow, webContents } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  let fixture;
  (async () => {
    fixture = createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><title>Page ${request.url.slice(1)}</title><main><h1>Fixture ${request.url}</h1></main>`);
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const { WorkspaceService } = await import('../src/workspace.js');
    const seed = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, 'workspace-data') });
    const home = seed.activeWorkspaceId;
    const trip = await seed.execute('workspaces.create', { name: 'Trip' });
    await seed.execute('workspaces.switch', { id: home });
    seed.close();
    // A link on the first launch's command line, as an operating system passes it (#99).
    process.argv.push(`${origin}/from-launch`, 'javascript:alert(1)');
    await import('../src/main.js');
    await app.whenReady();
    let main;
    for (let i = 0; i < 300; i++) {
      main = BrowserWindow.getAllWindows()[0];
      if (main && !main.webContents.isLoading() && main.webContents.getURL().endsWith('gui.html')) break;
      await new Promise(r => setTimeout(r, 20));
    }
    const run = (window, expression) => window.webContents.executeJavaScript(expression);
    const until = async (window, expression, label = expression) => {
      for (let i = 0; i < 300; i++) { try { if (await run(window, expression)) return; } catch { /* page still loading */ } await new Promise(r => setTimeout(r, 50)); }
      const context = await run(window, 'JSON.stringify({ tabs: document.getElementById("tabs")?.innerHTML.slice(0, 800), content: document.getElementById("content")?.innerHTML.slice(0, 400), status: document.getElementById("status")?.textContent })').catch(() => '');
      throw new Error(`Timed out: ${label} ${context}`);
    };
    const exec = (window, name, args = {}) => run(window, `window.weft.execute(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
    await until(main, 'document.getElementById("status")?.textContent === "Ready"', 'GUI ready');

    // ---- #99: the launch link opened in Everything; the javascript: link was refused.
    await until(main, `window.weft.execute("tabs.list", {}).then(tabs => tabs.some(t => t.workspaceId === ${JSON.stringify(EVERYTHING)} && t.url.endsWith("/from-launch")))`, 'launch link in Everything');
    await until(main, 'document.querySelector(".workspace-dot")?.classList.contains("everything")', 'Everything is first in the rail with its own mark');
    // A second launch with a link hands it to this session.
    const second = launch(['--second-launch', `${origin}/from-second`], { WEFT_TEST_PROFILE: process.env.WEFT_TEST_PROFILE, WEFT_PORT: '0' });
    await new Promise(resolve => second.once('exit', resolve));
    await until(main, `window.weft.execute("tabs.list", {}).then(tabs => tabs.some(t => t.workspaceId === ${JSON.stringify(EVERYTHING)} && t.url.endsWith("/from-second")))`, 'second-launch link in Everything');
    const activity = await exec(main, 'activity.list', { workspaceId: EVERYTHING });
    assert.ok(JSON.stringify(activity).includes('external'), 'externally supplied links are logged as such');
    // An agent token gains nothing from it: without naming Everything, its implicit target is the project workspace.
    await exec(main, 'workspaces.switch', { id: EVERYTHING });
    const response = await fetch(`http://127.0.0.1:${process.env.WEFT_PORT}/v1/execute`, { method: 'POST', headers: { authorization: `Bearer ${process.env.WEFT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ command: 'materials.list', args: {} }) });
    const outcome = await response.json();
    // Two project workspaces exist, so the agent must name one; Everything is never offered as an implicit target.
    assert.equal(outcome.error?.code, 'ambiguous_target', JSON.stringify(outcome));
    assert.deepEqual(outcome.error.details.workspaceIds.sort(), [home, trip.id].sort());

    // ---- #100: move the Trip workspace into its own window; its tab keeps running and moves back without reloading.
    await exec(main, 'workspaces.switch', { id: trip.id });
    await exec(main, 'tabs.new', { workspaceId: trip.id, url: `${origin}/trip` });
    await until(main, `window.weft.execute("tabs.list", {}).then(tabs => tabs.some(t => t.url.endsWith("/trip") && !t.loading))`, 'trip tab loaded');
    const tripTab = (await exec(main, 'tabs.list', {})).find(t => t.url.endsWith('/trip'));
    const tripContents = webContents.getAllWebContents().find(contents => contents.getURL().endsWith('/trip'));
    assert.ok(tripContents, JSON.stringify(webContents.getAllWebContents().map(contents => contents.getURL())));
    await tripContents.executeJavaScript('window.weftMarker = 42');
    await assert.rejects(run(main, `window.weft.windows({ action: "move", workspaceId: ${JSON.stringify(EVERYTHING)} })`), /main window/);
    await run(main, `window.weft.windows({ action: "move", workspaceId: ${JSON.stringify(trip.id)} })`);
    let tripWindow;
    for (let i = 0; i < 200 && !tripWindow; i++) { tripWindow = BrowserWindow.getAllWindows().find(window => window !== main && window.webContents.getURL().endsWith('gui.html') && !window.webContents.isLoading()); await new Promise(r => setTimeout(r, 25)); }
    assert.ok(tripWindow, 'a second window opened');
    await until(tripWindow, 'document.getElementById("status")?.textContent === "Ready"', 'second window GUI ready');
    await until(tripWindow, 'document.title.startsWith("Trip")', 'the window title names its workspace');
    await until(tripWindow, `window.weft.window().then(info => info.workspaceId === ${JSON.stringify(trip.id)} && !info.main)`, 'second window shows Trip');
    // The main window left Trip for another workspace and refuses to show it twice.
    assert.notEqual(await run(main, 'window.weft.window().then(info => info.workspaceId)'), trip.id);
    assert.equal((await run(main, `window.weft.executeOutcome("workspaces.switch", { id: ${JSON.stringify(trip.id)} })`)).error.code, 'invalid_arguments');
    // The page in the moved workspace kept its state: same renderer, no reload.
    await run(tripWindow, `document.querySelector('[data-action="activate-tab"][data-id="${tripTab.id}"]')?.click()`);
    await until(tripWindow, `document.querySelector(".pane-frame") !== null`, 'trip page shown in the second window');
    for (let i = 0; i < 100 && !tripWindow.contentView.children.length; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(tripWindow.contentView.children.length, 1, 'the tab view moved into the second window');
    assert.equal(tripWindow.contentView.children[0].webContents, tripContents, 'the same page renderer moved');
    assert.equal(await tripContents.executeJavaScript('window.weftMarker'), 42, 'the page was not reloaded');
    // Commands from the second window default to its own workspace and tab; agents see an informational window list.
    const tabsHere = await run(tripWindow, 'window.weft.execute("tabs.list", {})');
    assert.ok(tabsHere.every(t => t.workspaceId === trip.id) && tabsHere.some(t => t.id === tripTab.id && t.active && t.windowId === 2));
    const windowsList = await exec(main, 'windows.list');
    assert.deepEqual(windowsList.windows.map(w => [w.windowId, w.main]), [[1, true], [2, false]]);
    // Approvals and the emergency stop are reachable from the second window too.
    assert.ok(Array.isArray(await exec(tripWindow, 'approvals.list', {})));
    assert.equal(await run(tripWindow, 'Boolean(document.getElementById("safety-notices"))'), true);
    // Closing the second window returns Trip to the main window; the tab is still open.
    tripWindow.close();
    for (let i = 0; i < 100 && !tripWindow.isDestroyed(); i++) await new Promise(r => setTimeout(r, 25));
    await until(main, `window.weft.window().then(info => Object.keys(info.assignments).length === 0)`, 'Trip returned to the main window');
    const after = await exec(main, 'tabs.list', { workspaceId: trip.id });
    assert.ok(after.some(t => t.id === tripTab.id), JSON.stringify({ destroyed: tripContents.isDestroyed(), tripTab, after: after.map(t => [t.id, t.workspaceId, t.url]) }));
    await exec(main, 'workspaces.switch', { id: trip.id });

    // ---- #101: four live pages in a 2×2 grid; their views get the pane rectangles and are never suspended.
    for (const name of ['p2', 'p3', 'p4']) await exec(main, 'tabs.new', { workspaceId: trip.id, url: `${origin}/${name}` });
    await until(main, `window.weft.execute("tabs.list", {}).then(tabs => tabs.filter(t => t.workspaceId === ${JSON.stringify(trip.id)} && !t.loading && t.url.startsWith("http")).length >= 4)`, 'four pages loaded');
    for (const blank of (await exec(main, 'tabs.list', { workspaceId: trip.id })).filter(t => t.url === 'about:blank')) await exec(main, 'tabs.close', { tabId: blank.id });
    await exec(main, 'tabs.activate', { tabId: tripTab.id });
    await run(main, 'document.getElementById("page-more").click()');
    await until(main, 'document.querySelector(\'[data-action="pane-layout"]\') !== null');
    await run(main, 'document.querySelector(\'[data-action="pane-layout"]\').click()');
    await until(main, 'document.querySelector(\'select[name="layout"]\') !== null');
    const started = Date.now();
    await run(main, 'document.querySelector(\'select[name="layout"]\').value = "4-grid"; document.getElementById("edit-form").requestSubmit()');
    await until(main, 'document.querySelectorAll(".pane-header").length === 4', 'four pane headers');
    for (let i = 0; i < 200 && main.contentView.children.length < 4; i++) await new Promise(r => setTimeout(r, 25));
    const layoutMs = Date.now() - started;
    const views = main.contentView.children.map(view => view.getBounds());
    assert.equal(views.length, 4, `four native page views: ${JSON.stringify(views)} ${await run(main, '[...document.querySelectorAll(".pane-header")].map(h => h.textContent).join(" | ") + " :: " + [...document.querySelectorAll(".pane-doc")].map(d => d.textContent.slice(0, 80)).join(" | ")')}`);
    for (let a = 0; a < views.length; a++) for (let b = a + 1; b < views.length; b++) {
      const [p, q] = [views[a], views[b]];
      assert.ok(!(p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height), 'pane views do not overlap');
    }
    assert.equal(await run(main, 'document.querySelectorAll(".pane-header .state-badge").length'), 4, 'each pane shows its owner');
    assert.equal(await run(main, 'document.querySelectorAll(".pane-divider[role=separator]").length'), 2, 'two keyboard-resizable dividers');
    // A divider moves with the keyboard and the native views follow.
    const before = main.contentView.children[0].getBounds().width;
    await run(main, 'document.querySelector(".pane-divider.vertical").focus(); document.querySelector(".pane-divider.vertical").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }))');
    for (let i = 0; i < 100 && main.contentView.children[0].getBounds().width === before; i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(main.contentView.children.some(view => view.getBounds().width > before), 'resizing moved the views');
    // Visible panes are not suspended; the layout persists in the resume record.
    const visibleIds = (await exec(main, 'tabs.list', {})).filter(t => t.workspaceId === trip.id).map(t => t.id);
    for (const tabId of visibleIds) assert.equal((await exec(main, 'tabs.suspend', { tabId })).suspended, false);
    await until(main, `window.weft.execute("resume.get", { workspaceId: ${JSON.stringify(trip.id)} }).then(r => r.view.panes.layout === "4-grid")`, 'pane layout saved');
    const metrics = app.getAppMetrics().filter(metric => metric.type === 'Tab' && metric.pid !== main.webContents.getOSProcessId());
    const memoryMb = Math.round(metrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0) / 1024);
    console.log(`PANES_METRIC ${JSON.stringify({ livePanes: 4, layoutMs, pageRenderers: metrics.length, pageRendererMemoryMb: memoryMb })}`);
    // A small window collapses the grid with a notice instead of unusable panes.
    main.setSize(1000, 640);
    await until(main, 'document.querySelectorAll(".pane-header").length < 4', 'layout collapsed in a small window');
    console.log('WINDOWS_PANES_OK');
    fixture.close();
    app.quit();
  })().catch(error => { console.error(error); fixture?.close(); app.exit(1); });
} else {
  test('real Electron: Everything receives OS links, a workspace moves to its own window and back, four live panes', { timeout: budget(90000), skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires DISPLAY or xvfb-run' : false }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-windows-'));
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    writeFileSync(join(profile, '.keep'), '');
    const child = launch(['--windows-smoke'], { WEFT_TEST_PROFILE: profile, WEFT_PORT: String(port), WEFT_TOKEN: 'windows-fixture-token-0123456789abcdef' });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), budget(80000));
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output.slice(-6000));
      assert.match(output, /WINDOWS_PANES_OK/);
      const metric = /PANES_METRIC (.*)/.exec(output);
      if (metric) console.log(`# four live panes: ${metric[1]}`);
    } finally { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); }
  });
}
