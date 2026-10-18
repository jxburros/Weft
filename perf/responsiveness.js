/**
 * Real Electron responsiveness benchmark (#30). Seeds a large profile, launches the shipped main
 * process under the current display, then measures with concurrent scoped agents working over the
 * authenticated API:
 *   - GUI first render (process start to an interactive, populated overview),
 *   - agent navigation latency (page.navigate until the load completes),
 *   - human input latency (native click to the page's handler) and scroll latency (wheel to scroll event),
 *   - total memory and average CPU from Chromium process metrics.
 * Run `xvfb-run -a node perf/responsiveness.js` for the reference numbers in perf/README.md.
 * test/responsiveness.test.js runs a smaller fixture with generous CI budgets.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { electronEnv } from '../scripts/electron-env.js';

const harness = process.argv.includes('--responsiveness-harness');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]) : null; };
const summary = values => ({ samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.round(Math.max(...values)) : null });

/** Seed a workspace store with many records (outside the timed path). */
export async function seedProfile(profile, { records = 5000, workspaces = 3 } = {}) {
  const { WorkspaceService } = await import('../src/workspace.js');
  const service = new WorkspaceService({ directory: join(profile, 'workspace-data') });
  try {
    const first = service.activeWorkspaceId;
    const ids = [first];
    for (let i = 1; i < workspaces; i++) ids.push((await service.execute('workspaces.create', { name: `Project ${i + 1}` })).id);
    await service.execute('workspaces.switch', { id: first });
    const now = new Date().toISOString();
    service.data.materials = Array.from({ length: records }, (_, i) => ({ id: `mate_perf-${i}`, workspaceId: ids[i % ids.length], title: `Reference ${i}`, content: `Benchmark note ${i} `.repeat(20), kind: i % 5 ? 'note' : 'website',
      url: i % 5 ? null : `https://example.com/${i}`, tags: [], localOnly: false, pinned: i % 50 === 0, createdAt: now, updatedAt: now, revision: 1, history: [] }));
    service.data.tasks = Array.from({ length: Math.round(records / 10) }, (_, i) => ({ id: `task_perf-${i}`, workspaceId: ids[i % ids.length], title: `Task ${i}`, objective: 'Benchmark', status: i % 3 ? 'queued' : 'running', assignee: 'agent', progress: 0,
      blocker: i % 7 ? '' : 'Waiting', checkpoint: '', nextStep: '', evidence: [], materialIds: [], tabIds: [], outputs: [], createdAt: now, updatedAt: now, revision: 1 }));
    service.save();
    return ids;
  } finally { service.close(); }
}

/** Launch Weft on a seeded profile and run the measured workload. */
export async function runResponsiveness({ records = 5000, workspaces = 3, agents = 4, rounds = 8, probes = 20, timeoutMs = 240000 } = {}) {
  const electron = (await import('electron')).default;
  const profile = mkdtempSync(join(tmpdir(), 'weft-responsiveness-'));
  try {
    await seedProfile(profile, { records, workspaces });
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), '--responsiveness-harness'], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile, WEFT_PORT: String(port), WEFT_TOKEN: 'responsiveness-token',
        WEFT_BENCH: JSON.stringify({ agents, rounds, probes }) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const code = await new Promise(resolve => child.on('exit', resolve));
    clearTimeout(timer);
    const line = output.split('\n').find(item => item.startsWith('PERF_RESULT '));
    if (code !== 0 || !line) throw new Error(`Responsiveness run failed (exit ${code}):\n${output.slice(-4000)}`);
    return { fixture: { records, tasks: Math.round(records / 10), workspaces, agents, rounds, probes }, ...JSON.parse(line.slice('PERF_RESULT '.length)) };
  } finally { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); }
}

if (harness) {
  // Electron emits "ready" only after the entry module finishes evaluating: no top-level await here.
  void (async () => {
  const startedAt = performance.now() - process.uptime() * 1000;
  const { app, BrowserWindow } = (await import('electron')).default;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  const { agents, rounds, probes } = JSON.parse(process.env.WEFT_BENCH);
  const fixture = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Bench ${request.url.slice(0, 40)}</title><body style="height:8000px"><main><h1>Benchmark page</h1>${'<p>Paragraph of benchmark text.</p>'.repeat(200)}<button id="probe" style="position:fixed;top:40px;left:40px;width:200px;height:80px">Probe</button></main>
<script>let clicks=0,scrolls=0;document.getElementById('probe').addEventListener('mousedown',()=>{document.title='clicked-'+(++clicks)});addEventListener('scroll',()=>{document.title='scrolled-'+(++scrolls)},{passive:true});</script></body>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  await import(pathToFileURL(fileURLToPath(new URL('../src/main.js', import.meta.url))).href);
  try {
    await app.whenReady();
    let window;
    const until = async (check, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('benchmark wait timed out'); };
    await until(async () => (window = BrowserWindow.getAllWindows()[0]) && !window.webContents.isLoading()
      && await window.webContents.executeJavaScript('document.getElementById("status")?.textContent === "Ready" && document.getElementById("content").textContent.includes("Materials & references") && document.querySelectorAll(".compact-record").length > 0'));
    const guiReadyMs = Math.round(performance.now() - startedAt);
    const gui = js => window.webContents.executeJavaScript(js);
    const api = async (command, args, token) => {
      const response = await fetch(`http://127.0.0.1:${process.env.WEFT_PORT}/v1/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) });
      const outcome = await response.json();
      if (outcome.error) throw new Error(`${command}: ${outcome.error.code} ${outcome.error.message}`);
      return outcome.result;
    };
    // Concurrent agents: separate scoped, autonomous grants created by the person.
    const workspaceIds = (await gui('window.weft.execute("workspaces.list")')).map(item => item.id);
    const tokens = [];
    for (let i = 0; i < agents; i++) tokens.push((await gui(`window.weft.execute("clients.create", { name: "Bench agent ${i}", scopes: ["read", "records.write", "tabs.control"], workspaceIds: ${JSON.stringify(workspaceIds)}, crossWorkspace: true, autonomy: "autonomous" })`)).token);
    // The person browses an active tab while the agents work in their own tabs.
    await gui(`document.getElementById("address").value = ${JSON.stringify(`${origin}/human`)}; document.getElementById("navigation").requestSubmit()`);
    await until(async () => window.contentView.children.some(view => view.webContents?.getURL().startsWith(`${origin}/human`)));
    const page = window.contentView.children.find(view => view.webContents?.getURL().startsWith(`${origin}/human`)).webContents;
    // Start mid-page so every ±120 px wheel probe can scroll: a wheel at the top edge fires no scroll event.
    await page.executeJavaScript('scrollTo(0, 4000); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const navigation = [];
    const agentWork = tokens.map(async (token, index) => {
      // Agents work in the other workspaces: opening a tab in the person's active workspace would switch the visible tab.
      const others = workspaceIds.slice(1).length ? workspaceIds.slice(1) : workspaceIds;
      const workspaceId = others[index % others.length];
      const tab = await api('tabs.new', { url: `${origin}/agent-${index}`, workspaceId }, token);
      await api('tabs.claim', { tabId: tab.id, workspaceId, expectedVersion: (await api('page.inspect', { tabId: tab.id, workspaceId }, token)).version }, token);
      for (let round = 0; round < rounds; round++) {
        const { version } = await api('page.inspect', { tabId: tab.id, workspaceId }, token);
        const start = performance.now();
        await api('page.navigate', { tabId: tab.id, workspaceId, expectedVersion: version, url: `${origin}/agent-${index}/${round}` }, token);
        navigation.push(performance.now() - start);
        await api('page.snapshot', { tabId: tab.id, workspaceId, maxNodes: 200 }, token);
        await api('materials.create', { workspaceId, title: `Finding ${index}-${round}`, content: 'Benchmark finding' }, token);
      }
    });
    const titled = prefix => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { page.off('page-title-updated', listener); reject(new Error(`page never reported ${prefix}`)); }, 10000);
      const listener = (_event, title) => { if (title.startsWith(prefix)) { clearTimeout(timer); page.off('page-title-updated', listener); resolve(); } };
      page.on('page-title-updated', listener);
    });
    window.focus();
    page.focus();
    const input = [], scroll = [];
    const probeWork = (async () => {
      for (let i = 1; i <= probes; i++) {
        let start = performance.now();
        let seen = titled(`clicked-${i}`);
        page.sendInputEvent({ type: 'mouseDown', x: 100, y: 70, button: 'left', clickCount: 1 });
        page.sendInputEvent({ type: 'mouseUp', x: 100, y: 70, button: 'left', clickCount: 1 });
        await seen;
        input.push(performance.now() - start);
        start = performance.now();
        seen = titled(`scrolled-`);
        page.sendInputEvent({ type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: i % 2 ? -120 : 120 });
        await seen;
        scroll.push(performance.now() - start);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })();
    app.getAppMetrics(); // Chromium reports CPU since the previous call: start the interval here.
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    await Promise.all([...agentWork, probeWork]);
    const wall = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    const metrics = app.getAppMetrics();
    const result = { guiReadyMs, navigationMs: summary(navigation), inputMs: summary(input), scrollMs: summary(scroll),
      memoryMb: Math.round(metrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0) / 1024), processes: metrics.length,
      mainProcessCpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / wall) * 100), chromiumCpuPercent: Math.round(metrics.reduce((sum, metric) => sum + (metric.cpu?.percentCPUUsage ?? 0), 0)),
      workloadMs: Math.round(wall) };
    console.log(`PERF_RESULT ${JSON.stringify(result)}`);
    fixture.close();
    app.quit();
  } catch (error) {
    console.error(error);
    fixture.close();
    app.exit(1);
  }
  })();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = Number(process.env.WEFT_BENCH_RECORDS || 5000);
  const result = await runResponsiveness({ records, agents: Number(process.env.WEFT_BENCH_AGENTS || 4), rounds: Number(process.env.WEFT_BENCH_ROUNDS || 8) });
  console.log(JSON.stringify(result, null, 2));
}
