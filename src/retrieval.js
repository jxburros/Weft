import { createHash } from 'node:crypto';
import { locality } from './providers.js';
import { recordDocument, versionDocument, indexable } from './search-index.js';
import { chunkText, normalize, DEFAULT_MIN_SIMILARITY, MAX_VECTORS_PER_WORKSPACE } from './vector-index.js';
import { redactProviderSecrets } from './provider-safety.js';

/**
 * Optional local embeddings and hybrid retrieval (ADR 018, issue #67).
 *
 * Embeddings are off until a person enables them per workspace with an existing model
 * connection. Only that connection's endpoint is contacted: Ollama `/api/embed` or an
 * OpenAI-compatible `/embeddings`. Weft never downloads or installs a model. Endpoints that are
 * not on this device need an explicit egress acknowledgement, and local-only records are then
 * never sent. Lexical BM25 and exact-cosine vector results are fused with reciprocal-rank fusion.
 */
export const RRF_K = 60;
export const EMBED_BATCH = 16;
const EMBED_TIMEOUT_MS = 30000;
const sha = value => createHash('sha256').update(value).digest('hex');
const typed = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** Reciprocal-rank fusion: score(d) = sum over lists of 1 / (k + rank). Ties keep the earliest best rank. */
export function reciprocalRankFusion(lists, k = RRF_K) {
  const scores = new Map();
  for (const list of lists) list.forEach((key, index) => {
    const entry = scores.get(key) ?? { key, score: 0, best: Infinity };
    entry.score += 1 / (k + index + 1);
    entry.best = Math.min(entry.best, index);
    scores.set(key, entry);
  });
  return [...scores.values()].sort((a, b) => b.score - a.score || a.best - b.best || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const documentKey = (collection, recordId, versionId = '') => `${collection}\u0000${recordId}\u0000${versionId || ''}`;

export class Retrieval {
  constructor({ workspace, providers, fetchImpl = globalThis.fetch, clock = Date.now, intervalMs = 5000, audit = () => {} } = {}) {
    Object.assign(this, { workspace, providers, fetch: fetchImpl, clock, intervalMs });
    this.audit = entry => { try { audit(entry); } catch { /* audit failure never changes retrieval */ } };
    this.draining = null;
    if (intervalMs > 0) {
      this.timer = setInterval(() => { this.drain().catch(() => {}); }, intervalMs);
      this.timer.unref?.();
    }
  }
  close() { clearInterval(this.timer); this.closed = true; }
  get vectors() { return this.workspace.storage?.vectors; }

  execute(name, args, context) {
    if (name === 'search.status') return this.status(context.workspaceId);
    if (name === 'search.configureEmbeddings') return this.configure(args, context);
    if (name === 'search.reindex') return this.reindex(context.workspaceId);
    throw typed('Unknown search command', 'unknown_command');
  }

  profileFor(config) {
    const profile = this.providers?.profiles?.find(item => item.id === config.model_id);
    if (!profile) throw typed('The model connection used for embeddings no longer exists; a person must configure embeddings again.', 'unavailable');
    // Consent covers one destination: a connection pointed elsewhere stops embedding until reconfigured.
    if (profile.endpoint !== config.endpoint || profile.provider !== config.provider) throw typed('The embedding connection now points to a different endpoint; a person must configure embeddings again before any text is sent.', 'unavailable');
    return profile;
  }

  /** One request to the configured endpoint. Never retries another destination. */
  async embed(config, texts, signal) {
    const profile = this.profileFor(config);
    const key = this.providers.key(profile);
    const ollama = profile.provider === 'ollama';
    const url = ollama ? `${profile.endpoint}/api/embed` : `${profile.endpoint}/embeddings`;
    const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
    let response;
    try {
      response = await this.fetch(url, { method: 'POST', headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body: JSON.stringify({ model: config.embedding_model, input: texts }) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw typed(`Unable to reach the embedding endpoint (${new URL(profile.endpoint).origin}). Start the local model server; Weft does not fall back to another endpoint.`, 'unavailable');
    }
    const body = await response.text().catch(() => '');
    if (!response.ok) throw typed(redactProviderSecrets(`Embedding endpoint returned HTTP ${response.status}. Check that ${config.embedding_model} is already available there; Weft never downloads models.`), 'unavailable');
    let json;
    try { json = JSON.parse(body.slice(0, 64 * 1024 * 1024)); } catch { throw typed('Embedding endpoint did not return valid JSON', 'unavailable'); }
    const vectors = ollama ? json?.embeddings : Array.isArray(json?.data) ? [...json.data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map(item => item?.embedding) : null;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) throw typed('Embedding endpoint returned an unexpected number of vectors', 'unavailable');
    return vectors.map(normalize);
  }

  modelKey(profile, embeddingModel) { return `${profile.provider}:${profile.endpoint}:${embeddingModel}`; }

  async configure(args, context) {
    const workspaceId = context.workspaceId;
    const vectors = this.vectors;
    if (!args.enabled) {
      const previous = vectors.config(workspaceId);
      this.workspace.storage.transaction(() => {
        vectors.setConfig({ ...(previous ?? {}), workspace_id: workspaceId, enabled: 0, model_id: previous?.model_id ?? null, provider: previous?.provider ?? null, endpoint: previous?.endpoint ?? null,
          embedding_model: previous?.embedding_model ?? null, model_key: previous?.model_key ?? null, locality: previous?.locality ?? null, egress_acknowledged: 0,
          min_similarity: previous?.min_similarity ?? DEFAULT_MIN_SIMILARITY, dims: null, updated_at: new Date(this.clock()).toISOString() });
        vectors.clearQueue(workspaceId);
        // Disabling removes derived vectors; lexical search is unaffected.
        vectors.dropVectors(workspaceId);
      });
      return this.status(workspaceId);
    }
    if (!args.modelId) throw typed('Choose an existing model connection for embeddings', 'invalid_arguments', { field: 'modelId' });
    const profile = this.providers?.profiles?.find(item => item.id === args.modelId);
    if (!profile) throw typed('Model connection not found', 'not_found');
    if (!['ollama', 'openai'].includes(profile.provider)) throw typed('Embeddings need an Ollama or OpenAI-compatible connection; this connection type has no embedding endpoint.', 'unsupported_capability', { details: { capability: 'embeddings' } });
    const where = locality(profile.endpoint);
    const onDevice = where === 'on-device endpoint';
    if (!onDevice && args.acknowledgeEgress !== true) {
      throw typed(`${new URL(profile.endpoint).origin} is a ${where}, not this device. Record text would be sent there for embedding; set acknowledgeEgress to confirm. Local-only records are never sent.`, 'invalid_arguments', { field: 'acknowledgeEgress' });
    }
    const embeddingModel = args.embeddingModel ?? profile.model;
    const config = { workspace_id: workspaceId, enabled: 1, model_id: profile.id, provider: profile.provider, endpoint: profile.endpoint, embedding_model: embeddingModel,
      model_key: this.modelKey(profile, embeddingModel), locality: where, egress_acknowledged: onDevice ? 0 : 1, min_similarity: args.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
      dims: null, updated_at: new Date(this.clock()).toISOString() };
    // A fixed probe string (no workspace data) verifies the model is already available and learns its dimensions.
    const [probe] = await this.embed(config, ['Weft embedding check'], context.signal);
    config.dims = probe.length;
    const previous = this.vectors.config(workspaceId);
    const changed = previous?.model_key !== config.model_key || previous?.dims !== config.dims;
    this.workspace.storage.transaction(() => {
      vectors.setConfig(config);
      // A different model or dimension invalidates existing vectors: drop them and re-embed everything.
      if (changed) vectors.dropVectors(workspaceId);
      vectors.requeueWorkspace(workspaceId, this.clock());
    });
    this.audit({ type: 'policy', command: 'search.configureEmbeddings', actor: context.actor ?? 'human', workspaceId, outcome: 'completed', decision: onDevice ? 'allow' : 'approve',
      reason: onDevice ? 'on_device_destination' : 'egress_acknowledged', summary: { destination: new URL(profile.endpoint).origin, locality: where, model: embeddingModel, dims: config.dims } });
    void this.drain().catch(() => {});
    return this.status(workspaceId);
  }

  reindex(workspaceId) {
    const config = this.vectors.config(workspaceId);
    if (!config?.enabled) throw typed('Embeddings are not enabled for this workspace; a person can enable them in Settings.', 'unsupported_capability', { details: { capability: 'embeddings' } });
    this.workspace.storage.transaction(() => { this.vectors.dropVectors(workspaceId, config.model_key); this.vectors.requeueWorkspace(workspaceId, this.clock()); });
    return this.drain().then(() => this.status(workspaceId));
  }

  /** Process queued records until the queue is empty or the endpoint fails. Single-flight. */
  drain() {
    if (this.draining) return this.draining;
    this.draining = this.drainOnce().finally(() => { this.draining = null; });
    return this.draining;
  }
  async drainOnce() {
    const storage = this.workspace.storage;
    if (this.closed || !storage?.db || !this.vectors) return;
    for (let rounds = 0; rounds < 1000; rounds++) {
      const enabled = [...this.vectors.configs.values()].filter(row => row.enabled === 1).map(row => row.workspace_id);
      const queue = this.vectors.queued(8, enabled);
      if (!queue.length) return;
      for (const item of queue) {
        if (this.closed || !storage.db) return;
        try { await this.indexRecord(item); }
        catch (error) {
          if (!storage.db) return;
          // An unreachable endpoint stops this pass without counting against the record; it waits for the next pass.
          storage.transaction(() => {
            if (error.code !== 'unavailable') this.vectors.failQueued(item.collection, item.record_id, error.message);
            this.vectors.setConfigState(item.workspace_id, { last_error: redactProviderSecrets(error.message).slice(0, 300) });
          });
          if (error.code === 'unavailable') return;
        }
      }
    }
  }

  /** Embed one queued record: every document (record text, each capture version), chunked. */
  async indexRecord(item) {
    const storage = this.workspace.storage;
    const config = this.vectors.config(item.workspace_id);
    const record = (this.workspace.data[item.collection] ?? []).find(entry => entry.id === item.record_id);
    if (!config?.enabled || !record || !indexable(item.collection, record) || record.workspaceId !== item.workspace_id) {
      storage.transaction(() => { this.vectors.dequeue(item.collection, item.record_id); if (!record) this.vectors.replace(item.collection, item.record_id, item.workspace_id, []); });
      return;
    }
    const onDevice = config.locality === 'on-device endpoint';
    const documents = [{ versionId: '', ...recordDocument(item.collection, record) }];
    if (item.collection === 'artifacts' && Array.isArray(record.versions)) {
      for (const version of record.versions) {
        let text = '';
        try { text = version.text; } catch { /* damaged component: embed metadata only */ }
        documents.push(versionDocument(record, version, text));
      }
    }
    const existing = new Map(this.vectors.chunks(item.collection, item.record_id).filter(row => row.model_key === config.model_key && row.dims === config.dims)
      .map(row => [`${row.version_id}\u0000${row.chunk}\u0000${row.text_sha256}`, row]));
    const rows = [];
    const pending = [];
    for (const document of documents) {
      // Local-only records never leave this device, even with an egress acknowledgement.
      if (document.localOnly && !onDevice) continue;
      const { chunks } = chunkText(document.body || '');
      const pieces = chunks.length ? chunks : document.title ? [{ start: 0, end: 0, text: '' }] : [];
      pieces.forEach((piece, index) => {
        const input = `${document.title}\n\n${piece.text}`.trim();
        const hash = sha(`${config.model_key}\u0000${input}`);
        const row = { versionId: document.versionId || '', chunk: index, start: piece.start, end: piece.end, sha256: hash, modelKey: config.model_key };
        const reuse = existing.get(`${row.versionId}\u0000${index}\u0000${hash}`);
        if (reuse) rows.push({ ...row, vector: Array.from(new Float32Array(Uint8Array.from(reuse.vector).buffer)) });
        else { rows.push(row); pending.push({ row, input }); }
      });
    }
    const current = this.vectors.count(item.workspace_id, config.model_key) - (existing.size);
    if (current + rows.length > MAX_VECTORS_PER_WORKSPACE) throw typed(`This workspace reached the ${MAX_VECTORS_PER_WORKSPACE} vector limit for exact search; remaining records stay lexical-only.`, 'capacity');
    for (let start = 0; start < pending.length; start += 16) {
      const batch = pending.slice(start, start + 16);
      const vectors = await this.embed(config, batch.map(entry => entry.input));
      vectors.forEach((vector, index) => {
        if (vector.length !== config.dims) throw typed('The embedding model returned a different dimension; a person must configure embeddings again.', 'unavailable');
        batch[index].row.vector = vector;
      });
    }
    // The record may have changed while the endpoint answered; it was re-queued, so keep this pass consistent with what was read.
    storage.transaction(() => {
      this.vectors.replace(item.collection, item.record_id, item.workspace_id, rows);
      this.vectors.dequeue(item.collection, item.record_id);
      this.vectors.setConfigState(item.workspace_id, { last_error: null });
    });
    const latest = (this.workspace.data[item.collection] ?? []).find(entry => entry.id === item.record_id);
    if (latest && latest.revision !== record.revision) storage.transaction(() => this.vectors.enqueue(item.collection, latest, this.clock()));
  }

  /** Query vector and exact cosine matches, or a reason the vector side was not used. */
  async vectorSearch(workspaceId, query, { mode = 'auto', signal, limit = 100 } = {}) {
    const config = this.vectors?.config(workspaceId);
    if (!config?.enabled) {
      if (mode === 'hybrid') throw typed('Hybrid search needs embeddings, which are not enabled for this workspace. Use mode lexical or ask a person to enable embeddings.', 'unsupported_capability', { details: { capability: 'embeddings' } });
      return { used: false, reason: 'not_enabled', matches: [] };
    }
    let vector;
    try { [vector] = await this.embed(config, [String(query).slice(0, 4000)], signal); }
    catch (error) {
      if (mode === 'hybrid' || signal?.aborted) throw error;
      return { used: false, reason: 'endpoint_unavailable', error: redactProviderSecrets(error.message).slice(0, 300), matches: [] };
    }
    if (vector.length !== config.dims) return { used: false, reason: 'dimension_changed', matches: [] };
    return { used: true, model: config.embedding_model, matches: this.vectors.search(workspaceId, config.model_key, vector, { minSimilarity: config.min_similarity, limit }) };
  }

  /** Lexical and vector coverage: which documents are indexed, embedded or not (and why). */
  status(workspaceId, { listLimit = 50 } = {}) {
    const storage = this.workspace.storage;
    const config = this.vectors?.config(workspaceId) ?? null;
    const lexical = { documents: storage.documentCount(workspaceId), complete: true };
    if (!config?.enabled) return { workspaceId, lexical, vector: { enabled: false, embedded: 0, pending: 0, unembedded: [], unembeddedCount: 0 } };
    const onDevice = config.locality === 'on-device endpoint';
    const rows = this.vectors.coverage(workspaceId, config.model_key);
    const capped = this.vectors.count(workspaceId, config.model_key) >= MAX_VECTORS_PER_WORKSPACE;
    const unembedded = rows.filter(row => !row.embedded).map(row => ({ type: row.collection, id: row.record_id, ...(row.version_id ? { versionId: row.version_id } : {}),
      reason: row.local_only && !onDevice ? 'local_only' : row.queue_error ? (/vector limit/.test(row.queue_error) ? 'capacity' : 'error') : row.queued ? 'pending' : capped ? 'capacity' : 'empty' }));
    return { workspaceId, lexical, vector: { enabled: true, modelId: config.model_id, model: config.embedding_model, endpoint: new URL(config.endpoint).origin, locality: config.locality,
      egressAcknowledged: config.egress_acknowledged === 1, dims: config.dims, minSimilarity: config.min_similarity, maxVectors: MAX_VECTORS_PER_WORKSPACE, capped,
      embedded: rows.length - unembedded.length, pending: this.vectors.pendingCount(workspaceId), unembeddedCount: unembedded.length, unembedded: unembedded.slice(0, listLimit),
      ...(config.last_error ? { lastError: config.last_error } : {}) } };
  }
}
export { documentKey };
