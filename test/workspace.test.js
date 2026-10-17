import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-workspace-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, service: new WorkspaceService({ directory }) };
}

test('empty workspace persists notes, revisions, conversations and theme across restart', async t => {
  const { directory, service } = fixture(t);
  assert.equal(service.snapshot().workspaces[0].name, 'My workspace');
  assert.deepEqual(service.snapshot().materials, []);
  const note = await service.execute('materials.create', { title: 'Release notes', content: 'First version' });
  await service.execute('materials.update', { id: note.id, expectedRevision: 1, changes: { content: 'Second version' } });
  const conversation = await service.execute('conversations.create', {});
  await service.appendMessage(conversation.id, { role: 'user', content: 'Read the notes' });
  await service.execute('settings.update', { theme: 'dark' });
  const reopened = new WorkspaceService({ directory });
  const saved = await reopened.execute('materials.get', { id: note.id });
  assert.equal(saved.content, 'Second version');
  assert.equal(saved.history.length, 2);
  assert.equal(reopened.getConversation(conversation.id).messages[0].content, 'Read the notes');
  assert.equal(reopened.snapshot().settings.theme, 'dark');
  assert.deepEqual(readdirSync(directory), ['workspace-state.json']);
});

test('stale updates fail without changing durable state', async t => {
  const { service, directory } = fixture(t);
  const task = await service.execute('tasks.create', { title: 'Check references' });
  await service.execute('tasks.update', { id: task.id, expectedRevision: 1, changes: { objective: 'Inspect primary sources' } });
  await assert.rejects(service.execute('tasks.update', { id: task.id, expectedRevision: 1, changes: { title: 'Overwrite' } }), /STALE_STATE/);
  assert.equal(new WorkspaceService({ directory }).snapshot().tasks[0].title, 'Check references');
  assert.equal(service.snapshot().tasks[0].status, 'queued');
  await service.execute('tasks.transition', { id: task.id, status: 'paused', cause: 'Need source access' });
  assert.match(service.snapshot().activity.at(-1).detail, /Need source access/);
});

test('archive preserves records and deleting the last workspace leaves a usable empty workspace', async t => {
  const { service } = fixture(t);
  const original = service.activeWorkspaceId;
  await service.execute('materials.create', { title: 'Keep this' });
  await service.execute('workspaces.archive', { id: original });
  assert.notEqual(service.activeWorkspaceId, original);
  assert.equal(service.snapshot().materials.length, 1);
  await service.execute('workspaces.restore', { id: original });
  await service.execute('workspaces.switch', { id: original });
  for (const workspace of service.snapshot().workspaces) await service.execute('workspaces.delete', { id: workspace.id });
  assert.equal(service.snapshot().workspaces.length, 1);
  assert.equal(service.snapshot().workspaces[0].id, service.activeWorkspaceId);
});

test('site rules use hostname boundaries, paths and workspace scope', async t => {
  const { service } = fixture(t);
  await service.execute('siteRules.create', { hostname: 'EXAMPLE.COM', path: '/private' });
  assert.ok(service.matchSiteRule('https://sub.example.com/private/item'));
  assert.equal(service.matchSiteRule('https://badexample.com/private'), null);
  assert.equal(service.matchSiteRule('https://example.com/privateish'), null);
  assert.equal(service.matchSiteRule('https://example.com/public'), null);
  assert.equal(service.matchSiteRule('https://example.com/private', 'another_workspace'), null);
  await assert.rejects(service.execute('siteRules.create', { hostname: 'example.com@evil.test' }), /hostname/);
  await assert.rejects(service.execute('siteRules.create', { hostname: 'example.org' }, { actor: 'agent' }), /PERMISSION_REQUIRED/);
});

test('agents cannot promote findings or modify confirmed facts, and scoped clients cannot read other workspaces', async t => {
  const { service } = fixture(t);
  const id = service.activeWorkspaceId;
  const fact = await service.execute('context.create', { title: 'Approved fact', category: 'confirmed', content: 'Human approved' });
  await assert.rejects(service.execute('context.update', { id: fact.id, changes: { content: 'Web instruction' } }, { actor: 'agent' }), /PERMISSION_REQUIRED/);
  await assert.rejects(service.execute('context.create', { title: 'Injected', category: 'instructions' }, { actor: 'agent' }), /PERMISSION_REQUIRED/);
  await service.execute('context.create', { title: 'Observed', category: 'findings' }, { actor: 'agent', workspaceId: id });
  const second = await service.execute('workspaces.create', { name: 'Other project' });
  await assert.rejects(service.execute('context.get', { id: fact.id }, { actor: 'agent', workspaceId: second.id }), /PERMISSION_REQUIRED/);
  await assert.rejects(service.execute('workspaces.update', { id, changes: { name: 'Cross-scope' } }, { actor: 'agent', workspaceId: second.id }), /PERMISSION_REQUIRED/);
  const scoped = await service.execute('workspace.snapshot', {}, { actor: 'agent', workspaceId: second.id });
  assert.equal(scoped.workspaces.length, 1);
  assert.equal(scoped.context.length, 0);
});

test('artifacts retain immutable offline versions and hashes without active HTML rendering', async t => {
  const { service, directory } = fixture(t);
  const first = await service.execute('artifacts.create', { title: 'Source', text: '<script>untrusted()</script> First', url: 'https://example.com/reference?token=secret&q=research#session' });
  const versionId = first.versions[0].id;
  await service.execute('artifacts.create', { artifactId: first.id, title: 'Source', text: 'Second' });
  await service.execute('artifacts.annotate', { id: first.id, note: 'Reviewed' });
  const exact = await new WorkspaceService({ directory }).execute('artifacts.get', { id: first.id, versionId });
  assert.equal(exact.text, '<script>untrusted()</script> First');
  assert.equal(exact.url, 'https://example.com/reference?q=research');
  assert.equal(exact.components[0].sha256.length, 64);
  assert.equal(service.snapshot().artifacts[0].versions[0].text, undefined);
  await assert.rejects(service.execute('artifacts.create', { title: 'Invalid', pngBase64: Buffer.from('<svg onload="bad()"/>').toString('base64') }), /PNG/);
  assert.equal(service.snapshot().artifacts.length, 1);
});

test('export/import excludes sessions, secrets and global policy; rekeys related records and validates files', async t => {
  const { service } = fixture(t);
  const sourceId = service.activeWorkspaceId;
  const material = await service.execute('materials.create', { title: 'Document', kind: 'file', filename: '../../outside.txt', fileBase64: Buffer.from('safe').toString('base64') });
  assert.equal(material.filename, 'outside.txt');
  await service.execute('tasks.create', { title: 'Read document', materialIds: [material.id] });
  await service.execute('siteRules.create', { hostname: 'global.test', scope: 'global' });
  service.persistSession({ tabs: [{ id: 1, workspaceId: sourceId, url: 'https://example.com/?access_token=secret' }], activeId: 1 });
  const exported = await service.execute('workspaces.export', { id: sourceId });
  assert.equal(exported.browserSession, undefined);
  assert.deepEqual(exported.siteRules, []);
  exported.apiKey = 'never import this';
  exported.materials[0].password = 'never import this';
  const imported = await service.execute('workspaces.import', { data: exported });
  const importedMaterial = service.snapshot().materials.find(item => item.workspaceId === imported.id);
  const importedTask = service.snapshot().tasks.find(item => item.workspaceId === imported.id);
  assert.notEqual(importedMaterial.id, material.id);
  assert.deepEqual(importedTask.materialIds, [importedMaterial.id]);
  assert.equal(JSON.stringify(service.snapshot()).includes('never import this'), false);
  assert.equal(service.snapshot().browserSession.tabs[0].url, 'https://example.com/');
  const count = service.snapshot().workspaces.length;
  exported.materials[0].url = 'javascript:alert(1)';
  await assert.rejects(service.execute('workspaces.import', { data: exported }));
  assert.equal(service.snapshot().workspaces.length, count);
});

test('corrupt and unsupported storage fails explicitly without replacing the original file', t => {
  const { directory } = fixture(t);
  const path = join(directory, 'workspace-state.json');
  writeFileSync(path, '{broken');
  assert.throws(() => new WorkspaceService({ directory }), /unreadable/);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  writeFileSync(path, '{"schemaVersion":99}');
  assert.throws(() => new WorkspaceService({ directory }), /Unsupported/);
  assert.equal(readFileSync(path, 'utf8'), '{"schemaVersion":99}');
});

test('imported policies and workflows remain inactive until a human reviews them', async t => {
  const { service } = fixture(t);
  const original = service.activeWorkspaceId;
  await service.execute('siteRules.create', { hostname: 'example.com' });
  await service.execute('workflows.create', { title: 'Checklist', steps: [{ title: 'Review', instruction: 'Read first' }] });
  const exported = await service.execute('workspaces.export', { id: original });
  const imported = await service.execute('workspaces.import', { data: exported });
  const rule = service.snapshot().siteRules.find(item => item.workspaceId === imported.id);
  const workflow = service.snapshot().workflows.find(item => item.workspaceId === imported.id);
  assert.equal(rule.enabled, false);
  assert.equal(workflow.enabled, false);
  assert.equal(service.matchSiteRule('https://example.com'), null);
  await assert.rejects(service.execute('workflows.update', { id: workflow.id, changes: { enabled: true } }, { actor: 'automation' }), /human review/);
  await service.execute('siteRules.update', { id: rule.id, changes: { enabled: true } });
  assert.ok(service.matchSiteRule('https://example.com'));
});

test('overlapping rules prioritize connection blocking and ignore disabled rules', async t => {
  const { service } = fixture(t);
  await service.execute('siteRules.create', { hostname: 'example.com', mode: 'navigation' });
  const connection = await service.execute('siteRules.create', { hostname: 'example.com', mode: 'connection' });
  assert.equal(service.matchSiteRule('https://example.com').mode, 'connection');
  await service.execute('siteRules.update', { id: connection.id, changes: { enabled: false } });
  assert.equal(service.matchSiteRule('https://example.com').mode, 'navigation');
});

test('PNG payloads are canonicalized before storage and import to prevent markup injection', async t => {
  const { service } = fixture(t);
  const png = Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
  const malicious = png + '" onerror="alert(1)';
  const artifact = await service.execute('artifacts.create', { title: 'Image', pngBase64: malicious });
  const full = await service.execute('artifacts.get', { id: artifact.id });
  assert.equal(full.versions[0].pngBase64, png);
  const exported = await service.execute('workspaces.export', { id: service.activeWorkspaceId });
  exported.artifacts[0].versions[0].pngBase64 = malicious;
  const imported = await service.execute('workspaces.import', { data: exported });
  const importedRecord = service.snapshot().artifacts.find(item => item.workspaceId === imported.id);
  assert.equal((await service.execute('artifacts.get', { id: importedRecord.id })).versions[0].pngBase64, png);
});
