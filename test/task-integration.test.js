import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeFixture, human } from './fixtures/task-runtime-fixture.mjs';

/**
 * The task runtime (ADR 016) merged with restricted originals (ADR 012), shared context and trusted
 * promotion (ADR 013) and workspace encryption (ADR 014): task identities get no more than any agent.
 */
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-task-integration-'));
  const f = createRuntimeFixture({ directory });
  t.after(() => { f.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return f;
}
const step = (title, command, args = {}, extra = {}) => ({ kind: 'command', title, command, args, ...extra });
async function startTask(f, plan, executor = { type: 'runner', autonomy: 'autonomous' }) {
  const task = await f.run('tasks.create', { workspaceId: f.workspaceId, title: 'Integration task', plan });
  await f.run('tasks.start', { id: task.id, executor });
  return task.id;
}

test('task steps keep restricted originals withheld and need a human approval to read one', async t => {
  const f = setup(t);
  const SECRET = 'zebracodeword';
  const capture = await f.run('artifacts.create', { workspaceId: f.workspaceId, title: 'Receipt', text: `Card ${SECRET} charged.` });
  const original = capture.versions[0].id;
  await f.run('artifacts.redact', { id: capture.id, versionId: original, text: [{ literal: SECRET }] });
  await f.run('artifacts.setAccess', { id: capture.id, versionId: original, access: 'restricted' });
  const id = await startTask(f, [step('Read capture', 'artifacts.get', { id: capture.id, versionId: original }), step('Read original', 'artifacts.readOriginal', { id: capture.id, versionId: original })]);
  const task = await f.settle(id);
  assert.equal(task.status, 'waiting_on_human');
  assert.equal(task.blocker.kind ?? task.run?.blocker?.kind ?? 'approval', 'approval');
  assert.equal(JSON.stringify(task).includes(SECRET), false, 'neither the step result nor the operation record holds the original text');
  assert.equal(JSON.stringify(f.events).includes(SECRET), false);
});

test('a task cannot promote context without the human approval path, nor read another workspace outside shared collections', async t => {
  const f = setup(t);
  const proposal = await f.run('context.propose', { workspaceId: f.workspaceId, title: 'Supplier ships Tuesdays', content: 'Seen on the order page.', proposedCategory: 'confirmed', rationale: 'Order page' });
  // The fixture browser cannot open real tabs: create the second workspace without browser effects.
  const browser = f.workspace.browser;
  f.workspace.browser = null;
  const other = await f.workspace.execute('workspaces.create', { name: 'Other project' }, human).finally(() => { f.workspace.browser = browser; });
  const hidden = await f.workspace.execute('context.create', { workspaceId: other.id, title: 'Private', content: 'Private note' }, human);
  const promote = await startTask(f, [step('Promote', 'context.promote', { id: proposal.id, expectedRevision: 1 })]);
  let task = await f.settle(promote);
  assert.equal(task.status, 'waiting_on_human', 'trusted context waits for a person even at autonomous level');
  assert.equal(f.workspace.data.context.some(item => item.promotedFrom?.id === proposal.id), false);
  const outside = await startTask(f, [step('Read other workspace', 'context.get', { id: hidden.id })]);
  task = await f.settle(outside);
  assert.notEqual(task.status, 'completed');
  assert.equal(JSON.stringify(task).includes('Private note'), false);
});

test('locking an encrypted profile pauses runtime tasks; only a person continues after unlock, and in-flight work is swept', { timeout: 60000 }, async t => {
  const f = setup(t);
  const enc = (name, args = {}) => f.workspace.executeEncryption(name, args, human);
  await enc('encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'manual', passphrase: 'correct horse battery staple' });
  f.workspace.encryptionHooks = { beforeLock: () => f.tasks.suspendForLock(), afterUnlock: async () => { await f.tasks.init(); f.tasks.start(); } };
  const hold = f.page.hold(1);
  const id = await startTask(f, [step('Read page', 'page.readable', { tabId: 1 }), step('Record', 'context.create', { title: 'after lock', category: 'findings', content: 'x' })]);
  await hold.started;
  await enc('encryption.lock');
  assert.equal((await f.attempt('tasks.list', { workspaceId: f.workspaceId })).error.code, 'locked');
  hold.release({ url: 'https://shop.example.com/cart', title: 'Fixture', text: 'page', links: [] });
  await new Promise(resolve => setTimeout(resolve, 50));
  await enc('encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' });
  const task = await f.settle(id);
  assert.equal(task.status, 'paused');
  assert.ok(task.timeline.some(entry => entry.reason === 'profile_locked'), JSON.stringify(task.timeline.map(entry => entry.reason)));
  assert.equal(f.workspace.data.context.some(item => item.title === 'after lock'), false, 'no step ran while or because of the lock');
  assert.ok(task.operations.every(op => op.status !== 'attempted'), 'the unlock sweep resolved the in-flight operation record');
  assert.equal((await f.attempt('tasks.continue', { id }, { actor: 'automation' })).error.code, 'permission_required', 'agents cannot continue a task the lock paused');
  await f.run('tasks.continue', { id });
  assert.equal((await f.settle(id)).status, 'completed');
  // Plans, timelines and operation records are sealed with the rest of the task record.
  const files = readdirSync(f.workspace.directory).filter(name => name.startsWith('workspace.sqlite'));
  assert.ok(files.length > 0);
  for (const name of files) assert.equal(readFileSync(join(f.workspace.directory, name)).includes('Read page'), false, name);
});
