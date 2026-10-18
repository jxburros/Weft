/**
 * Optional per-workspace embedding index (ADR 018, issue #67). Derived data in the workspace
 * database: float32 vectors as BLOBs, exact cosine search, an incremental queue filled in the
 * same transaction as the record change, and per-workspace configuration. Vectors are never
 * exported; backups copy them with the database. In an encrypted profile (ADR 014) each chunk's
 * text digest and vector are one AES-256-GCM envelope under a key derived from the index key, and
 * the on-disk digest column is keyed, so unlocking only decrypts: nothing is re-embedded.
 */
export const VECTOR_INDEX_VERSION = 1;
/** Exact search keeps every vector of a workspace in memory; beyond this, indexing stops and coverage says so. */
export const MAX_VECTORS_PER_WORKSPACE = 20000;
export const MAX_DIMENSIONS = 8192;
export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP = 200;
export const MAX_CHUNKS_PER_DOCUMENT = 32;
export const DEFAULT_MIN_SIMILARITY = 0.35;

/** Split text into overlapping chunks at whitespace; offsets point into the original text. */
export function chunkText(text, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP, max = MAX_CHUNKS_PER_DOCUMENT } = {}) {
  const value = String(text ?? '');
  const chunks = [];
  let start = 0;
  while (start < value.length && chunks.length < max) {
    let end = Math.min(value.length, start + size);
    if (end < value.length) {
      const space = value.lastIndexOf(' ', end);
      const newline = value.lastIndexOf('\n', end);
      const cut = Math.max(space, newline);
      if (cut > start + size / 2) end = cut;
    }
    const piece = value.slice(start, end);
    if (piece.trim()) chunks.push({ start, end, text: piece });
    if (end >= value.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return { chunks, truncated: start < value.length && chunks.length >= max && chunks.at(-1).end < value.length };
}

export const toBlob = vector => new Uint8Array(Float32Array.from(vector).buffer);
/** Authenticated context of one stored chunk: moving a sealed vector to another record, chunk, model or size fails. */
export const vectorAad = row => [row.workspace_id, row.collection, row.record_id, row.version_id ?? '', row.chunk, row.model_key, row.dims].join('\u0000');
/** Seal one plaintext chunk row (hex text digest and raw vector bytes) for an encrypted profile. */
export function sealVectorRow(keys, row, digest, bytes) {
  return { digest: keys.vectorDigest(digest), blob: keys.sealVector(vectorAad(row), Buffer.concat([Buffer.from(digest, 'hex'), Buffer.from(bytes)])) };
}
/** Open one sealed chunk row: the plaintext text digest and raw vector bytes, checked against the keyed digest column. */
export function openVectorRow(keys, row) {
  const payload = keys.openVector(vectorAad(row), row.vector);
  const digest = payload.subarray(0, 32).toString('hex');
  if (payload.length < 36 || keys.vectorDigest(digest) !== row.text_sha256) throw Object.assign(new Error('ENCRYPTION_INTEGRITY: an embedding vector does not match its row. Nothing was changed; reindex embeddings or restore from a verified backup.'), { code: 'component_integrity' });
  return { digest, bytes: new Uint8Array(payload.subarray(32)) };
}
export const fromBlob = blob => new Float32Array(Uint8Array.from(blob).buffer);
/** Unit-normalize so cosine similarity is a dot product; rejects empty, non-finite or zero vectors. */
export function normalize(vector) {
  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) throw new Error('Embedding is not a numeric vector');
  if (!vector.length || vector.length > MAX_DIMENSIONS) throw new Error(`Embedding has ${vector.length} dimensions; 1-${MAX_DIMENSIONS} are supported`);
  let norm = 0;
  for (const value of vector) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Embedding contains a non-numeric value'); norm += value * value; }
  norm = Math.sqrt(norm);
  if (!norm) throw new Error('Embedding is a zero vector');
  return Array.from(vector, value => value / norm);
}

export class VectorIndex {
  constructor(db) {
    this.db = db;
    this.configs = new Map();
    this.cache = new Map();
  }
  /**
   * Create or upgrade the tables. With `keys` (encrypted profile, ADR 014) vectors and the queue stay in the
   * database, each vector sealed with the profile's vector key. A profile encrypted before vectors were sealed kept
   * them in memory only; it has none on disk, so its embedded workspaces are queued once (unchanged chunks are then
   * embedded once more and never again). The per-workspace configuration (connection, model name, locality) stays on
   * disk like other model connection settings.
   */
  ensure(getInfo, setInfo, { keys = null, now = Date.now() } = {}) {
    const current = getInfo('vectorIndexVersion') === String(VECTOR_INDEX_VERSION);
    if (!current) this.db.exec('DROP TABLE IF EXISTS main.vector_chunks; DROP TABLE IF EXISTS main.vector_queue; DROP TABLE IF EXISTS main.vector_config;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS main.vector_config(workspace_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, model_id TEXT, provider TEXT, endpoint TEXT, embedding_model TEXT, model_key TEXT,
      locality TEXT, egress_acknowledged INTEGER NOT NULL DEFAULT 0, min_similarity REAL NOT NULL, dims INTEGER, updated_at TEXT NOT NULL, last_error TEXT);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS main.vector_chunks(rowid INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, collection TEXT NOT NULL, record_id TEXT NOT NULL, version_id TEXT NOT NULL DEFAULT '', chunk INTEGER NOT NULL,
        chunk_start INTEGER NOT NULL, chunk_end INTEGER NOT NULL, text_sha256 TEXT NOT NULL, model_key TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL, UNIQUE(collection, record_id, version_id, chunk));
      CREATE INDEX IF NOT EXISTS main.vector_chunks_workspace ON vector_chunks(workspace_id, model_key);
      CREATE TABLE IF NOT EXISTS main.vector_queue(collection TEXT NOT NULL, record_id TEXT NOT NULL, workspace_id TEXT NOT NULL, enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        PRIMARY KEY(collection, record_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS main.vector_queue_workspace ON vector_queue(workspace_id);`);
    if (!current) setInfo('vectorIndexVersion', String(VECTOR_INDEX_VERSION));
    this.keys = keys;
    this.loadConfigs();
    if (keys && getInfo('vectorsSealed') !== '1') {
      for (const [workspaceId, config] of this.configs) if (config.enabled === 1) this.requeueWorkspace(workspaceId, now);
      setInfo('vectorsSealed', '1');
    }
  }
  /** Stored form of one chunk: plaintext digest and floats, or a sealed envelope under a keyed digest. */
  encode(row, digest, vector) {
    const bytes = toBlob(vector);
    return this.keys ? sealVectorRow(this.keys, row, digest, bytes) : { digest, blob: bytes };
  }
  decode(row) { return this.keys ? openVectorRow(this.keys, row) : { digest: row.text_sha256, bytes: row.vector }; }
  loadConfigs() {
    this.configs = new Map(this.db.prepare('SELECT * FROM vector_config').all().map(row => [row.workspace_id, row]));
  }
  config(workspaceId) { return this.configs.get(workspaceId) ?? null; }
  enabled(workspaceId) { return this.configs.get(workspaceId)?.enabled === 1; }
  /** Called inside the record commit transaction. */
  enqueue(collection, record, now) {
    if (!this.enabled(record.workspaceId)) return;
    this.db.prepare('INSERT INTO vector_queue(collection, record_id, workspace_id, enqueued_at) VALUES (?, ?, ?, ?) ON CONFLICT(collection, record_id) DO UPDATE SET workspace_id = excluded.workspace_id, enqueued_at = excluded.enqueued_at, attempts = 0, last_error = NULL')
      .run(collection, record.id, record.workspaceId, now);
  }
  /** Called inside the commit transaction for a deleted record. */
  remove(collection, id) {
    const rows = this.db.prepare('SELECT DISTINCT workspace_id FROM vector_chunks WHERE collection = ? AND record_id = ?').all(collection, id);
    this.db.prepare('DELETE FROM vector_chunks WHERE collection = ? AND record_id = ?').run(collection, id);
    this.db.prepare('DELETE FROM vector_queue WHERE collection = ? AND record_id = ?').run(collection, id);
    for (const row of rows) this.cache.delete(row.workspace_id);
    if (collection === 'workspaces') { this.db.prepare('DELETE FROM vector_config WHERE workspace_id = ?').run(id); this.configs.delete(id); }
  }
  /**
   * Called inside the commit transaction: drop vectors of capture versions that are restricted,
   * purged or gone (#17), whether or not embeddings are still enabled, so derived vectors never
   * outlive the text they were made from.
   */
  pruneWithheld(collection, record) {
    const keep = new Set((Array.isArray(record?.versions) ? record.versions : []).filter(version => version && typeof version.id === 'string' && version.access !== 'restricted' && !version.purged).map(version => version.id));
    const stale = this.db.prepare("SELECT DISTINCT version_id FROM vector_chunks WHERE collection = ? AND record_id = ? AND version_id <> ''").all(collection, record.id).map(row => row.version_id).filter(id => !keep.has(id));
    for (const versionId of stale) this.db.prepare('DELETE FROM vector_chunks WHERE collection = ? AND record_id = ? AND version_id = ?').run(collection, record.id, versionId);
    if (stale.length) this.cache.clear();
    return stale.length;
  }
  setConfig(row) {
    this.db.prepare(`INSERT INTO vector_config(workspace_id, enabled, model_id, provider, endpoint, embedding_model, model_key, locality, egress_acknowledged, min_similarity, dims, updated_at, last_error)
      VALUES (@workspace_id, @enabled, @model_id, @provider, @endpoint, @embedding_model, @model_key, @locality, @egress_acknowledged, @min_similarity, @dims, @updated_at, NULL)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled = excluded.enabled, model_id = excluded.model_id, provider = excluded.provider, endpoint = excluded.endpoint, embedding_model = excluded.embedding_model,
        model_key = excluded.model_key, locality = excluded.locality, egress_acknowledged = excluded.egress_acknowledged, min_similarity = excluded.min_similarity, dims = excluded.dims, updated_at = excluded.updated_at, last_error = NULL`)
      .run(Object.fromEntries(['workspace_id', 'enabled', 'model_id', 'provider', 'endpoint', 'embedding_model', 'model_key', 'locality', 'egress_acknowledged', 'min_similarity', 'dims', 'updated_at'].map(key => [key, row[key] ?? null])));
    this.loadConfigs();
  }
  setConfigState(workspaceId, fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (!['dims', 'last_error'].includes(key)) throw new Error('Unsupported vector config field');
      this.db.prepare(`UPDATE vector_config SET ${key} = ? WHERE workspace_id = ?`).run(value, workspaceId);
    }
    this.loadConfigs();
  }
  /** Remove derived vectors of a workspace (all of them, or those not produced by `keepModelKey`). */
  dropVectors(workspaceId, keepModelKey = null) {
    if (keepModelKey) this.db.prepare('DELETE FROM vector_chunks WHERE workspace_id = ? AND model_key <> ?').run(workspaceId, keepModelKey);
    else this.db.prepare('DELETE FROM vector_chunks WHERE workspace_id = ?').run(workspaceId);
    this.cache.delete(workspaceId);
  }
  /** Queue every indexed record of the workspace; unchanged chunks are reused by text digest. */
  requeueWorkspace(workspaceId, now) {
    // From the record table, not the search index: an encrypted profile builds its in-memory index in the background. Records that
    // have nothing to embed are dropped from the queue when processed.
    this.db.prepare(`INSERT INTO vector_queue(collection, record_id, workspace_id, enqueued_at) SELECT collection, id, workspace_id, ? FROM main.records WHERE workspace_id = ? AND collection <> 'workspaces'
      ON CONFLICT(collection, record_id) DO UPDATE SET enqueued_at = excluded.enqueued_at, attempts = 0, last_error = NULL`).run(now, workspaceId);
    this.cache.delete(workspaceId);
  }
  clearQueue(workspaceId) { this.db.prepare('DELETE FROM vector_queue WHERE workspace_id = ?').run(workspaceId); }
  queued(limit, workspaceIds) {
    const ids = [...workspaceIds];
    if (!ids.length) return [];
    return this.db.prepare(`SELECT collection, record_id, workspace_id, attempts FROM vector_queue WHERE workspace_id IN (${ids.map(() => '?').join(',')}) AND attempts < 5 ORDER BY enqueued_at, collection, record_id LIMIT ?`).all(...ids, limit);
  }
  pendingCount(workspaceId) { return this.db.prepare('SELECT count(*) AS count FROM vector_queue WHERE workspace_id = ?').get(workspaceId).count; }
  failQueued(collection, recordId, message) {
    this.db.prepare('UPDATE vector_queue SET attempts = attempts + 1, last_error = ? WHERE collection = ? AND record_id = ?').run(String(message).slice(0, 300), collection, recordId);
  }
  dequeue(collection, recordId) { this.db.prepare('DELETE FROM vector_queue WHERE collection = ? AND record_id = ?').run(collection, recordId); }
  /**
   * Stored chunks of one record with their plaintext text digest and vector bytes (opened for an encrypted profile), for
   * reuse when the record is embedded again. A chunk that fails authentication is not reused: re-embedding replaces it.
   */
  chunks(collection, recordId) {
    return this.db.prepare('SELECT workspace_id, collection, record_id, version_id, chunk, text_sha256, model_key, dims, vector, chunk_start, chunk_end FROM vector_chunks WHERE collection = ? AND record_id = ?').all(collection, recordId)
      .flatMap(row => { try { const { digest, bytes } = this.decode(row); return [{ ...row, text_sha256: digest, vector: bytes }]; } catch (error) { if (error.code === 'component_integrity') return []; throw error; } });
  }
  count(workspaceId, modelKey) { return this.db.prepare('SELECT count(*) AS count FROM vector_chunks WHERE workspace_id = ? AND model_key = ?').get(workspaceId, modelKey).count; }
  /** Replace every chunk of one record (all its documents) with the supplied rows. */
  replace(collection, recordId, workspaceId, rows) {
    this.db.prepare('DELETE FROM vector_chunks WHERE collection = ? AND record_id = ?').run(collection, recordId);
    const insert = this.db.prepare('INSERT INTO vector_chunks(workspace_id, collection, record_id, version_id, chunk, chunk_start, chunk_end, text_sha256, model_key, dims, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of rows) {
      const { digest, blob } = this.encode({ workspace_id: workspaceId, collection, record_id: recordId, version_id: row.versionId, chunk: row.chunk, model_key: row.modelKey, dims: row.vector.length }, row.sha256, row.vector);
      insert.run(workspaceId, collection, recordId, row.versionId, row.chunk, row.start, row.end, digest, row.modelKey, row.vector.length, blob);
    }
    this.cache.delete(workspaceId);
  }
  /** Every vector of one workspace for one model, cached until the workspace's vectors change. */
  matrix(workspaceId, modelKey) {
    const cached = this.cache.get(workspaceId);
    if (cached?.modelKey === modelKey) { this.cache.delete(workspaceId); this.cache.set(workspaceId, cached); return cached; }
    const rows = this.db.prepare('SELECT workspace_id, collection, record_id, version_id, chunk, chunk_start, chunk_end, text_sha256, model_key, dims, vector FROM vector_chunks WHERE workspace_id = ? AND model_key = ? ORDER BY rowid').all(workspaceId, modelKey);
    const entry = { modelKey, rows: rows.map(row => ({ collection: row.collection, record_id: row.record_id, version_id: row.version_id, chunk_start: row.chunk_start, chunk_end: row.chunk_end, dims: row.dims, vector: fromBlob(this.decode(row).bytes) })) };
    this.cache.set(workspaceId, entry);
    // Bound memory: keep matrices for the few most recently searched workspaces.
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
    return entry;
  }
  /** Exact cosine search; vectors are stored unit-normalized. Returns the best chunk per document. */
  search(workspaceId, modelKey, query, { minSimilarity = DEFAULT_MIN_SIMILARITY, limit = 100 } = {}) {
    const { rows } = this.matrix(workspaceId, modelKey);
    const best = new Map();
    for (const row of rows) {
      if (row.vector.length !== query.length) continue;
      let dot = 0;
      for (let i = 0; i < query.length; i++) dot += row.vector[i] * query[i];
      if (dot < minSimilarity) continue;
      const key = `${row.collection}\u0000${row.record_id}\u0000${row.version_id}`;
      const prior = best.get(key);
      if (!prior || dot > prior.similarity) best.set(key, { collection: row.collection, recordId: row.record_id, versionId: row.version_id, similarity: dot, start: row.chunk_start, end: row.chunk_end });
    }
    return [...best.values()].sort((a, b) => b.similarity - a.similarity || (a.recordId < b.recordId ? -1 : 1)).slice(0, limit);
  }
  /** Documents of a workspace and whether each has vectors for the model, for coverage reports. */
  coverage(workspaceId, modelKey) {
    return this.db.prepare(`SELECT d.collection, d.record_id, d.version_id, d.local_only,
        EXISTS(SELECT 1 FROM vector_chunks v WHERE v.collection = d.collection AND v.record_id = d.record_id AND v.version_id = d.version_id AND v.model_key = ?) AS embedded,
        q.last_error AS queue_error, q.record_id IS NOT NULL AS queued
      FROM search_docs d LEFT JOIN vector_queue q ON q.collection = d.collection AND q.record_id = d.record_id WHERE d.workspace_id = ? ORDER BY d.rowid`).all(modelKey ?? '', workspaceId);
  }
}
