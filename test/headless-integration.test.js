import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { DisplayController } from '../src/display.js';
import { createKeyProtector } from '../src/encryption.js';
import { fakeSafeStorage, kdfParams } from './encryption-helpers.js';

/**
 * Headless sessions, resume state and resource scheduling (ADR 015) merged with the credential
 * broker (ADR 017), archives (ADR 012), workflow recording (ADR 016) and encryption (ADR 014).
 */
const human = { actor: 'human', source: 'gui' };
function fixture(t, { encrypted = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-headless-integration-'));
  const workspace = new WorkspaceService({ directory, onWarning() {}, ...(encrypted && { keyProtector: createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' }), encryption: { kdf: kdfParams } }) });
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {}, protectedCooldownMs: 60000 });
  browser.switchWorkspace = async () => null;
  workspace.attachBrowser(browser);
  const window = { isDestroyed: () => false, isVisible: () => false, focus() {}, show() {}, hide() {} };
  const display = new DisplayController({ window, browser, launchedHeadless: true, userData: directory, environment: { supported: true },
    locked: () => (workspace.locked ? workspace.encryption?.lockReason ?? 'locked' : null) });
  const dispatch = createDispatcher({ workspace, browser, admission, display, providers: { close() {} } });
  t.after(() => { browser.close(); try { workspace.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, browser, dispatch, display };
}
function addTab(browser, id, workspaceId, extra = {}) {
  const contents = { id: 100 + id, getURL: () => 'https://shop.example/', getTitle: () => 'Shop', isDestroyed: () => false, isCurrentlyAudible: () => false, close() {}, stop() {}, executeJavaScript: async () => null };
  const tab = { id, workspaceId, version: 1, controller: 'available', url: 'https://shop.example/', title: 'Shop', view: { webContents: contents }, ...extra };
  browser.tabs.set(id, tab);
  return tab;
}

test('tabs are never suspended under a protected login, during a capture or recording, or while a runtime task uses them', async t => {
  const f = fixture(t);
  const workspaceId = f.workspace.activeWorkspaceId;
  addTab(f.browser, 1, workspaceId);
  f.browser.activeId = 1;
  const protectedTab = addTab(f.browser, 2, workspaceId);
  const token = Symbol('fill');
  f.browser.beginProtected(protectedTab, token, 'credential fill');
  assert.ok(f.browser.quickBlockers(protectedTab).includes('protected_operation'));
  f.browser.endProtected(protectedTab, token);
  assert.ok(f.browser.quickBlockers(protectedTab).includes('protected_operation'), 'the protection cooldown also blocks suspension');
  const capturing = addTab(f.browser, 3, workspaceId, { capturing: 1 });
  assert.ok(f.browser.quickBlockers(capturing).includes('capturing'), 'an archive or bundle capture in progress');
  const recording = addTab(f.browser, 4, workspaceId, { recording: true });
  assert.ok(f.browser.quickBlockers(recording).includes('recording'), 'a workflow recording');
  const planned = addTab(f.browser, 5, workspaceId);
  await f.workspace.execute('tasks.create', { workspaceId, title: 'Runtime task', plan: [{ kind: 'command', title: 'Read', command: 'page.readable', args: { tabId: 5 } }] }, human);
  f.workspace.data.tasks.at(-1).executor = { type: 'runner', autonomy: 'scoped' };
  assert.ok(f.browser.quickBlockers(planned).includes('active_task'), 'a runtime task step targets this tab');
  const idle = addTab(f.browser, 6, workspaceId);
  assert.deepEqual(f.browser.quickBlockers(idle), []);
  const result = await f.browser.suspendTab(protectedTab, 'requested');
  assert.equal(result.suspended, false);
});

test('a locked encrypted profile starts locked headless: display.status reports it while every other command answers locked', async t => {
  const f = fixture(t, { encrypted: true });
  await f.workspace.executeEncryption('encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'manual', passphrase: 'correct horse battery staple' }, human);
  await f.workspace.executeEncryption('encryption.lock', {}, human);
  const status = await f.dispatch('display.status', {}, { actor: 'automation' });
  assert.equal(status.error, null, JSON.stringify(status.error));
  assert.equal(status.result.locked.reason, 'locked');
  assert.match(status.result.humanAttention, /locked/);
  assert.equal((await f.dispatch('tabs.search', { query: 'shop' }, { actor: 'automation' })).error.code, 'locked');
  assert.equal((await f.dispatch('resume.get', {}, human)).error.code, 'locked');
  assert.equal((await f.dispatch('encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' }, { actor: 'automation' })).error.code, 'permission_required', 'unlocking stays human-only');
});

test('resume records and tab groups are sealed under encryption and listed as excluded from exports', async t => {
  const f = fixture(t, { encrypted: true });
  const workspaceId = f.workspace.activeWorkspaceId;
  addTab(f.browser, 1, workspaceId);
  await f.workspace.executeEncryption('encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' }, human);
  const group = await f.dispatch('tabGroups.create', { workspaceId, name: 'NEEDLE-GROUP-NAME', color: 'sage', tabIds: [1] }, human);
  assert.equal(group.error, null, JSON.stringify(group.error));
  const saved = await f.dispatch('resume.save', { workspaceId, section: 'tasks', activeTabId: 1 }, human);
  assert.equal(saved.error, null, JSON.stringify(saved.error));
  const files = readdirSync(f.directory).filter(name => name.startsWith('workspace.sqlite'));
  for (const name of files) assert.equal(readFileSync(join(f.directory, name)).includes('NEEDLE-GROUP-NAME'), false, name);
  const exported = await f.workspace.execute('workspaces.export', { id: workspaceId, acknowledgePlaintext: true }, human);
  assert.equal(JSON.stringify(exported).includes('NEEDLE-GROUP-NAME'), false);
  assert.ok(exported.excluded.some(item => /Tab groups and the last-view resume record/.test(item)));
});
