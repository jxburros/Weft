import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { WorkspaceService } from '../src/workspace.js';
import { DatabaseSync } from '../src/sqlite.js';
import { Browser } from '../src/browser.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';

const human = { actor: 'human', source: 'gui' };
function profile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-storage-integration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}
function open(t, directory) {
  const service = new WorkspaceService({ directory, onWarning() {} });
  t.after(() => service.close());
  return service;
}
const rows = (directory, collection) => {
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT doc FROM records WHERE collection = ? ORDER BY seq').all(collection).map(row => JSON.parse(row.doc)); } finally { db.close(); }
};

test('handoffs, takeovers and site-rule provenance persist as SQLite rows and roll back with their activity', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const task = await service.execute('tasks.create', { title: 'Compare suppliers' }, human);
  const handoff = await service.executeHandoff('handoffs.create', { to: 'any-agent', objective: 'Compare supplier lead times', completedActions: ['Opened both catalogs'],
    findings: ['Supplier B ships in 3 days'], evidence: [{ type: 'task', id: task.id, note: 'Tracking task' }], nextStep: 'Check warranty terms', taskId: task.id }, human);
  await service.recordTakeover({ workspaceId: service.activeWorkspaceId, reason: 'human_takeover', previousController: 'agent-1', interrupted: [], cancelledQueue: [], tab: { tabId: 7, url: 'https://example.test/a?token=x', title: 'Page', navigationVersion: 3 } });
  const rule = await service.execute('siteRules.create', { hostname: 'tracker.example', reason: 'Tracking', evidence: ['https://example.org/report'] }, human);
  await service.execute('siteRules.update', { id: rule.id, changes: { behavior: 'warn' } }, human);
  await service.execute('siteRules.review', { id: rule.id, reviewBy: '2027-01-01', note: 'Still relevant' }, human);
  const stored = rows(directory, 'handoffs');
  assert.deepEqual(stored.map(item => item.kind).sort(), ['handoff', 'takeover']);
  assert.equal(stored.find(item => item.kind === 'takeover').tabs[0].url, 'https://example.test/a', 'secret query parameters are not stored');
  const storedRule = rows(directory, 'siteRules')[0];
  assert.deepEqual(storedRule.revisions.map(item => item.summary), ['Created', 'Updated', 'Reviewed: Still relevant']);
  assert.equal(storedRule.reviewBy, '2027-01-01');

  // An external writer makes the next commit fail: the handoff change and its activity entry roll back together.
  const activityBefore = service.data.activity.length;
  const external = new DatabaseSync(join(directory, 'workspace.sqlite'));
  external.prepare("INSERT INTO state_meta(key, value) VALUES ('externalMarker', '1')").run();
  external.close();
  await assert.rejects(service.executeHandoff('handoffs.complete', { id: handoff.id, status: 'completed', note: 'done' }, human), /STORE_CONFLICT/);
  assert.equal(service.data.handoffs.find(item => item.id === handoff.id).status, 'open');
  assert.equal(service.data.activity.length, activityBefore);
  assert.equal(rows(directory, 'handoffs').find(item => item.id === handoff.id).status, 'open');
});

test('format 2 export/import carries handoff history and rule provenance; open handoffs become cancelled history', async t => {
  const service = open(t, profile(t));
  const task = await service.execute('tasks.create', { title: 'Draft summary' }, human);
  const handoff = await service.executeHandoff('handoffs.create', { to: 'any-agent', objective: 'Summarize the lead-time findings', findings: [`Linked to ${task.id}`],
    evidence: [{ type: 'task', id: task.id }, { type: 'url', id: 'https://example.org/source?session=abc' }], nextStep: 'Write the summary', taskId: task.id }, human);
  const rule = await service.execute('siteRules.create', { hostname: 'ads.example', reason: 'Ads' }, human);
  await service.execute('siteRules.review', { id: rule.id, note: 'Checked' }, human);
  service.commitChange(() => { service.data.storagePolicies = [{ id: 'storage_fixture', kind: 'site', workspaceId: service.activeWorkspaceId, hostname: 'a.example', mode: 'block' }]; });
  const exported = await service.execute('workspaces.export', { id: service.activeWorkspaceId }, human);
  assert.equal(exported.formatVersion, 2);
  assert.equal(exported.handoffs.length, 1);
  assert.deepEqual(exported.siteRules[0].revisions.map(item => item.summary), ['Created', 'Reviewed: Checked']);
  assert.ok(exported.excluded.some(item => /Site storage modes/.test(item)));
  assert.ok(exported.excluded.some(item => /Community list subscriptions/.test(item)));
  assert.equal(exported.excluded.some(item => /(handoffs|storagePolicies) \(/.test(item)), false, 'handoffs are exported; storage modes are a named exclusion');
  assert.equal(exported.storagePolicies, undefined);

  const imported = await service.execute('workspaces.import', { data: exported }, human);
  const report = imported.importReport;
  assert.equal(report.records.handoffs, 1);
  assert.ok(report.lossy.some(item => item.collection === 'handoffs' && item.field === 'status'));
  const [copy] = service.data.handoffs.filter(item => item.workspaceId === imported.id);
  const [newTask] = service.data.tasks.filter(item => item.workspaceId === imported.id);
  assert.notEqual(copy.id, handoff.id);
  assert.equal(copy.taskId, newTask.id, 'structured task link is remapped');
  assert.equal(copy.evidence[0].id, newTask.id, 'record evidence is remapped');
  assert.equal(copy.evidence[1].id, 'https://example.org/source');
  assert.equal(copy.findings[0], `Linked to ${newTask.id}`, 'free-form citations are rewritten');
  assert.deepEqual([copy.status, copy.importedStatus], ['cancelled', 'open'], 'an imported open handoff cannot steer tabs in the new profile');
  await assert.rejects(service.executeHandoff('handoffs.accept', { id: copy.id }, { actor: 'agent-2' }), /cancelled, not open/);
  const [newRule] = service.data.siteRules.filter(item => item.workspaceId === imported.id);
  assert.equal(newRule.enabled, false);
  assert.equal(newRule.createdBy, 'human');
  assert.deepEqual(newRule.revisions.map(item => item.summary), ['Created', 'Reviewed: Checked', 'Imported inactive for review']);
  assert.ok(newRule.lastReviewedAt);
});

test('handoff records are searchable in their own workspace only', async t => {
  const service = open(t, profile(t));
  await service.executeHandoff('handoffs.create', { to: 'human', objective: 'Reconcile the zeppelin invoice totals', nextStep: 'Ask accounting' }, human);
  const hits = await service.execute('search.query', { query: 'zeppelin' }, human);
  assert.equal(hits[0].type, 'handoffs');
  assert.match(hits[0].title, /^Handoff: Reconcile/);
  assert.equal(hits[0].citation.recordType, 'handoffs');
  const other = await service.execute('workspaces.create', { name: 'Other' }, human);
  assert.deepEqual(await service.execute('search.query', { query: 'zeppelin', workspaceId: other.id }, human), []);
});

test('restoring a backup appends to the activity hash chain and never rewinds authority state', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-storage-integration-'));
  const workspace = new WorkspaceService({ directory, onWarning() {} });
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {} });
  t.after(() => { browser.close(); workspace.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const clients = new ClientGrants({ directory, masterToken: 'integration-token', workspace });
  const dispatch = createDispatcher({ workspace, browser, clients, providers: { close() {} }, admission });
  const ok = async (name, args = {}, context = human) => { const outcome = await dispatch(name, args, context); assert.equal(outcome.error, null, `${name}: ${JSON.stringify(outcome.error)}`); return outcome.result; };
  await ok('materials.create', { title: 'Kept' });
  const backup = await ok('backups.create', { note: 'before' });
  await ok('materials.create', { title: 'After backup' });
  const grant = await ok('clients.create', { name: 'Agent', scopes: ['read'], workspaceIds: [workspace.activeWorkspaceId] });
  const before = (await ok('activity.list', { scope: 'all', limit: 200 })).items.length;
  const preview = await ok('backups.restore', { id: backup.id, dryRun: true });
  assert.equal(preview.applied, false);
  const restored = await ok('backups.restore', { id: backup.id });
  assert.ok(existsSync(join(directory, restored.preservedOriginal)));
  assert.deepEqual((await ok('materials.list')).map(item => item.title), ['Kept']);
  const after = (await ok('activity.list', { scope: 'all', limit: 200 })).items;
  assert.ok(after.length > before, 'the activity log was appended to, not replaced');
  const entry = after.find(item => item.command === 'backups.restore' && item.outcome === 'completed');
  assert.equal(entry.targetId, backup.id);
  assert.equal((await ok('activity.verify')).status, 'intact');
  // Grants created after the backup are not rolled back (and revoked ones are never revived).
  assert.ok((await ok('clients.list')).some(item => item.clientId === grant.clientId));
  assert.ok(JSON.parse(readFileSync(join(directory, 'client-grants.json'), 'utf8')).grants.length >= 1);
});
