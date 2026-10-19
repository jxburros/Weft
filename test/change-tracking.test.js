import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackChanges, untracked } from '../src/change-tracker.js';
import { WorkspaceService } from '../src/workspace.js';

function service(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-tracking-'));
  const workspace = new WorkspaceService({ directory });
  t.after(() => { workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  return workspace;
}

test('the tracker notes records read, collections touched and keys replaced, and never stores a proxy', () => {
  const a = { id: 'a', n: 1 };
  const b = { id: 'b', n: 2 };
  const root = { items: [a, b], other: [{ id: 'c' }], settings: { theme: 'dark' } };
  let late = 0;
  const tracker = trackChanges(root, { onLate: () => late++ });
  const data = tracker.proxy;
  data.items.find(item => item.id === 'a').n = 5;
  data.items.push({ id: 'd' });
  data.replacement = data.other;
  const hints = tracker.finish();
  assert.deepEqual([...hints.records.keys()].sort(), ['items', 'other']);
  assert.ok(hints.records.get('items').has(a), 'a record found by iteration is noted');
  assert.ok([...hints.records.get('items')].some(item => item.id === 'd'), 'an added record is noted');
  assert.deepEqual([...hints.replaced], ['replacement']);
  assert.equal(root.replacement, root.other, 'assigned values are unwrapped');
  assert.doesNotThrow(() => structuredClone(root));
  assert.equal(late, 0);
  assert.equal(untracked(data.items), root.items);
  assert.equal(late, 1, 'using a proxy after the transaction is reported');
});

test('a command re-serializes only the records it read, and the commit matches a full diff', async t => {
  const workspace = service(t);
  const seed = await workspace.execute('materials.create', { title: 'Seed', content: 'seed' });
  workspace.data.materials = Array.from({ length: 2000 }, (_, i) => ({ ...structuredClone(seed), id: `material-${i}`, title: `Note ${i}` }));
  workspace.save();
  const storage = workspace.storage;
  const serialize = storage.serialize.bind(storage);
  const plan = storage.plan.bind(storage);
  const counts = { hinted: 0, full: 0 };
  let mode = null;
  storage.serialize = (collection, record, options) => { if (mode && collection === 'materials') counts[mode]++; return serialize(collection, record, options); };
  storage.plan = (state, only, hints) => { mode = hints ? 'hinted' : 'full'; try { return plan(state, only, hints); } finally { mode = null; } };
  // Under the Node test runner every hinted commit is also compared with a full diff and fails on any difference.
  await workspace.execute('materials.update', { id: 'material-1999', changes: { content: 'changed' } });
  const hinted = counts.hinted;
  counts.full = 0;
  storage.plan(workspace.data);
  const full = counts.full;
  assert.ok(full >= 2000, 'a full diff serializes every record');
  assert.ok(hinted < 20, `the tracked commit serialized ${hinted} materials`);
  workspace.close();
  const reopened = new WorkspaceService({ directory: workspace.directory });
  t.after(() => reopened.close());
  assert.equal((await reopened.execute('materials.get', { id: 'material-1999' })).content, 'changed');
});

test('a change the tracker could not see is caught by the verification and written by the next full diff', async t => {
  const workspace = service(t);
  const note = await workspace.execute('materials.create', { title: 'Note', content: 'before' });
  const other = await workspace.execute('materials.create', { title: 'Other', content: 'other' });
  // A reference held from before the transaction, changed without saving: invisible to the change tracker.
  workspace.data.materials.find(item => item.id === note.id).content = 'outside';
  await assert.rejects(workspace.execute('materials.update', { id: other.id, changes: { content: 'tracked' } }), error => error.code === 'STORE_TRACKING_MISMATCH');
  // The failed commit rolled back both changes; a plain save (always a full diff) persists an outside change.
  workspace.data.materials.find(item => item.id === note.id).content = 'outside';
  workspace.save();
  assert.equal(workspace.storage.plan(workspace.data).upserts.length, 0);
});

test('a stale tracking view used after its transaction forces a full diff on the next commit', async t => {
  const workspace = service(t);
  const note = await workspace.execute('materials.create', { title: 'Note', content: 'before' });
  let held;
  await workspace.executeModule(() => { held = workspace.data.materials; });
  held.find(item => item.id === note.id).content = 'late';
  assert.equal(workspace.fullDiffNext, true);
  await workspace.execute('materials.create', { title: 'Next', content: 'next' });
  assert.equal(workspace.storage.plan(workspace.data).upserts.length, 0, 'the late change was written by a full diff');
});

test('snapshot revisions let a poller skip unchanged state', async t => {
  const workspace = service(t);
  const first = await workspace.execute('workspace.snapshot', {});
  assert.equal(typeof first.revision, 'string');
  assert.deepEqual(await workspace.execute('workspace.snapshot', { ifRevision: first.revision }), { unchanged: true, revision: first.revision });
  await workspace.execute('materials.create', { title: 'Note', content: 'x' });
  const next = await workspace.execute('workspace.snapshot', { ifRevision: first.revision });
  assert.notEqual(next.revision, first.revision);
  assert.ok(next.materials.some(item => item.title === 'Note'));
});
