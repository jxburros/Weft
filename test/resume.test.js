import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';
import { RESTORE_NOTICES } from '../src/resume.js';

const human = { actor: 'human', source: 'gui' };

function page(url, title) {
  return { id: Math.floor(Math.random() * 1e6), getURL: () => url, getTitle: () => title, isDestroyed: () => false, close() {}, stop() {}, executeJavaScript: async () => null };
}
/** Real dispatcher and store with scripted tabs in two workspaces. */
async function fixture(t, directory = mkdtempSync(join(tmpdir(), 'weft-resume-'))) {
  const workspace = new WorkspaceService({ directory });
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {} });
  // Scripted tabs only: switching workspaces does not open real pages here.
  browser.switchWorkspace = async () => null;
  workspace.attachBrowser(browser);
  const clients = new ClientGrants({ directory, masterToken: 'resume-master', workspace });
  const dispatch = createDispatcher({ workspace, browser, clients, admission, providers: { close() {} } });
  t.after(() => { browser.close(); workspace.close(); });
  return { directory, workspace, browser, dispatch, clients };
}
function addTab(browser, id, workspaceId, url, title, extra = {}) {
  browser.tabs.set(id, { id, workspaceId, version: 1, controller: 'available', url, title, view: { webContents: page(url, title) }, ...extra });
}

test('tab groups: create, rename, recolor, collapse, membership by workspace, delete keeps tabs, persisted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-resume-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await fixture(t, directory);
  const first = f.workspace.activeWorkspaceId;
  const second = (await f.dispatch('workspaces.create', { name: 'Other' }, human)).result.id;
  addTab(f.browser, 1, first, 'https://alpha.example/', 'Alpha research');
  addTab(f.browser, 2, first, 'https://beta.example/', 'Beta notes');
  addTab(f.browser, 3, second, 'https://gamma.example/', 'Gamma');
  const group = (await f.dispatch('tabGroups.create', { workspaceId: first, name: 'Research', color: 'sage', tabIds: [1] }, human)).result;
  assert.deepEqual([group.name, group.color, group.colorName, group.tabIds], ['Research', 'sage', 'Sage', [1]]);
  assert.equal((await f.dispatch('tabGroups.create', { workspaceId: first, name: 'Mixed', tabIds: [3] }, human)).error.code, 'target_mismatch');
  assert.equal((await f.dispatch('tabs.group', { tabId: 3, groupId: group.id }, human)).error.code, 'target_mismatch', 'groups never hold tabs from another workspace');
  assert.equal((await f.dispatch('tabs.group', { tabId: 2, groupId: group.id }, human)).result.groupId, group.id);
  const updated = (await f.dispatch('tabGroups.update', { id: group.id, changes: { name: 'Reading', color: 'sky', collapsed: true }, expectedRevision: 1 }, human)).result;
  assert.deepEqual([updated.name, updated.colorName, updated.collapsed, updated.revision], ['Reading', 'Sky', true, 2]);
  assert.equal((await f.dispatch('tabGroups.update', { id: group.id, changes: { name: 'x' }, expectedRevision: 1 }, human)).error.code, 'stale_state');
  // Search sees titles, URLs and group names, with text indicators for ownership and tasks.
  await f.dispatch('tasks.create', { workspaceId: first, title: 'Compare sources', tabIds: [2], status: 'running' }, human);
  f.browser.tabs.get(1).controller = 'client:agent';
  const found = (await f.dispatch('tabs.search', { workspaceId: first, query: 'reading' }, human)).result;
  assert.deepEqual(found.results.map(item => item.tabId), [1, 2]);
  assert.equal(found.results[0].control.label, 'Agent drives: client:agent');
  assert.deepEqual(found.results[1].tasks.map(task => task.title), ['Compare sources']);
  assert.deepEqual(found.results[1].group, { id: group.id, name: 'Reading', color: 'sky' });
  assert.equal((await f.dispatch('tabs.search', { workspaceId: first, query: 'gamma' }, human)).result.count, 0, 'other workspaces stay out unless asked');
  assert.equal((await f.dispatch('tabs.search', { workspaceId: first, query: 'gamma', allWorkspaces: true }, human)).result.results[0].workspaceName, 'Other');
  // The session row keeps memberships; the store keeps groups across a restart.
  assert.equal(f.workspace.data.browserSession.tabs.find(tab => tab.id === 2).groupId, group.id);
  f.browser.close(); f.workspace.close();
  const reopened = new WorkspaceService({ directory });
  try {
    assert.deepEqual(reopened.data.tabGroups.map(item => [item.name, item.color, item.collapsed]), [['Reading', 'sky', true]]);
    assert.ok(!JSON.stringify(reopened.exportWorkspace(first)).includes('Reading'), 'tab groups describe this profile and are not exported');
  } finally { reopened.close(); }
});

test('deleting a group ungroups its tabs; deleting a workspace removes its groups and resume record', async t => {
  const f = await fixture(t);
  const first = f.workspace.activeWorkspaceId;
  const second = (await f.dispatch('workspaces.create', { name: 'Doomed' }, human)).result.id;
  addTab(f.browser, 1, first, 'https://alpha.example/', 'Alpha');
  addTab(f.browser, 5, second, 'https://delta.example/', 'Delta');
  const group = (await f.dispatch('tabGroups.create', { workspaceId: first, name: 'Keep', tabIds: [1] }, human)).result;
  const removed = (await f.dispatch('tabGroups.delete', { id: group.id }, human)).result;
  assert.deepEqual(removed.ungroupedTabIds, [1]);
  assert.equal(f.browser.tabs.get(1).groupId, null);
  assert.ok(f.browser.tabs.has(1), 'tabs stay open');
  await f.dispatch('tabGroups.create', { workspaceId: second, name: 'Doomed group' }, human);
  await f.dispatch('resume.save', { workspaceId: second, section: 'tasks' }, human);
  await f.dispatch('workspaces.delete', { id: second }, human);
  assert.equal(f.workspace.data.tabGroups.length, 0);
  assert.equal(f.workspace.data.resumeStates.length, 0);
});

test('resume records restore section, split panes, panels and pinned resources with live continuation links and disclosures', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-resume-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await fixture(t, directory);
  const first = f.workspace.activeWorkspaceId;
  addTab(f.browser, 1, first, 'https://alpha.example/', 'Alpha');
  addTab(f.browser, 2, first, 'https://beta.example/', 'Beta');
  const note = (await f.dispatch('materials.create', { title: 'Key note', content: 'x' }, human)).result;
  const blocked = (await f.dispatch('tasks.create', { title: 'Waiting on login', status: 'waiting_on_human', blocker: 'Needs a person to sign in', nextStep: 'Retry export', tabIds: [2] }, human)).result;
  await f.dispatch('tasks.create', { title: 'Done already', status: 'completed' }, human);
  const conversation = (await f.dispatch('conversations.create', { title: 'Plan' }, human)).result;
  const handoff = (await f.dispatch('handoffs.create', { workspaceId: first, objective: 'Finish the comparison', nextStep: 'Read the second source', to: 'human' }, human));
  assert.equal(handoff.error, null, JSON.stringify(handoff.error));
  const saved = (await f.dispatch('resume.save', { workspaceId: first, section: 'tasks', activeTabId: 2, split: { tabId: 1, focusedPane: 'secondary' },
    panels: { agentPanelOpen: true, sidebarCollapsed: true, conversationId: conversation.id }, pinned: [{ type: 'material', id: note.id }, { type: 'tab', id: 1 }, { type: 'task', id: blocked.id }] }, human)).result;
  assert.deepEqual(saved.view, { section: 'tasks', activeTabId: 2, split: { tabId: 1, focusedPane: 'secondary' }, panels: { agentPanelOpen: true, sidebarCollapsed: true, conversationId: conversation.id },
    // An older split-view record reads as a two-pane layout (#101).
    panes: { layout: '2-columns', items: [{ type: 'tab', id: 2 }, { type: 'tab', id: 1 }], focused: 1, sizes: [0.5], migratedFromSplit: true } });
  assert.equal((await f.dispatch('resume.save', { workspaceId: first, pinned: [{ type: 'task', id: 'task_missing' }] }, human)).error.code, 'not_found');
  assert.equal((await f.dispatch('resume.save', { workspaceId: first, activeTabId: 99 }, human)).error.code, 'not_found');
  // A restart: the record persists; live links are recomputed from current records and tabs.
  f.browser.close(); f.workspace.close();
  const g = await fixture(t, directory);
  addTab(g.browser, 2, first, 'https://beta.example/', 'Beta');
  const resume = (await g.dispatch('resume.get', { workspaceId: first }, human)).result;
  assert.equal(resume.view.section, 'tasks');
  assert.equal(resume.view.activeTabId, 2);
  assert.deepEqual(resume.view.split, { tabId: null, focusedPane: 'primary' }, 'a split pane whose tab is gone closes instead of pointing nowhere');
  assert.equal(resume.missing.splitTab, true);
  assert.deepEqual(resume.pinned.map(item => [item.type, item.exists, item.link.command]), [['material', true, 'materials.get'], ['tab', false, 'tabs.activate'], ['task', true, 'tasks.get']]);
  assert.deepEqual(resume.continue.blockers.map(item => [item.title, item.blocker, item.nextStep, item.tabIds]), [['Waiting on login', 'Needs a person to sign in', 'Retry export', [2]]]);
  assert.ok(!resume.continue.tasks.some(item => item.title === 'Done already'));
  assert.equal(resume.continue.handoffs[0].objective, 'Finish the comparison');
  assert.deepEqual(resume.notices, RESTORE_NOTICES);
  assert.ok(resume.notices.some(notice => /sign in again/.test(notice)) && resume.notices.some(notice => /Unsent form input/.test(notice)));
  // Agents may read the resume record; scoped clients only for their workspace.
  const grant = g.clients.authenticate((await g.dispatch('clients.create', { name: 'Reader', scopes: ['read'], workspaceIds: [first] }, human)).result.token);
  assert.equal((await g.dispatch('resume.get', { workspaceId: first }, grant)).result.view.section, 'tasks');
  assert.equal((await g.dispatch('resume.save', { workspaceId: first, section: 'overview' }, grant)).error.code, 'permission_required');
  g.browser.close(); g.workspace.close();
});

test('pane layouts hold 1 to 4 tabs, captures and documents of one workspace and drop items that are gone (#101)', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-panes-'));
  const f = await fixture(t, directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = f.workspace.activeWorkspaceId;
  addTab(f.browser, 1, first, 'https://alpha.example/', 'Alpha');
  addTab(f.browser, 2, first, 'https://beta.example/', 'Beta');
  const note = (await f.dispatch('materials.create', { title: 'Notes', content: 'Side by side' }, human)).result;
  const task = (await f.dispatch('tasks.create', { title: 'Compare' }, human)).result;
  const other = (await f.dispatch('workspaces.create', { name: 'Other' }, human)).result;
  const elsewhere = (await f.dispatch('materials.create', { workspaceId: other.id, title: 'Elsewhere' }, human)).result;
  const panes = { layout: '4-grid', items: [{ type: 'tab', id: 1 }, { type: 'material', id: note.id }, { type: 'tab', id: 2 }, { type: 'task', id: task.id }], focused: 2, sizes: [0.4, 0.6] };
  const saved = (await f.dispatch('resume.save', { workspaceId: first, panes }, human)).result;
  assert.deepEqual(saved.view.panes, { ...panes, migratedFromSplit: false });
  // Records from another workspace, repeated items and too many panes are refused.
  assert.equal((await f.dispatch('resume.save', { workspaceId: first, panes: { layout: '2-columns', items: [{ type: 'material', id: elsewhere.id }] } }, human)).error.code, 'not_found');
  assert.equal((await f.dispatch('resume.save', { workspaceId: first, panes: { layout: '2-columns', items: [{ type: 'tab', id: 1 }, { type: 'tab', id: 1 }] } }, human)).error.code, 'invalid_arguments');
  assert.equal((await f.dispatch('resume.save', { workspaceId: first, panes: { layout: '2-rows', items: [{ type: 'tab', id: 1 }, null, { type: 'tab', id: 2 }] } }, human)).error.code, 'invalid_arguments');
  assert.equal((await f.dispatch('resume.save', { workspaceId: first, panes: { layout: '5-grid', items: [] } }, human)).error.code, 'invalid_arguments');
  // With tab 2 closed, its pane is empty and counted as missing; the rest of the layout stays.
  f.browser.tabs.delete(2);
  const resume = (await f.dispatch('resume.get', { workspaceId: first }, human)).result;
  assert.deepEqual(resume.view.panes.items, [{ type: 'tab', id: 1 }, { type: 'material', id: note.id }, null, { type: 'task', id: task.id }]);
  assert.equal(resume.view.panes.layout, '4-grid');
  assert.equal(resume.missing.panes, 1);
});
