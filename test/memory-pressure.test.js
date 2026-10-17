import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { createMemoryPressureSource, classifyPressure, parsePsi } from '../src/memory-pressure.js';

/*
 * #30: the operating system's memory-pressure signal (injected here; real sources per platform are
 * documented in src/memory-pressure.js) combined with the renderer budget, and unsaved-input/media
 * checks across subframes, including frames that cannot be inspected.
 */
const human = { actor: 'human', source: 'gui' };
const GiB = 1024 ** 3;
const PSI = (some, full = 0) => `some avg10=${some.toFixed(2)} avg60=1.00 avg300=0.50 total=12345\nfull avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=100\n`;

test('pressure levels come from Linux PSI and available memory; each platform degrades honestly', async () => {
  assert.deepEqual(parsePsi(PSI(12.5, 3)).some, { avg10: 12.5, avg60: 1, avg300: 0.5 });
  assert.throws(() => parsePsi('garbage'), /pressure-stall/);
  assert.equal(classifyPressure({ psi: parsePsi(PSI(0.5)) }).level, 'normal');
  assert.equal(classifyPressure({ psi: parsePsi(PSI(15)) }).level, 'moderate');
  assert.equal(classifyPressure({ psi: parsePsi(PSI(45)) }).level, 'critical');
  assert.equal(classifyPressure({ psi: parsePsi(PSI(2, 12)) }).level, 'critical', 'full stalls are critical');
  assert.equal(classifyPressure({ availableBytes: 0.08 * GiB, totalBytes: GiB }).level, 'moderate');
  assert.equal(classifyPressure({ availableBytes: 0.04 * GiB, totalBytes: GiB }).level, 'critical');
  // macOS free pages understate what is available: only very low values count, and never as critical.
  assert.equal(classifyPressure({ availableBytes: 0.04 * GiB, totalBytes: GiB, availableIsFreePages: true }).level, 'normal');
  assert.equal(classifyPressure({ availableBytes: 0.01 * GiB, totalBytes: GiB, availableIsFreePages: true }).level, 'moderate');

  const linux = await createMemoryPressureSource({ platform: 'linux', readPsi: async () => PSI(42), freemem: () => 6 * GiB, totalmem: () => 16 * GiB })();
  assert.deepEqual([linux.level, linux.sources, linux.reasons], ['critical', ['linux_psi', 'os_available_memory'], ['psi']]);
  assert.equal(linux.psi.someAvg10, 42);
  let reads = 0;
  const noPsi = createMemoryPressureSource({ platform: 'linux', readPsi: async () => { reads++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, freemem: () => 0.5 * GiB, totalmem: () => 16 * GiB });
  assert.deepEqual([(await noPsi()).level, (await noPsi()).sources], ['critical', ['os_available_memory']]);
  assert.equal(reads, 1, 'a kernel without PSI is not probed again');
  const windows = await createMemoryPressureSource({ platform: 'win32', readPsi: async () => { throw new Error('never read'); }, freemem: () => 1.2 * GiB, totalmem: () => 16 * GiB })();
  assert.deepEqual([windows.level, windows.sources], ['moderate', ['os_available_memory']]);
  const mac = await createMemoryPressureSource({ platform: 'darwin', freemem: () => 0.3 * GiB, totalmem: () => 16 * GiB })();
  assert.deepEqual([mac.level, mac.sources], ['moderate', ['os_free_pages']]);
  const electronOnly = await createMemoryPressureSource({ platform: 'win32', freemem: () => { throw new Error('unavailable'); }, totalmem: () => 0, systemMemoryInfo: () => ({ total: 8 * 1024 * 1024, free: 4 * 1024 * 1024 }) })();
  assert.deepEqual([electronOnly.level, electronOnly.sources, electronOnly.totalMb], ['normal', ['electron_free_memory'], 8192]);
  const nothing = await createMemoryPressureSource({ platform: 'freebsd', freemem: () => { throw new Error('x'); }, totalmem: () => 0, systemMemoryInfo: null })();
  assert.deepEqual([nothing.available, nothing.level], [false, 'normal']);
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-memory-pressure-'));
  const workspace = new WorkspaceService({ directory, onWarning() {} });
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const browser = new Browser({ session, workspaceService: workspace, admission: new AutomationAdmission(), electronApi: {} });
  workspace.attachBrowser(browser);
  t.after(() => { browser.close(); workspace.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const clean = { media: false, unsavedInput: false, fullscreen: false };
  /** A tab whose top frame reports `top` and whose subframes are given as { state } or { fails } or { destroyed }. */
  const addTab = (id, { top = clean, frames = [], lastActiveAt = 1 } = {}) => {
    const main = { id: 'main' };
    const subframes = frames.map(frame => ({
      isDestroyed: () => Boolean(frame.destroyed),
      executeJavaScript: async () => { if (frame.fails) throw new Error('Frame refused script'); if (frame.hangs) return new Promise(() => {}); return frame.state; } }));
    main.framesInSubtree = [main, ...subframes];
    const webContents = { id: 100 + id, mainFrame: main, getURL: () => `https://site.example/${id}`, getTitle: () => `Tab ${id}`, getZoomFactor: () => 1, isDestroyed: () => false, close() {}, stop() {},
      executeJavaScript: async code => (/unsavedInput/.test(code) ? top : { scrollX: 0, scrollY: 0 }) };
    browser.tabs.set(id, { id, workspaceId: workspace.activeWorkspaceId, version: 1, controller: 'available', lastActiveAt, view: { webContents } });
  };
  return { workspace, browser, addTab, clean };
}

test('unsaved input and media are found in subframes; a frame that cannot be inspected keeps the tab loaded', async t => {
  const { browser, addTab, clean } = fixture(t);
  addTab(1, { frames: [{ state: clean }, { state: { ...clean, unsavedInput: true } }] });
  addTab(2, { frames: [{ state: { ...clean, media: true } }] });
  addTab(3, { frames: [{ state: clean }, { fails: true }] });
  addTab(4, { frames: [{ state: clean }, { destroyed: true, fails: true }] });
  addTab(5, { frames: Array.from({ length: 60 }, () => ({ state: clean })) });
  addTab(6, { frames: [{ state: 'not an object' }] });
  addTab(9);
  browser.activeId = 9;
  const blockers = async id => browser.suspensionBlockers(browser.tab(id));
  assert.deepEqual(await blockers(1), ['unsaved_input'], 'an edited field inside a (cross-origin) subframe blocks suspension');
  assert.deepEqual(await blockers(2), ['media']);
  assert.deepEqual(await blockers(3), ['frame_not_inspected'], 'possibly unsaved: never suspended');
  assert.deepEqual(await blockers(4), [], 'a frame that went away is not a blocker');
  assert.deepEqual(await blockers(5), ['frame_not_inspected'], 'more frames than Weft checks: not suspended');
  assert.deepEqual(await blockers(6), ['frame_not_inspected']);
  const results = await browser.suspendIdle({ now: Date.now() + 3600000 });
  assert.deepEqual(results.filter(item => item.suspended).map(item => item.tabId), [4]);
});

test('system memory pressure suspends a few idle background tabs, combined with the renderer budget', async t => {
  const { workspace, browser, addTab } = fixture(t);
  await workspace.execute('settings.update', { resources: { idleSuspendMinutes: 0 } }, human);
  const now = Date.now();
  for (const id of [1, 2, 3, 4, 5, 6]) addTab(id, { lastActiveAt: now - id * 10 * 60000 });
  addTab(7, { lastActiveAt: now - 10000 });
  addTab(8, { lastActiveAt: now - 3600000, top: { media: false, unsavedInput: true, fullscreen: false } });
  addTab(9, { lastActiveAt: now });
  browser.activeId = 9;
  // Moderate: at most two idle tabs (idle 5+ minutes), least recently used first; edited pages stay loaded.
  let level = 'moderate';
  const samples = [];
  browser.systemMemory = async () => { samples.push(level); return { available: true, level, reasons: ['psi'], sources: ['linux_psi'], psi: { someAvg10: 15, fullAvg10: 0 } }; };
  let results = await browser.suspendIdle({ now });
  let suspended = results.filter(item => item.suspended).map(item => item.tabId);
  assert.deepEqual(suspended, [6, 5], 'two least recently used idle tabs (the edited one is skipped)');
  assert.ok(results.find(item => item.tabId === 8).blockedBy.includes('unsaved_input'));
  assert.ok(results.every(item => item.trigger === 'system_memory_pressure'));
  assert.equal(browser.memoryStatus.system.level, 'moderate');
  // Critical: up to four tabs idle a minute or more, stopping as soon as pressure is relieved.
  let calls = 0;
  browser.systemMemory = async () => { calls++; return { available: true, level: calls >= 3 ? 'normal' : 'critical', reasons: ['available_memory'], sources: ['os_available_memory'] }; };
  results = await browser.suspendIdle({ now });
  suspended = results.filter(item => item.suspended).map(item => item.tabId);
  assert.deepEqual(suspended, [4, 3], 'stops once the system reports normal pressure again');
  assert.equal(browser.tab(7).suspended ?? null, null, 'a tab used seconds ago is not suspended');
  assert.equal(browser.memoryStatus.system.initialLevel, 'critical');
  // A disabled setting ignores the signal.
  browser.systemMemory = async () => ({ available: true, level: 'critical', reasons: ['psi'], sources: ['linux_psi'] });
  await workspace.execute('settings.update', { resources: { systemMemoryPressure: false } }, human);
  assert.deepEqual((await browser.suspendIdle({ now })).filter(item => item.suspended), []);
  // The renderer budget still applies on its own.
  await workspace.execute('settings.update', { resources: { memoryBudgetMb: 100 } }, human);
  browser.rendererMemoryMb = async () => 60 * [...browser.tabs.values()].filter(tab => !tab.suspended).length;
  results = await browser.suspendIdle({ now });
  assert.ok(results.some(item => item.suspended && item.trigger === 'memory_pressure'));
  assert.equal(browser.memoryStatus.budgetMb, 100);
});
