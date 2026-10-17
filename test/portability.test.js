import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { commands } from '../src/commands.js';

const PNG = body => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(body)]).toString('base64');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-portability-'));
  const service = new WorkspaceService({ directory, onWarning() {} });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, service };
}
// A project exercising every relationship the export format claims to preserve.
async function project(service) {
  const material = await service.execute('materials.create', { title: 'Paper', content: 'draft', kind: 'file', filename: 'paper.txt', mimeType: 'text/plain', fileBase64: Buffer.from('file body').toString('base64') });
  await service.execute('materials.update', { id: material.id, changes: { content: 'second draft' } });
  const capture = await service.execute('artifacts.create', { title: 'Source', text: 'first capture', pngBase64: PNG('one'), url: 'https://example.com/source?token=hidden' });
  const second = await service.execute('artifacts.create', { artifactId: capture.id, title: 'Source', text: 'second capture' });
  await service.execute('artifacts.annotate', { id: capture.id, note: 'Checked', tags: ['verified'] });
  const context = await service.execute('context.create', { title: 'Finding', content: `Supported by ${capture.id} version ${second.versions[1].id}; see ${material.id}.`, sources: ['https://example.com/source', material.id] });
  const task = await service.execute('tasks.create', { title: 'Write summary', evidence: [capture.id, context.id], materialIds: [material.id], outputs: [context.id], checkpoint: `Cite ${capture.id}` });
  await service.execute('tasks.transition', { id: task.id, status: 'running', cause: 'started' });
  const conversation = await service.execute('conversations.create', { title: 'Discussion' });
  await service.appendMessage(conversation.id, { role: 'user', content: `Summarize ${context.id}`, attachments: [context.id], localOnly: true });
  await service.recordTurnManifest(conversation.id, { id: 'turn1', status: 'complete', sources: [context.id] });
  const workflow = await service.execute('workflows.create', { title: 'Review', materialIds: [material.id], steps: [{ title: 'Read', instruction: `Read ${material.id}` }] });
  await service.execute('siteRules.create', { hostname: 'blocked.example' });
  await service.execute('materials.create', { title: 'Live site', kind: 'website', url: 'https://example.org/page' });
  return { material, capture, second, context, task, conversation, workflow };
}

test('format 2 round-trips revisions, conversations, links, exact versions and citations', async t => {
  const { service } = fixture(t);
  const source = await project(service);
  const sourceId = service.activeWorkspaceId;
  const exported = await service.execute('workspaces.export', { id: sourceId });
  assert.equal(exported.formatVersion, 2);
  assert.equal(exported.artifacts[0].versions[0].url, 'https://example.com/source');
  const imported = await service.execute('workspaces.import', { data: exported });
  const report = imported.importReport;
  const scoped = async name => service.execute(`${name}.list`, { workspaceId: imported.id });
  const [material] = (await scoped('materials')).filter(item => item.title === 'Paper');
  const fullMaterial = await service.execute('materials.get', { id: material.id });
  assert.equal(fullMaterial.revision, 2);
  assert.deepEqual(fullMaterial.history.map(entry => entry.content), ['draft', 'second draft']);
  assert.equal(Buffer.from(fullMaterial.fileBase64, 'base64').toString(), 'file body');
  const [artifact] = await scoped('artifacts');
  const original = await service.execute('artifacts.get', { id: source.capture.id });
  const copy = await service.execute('artifacts.get', { id: artifact.id });
  assert.deepEqual(copy.versions.map(version => version.components), original.versions.map(version => version.components));
  assert.deepEqual(copy.versions.map(version => [version.number, version.text, version.pngBase64 ?? null]), original.versions.map(version => [version.number, version.text, version.pngBase64 ?? null]));
  assert.equal(copy.versions[1].previousVersionId, copy.versions[0].id);
  assert.notEqual(copy.versions[0].id, original.versions[0].id);
  assert.deepEqual(copy.annotations.map(item => item.note), ['Checked']);
  const [context] = await scoped('context');
  assert.equal(context.content, `Supported by ${artifact.id} version ${copy.versions[1].id}; see ${material.id}.`);
  assert.deepEqual(context.sources, ['https://example.com/source', material.id]);
  const [task] = await scoped('tasks');
  assert.deepEqual([task.evidence, task.materialIds, task.outputs, task.status, task.revision], [[artifact.id, context.id], [material.id], [context.id], 'running', 2]);
  assert.equal(task.checkpoint, `Cite ${artifact.id}`);
  const [conversation] = await scoped('conversations');
  assert.deepEqual(conversation.messages[0].attachments, [context.id]);
  assert.equal(conversation.messages[0].localOnly, true);
  assert.deepEqual(conversation.turnManifests, [{ id: 'turn1', status: 'complete', sources: [context.id] }]);
  const [workflow] = await scoped('workflows');
  assert.equal(workflow.steps[0].instruction, `Read ${material.id}`);
  // The report states what changed and what was not carried over.
  assert.equal(report.artifactVersions, 2);
  assert.ok(report.remapped.freeFormCitations >= 6);
  assert.deepEqual(report.policies.siteRules.map(rule => [rule.hostname, rule.enabled]), [['blocked.example', false]]);
  assert.ok(report.lossy.some(item => item.collection === 'siteRules' && /disabled/.test(item.reason)));
  assert.ok(report.lossy.some(item => item.collection === 'workflows' && /disabled/.test(item.reason)));
  assert.ok(report.linkedSourcesNotIncluded.items.some(item => item.url === 'https://example.org/page'));
  assert.ok(report.excluded.some(item => /cookies/.test(item)));
  // Search over the imported copy cites the new identities.
  const [hit] = await service.execute('search.query', { query: 'second capture', workspaceId: imported.id });
  assert.equal(hit.citation.versionId, copy.versions[1].id);
});

test('import preview reports policies, workflows, linked sources and lossy mappings without committing', async t => {
  const { service } = fixture(t);
  await project(service);
  const exported = await service.execute('workspaces.export', { id: service.activeWorkspaceId });
  exported.tasks[0].legacyPriority = 'high';
  exported.context[0].content += ' and ctx_00000000-0000-4000-8000-00000000dead';
  const before = service.storage.contentDigest();
  const preview = await service.execute('workspaces.import', { data: exported, dryRun: true });
  assert.equal(preview.applied, false);
  assert.equal(service.storage.contentDigest(), before);
  const report = preview.result.importReport;
  assert.deepEqual(report.policies.workflows.map(item => [item.title, item.enabled, item.steps]), [['Review', false, 1]]);
  assert.ok(report.lossy.some(item => item.collection === 'tasks' && item.field === 'legacyPriority'));
  assert.ok(report.lossy.some(item => item.field === 'free-form citations' && item.count === 1));
  assert.ok(preview.changes.created.count > 5);
  assert.equal(commands['workspaces.import'].humanOnly, true);
});

test('corrupted components, unresolved links, secrets and newer formats are rejected atomically', async t => {
  const { service } = fixture(t);
  await project(service);
  const valid = await service.execute('workspaces.export', { id: service.activeWorkspaceId });
  const before = service.storage.contentDigest();
  const corrupt = structuredClone(valid);
  corrupt.artifacts[0].versions[0].text = 'altered capture';
  await assert.rejects(service.execute('workspaces.import', { data: corrupt }), /COMPONENT_INTEGRITY/);
  const badFile = structuredClone(valid);
  badFile.materials[0].fileBase64 = Buffer.from('other bytes').toString('base64');
  await assert.rejects(service.execute('workspaces.import', { data: badFile }), /COMPONENT_INTEGRITY/);
  const dangling = structuredClone(valid);
  dangling.tasks[0].evidence.push('artifact_00000000-0000-4000-8000-000000000000');
  await assert.rejects(service.execute('workspaces.import', { data: dangling }), /reference/);
  const secret = structuredClone(valid);
  secret.conversations[0].turnManifests[0].session_token = 'never';
  await assert.rejects(service.execute('workspaces.import', { data: secret }), /SECRET_FIELD/);
  await assert.rejects(service.execute('workspaces.import', { data: { ...valid, formatVersion: 3 } }), /newer/);
  const active = structuredClone(valid);
  active.materials[0].url = 'javascript:alert(1)';
  await assert.rejects(service.execute('workspaces.import', { data: active }));
  assert.equal(service.storage.contentDigest(), before);
  // Script-like content is stored as inert text.
  const inert = structuredClone(valid);
  inert.context[0].content = '<img src=x onerror=alert(1)><script>steal()</script>';
  const imported = await service.execute('workspaces.import', { data: inert });
  assert.equal((await service.execute('context.list', { workspaceId: imported.id }))[0].content, inert.context[0].content);
});

test('older exports without format version import with reported initialization', async t => {
  const { service } = fixture(t);
  for (const version of [1, 2]) {
    const input = readFileSync(new URL(`./fixtures/schema-v${version}/workspace-export.json`, import.meta.url), 'utf8');
    const imported = await service.execute('workspaces.import', { data: input });
    assert.equal(imported.importReport.formatVersion, 1);
    assert.ok(imported.importReport.lossy.some(item => item.field === 'formatVersion'));
  }
});

test('duplicate copies revisions and stored components without reading them into the export', async t => {
  const { service } = fixture(t);
  const source = await project(service);
  const copy = await service.execute('workspaces.duplicate', { id: service.activeWorkspaceId, name: 'Copy' });
  const [artifact] = await service.execute('artifacts.list', { workspaceId: copy.id });
  assert.equal((await service.execute('artifacts.get', { id: artifact.id })).versions[0].pngBase64, (await service.execute('artifacts.get', { id: source.capture.id })).versions[0].pngBase64);
  const [material] = (await service.execute('materials.list', { workspaceId: copy.id })).filter(item => item.title === 'Paper');
  assert.equal(material.history.length, 2);
});

test('package transfer moves projects larger than the REST limit with verified components', async t => {
  const { service, directory } = fixture(t);
  await project(service);
  const large = await service.execute('artifacts.create', { title: 'Large', pngBase64: PNG(Buffer.alloc(3 * 1024 * 1024, 1)) });
  const result = await service.execute('workspaces.exportPackage', { id: service.activeWorkspaceId, name: 'project-1', sensitiveTerms: ['file body'] });
  assert.ok(result.bytes > 3 * 1024 * 1024);
  assert.equal(result.residueScan.status, 'found');
  const folder = join(directory, 'transfers', 'project-1');
  assert.ok(readFileSync(join(folder, 'workspace.json')).length < 1024 * 1024, 'records file references components instead of inlining them');
  await assert.rejects(service.execute('workspaces.exportPackage', { id: service.activeWorkspaceId, name: 'project-1' }), /already exists/);
  const imported = await service.execute('workspaces.importPackage', { name: 'project-1' });
  const copy = (await service.execute('artifacts.list', { workspaceId: imported.id })).find(item => item.title === 'Large');
  assert.equal((await service.execute('artifacts.get', { id: copy.id })).versions[0].pngBase64, (await service.execute('artifacts.get', { id: large.id })).versions[0].pngBase64);
  assert.equal(imported.importReport.records.artifacts, 2);
  await assert.rejects(service.execute('workspaces.importPackage', { name: 'project-1' }, { actor: 'automation' }), /PERMISSION_REQUIRED/);
});

test('package import rejects malformed paths, links, missing and corrupted components', async t => {
  const { service, directory } = fixture(t);
  await service.execute('artifacts.create', { title: 'Capture', text: 'package text' });
  await service.execute('workspaces.exportPackage', { id: service.activeWorkspaceId, name: 'base' });
  const base = join(directory, 'transfers', 'base');
  const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8'));
  const component = manifest.files.find(file => file.path.startsWith('components/'));
  const variant = (name, change) => {
    const folder = join(directory, 'transfers', name);
    mkdirSync(join(folder, 'components', component.sha256.slice(0, 2)), { recursive: true });
    writeFileSync(join(folder, 'workspace.json'), readFileSync(join(base, 'workspace.json')));
    writeFileSync(join(folder, ...component.path.split('/')), readFileSync(join(base, ...component.path.split('/'))));
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest));
    change(folder);
  };
  for (const name of ['../base', '/tmp/x', 'a/b', '.hidden', 'x'.repeat(101)]) await assert.rejects(service.execute('workspaces.importPackage', { name }), /invalid_arguments|Invalid|name/i, name);
  variant('traversal', folder => writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ ...manifest, files: [...manifest.files, { path: '../../outside', size: 1, sha256: '0'.repeat(64) }] })));
  variant('corrupt', folder => writeFileSync(join(folder, ...component.path.split('/')), 'tampered'));
  variant('missing', folder => rmSync(join(folder, ...component.path.split('/'))));
  variant('unlisted', folder => writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ ...manifest, files: manifest.files.filter(file => file !== component) })));
  variant('records-changed', folder => writeFileSync(join(folder, 'workspace.json'), readFileSync(join(folder, 'workspace.json'), 'utf8').replace('Capture', 'Captur3')));
  const linked = process.platform !== 'win32';
  if (linked) variant('symlink', folder => { rmSync(join(folder, ...component.path.split('/'))); symlinkSync(join(base, ...component.path.split('/')), join(folder, ...component.path.split('/'))); });
  const before = service.storage.contentDigest();
  const expectations = { traversal: /malformed/, corrupt: /COMPONENT_INTEGRITY/, missing: /regular files/, unlisted: /does not list/, 'records-changed': /COMPONENT_INTEGRITY/, ...(linked && { symlink: /regular files/ }) };
  for (const [name, pattern] of Object.entries(expectations)) await assert.rejects(service.execute('workspaces.importPackage', { name }), pattern, name);
  assert.equal(service.storage.contentDigest(), before);
  assert.equal(existsSync(join(directory, 'outside')), false);
  assert.ok(readdirSync(join(directory, 'transfers')).every(name => !name.startsWith('.tmp-')));
});
