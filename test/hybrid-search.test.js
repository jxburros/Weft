import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { Providers, capRetrieved, retrievalCapTokens, CONTEXT_SEND_CAP_RATIO } from '../src/providers.js';
import { Retrieval, reciprocalRankFusion } from '../src/retrieval.js';
import { chunkText } from '../src/vector-index.js';
import { fakeEndpoint, json, until } from './model-test-helpers.js';

/**
 * Deterministic fake embedding model: each concept is one dimension and synonyms share it, so
 * "automobile" and "sedan" are close while sharing no words. A constant bias dimension keeps
 * unknown text a valid non-zero vector that matches nothing.
 */
const CONCEPTS = [
  ['car', 'automobile', 'vehicle', 'sedan', 'truck', 'tires'],
  ['invoice', 'bill', 'payment', 'expense', 'price'],
  ['rain', 'storm', 'weather', 'forecast', 'precipitation'],
  ['doctor', 'physician', 'clinic', 'medical'],
  ['solar', 'photovoltaic', 'panels', 'electricity'],
  ['contract', 'agreement', 'clause', 'lawyer'],
  ['recipe', 'cooking', 'meal', 'meals', 'dinner'],
  ['flight', 'airline', 'airport', 'trip'],
];
const embed = text => {
  const vector = new Array(CONCEPTS.length + 1).fill(0);
  vector[CONCEPTS.length] = 0.1;
  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) CONCEPTS.forEach((words, index) => { if (words.includes(word)) vector[index] += 1; });
  return vector;
};
async function embeddingServer(t, { failing = () => false } = {}) {
  return fakeEndpoint(t, (req, res, body) => {
    if (failing()) { res.writeHead(503); res.end('{"error":"model not loaded"}'); return; }
    if (req.url === '/api/embed') return json(res, { model: body.model, embeddings: body.input.map(embed) });
    if (req.url === '/v1/embeddings') return json(res, { data: body.input.map((text, index) => ({ index, embedding: embed(text) })).reverse() });
    res.writeHead(404); res.end();
  });
}
const human = { actor: 'human', source: 'gui' };
async function fixture(t, { provider = 'ollama', endpointHost = null, failing } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'weft-hybrid-'));
  const workspace = new WorkspaceService({ directory, onWarning() {} });
  const server = await embeddingServer(t, { failing });
  const port = new URL(server.base).port;
  // A non-loopback endpoint name is routed to the fake server so locality rules can be exercised.
  const fetchImpl = (url, init) => globalThis.fetch(endpointHost ? String(url).replace(endpointHost, `127.0.0.1:${port}`) : url, init);
  const providers = await new Providers({ directory, workspace, env: {}, fetchImpl }).init();
  const endpoint = endpointHost ? `http://${endpointHost}${provider === 'openai' ? '/v1' : ''}` : `${server.base}${provider === 'openai' ? '/v1' : ''}`;
  const connection = await providers.execute('models.save', { name: 'Local embeddings', provider, endpoint, model: 'chat-model' });
  const retrieval = new Retrieval({ workspace, providers, fetchImpl, intervalMs: 0 });
  workspace.attachRetrieval(retrieval);
  t.after(async () => { retrieval.close(); providers.close(); workspace.close(); await rm(directory, { recursive: true, force: true }); });
  const workspaceId = workspace.activeWorkspaceId;
  const run = (name, args = {}, context = human) => workspace.execute(name, /\.(update|delete)$/.test(name) ? args : { workspaceId, ...args }, context);
  const enable = (extra = {}) => run('search.configureEmbeddings', { enabled: true, modelId: connection.id, embeddingModel: 'fake-embed', ...extra });
  return { workspace, providers, retrieval, server, connection, workspaceId, run, enable };
}
const GOLDEN = [
  ['Car maintenance log', 'Changed the oil on the sedan and rotated the tires.'],
  ['Quarterly invoice', 'Payment due for consulting services.'],
  ['Storm preparation', 'Forecast says heavy rain tomorrow.'],
  ['Clinic visit notes', 'The physician recommended rest.'],
  ['Rooftop quote', 'Photovoltaic panels produce electricity.'],
  ['Supplier agreement', 'Clause 4 covers termination.'],
  ['Weeknight dinner ideas', 'A quick recipe for busy meals.'],
  ['Travel logistics', 'The flight leaves the airport at nine.'],
];
// Queries use a synonym that appears in no document, except the final lexical control.
const QUERIES = [['automobile', 0], ['bill', 1], ['precipitation', 2], ['doctor', 3], ['solar', 4], ['contract', 5], ['cooking', 6], ['airline', 7], ['tires', 0]];
async function seed(f) {
  const ids = [];
  for (const [title, content] of GOLDEN) ids.push((await f.run('materials.create', { title, content })).id);
  return ids;
}
const recallAt = async (f, ids, mode, k = 3) => {
  let hits = 0;
  for (const [query, index] of QUERIES) if ((await f.run('search.query', { query, mode, limit: k })).some(result => result.id === ids[index])) hits++;
  return hits / QUERIES.length;
};

test('reciprocal-rank fusion uses k=60 and keeps deterministic order', () => {
  const fused = reciprocalRankFusion([['a', 'b', 'c'], ['c', 'a']]);
  assert.deepEqual(fused.map(item => item.key), ['a', 'c', 'b']);
  assert.ok(Math.abs(fused[0].score - (1 / 61 + 1 / 62)) < 1e-12);
  const { chunks } = chunkText('word '.repeat(1000), { size: 1200, overlap: 200 });
  assert.ok(chunks.length >= 4 && chunks.every(chunk => chunk.text.length <= 1200));
  assert.ok(chunks[1].start < chunks[0].end, 'chunks overlap');
});

test('golden queries: hybrid retrieval over a local fake embedding endpoint beats lexical on synonyms', async t => {
  for (const provider of ['ollama', 'openai']) {
    await t.test(provider, async t => {
      const f = await fixture(t, { provider });
      const ids = await seed(f);
      assert.equal((await f.run('search.status')).vector.enabled, false);
      const lexicalBefore = await recallAt(f, ids, 'auto');
      const status = await f.enable();
      assert.equal(status.vector.enabled, true);
      assert.equal(status.vector.dims, CONCEPTS.length + 1);
      await f.retrieval.drain();
      const after = await f.run('search.status');
      assert.equal(after.vector.pending, 0);
      assert.equal(after.vector.unembeddedCount, 0, JSON.stringify(after.vector.unembedded));
      const lexical = await recallAt(f, ids, 'lexical');
      const hybrid = await recallAt(f, ids, 'hybrid');
      t.diagnostic(`recall@3 lexical=${lexical.toFixed(2)} hybrid=${hybrid.toFixed(2)}`);
      assert.equal(lexical, lexicalBefore, 'lexical mode is unchanged by enabling embeddings');
      assert.ok(lexical <= 0.2, `lexical recall ${lexical}`);
      assert.ok(hybrid >= 0.85, `hybrid recall ${hybrid}`);
      // Results keep exact citations and explain the fusion.
      const [top] = await f.run('search.query', { query: 'automobile' });
      assert.equal(top.id, ids[0]);
      assert.deepEqual(top.citation, { recordType: 'materials', recordId: ids[0], revision: 1, versionId: null, versionNumber: null });
      assert.equal(top.match, 'semantic');
      assert.equal(top.ranking.method, 'rrf');
      assert.equal(top.ranking.k, 60);
      assert.equal(top.ranking.lexicalRank, null);
      assert.equal(top.ranking.vectorRank, 1);
      // Only the configured endpoint was contacted, with the embedding model name; nothing was downloaded.
      assert.ok(f.server.requests.every(request => request.url === (provider === 'ollama' ? '/api/embed' : '/v1/embeddings') && request.body.model === 'fake-embed'));
    });
  }
});

test('verified absence, coverage and workspace scope in SQL', async t => {
  const f = await fixture(t);
  const ids = await seed(f);
  await f.enable();
  await f.retrieval.drain();
  const nothing = await f.run('search.query', { query: 'quantum entanglement', page: { limit: 5 } });
  assert.deepEqual(nothing.items, []);
  assert.equal(nothing.mode, 'hybrid');
  assert.equal(nothing.absence.verified, true);
  assert.deepEqual(nothing.absence.searched, ['lexical', 'vector']);
  assert.equal(nothing.coverage.vector.embedded, GOLDEN.length);
  // A record added after the last indexing pass is reported as unembedded, so absence is not verified.
  const late = await f.run('materials.create', { title: "Late truck note", content: "truck tires" });
  const unverified = await f.run('search.query', { query: 'quantum entanglement', page: { limit: 5 } });
  assert.equal(unverified.absence.verified, false);
  assert.ok(unverified.coverage.vector.unembedded.some(item => item.id === late.id && item.reason === 'pending'));
  await f.retrieval.drain();
  assert.equal((await f.run('search.query', { query: 'quantum entanglement', page: { limit: 5 } })).absence.verified, true);
  // Another workspace never sees these vectors or documents.
  const other = await f.workspace.execute('workspaces.create', { name: 'Other' }, human);
  await f.workspace.execute('search.configureEmbeddings', { workspaceId: other.id, enabled: true, modelId: f.connection.id, embeddingModel: 'fake-embed' }, human);
  assert.deepEqual(await f.workspace.execute('search.query', { workspaceId: other.id, query: 'automobile' }, human), []);
  // A scoped caller cannot query a workspace outside its grant.
  await assert.rejects(f.workspace.execute('search.query', { workspaceId: f.workspaceId, query: 'automobile' }, { actor: 'automation', workspaceId: other.id }), /outside the authorized scope/);
  // Deleting a record removes its vectors; updating it re-embeds it.
  await f.run('materials.delete', { id: ids[0] });
  assert.ok(!(await f.run('search.query', { query: 'automobile' })).some(result => result.id === ids[0]));
  await f.run('materials.update', { id: ids[1], changes: { content: 'Now about the sedan.' } });
  await f.retrieval.drain();
  const updated = (await f.run('search.query', { query: 'automobile', mode: 'hybrid' })).find(result => result.id === ids[1]);
  assert.equal(updated.revision, 2, 'the re-embedded record is found by meaning, cited at its new revision');
});

test('paged search cursors, model changes and disabling', async t => {
  const f = await fixture(t);
  await seed(f);
  for (let i = 0; i < 6; i++) await f.run('materials.create', { title: `Sedan note ${i}`, content: 'sedan' });
  await f.enable();
  await f.retrieval.drain();
  const first = await f.run('search.query', { query: 'sedan', page: { limit: 4 } });
  const second = await f.run('search.query', { query: 'sedan', page: { limit: 4, cursor: first.nextCursor } });
  const ids = [...first.items, ...second.items].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'pages do not repeat results');
  assert.equal(first.total, 7);
  await assert.rejects(f.run('search.query', { query: 'other', page: { cursor: first.nextCursor } }), /different command, workspace or filter/);
  await assert.rejects(f.run('search.query', { query: 'sedan', limit: 3, page: { limit: 4 } }), /page.limit/);
  // A different embedding model drops every vector and re-embeds everything.
  const requests = f.server.requests.length;
  const changed = await f.enable({ embeddingModel: 'fake-embed-v2' });
  assert.equal(changed.vector.embedded, 0);
  await f.retrieval.drain();
  assert.ok(f.server.requests.slice(requests).some(request => request.body.model === 'fake-embed-v2'));
  assert.equal((await f.run('search.status')).vector.unembeddedCount, 0);
  // Re-indexing with the same model reuses unchanged chunks: no text is sent again.
  const before = f.server.requests.length;
  await f.run('search.reindex');
  assert.equal(f.server.requests.length, before);
  const disabled = await f.run('search.configureEmbeddings', { enabled: false });
  assert.equal(disabled.vector.enabled, false);
  assert.equal(f.workspace.storage.db.prepare('SELECT count(*) AS count FROM vector_chunks').get().count, 0, 'disabling removes stored vectors');
  await assert.rejects(f.run('search.query', { query: 'sedan', mode: 'hybrid' }), error => error.code === 'unsupported_capability');
});

test('embedding destinations: local by default, explicit egress acknowledgement, local-only records stay on device', async t => {
  const f = await fixture(t, { endpointHost: '192.168.40.7:11434' });
  const secret = await f.run('materials.create', { title: 'Private car notes', content: 'sedan loan details', localOnly: true });
  await f.run('materials.create', { title: 'Shared car notes', content: 'sedan schedule' });
  await assert.rejects(f.enable(), error => error.code === 'invalid_arguments' && /acknowledgeEgress/.test(error.message));
  assert.equal(f.server.requests.length, 0, 'nothing is sent before acknowledgement');
  await assert.rejects(f.run('search.configureEmbeddings', { enabled: true, modelId: f.connection.id }, { actor: 'automation' }), /human administration/);
  const status = await f.enable({ acknowledgeEgress: true });
  assert.equal(status.vector.locality, 'local-network endpoint');
  assert.equal(status.vector.egressAcknowledged, true);
  await f.retrieval.drain();
  const sent = JSON.stringify(f.server.requests.map(request => request.body.input));
  assert.doesNotMatch(sent, /loan details|Private car notes/);
  assert.match(sent, /sedan schedule/);
  const coverage = await f.run('search.status');
  assert.ok(coverage.vector.unembedded.some(item => item.id === secret.id && item.reason === 'local_only'));
});

test('an unavailable endpoint degrades auto search to lexical, reported as partial; hybrid fails', async t => {
  let down = false;
  const f = await fixture(t, { failing: () => down });
  await seed(f);
  await f.enable();
  await f.retrieval.drain();
  down = true;
  const page = await f.run('search.query', { query: 'tires', page: { limit: 5 } });
  assert.equal(page.mode, 'lexical');
  assert.equal(page.partial, true);
  assert.equal(page.vector.reason, 'endpoint_unavailable');
  assert.equal(page.items.length, 1);
  await assert.rejects(f.run('search.query', { query: 'tires', mode: 'hybrid' }), error => error.code === 'unavailable');
  // New records wait in the queue with the error; nothing falls back to another endpoint.
  await f.run('materials.create', { title: 'Queued', content: 'truck' });
  await f.retrieval.drain();
  const status = await f.run('search.status');
  assert.equal(status.vector.pending, 1);
  assert.match(status.vector.lastError, /Unable to reach|HTTP 503/);
  down = false;
  await f.retrieval.drain();
  assert.equal((await f.run('search.status')).vector.pending, 0);
});

test('retrieved context sent to a model is capped at 0.4 of the window after the reserved reply', async t => {
  const caps = { contextWindow: 4096, maxOutputTokens: 1024 };
  assert.equal(retrievalCapTokens(caps), Math.floor(CONTEXT_SEND_CAP_RATIO * (4096 - 1024)));
  const items = Array.from({ length: 50 }, (_, index) => ({ id: `r${index}`, content: 'x'.repeat(300) }));
  const fit = capRetrieved(items, retrievalCapTokens(caps), kept => ({ items: kept }));
  assert.ok(fit.tokens <= retrievalCapTokens(caps));
  assert.ok(fit.kept.length > 0 && fit.omitted > 0);
  assert.deepEqual(fit.kept.map(item => item.id), items.slice(0, fit.kept.length).map(item => item.id), 'higher-ranked results are kept whole, in order');

  // Search results attached to a chat turn obey the same cap and report omissions in the disclosure.
  const f = await fixture(t);
  for (let i = 0; i < 40; i++) await f.run('materials.create', { title: `Sedan report ${i}`, content: `sedan ${'detail '.repeat(150)}` });
  f.providers.searchWorkspace = ({ workspaceId, query, limit }) => f.workspace.execute('search.query', { workspaceId, query, page: { limit } }, { actor: 'model-reader', workspaceId });
  const chat = await f.providers.execute('models.save', { name: 'Small local model', provider: 'openai', endpoint: 'http://127.0.0.1:9/v1', model: 'small', capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } });
  const conversation = await f.run('conversations.create', { title: 'Ask' });
  const { disclosure } = await f.providers.execute('chat.preview', { conversationId: conversation.id, modelId: chat.id, text: 'Summarize', attachments: [{ kind: 'search', query: 'sedan', limit: 40 }] });
  const item = disclosure.items.find(entry => entry.kind === 'search');
  assert.equal(item.delivery, 'text');
  assert.ok(item.estimatedTokens <= disclosure.context.retrievalCapTokens + 50, `${item.estimatedTokens} tokens`);
  assert.ok(item.provenance.omitted > 0 && item.provenance.sent > 0);
  assert.equal(item.truncated, true);
  assert.equal(disclosure.context.retrievalCapRatio, 0.4);
});

test('drain waits for indexing to finish before returning', async t => {
  const f = await fixture(t);
  await f.enable();
  await f.run('materials.create', { title: 'Sedan', content: 'sedan' });
  void f.retrieval.drain();
  await until(async () => (await f.run('search.status')).vector.pending === 0);
});
