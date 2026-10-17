import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { CommunityLists } from '../src/community-lists.js';
import { DatabaseSync } from '../src/sqlite.js';

const human = { actor: 'human' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-lists-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = new WorkspaceService({ directory }); t.after(() => workspace.close());
  return { directory, workspace, lists: new CommunityLists({ workspace }) };
}
function source(hostname = 'example.com', commit = 'a'.repeat(40)) {
  const data = JSON.stringify({ format: 'weft-site-list', version: 1, rules: [{ hostname, reason: 'Pinned test data' }] });
  return { id: 'community', sourceRepo: 'example/lists', commit, path: 'lists/sites.json', sha256: createHash('sha256').update(data).digest('hex'), bytes: Buffer.byteLength(data), data };
}

test('offline list pins and disabled rule provenance persist across restart', async t => {
  const { workspace, lists, directory } = fixture(t);
  const input = source();
  const installed = await lists.execute('lists.install', input, human);
  assert.equal(installed.enabled, false);
  assert.equal(installed.integrity, 'verified');
  assert.equal(installed.data, undefined);
  assert.equal(installed.ruleCount, 1);
  assert.equal(installed.rollbackAvailable, false);
  assert.equal(workspace.matchSiteRule('https://example.com'), null);
  const rule = workspace.data.siteRules[0];
  assert.deepEqual(rule.provenance, { kind: 'community-list', listId: input.id, subscriptionWorkspaceId: workspace.activeWorkspaceId, sourceRepo: input.sourceRepo, commit: input.commit, path: input.path, sha256: input.sha256, bytes: input.bytes, ruleIndex: 0 });
  await workspace.execute('siteRules.update', { id: rule.id, changes: { enabled: true } }, human);
  assert.equal((await lists.execute('lists.status', {}, human))[0].enabledRuleCount, 1);
  const reopened = new WorkspaceService({ directory }); t.after(() => reopened.close());
  assert.equal(new CommunityLists({ workspace: reopened }).summary(reopened.data.siteLists[0]).sha256, input.sha256);
  assert.equal(reopened.matchSiteRule('https://example.com').provenance.commit, input.commit);
});

test('updates preserve prior pin, replace only owned rules and rollback disabled', async t => {
  const { workspace, lists } = fixture(t);
  await workspace.execute('siteRules.create', { hostname: 'personal.test', enabled: true }, human);
  const old = await lists.execute('lists.install', source(), human);
  await workspace.execute('siteRules.update', { id: workspace.data.siteRules[1].id, changes: { enabled: true } }, human);
  const updated = await lists.execute('lists.install', source('next.test', 'b'.repeat(40)), human);
  assert.equal(updated.rollbackAvailable, true);
  assert.equal(updated.previous.sha256, old.sha256);
  assert.equal(updated.enabled, false);
  assert.equal(workspace.matchSiteRule('https://example.com'), null);
  assert.ok(workspace.matchSiteRule('https://personal.test'));
  const restored = await lists.execute('lists.rollback', { id: 'community' }, human);
  assert.equal(restored.sha256, old.sha256);
  assert.equal(restored.enabled, false);
  assert.equal(workspace.data.siteRules.find(rule => rule.provenance).hostname, 'example.com');
  assert.equal(workspace.data.siteRules.length, 2);
});

test('list integrity, schema and authority failures preserve store bytes', async t => {
  const { workspace, lists } = fixture(t);
  const before = readFileSync(workspace.path, 'utf8');
  for (const input of [{ ...source(), bytes: 1 }, { ...source(), sha256: '0'.repeat(64) }, { ...source(), commit: 'main' }, { ...source(), path: '../sites.json' }]) await assert.rejects(lists.execute('lists.install', input, human));
  const hostile = source();
  const data = JSON.parse(hostile.data); data.rules[0].code = 'process.exit()';
  hostile.data = JSON.stringify(data); hostile.bytes = Buffer.byteLength(hostile.data); hostile.sha256 = createHash('sha256').update(hostile.data).digest('hex');
  await assert.rejects(lists.execute('lists.install', hostile, human));
  for (const name of ['lists.install', 'lists.status', 'lists.rollback']) await assert.rejects(lists.execute(name, name === 'lists.install' ? source() : {}, { actor: 'automation' }), /PERMISSION_REQUIRED/);
  await assert.rejects(lists.execute('lists.rollback', { id: 'community' }, human), /No previous/);
  assert.equal(readFileSync(workspace.path, 'utf8'), before);
});

test('list status is offline, scoped and repeated identical installation is idempotent', async t => {
  const { workspace, lists } = fixture(t);
  const original = workspace.activeWorkspaceId;
  await lists.execute('lists.install', source(), human);
  const before = readFileSync(workspace.path, 'utf8');
  assert.equal((await lists.execute('lists.install', source(), human)).unchanged, true);
  assert.equal(readFileSync(workspace.path, 'utf8'), before);
  const other = await workspace.execute('workspaces.create', { name: 'Other' });
  assert.deepEqual(await lists.execute('lists.status', {}, human), []);
  await assert.rejects(lists.execute('lists.status', { workspaceId: original }, { actor: 'human', workspaceId: other.id }), /PERMISSION_REQUIRED/);
  assert.equal((await lists.execute('lists.status', { workspaceId: original }, human)).length, 1);
});

test('external store changes roll back all subscription and rule mutations', async t => {
  const { workspace, lists } = fixture(t);
  const external = new DatabaseSync(workspace.path);
  external.prepare("INSERT INTO state_meta(key, value) VALUES ('externalMarker', '1')").run();
  const before = workspace.storage.contentDigest();
  await assert.rejects(lists.execute('lists.install', source(), human), /STORE_CONFLICT/);
  assert.equal(workspace.data.siteLists, undefined);
  assert.deepEqual(workspace.data.siteRules, []);
  assert.equal(workspace.storage.contentDigest(), before);
  assert.equal(external.prepare("SELECT count(*) AS count FROM records WHERE collection = 'siteRules'").get().count, 0);
  external.close();
});

test('rollback rechecks preserved bytes rather than trusting cached rule descriptors', async t => {
  const { workspace, lists } = fixture(t);
  await lists.execute('lists.install', source(), human);
  await lists.execute('lists.install', source('next.test', 'b'.repeat(40)), human);
  workspace.data.siteLists[0].previous.rules[0].hostname = 'tampered.test';
  const restored = await lists.execute('lists.rollback', { id: 'community' }, human);
  assert.equal(restored.integrity, 'verified');
  assert.equal(workspace.data.siteRules[0].hostname, 'example.com');
  workspace.data.siteLists[0].previous.data += '\n';
  const before = workspace.storage.contentDigest();
  await assert.rejects(lists.execute('lists.rollback', { id: 'community' }, human), /LIST_INTEGRITY/);
  assert.equal(workspace.storage.contentDigest(), before);
});
