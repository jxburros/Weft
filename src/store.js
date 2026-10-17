import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from './sqlite.js';
import { ComponentStore, sha256 } from './components.js';
import { syncDirectory } from './storage-safety.js';
import { rejectSecretKeys } from './export-safety.js';
import { SEARCH_INDEX_VERSION, compileQuery, indexable, recordDocument, versionDocument } from './search-index.js';
import { VectorIndex } from './vector-index.js';

export const STORE_FILE = 'workspace.sqlite';
export const COMPONENTS_DIR = 'components';
export const RECOVERY_DIR = 'recovery';
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_RETAINED_RESULT = 1024 * 1024;
export const OMITTED_RESULT = '{"$omitted":"size"}';
export const REQUEST_RETENTION = Object.freeze({ resultMs: 7 * 24 * 3600 * 1000, fingerprintMs: 30 * 24 * 3600 * 1000, maxEntries: 50000 });
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const recordKey = (collection, id) => `${collection}\u0000${id}`;
const segment = (item, index) => (item && typeof item === 'object' && typeof item.id === 'string' ? `#${item.id}` : String(index));
const isMarker = value => Boolean(value) && typeof value === 'object' && /^[0-9a-f]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size >= 0 && ['base64', 'utf8'].includes(value.encoding);
/** Fields whose bytes live in content-addressed components rather than the metadata row. */
export const heavyField = (collection, path, key) => /Base64$/.test(key) || (collection === 'artifacts' && key === 'text' && path.length === 2 && path[0] === 'versions');
const LAZY = new WeakMap();
const lazyMarker = (object, key) => { const descriptor = Object.getOwnPropertyDescriptor(object, key); return descriptor?.get ? LAZY.get(descriptor.get) : undefined; };
export const canonicalJson = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);

// Append-only: never edit a shipped migration. user_version records the applied version.
export const storeMigrations = Object.freeze([
  { version: 1, up: db => db.exec(`
    CREATE TABLE store_info(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE store_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE state_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE records(collection TEXT NOT NULL, id TEXT NOT NULL, workspace_id TEXT, seq INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY(collection, id)) WITHOUT ROWID;
    CREATE INDEX records_order ON records(collection, seq);
    CREATE INDEX records_workspace ON records(workspace_id, collection);
    CREATE TABLE component_refs(sha256 TEXT NOT NULL, collection TEXT NOT NULL, record_id TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(sha256, collection, record_id)) WITHOUT ROWID;
    CREATE INDEX component_refs_record ON component_refs(collection, record_id);
    CREATE TABLE requests(scope TEXT NOT NULL, request_id TEXT NOT NULL, command TEXT NOT NULL, fingerprint TEXT NOT NULL, workspace_id TEXT, result TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(scope, request_id)) WITHOUT ROWID;
    CREATE INDEX requests_age ON requests(created_at);
  `) },
]);
export const STORE_SCHEMA_VERSION = Math.max(...storeMigrations.map(item => item.version));

function fsyncPath(path) { const fd = openSync(path, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function removeDatabaseFiles(path) { for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true }); }

/**
 * Transactional SQLite metadata plus content-addressed components.
 *
 * WorkspaceService keeps its familiar in-memory state object. A commit diffs
 * each record document against what was last committed, so only changed rows,
 * their search documents and new components are written, inside one
 * transaction. Capture/file bytes become lazy, verified component reads.
 */
export class MetadataStore {
  constructor({ directory, file = STORE_FILE, assertOwned = () => {}, migrations = storeMigrations, clock = Date.now } = {}) {
    this.directory = directory;
    this.path = join(directory, file);
    this.assertOwned = assertOwned;
    this.migrations = migrations;
    this.clock = clock;
    this.components = new ComponentStore(join(directory, COMPONENTS_DIR));
    this.resetCaches();
    this.pending = null;
    this.lastPrune = 0;
  }
  static exists(directory) { return existsSync(join(directory, STORE_FILE)); }
  /** Interrupted creations/migrations never became the canonical file; remove them. */
  static cleanupTemporary(directory) {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) if (/^workspace\.sqlite\.(?:creating|migrating)-[0-9a-f-]{36}(?:-wal|-shm|-journal)?$/.test(name)) rmSync(join(directory, name), { force: true });
  }
  /** Build a complete store under a temporary name, verify it, then atomically make it canonical. */
  static create({ directory, state, info = {}, assertOwned, kind = 'creating', verify = true }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `${STORE_FILE}.${kind}-${randomUUID()}`;
    const temp = new MetadataStore({ directory, file: name, assertOwned });
    const expected = verify ? canonicalJson(normalizeHeavy(state)) : null;
    try {
      temp.open({ create: true });
      temp.commit(state);
      temp.transaction(() => { for (const [key, value] of Object.entries(info)) temp.setInfo(key, JSON.stringify(value)); });
      if (verify && canonicalJson(temp.materialize(temp.load())) !== expected) throw failure('STORE_VERIFY_FAILED', 'Migrated workspace did not match its source; the original has been preserved');
      temp.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      temp.db.prepare('PRAGMA journal_mode = DELETE').get();
      temp.close();
      fsyncPath(temp.path);
      renameSync(temp.path, join(directory, STORE_FILE));
      syncDirectory(directory);
    } catch (error) {
      temp.close();
      removeDatabaseFiles(temp.path);
      throw error;
    }
  }
  resetCaches() {
    this.docs = new Map();
    this.meta = new Map();
    this.markers = new Map();
    this.maxSeq = new Map();
    this.layout = new Set();
  }
  open({ create = false, readOnly = false } = {}) {
    if (!existsSync(this.path)) {
      if (!create) throw failure('STORE_MISSING', 'Workspace database is missing');
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(this.path, '', { flag: 'wx', mode: 0o600 });
    }
    let db;
    try {
      db = new DatabaseSync(this.path, readOnly ? { readOnly: true } : {});
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF');
      if (!readOnly) {
        if (db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') throw failure('STORE_UNSUPPORTED', 'Write-ahead logging is unavailable for this profile location');
        db.exec('PRAGMA synchronous = FULL; PRAGMA secure_delete = ON');
      }
      const check = db.prepare('PRAGMA quick_check').all();
      if (check.length !== 1 || check[0].quick_check !== 'ok') throw failure('STORE_CORRUPT', 'Workspace database failed its integrity check');
    } catch (error) {
      try { db?.close(); } catch { /* preserve the original error */ }
      if (/^STORE_(?:UNSUPPORTED)$/.test(error.code)) throw error;
      throw failure('STORE_CORRUPT', `Workspace database is unreadable or damaged (${error.code === 'STORE_CORRUPT' ? 'integrity check failed' : error.message}). It has been preserved unchanged; restore a verified backup with Weft closed.`);
    }
    this.db = db;
    this.readOnly = readOnly;
    try {
      if (!readOnly) {
        this.migrate(); this.ensureSearchIndex();
        this.vectors = new VectorIndex(db);
        this.vectors.ensure(key => this.info(key), (key, value) => this.setInfo(key, value));
      }
      else if (this.version() > STORE_SCHEMA_VERSION) throw failure('STORE_UNSUPPORTED', 'Workspace database was written by a newer Weft version');
      const stat = statSync(this.path);
      this.identity = `${stat.dev}:${stat.ino}`;
      this.dataVersion = this.readDataVersion();
    } catch (error) { this.close(); throw error; }
    return this;
  }
  close() { try { this.db?.close(); } catch { /* already closed */ } this.db = null; }
  assertOpen() { if (!this.db) throw failure('STORE_CLOSED', 'Workspace storage is closed'); }
  version() { return this.db.prepare('PRAGMA user_version').get().user_version; }
  readDataVersion() { return this.db.prepare('PRAGMA data_version').get().data_version; }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ } throw error; }
  }
  info(key) { try { return this.db.prepare('SELECT value FROM store_info WHERE key = ?').get(key)?.value; } catch { return undefined; } }
  setInfo(key, value) { this.db.prepare('INSERT INTO store_info(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }
  migrate() {
    const current = this.version();
    if (current > Math.max(...this.migrations.map(item => item.version))) throw failure('STORE_UNSUPPORTED', 'Workspace database was written by a newer Weft version; it has been preserved unchanged');
    const pending = this.migrations.filter(item => item.version > current).sort((a, b) => a.version - b.version);
    if (!pending.length) return;
    // Preserve a consistent copy of an existing database before any schema change.
    if (current > 0) this.preserveCopy(`pre-migration-v${current}`);
    for (const migration of pending) {
      this.transaction(() => {
        migration.up(this.db);
        this.db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
        this.db.prepare('INSERT INTO store_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, new Date(this.clock()).toISOString());
      });
    }
  }
  /** Consistent single-file copy of the committed database in recovery/. */
  preserveCopy(label) {
    const directory = join(this.directory, RECOVERY_DIR);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `workspace.${label}-${new Date(this.clock()).toISOString().replace(/[:.]/g, '')}-${randomUUID().slice(0, 8)}.sqlite`);
    this.vacuumInto(target);
    return target;
  }
  vacuumInto(target) {
    this.db.prepare('VACUUM INTO ?').run(target);
    chmodSync(target, 0o600);
    fsyncPath(target);
  }
  ensureSearchIndex() {
    const exists = this.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('search_docs', 'search_fts')").get().count === 2;
    // FTS5 secure-delete removes deleted tokens from the index immediately instead of leaving tombstoned segments (redaction, restriction, purge).
    if (exists && this.info('searchIndexVersion') === String(SEARCH_INDEX_VERSION)) {
      // Enabled once for indexes created before this option; opening never writes otherwise (other readers would see a change).
      if (this.db.prepare("SELECT v FROM search_fts_config WHERE k = 'secure-delete'").get()?.v !== 1) this.db.exec("INSERT INTO search_fts(search_fts, rank) VALUES('secure-delete', 1)");
      return;
    }
    this.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS search_fts; DROP TABLE IF EXISTS search_docs;
        CREATE TABLE search_docs(rowid INTEGER PRIMARY KEY, collection TEXT NOT NULL, record_id TEXT NOT NULL, version_id TEXT NOT NULL DEFAULT '', workspace_id TEXT, revision INTEGER, version_number INTEGER, local_only INTEGER NOT NULL DEFAULT 0, updated_at TEXT, UNIQUE(collection, record_id, version_id));
        CREATE INDEX search_docs_workspace ON search_docs(workspace_id);
        CREATE VIRTUAL TABLE search_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
        INSERT INTO search_fts(search_fts, rank) VALUES('secure-delete', 1);`);
      for (const row of this.db.prepare('SELECT collection, doc FROM records').iterate()) {
        const record = JSON.parse(row.doc);
        if (row.doc.includes('"$component"')) this.hydrate(row.collection, record, false);
        this.indexRecord(row.collection, record);
      }
      this.setInfo('searchIndexVersion', String(SEARCH_INDEX_VERSION));
    });
  }

  // ---- Loading and lazy components -------------------------------------------------
  load() {
    this.assertOpen();
    this.resetCaches();
    const state = {};
    for (const row of this.db.prepare('SELECT key, value FROM state_meta ORDER BY key').iterate()) { state[row.key] = JSON.parse(row.value); this.meta.set(row.key, row.value); }
    for (const name of JSON.parse(this.info('layout') || '[]')) { state[name] = []; this.layout.add(name); this.docs.set(name, new Map()); }
    for (const row of this.db.prepare('SELECT collection, id, seq, doc FROM records ORDER BY collection, seq').iterate()) {
      if (!this.layout.has(row.collection)) { this.layout.add(row.collection); state[row.collection] = []; this.docs.set(row.collection, new Map()); }
      state[row.collection].push(this.parse(row.collection, row.doc));
      this.docs.get(row.collection).set(row.id, { doc: row.doc, seq: row.seq });
      if (row.seq > (this.maxSeq.get(row.collection) || 0)) this.maxSeq.set(row.collection, row.seq);
    }
    this.dataVersion = this.readDataVersion();
    return state;
  }
  parse(collection, doc) {
    const record = JSON.parse(doc);
    if (doc.includes('"$component"')) this.hydrate(collection, record, true);
    return record;
  }
  hydrate(collection, record, register) {
    const found = [];
    const walk = (value, path) => {
      if (Array.isArray(value)) { value.forEach((item, index) => walk(item, [...path, segment(item, index)])); return; }
      if (!value || typeof value !== 'object') return;
      for (const key of Object.keys(value)) {
        const item = value[key];
        if (item && typeof item === 'object' && isMarker(item.$component) && Object.keys(item).length === 1 && heavyField(collection, path, key)) {
          delete value[key];
          this.defineLazy(value, key, item.$component);
          found.push({ path: path.join('/'), key, marker: item.$component });
        } else walk(item, [...path, key]);
      }
    };
    walk(record, []);
    if (register) { if (found.length) this.markers.set(recordKey(collection, record.id), found); else this.markers.delete(recordKey(collection, record.id)); }
    return found;
  }
  defineLazy(object, key, marker) {
    const store = this;
    const get = function () { return store.readComponent(marker); };
    LAZY.set(get, marker);
    Object.defineProperty(object, key, { configurable: true, enumerable: false, get,
      set(value) { Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true }); } });
  }
  componentMarker(object, key) { return lazyMarker(object, key); }
  /** Write a component ahead of the transaction that will reference it. */
  putComponent(bytes) { this.uncommittedComponents = true; return this.components.put(bytes); }
  readComponent(marker) {
    const pending = this.pending?.get(marker.sha256);
    if (pending !== undefined) return pending;
    const bytes = this.components.read(marker.sha256, marker.size);
    return marker.encoding === 'base64' ? bytes.toString('base64') : bytes.toString('utf8');
  }
  /** Deep copy for output, reading lazy components (verified on read). */
  materialize(value) {
    if (Array.isArray(value)) return value.map(item => this.materialize(item));
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const key of Object.keys(value)) output[key] = this.materialize(value[key]);
    for (const key of Object.getOwnPropertyNames(value)) if (!Object.prototype.propertyIsEnumerable.call(value, key) && lazyMarker(value, key)) output[key] = value[key];
    return output;
  }
  /** Restore lazy component fields that ordinary structuredClone/spread copies drop. */
  reattach(state) {
    if (!state || typeof state !== 'object') return state;
    const indexes = new Map();
    for (const [key, entries] of this.markers) {
      const [collection, id] = key.split('\u0000');
      if (!Array.isArray(state[collection])) continue;
      if (!indexes.has(collection)) indexes.set(collection, new Map(state[collection].filter(item => item && typeof item === 'object').map(item => [item.id, item])));
      const record = indexes.get(collection).get(id);
      if (!record) continue;
      for (const entry of entries) {
        const parent = resolvePath(record, entry.path);
        if (parent && !Object.hasOwn(parent, entry.key)) this.defineLazy(parent, entry.key, entry.marker);
      }
    }
    return state;
  }

  // ---- Serialization and diffing -----------------------------------------------------
  serialize(collection, record, { write }) {
    const key = recordKey(collection, record.id);
    const registered = this.markers.get(key);
    // Fast path: no registered or newly attached (non-enumerable) component fields.
    if (!registered && collection !== 'artifacts' && Object.getOwnPropertyNames(record).length === Object.keys(record).length) {
      const doc = JSON.stringify(record);
      if (!doc.includes('Base64"')) return { doc, markers: [] };
    }
    const byPath = new Map();
    for (const entry of registered || []) byPath.set(entry.path, [...(byPath.get(entry.path) || []), entry]);
    const markers = [];
    const walk = (value, path) => {
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map((item, index) => { const result = walk(item, [...path, segment(item, index)]); return result === undefined || typeof result === 'function' || typeof result === 'symbol' ? null : result; });
      const output = {};
      const heavy = new Map();
      const pathKey = path.join('/');
      for (const name of Object.keys(value)) {
        const item = value[name];
        if (typeof item === 'string' && heavyField(collection, path, name)) heavy.set(name, this.externalize(value, name, item, write));
        else { const result = walk(item, [...path, name]); if (result !== undefined && typeof result !== 'function' && typeof result !== 'symbol') output[name] = result; }
      }
      for (const name of Object.getOwnPropertyNames(value)) {
        if (heavy.has(name) || Object.prototype.propertyIsEnumerable.call(value, name)) continue;
        const marker = lazyMarker(value, name);
        if (marker) heavy.set(name, marker);
      }
      for (const entry of byPath.get(pathKey) || []) {
        if (Object.hasOwn(value, entry.key)) continue;
        this.defineLazy(value, entry.key, entry.marker);
        heavy.set(entry.key, entry.marker);
      }
      for (const name of [...heavy.keys()].sort()) { output[name] = { $component: heavy.get(name) }; markers.push({ path: pathKey, key: name, marker: heavy.get(name) }); }
      return output;
    };
    return { doc: JSON.stringify(walk(record, [])), markers };
  }
  externalize(object, name, value, write) {
    const encoding = /Base64$/.test(name) ? 'base64' : 'utf8';
    const bytes = Buffer.from(value, encoding);
    if (!write) return { sha256: sha256(bytes), size: bytes.length, encoding };
    const marker = { ...this.putComponent(bytes), encoding };
    if (encoding === 'utf8' && this.pending) this.pending.set(marker.sha256, value);
    this.defineLazy(object, name, marker);
    return marker;
  }
  plan(state) {
    if (!state || typeof state !== 'object') throw failure('STORE_INVALID', 'Workspace state must be an object');
    const plan = { meta: [], metaDeletes: [], collections: new Map(), upserts: [], reseq: [], deletes: [], layout: null };
    const keys = Object.keys(state).filter(key => state[key] !== undefined);
    const collections = keys.filter(key => isRecordArray(state[key]));
    for (const key of keys) {
      if (collections.includes(key)) continue;
      const json = JSON.stringify(state[key]);
      if (this.meta.get(key) !== json) plan.meta.push({ key, json, value: state[key] });
    }
    for (const key of this.meta.keys()) if (!keys.includes(key) || collections.includes(key)) plan.metaDeletes.push(key);
    for (const name of collections) {
      const previous = this.docs.get(name) || new Map();
      let maxSeq = this.maxSeq.get(name) || 0;
      let last = 0;
      let ordered = true;
      const rows = state[name].map(record => {
        const prior = previous.get(record.id);
        const { doc, markers } = this.serialize(name, record, { write: false });
        const seq = prior ? prior.seq : ++maxSeq;
        if (seq <= last) ordered = false;
        last = seq;
        return { collection: name, record, prior, doc, markers, seq, changed: !prior || prior.doc !== doc };
      });
      if (!ordered) { rows.forEach((row, index) => { if (row.seq !== index + 1) { row.seq = index + 1; row.reseq = true; } }); maxSeq = rows.length; }
      plan.collections.set(name, { rows, maxSeq });
      for (const row of rows) if (row.changed) plan.upserts.push(row); else if (row.reseq) plan.reseq.push(row);
      const ids = new Set(state[name].map(record => record.id));
      for (const id of previous.keys()) if (!ids.has(id)) plan.deletes.push({ collection: name, id });
    }
    for (const name of this.layout) if (!collections.includes(name)) for (const id of (this.docs.get(name) || new Map()).keys()) plan.deletes.push({ collection: name, id });
    const layout = [...collections].sort();
    if (canonicalJson(layout) !== canonicalJson([...this.layout].sort())) plan.layout = layout;
    return plan;
  }
  /** Created/updated/deleted records and changed settings that committing would produce. */
  changes(state) {
    const plan = this.plan(state);
    const limit = items => ({ count: items.length, items: items.slice(0, 1000) });
    return {
      created: limit(plan.upserts.filter(row => !row.prior).map(row => ({ collection: row.collection, id: row.record.id }))),
      updated: limit(plan.upserts.filter(row => row.prior).map(row => ({ collection: row.collection, id: row.record.id }))),
      deleted: limit(plan.deletes),
      state: [...plan.meta.map(item => item.key), ...plan.metaDeletes].sort(),
    };
  }
  commit(state, { requests = [], removeRequests = [], deferCollection = false } = {}) {
    this.assertOpen();
    this.assertOwned();
    const plan = this.plan(state);
    // Secret checks precede any component or row write.
    for (const row of plan.upserts) rejectSecretKeys(row.record);
    for (const item of plan.meta) rejectSecretKeys(item.value);
    if (!plan.upserts.length && !plan.reseq.length && !plan.deletes.length && !plan.meta.length && !plan.metaDeletes.length && !plan.layout && !requests.length && !removeRequests.length) return { released: [] };
    this.pending = new Map();
    try {
      for (const row of plan.upserts) {
        const result = this.serialize(row.collection, row.record, { write: true });
        row.doc = result.doc; row.markers = result.markers;
        if (Buffer.byteLength(row.doc) > MAX_DOCUMENT_BYTES) throw failure('STORE_SIZE_LIMIT', `A ${row.collection} record exceeds the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MiB document limit`);
      }
      this.assertIdentity();
      const released = new Set();
      this.transaction(() => {
        if (this.readDataVersion() !== this.dataVersion) throw failure('STORE_CONFLICT', 'Workspace database changed outside this session. Changes were not written; restart and review external changes before retrying.');
        const db = this.db;
        for (const item of plan.meta) db.prepare('INSERT INTO state_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(item.key, item.json);
        for (const key of plan.metaDeletes) db.prepare('DELETE FROM state_meta WHERE key = ?').run(key);
        const refsOf = (collection, id) => db.prepare('SELECT sha256 FROM component_refs WHERE collection = ? AND record_id = ?').all(collection, id).map(row => row.sha256);
        for (const row of plan.upserts) {
          const id = row.record.id;
          const workspaceId = row.collection === 'workspaces' ? id : typeof row.record.workspaceId === 'string' ? row.record.workspaceId : null;
          db.prepare('INSERT INTO records(collection, id, workspace_id, seq, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET workspace_id = excluded.workspace_id, seq = excluded.seq, doc = excluded.doc').run(row.collection, id, workspaceId, row.seq, row.doc);
          const next = new Map(row.markers.map(entry => [entry.marker.sha256, entry.marker.size]));
          for (const hash of refsOf(row.collection, id)) if (!next.has(hash)) released.add(hash);
          db.prepare('DELETE FROM component_refs WHERE collection = ? AND record_id = ?').run(row.collection, id);
          for (const [hash, size] of next) db.prepare('INSERT INTO component_refs(sha256, collection, record_id, size) VALUES (?, ?, ?, ?)').run(hash, row.collection, id, size);
          this.indexRecord(row.collection, row.record);
          if (row.collection === 'artifacts') this.vectors?.pruneUnindexed(row.collection, id);
          if (indexable(row.collection, row.record)) this.vectors?.enqueue(row.collection, row.record, this.clock());
        }
        for (const row of plan.reseq) db.prepare('UPDATE records SET seq = ? WHERE collection = ? AND id = ?').run(row.seq, row.collection, row.record.id);
        for (const item of plan.deletes) {
          db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(item.collection, item.id);
          for (const hash of refsOf(item.collection, item.id)) released.add(hash);
          db.prepare('DELETE FROM component_refs WHERE collection = ? AND record_id = ?').run(item.collection, item.id);
          this.unindexRecord(item.collection, item.id);
          this.vectors?.remove(item.collection, item.id);
        }
        if (plan.layout) this.setInfo('layout', JSON.stringify(plan.layout));
        for (const item of removeRequests) db.prepare('DELETE FROM requests WHERE scope = ? AND request_id = ?').run(item.scope, item.requestId);
        for (const item of requests) {
          const result = item.result === undefined ? null : JSON.stringify(item.result);
          db.prepare('INSERT INTO requests(scope, request_id, command, fingerprint, workspace_id, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(item.scope, item.requestId, item.command, item.fingerprint, item.workspaceId ?? null, result && Buffer.byteLength(result) > MAX_RETAINED_RESULT ? OMITTED_RESULT : result, this.clock());
        }
        this.pruneRequests();
      });
      this.applyPlan(plan);
      this.uncommittedComponents = false;
      const releasedList = [...released];
      if (!deferCollection) this.collectGarbage(releasedList);
      return { released: releasedList };
    } finally { this.pending = null; }
  }
  applyPlan(plan) {
    for (const item of plan.meta) this.meta.set(item.key, item.json);
    for (const key of plan.metaDeletes) this.meta.delete(key);
    for (const item of plan.deletes) { this.docs.get(item.collection)?.delete(item.id); this.markers.delete(recordKey(item.collection, item.id)); }
    for (const [name, { rows, maxSeq }] of plan.collections) {
      const docs = this.docs.get(name) || new Map();
      for (const row of rows) {
        if (row.changed || row.reseq) docs.set(row.record.id, { doc: row.doc, seq: row.seq });
        if (row.changed) { if (row.markers.length) this.markers.set(recordKey(name, row.record.id), row.markers); else this.markers.delete(recordKey(name, row.record.id)); }
      }
      this.docs.set(name, docs);
      this.maxSeq.set(name, maxSeq);
    }
    if (plan.layout) {
      for (const name of this.layout) if (!plan.layout.includes(name)) this.docs.delete(name);
      this.layout = new Set(plan.layout);
    }
    this.dataVersion = this.readDataVersion();
  }
  assertIdentity() {
    let stat;
    try { stat = statSync(this.path); } catch { stat = null; }
    if (!stat || `${stat.dev}:${stat.ino}` !== this.identity) throw failure('STORE_CONFLICT', 'Workspace database was replaced or removed outside this session. Changes were not written; restart and review the profile.');
  }
  /** Delete component files no committed record references any longer. */
  collectGarbage(hashes) {
    for (const hash of hashes) {
      if (!this.db.prepare('SELECT 1 FROM component_refs WHERE sha256 = ? LIMIT 1').get(hash)) this.components.remove(hash);
    }
  }
  /** Startup recovery: remove components and temporary files left by interrupted writes. */
  sweepOrphans() {
    const referenced = new Set(this.db.prepare('SELECT DISTINCT sha256 FROM component_refs').all().map(row => row.sha256));
    const { hashes, temporary } = this.components.list();
    this.components.removeTemporary(temporary);
    let removed = 0;
    for (const hash of hashes) if (!referenced.has(hash)) { this.components.remove(hash); removed++; }
    return { removed, temporary: temporary.length };
  }
  /** Verify every referenced component; returns problems without changing anything. */
  verifyComponents() {
    const problems = [];
    for (const row of this.db.prepare('SELECT sha256, min(size) AS size FROM component_refs GROUP BY sha256').iterate()) {
      try { this.components.read(row.sha256, row.size); } catch (error) { problems.push({ sha256: row.sha256, code: error.code, message: error.message }); }
    }
    return problems;
  }
  /**
   * After content is restricted or purged: merge the full-text index and truncate the write-ahead log so
   * removed rows and tokens do not linger in WAL frames. secure_delete already zeroes freed database content.
   */
  secureCompact() {
    this.assertOpen();
    this.db.exec("INSERT INTO search_fts(search_fts) VALUES('optimize')");
    this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  }
  checkpoint() { return { meta: new Map(this.meta), docs: new Map([...this.docs].map(([name, docs]) => [name, new Map(docs)])), layout: [...this.layout] }; }
  stateFrom(checkpoint) {
    const state = {};
    for (const [key, json] of checkpoint.meta) state[key] = JSON.parse(json);
    for (const name of checkpoint.layout) state[name] = [...(checkpoint.docs.get(name) || new Map())].sort((a, b) => a[1].seq - b[1].seq).map(([, { doc }]) => this.parse(name, doc));
    return state;
  }
  /** Return the last committed state, reusing unchanged in-memory objects. Components written for the discarded changes are removed. */
  revert(state) {
    if (this.uncommittedComponents && this.db) { this.uncommittedComponents = false; this.sweepOrphans(); }
    const restored = {};
    for (const [key, json] of this.meta) restored[key] = state && JSON.stringify(state[key]) === json ? state[key] : JSON.parse(json);
    for (const name of this.layout) {
      const live = new Map(Array.isArray(state?.[name]) ? state[name].filter(item => item && typeof item === 'object' && typeof item.id === 'string').map(item => [item.id, item]) : []);
      restored[name] = [...(this.docs.get(name) || new Map())].sort((a, b) => a[1].seq - b[1].seq).map(([id, { doc }]) => {
        const current = live.get(id);
        return current && this.serialize(name, current, { write: false }).doc === doc ? current : this.parse(name, doc);
      });
    }
    return restored;
  }
  contentDigest() {
    const hash = [];
    for (const row of this.db.prepare('SELECT key, value FROM state_meta ORDER BY key').iterate()) hash.push(`m\u0000${row.key}\u0000${row.value}`);
    for (const row of this.db.prepare('SELECT collection, id, doc FROM records ORDER BY collection, id').iterate()) hash.push(`r\u0000${row.collection}\u0000${row.id}\u0000${row.doc}`);
    return sha256(hash.join('\u0001'));
  }

  // ---- Search ------------------------------------------------------------------------
  indexRecord(collection, record) {
    const existing = this.db.prepare('SELECT rowid, version_id FROM search_docs WHERE collection = ? AND record_id = ?').all(collection, record.id);
    if (!indexable(collection, record)) { for (const row of existing) this.deleteDocument(row.rowid); return; }
    const documents = [recordDocument(collection, record)];
    const keep = new Set();
    if (collection === 'artifacts' && Array.isArray(record.versions)) {
      const indexed = new Set(existing.filter(row => row.version_id).map(row => row.version_id));
      for (const version of record.versions) {
        if (!version || typeof version.id !== 'string') continue;
        // Restricted originals and purged versions are never searchable; an existing row is removed.
        if (version.access === 'restricted' || version.purged) continue;
        keep.add(version.id);
        if (indexed.has(version.id)) continue;
        let text = '';
        try { text = version.text; } catch { /* index metadata even when a component is damaged */ }
        documents.push(versionDocument(record, version, text));
      }
    }
    for (const row of existing) if (!keep.has(row.version_id) || !row.version_id) this.deleteDocument(row.rowid);
    if (keep.size) this.db.prepare('UPDATE search_docs SET workspace_id = ?, local_only = ?, revision = ? WHERE collection = ? AND record_id = ?').run(record.workspaceId, record.localOnly === true ? 1 : 0, Number.isSafeInteger(record.revision) ? record.revision : null, collection, record.id);
    for (const document of documents) {
      const row = this.db.prepare('INSERT INTO search_docs(collection, record_id, version_id, workspace_id, revision, version_number, local_only, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(collection, record.id, document.versionId, record.workspaceId, document.revision, document.versionNumber, document.localOnly ? 1 : 0, document.updatedAt);
      this.db.prepare('INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)').run(row.lastInsertRowid, document.title, document.body);
    }
  }
  unindexRecord(collection, id) {
    for (const row of this.db.prepare('SELECT rowid FROM search_docs WHERE collection = ? AND record_id = ?').all(collection, id)) this.deleteDocument(row.rowid);
  }
  deleteDocument(rowid) {
    this.db.prepare('DELETE FROM search_fts WHERE rowid = ?').run(rowid);
    this.db.prepare('DELETE FROM search_docs WHERE rowid = ?').run(rowid);
  }
  /** BM25-ranked full-text search, scoped to one workspace inside the SQL query. */
  /** Title, excerpt and citation fields of one indexed document (vector-only results). */
  document({ collection, recordId, versionId = '', start = 0 }) {
    const row = this.db.prepare(`SELECT d.rowid AS rowid, d.collection, d.record_id, d.version_id, d.version_number, d.revision, d.local_only, d.updated_at, f.title AS title, substr(f.body, ?, 300) AS excerpt
      FROM search_docs d JOIN search_fts f ON f.rowid = d.rowid WHERE d.collection = ? AND d.record_id = ? AND d.version_id = ?`).get(Math.max(1, start + 1), collection, recordId, versionId);
    return row ? { ...row, excerpt: `${start ? '…' : ''}${String(row.excerpt || '').replace(/\s+/g, ' ').trim()}` } : null;
  }
  /** Number of documents a query matches in a workspace (all or any terms). */
  searchCount({ workspaceId, query }) {
    const compiled = compileQuery(query);
    if (!compiled || typeof workspaceId !== 'string') return 0;
    return this.db.prepare('SELECT count(*) AS count FROM search_fts JOIN search_docs d ON d.rowid = search_fts.rowid WHERE search_fts MATCH ? AND d.workspace_id = ?').get(compiled.any ?? compiled.all, workspaceId).count;
  }
  /** Indexed documents of a workspace (lexical coverage). */
  documentCount(workspaceId) { return this.db.prepare('SELECT count(*) AS count FROM search_docs WHERE workspace_id = ?').get(workspaceId).count; }
  search({ workspaceId, query, limit = 50 }) {
    this.assertOpen();
    const compiled = compileQuery(query);
    if (!compiled || typeof workspaceId !== 'string') return [];
    // Rank first; build excerpts only for the returned rows.
    const statement = this.db.prepare(`SELECT d.rowid AS rowid, d.collection, d.record_id, d.version_id, d.version_number, d.revision, d.local_only, d.updated_at, bm25(search_fts, 6.0, 1.0) AS score
      FROM search_fts JOIN search_docs d ON d.rowid = search_fts.rowid
      WHERE search_fts MATCH ? AND d.workspace_id = ? ORDER BY score, d.rowid LIMIT ?`);
    // FTS5 snippet() scores every fragment of large captures; a direct scan for the first query token is far cheaper.
    const text = this.db.prepare('SELECT title, body FROM search_fts WHERE rowid = ?');
    const pattern = new RegExp(compiled.tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'iu');
    const excerpt = (matched, rowid) => {
      const { title, body } = text.get(rowid);
      const at = Math.max(0, (body.search(pattern) || 0) - 80);
      return { title, excerpt: `${at ? '…' : ''}${body.slice(at, at + 300).replace(/\s+/g, ' ').trim()}` };
    };
    const rows = statement.all(compiled.all, workspaceId, limit).map(row => ({ ...row, match: 'all', query: compiled.all }));
    if (rows.length < limit && compiled.any) {
      const seen = new Set(rows.map(row => row.rowid));
      for (const row of statement.all(compiled.any, workspaceId, limit + rows.length)) {
        if (rows.length >= limit) break;
        if (!seen.has(row.rowid)) rows.push({ ...row, match: 'partial', query: compiled.any });
      }
    }
    return rows.map(({ query: matched, ...row }) => ({ ...row, ...excerpt(matched, row.rowid) }));
  }

  // ---- Request identity ----------------------------------------------------------------
  request(scope, requestId) {
    this.assertOpen();
    return this.db.prepare('SELECT command, fingerprint, workspace_id AS workspaceId, result, created_at AS createdAt FROM requests WHERE scope = ? AND request_id = ?').get(scope, requestId);
  }
  pruneRequests(force = false) {
    const now = this.clock();
    if (!force && now - this.lastPrune < 60000) return;
    this.lastPrune = now;
    this.db.prepare('DELETE FROM requests WHERE created_at < ?').run(now - REQUEST_RETENTION.fingerprintMs);
    this.db.prepare('UPDATE requests SET result = NULL WHERE created_at < ? AND result IS NOT NULL').run(now - REQUEST_RETENTION.resultMs);
    this.db.prepare('DELETE FROM requests WHERE (scope, request_id) IN (SELECT scope, request_id FROM requests ORDER BY created_at DESC LIMIT -1 OFFSET ?)').run(REQUEST_RETENTION.maxEntries);
  }
}

function isRecordArray(value) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id || item.id.length > 512 || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}
function resolvePath(record, path) {
  let current = record;
  for (const part of path ? path.split('/') : []) {
    if (!current || typeof current !== 'object') return null;
    current = Array.isArray(current) ? (part.startsWith('#') ? current.find(item => item?.id === part.slice(1)) : current[Number(part)]) : current[part];
  }
  return current && typeof current === 'object' ? current : null;
}
/** Comparable form of source state: base64 fields in canonical encoding. */
function normalizeHeavy(value, key = '') {
  if (Array.isArray(value)) return value.map(item => normalizeHeavy(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([name, item]) => [name, normalizeHeavy(item, name)]));
  if (typeof value === 'string' && /Base64$/.test(key)) return Buffer.from(value, 'base64').toString('base64');
  return value;
}
