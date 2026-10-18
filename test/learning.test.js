import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { Providers } from '../src/providers.js';
import { Learning } from '../src/learning.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { fakeEndpoint, json } from './model-test-helpers.js';
const human = { actor: 'human', source: 'gui' };
async function fixture(t, { cloud = false, respond } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'weft-learning-'));
  const workspace = new WorkspaceService({ directory });
  const requests = [];
  const server = await fakeEndpoint(t, async (req, res, body) => {
    requests.push(body);
    if (respond) await respond();
    json(res, { choices: [{ message: { content: JSON.stringify({ title: 'Supplier terms', content: 'The supplier says invoices are due in thirty days.' }) }, finish_reason: 'stop' }] });
  });
  const fetchImpl = (url, init) => fetch(String(url).replace('https://learning.example', server.base), init);
  const providers = await new Providers({ directory, workspace, fetchImpl }).init();
  const model = await providers.execute('models.save', { name: 'Learning fixture', provider: 'openai', endpoint: cloud ? 'https://learning.example/v1' : `${server.base}/v1`, model: 'fixture' });
  const learning = new Learning({ workspace, providers, fetchImpl });
  const dispatch = createDispatcher({ workspace, providers, admission: new AutomationAdmission() });
  const workspaceId = workspace.activeWorkspaceId;
  const run = (name, args = {}) => workspace.execute(name, { workspaceId, ...args }, human);
  t.after(async () => { learning.close(); providers.close(); workspace.close(); await rm(directory, { recursive: true, force: true }); });
  return { workspace, providers, learning, requests, model, workspaceId, run, dispatch };
}
test('opt-in learning creates cited editable memory once, shares only chosen global entries, and erase pauses without relearning', async t => {
  const f = await fixture(t);
  const source = await f.run('materials.create', { title: 'Supplier email', content: 'Invoices are due in thirty days.', localOnly: true });
  await f.learning.tick(); assert.equal(f.requests.length, 0);
  await f.run('learning.configure', { enabled: true, modelId: f.model.id, global: true });
  await f.learning.tick(); assert.equal(f.requests.length, 1);
  const memory = f.workspace.data.memories[0];
  assert.equal(memory.localOnly, true); assert.equal(memory.scope, 'global'); assert.ok(memory.sources[0].includes(source.id));
  assert.equal(f.requests[0].tools, undefined);
  await f.learning.tick(); assert.equal(f.requests.length, 1);
  await f.workspace.execute('memories.update', { id: memory.id, expectedRevision: 1, changes: { content: 'Human correction: fifteen days.' } }, human);
  await f.learning.tick(); assert.match(f.workspace.data.memories[0].content, /Human correction/);
  const other = await f.workspace.execute('workspaces.create', { name: 'Other' }, human);
  const hits = await f.workspace.execute('search.query', { workspaceId: other.id, query: 'fifteen' }, human);
  assert.equal(hits[0].id, memory.id); assert.equal(hits[0].shared.collectionId, 'global-memory');
  await f.run('learning.erase', { scope: 'global' });
  assert.equal(f.workspace.data.memories.length, 0);
  assert.equal((await f.run('learning.status')).config.enabled, false);
  await f.run('learning.configure', { enabled: true, modelId: f.model.id, global: true });
  await f.learning.tick(); assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.workspace.execute('search.query', { workspaceId: other.id, query: 'fifteen' }, human), []);
  assert.equal(f.workspace.snapshot({ agent: true }).learning, undefined);
});
test('cloud learning needs consent, skips local-only sources, and cannot be enabled by an agent', async t => {
  const f = await fixture(t, { cloud: true });
  await f.run('materials.create', { title: 'Secret', content: 'Private invoice', localOnly: true });
  await assert.rejects(f.run('learning.configure', { enabled: true, modelId: f.model.id }), /Confirm sharing/);
  const denied = await f.dispatch('learning.configure', { enabled: true, modelId: f.model.id, acknowledgeEgress: true }, { actor: 'automation', autonomy: 'autonomous' });
  assert.ok(denied.error);
  await f.run('learning.configure', { enabled: true, modelId: f.model.id, acknowledgeEgress: true });
  await f.learning.tick(); assert.equal(f.requests.length, 0);
  await f.run('materials.create', { title: 'Public note', content: 'Invoice is due tomorrow.' });
  await f.learning.tick(); assert.equal(f.requests.length, 1);
  assert.ok(!JSON.stringify(f.requests).includes('Private invoice'));
  const chat = await f.run('conversations.create', { title: 'Memory preview' });
  const preview = await f.providers.prepare({ conversationId: chat.id, modelId: f.model.id, text: 'What do we know?' });
  assert.ok(preview.disclosure.items.some(i => i.key.startsWith('memory:')));
});
test('erasing during a model request discards the late summary', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const f = await fixture(t, { respond: () => gate });
  await f.run('materials.create', { title: 'Invoice', content: 'Invoice details' });
  await f.run('learning.configure', { enabled: true, modelId: f.model.id });
  const work = f.learning.tick();
  while (!f.requests.length) await new Promise(r => setTimeout(r, 5));
  await f.run('learning.erase', { scope: 'all' }); release(); await work;
  assert.deepEqual(f.workspace.data.memories, []);
});
test('workspace memory is searchable with longer cited passages and private memory stays out of cloud disclosure', async t => {
  const f = await fixture(t, { cloud: true });
  await f.workspace.execute('workspaces.update', { id: f.workspaceId, changes: { memory: 'Renewal details: ' + 'invoice terms '.repeat(150), contextLocalOnly: true } }, human);
  const hits = await f.run('search.query', { query: 'renewal', passageChars: 1800 });
  assert.equal(hits[0].type, 'workspaces'); assert.equal(hits[0].localOnly, true); assert.ok(hits[0].content.length > 300);
  f.providers.searchWorkspace = args => f.workspace.execute('search.query', { ...args, passageChars: 3000 }, human);
  const chat = await f.run('conversations.create', { title: 'Query' });
  const preview = await f.providers.prepare({ conversationId: chat.id, modelId: f.model.id, text: 'renewal', attachments: [{ kind: 'search', query: 'renewal' }] });
  assert.ok(!JSON.stringify(preview.userContent).includes('invoice terms'));
});

test('learning and edited memories survive restart; imported shared memory stays workspace-scoped', async t => {
  const f = await fixture(t);
  await f.run('materials.create', { title: 'Terms', content: 'Invoices are due in thirty days.' });
  await f.run('learning.configure', { enabled: true, modelId: f.model.id, global: true });
  await f.learning.tick();
  const exported = await f.workspace.execute('workspaces.export', { id: f.workspaceId }, human);
  const imported = await f.workspace.execute('workspaces.import', { data: exported }, human);
  const copied = f.workspace.data.memories.filter(m => m.workspaceId === imported.id);
  assert.equal(copied.length, 1); assert.equal(copied[0].scope, 'workspace');
  assert.equal((await f.run('learning.status', { workspaceId: imported.id })).config.enabled, false);
  f.learning.close(); f.workspace.close();
  const reopened = new WorkspaceService({ directory: f.workspace.directory });
  try {
    assert.equal(reopened.data.memories.length, 2);
    assert.equal(reopened.data.learning.configs[f.workspaceId].enabled, true);
    assert.equal(Object.keys(reopened.data.learning.processed).length, 1);
  } finally { reopened.close(); }
});
