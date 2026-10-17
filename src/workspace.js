import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { workspaceSchemas, recordShapes, finishReason } from './workspace-commands.js';
import { acquireProfileLock, storageWarnings, syncDirectory } from './storage-safety.js';
import { CURRENT_SCHEMA_VERSION, migrateSchema } from './migrations.js';
import { secretKey, rejectSecretKeys, inspectExportResidue } from './export-safety.js';
import { MetadataStore, OMITTED_RESULT, RECOVERY_DIR, canonicalJson } from './store.js';
import { componentPath, sha256 } from './components.js';
import { cleanupBackupTemporary, createBackup, deleteBackup, listBackups, pruneBackups, recoverInterruptedRestore, restoreBackup, verifyBackup } from './backups.js';
import { executeHandoffCommand, importHandoffs, recordTakeover } from './handoffs.js';
import { effectiveRule, explainRules } from './site-rules.js';
import { originFor, importedOrigin } from './provenance.js';
import { TRUSTED_CATEGORIES, buildCitations, exportCollections, exportMaterial, forCaller, importCollections, importConflicts, importContextFields, linkedOmissions, prefetchSourceTexts, quotedSources, recheckCitations, sharedAccess, sharedInto } from './context-records.js';

const collections = [...Object.keys(recordShapes), 'artifacts'];
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const uuid = prefix => `${prefix}_${randomUUID()}`;
const digest = value => sha256(value);
const MAX_FILE = 100 * 1024 * 1024;
const MAX_PACKAGE_RECORDS_FILE = 256 * 1024 * 1024;
const LEGACY_FILE = 'workspace-state.json';
const TRANSFERS_DIR = 'transfers';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REPLAYED = Symbol.for('weft.replayed');
const urlSecret = /token|secret|password|credential|authorization|api.?key|session|signature|^code$|^key$/i;
const fail = (code, message, extra = {}) => Object.assign(new Error(`${code.toUpperCase()}: ${message}`), { code, ...extra });
const HUMAN_ADMIN = new Set(['siteRules.review', 'settings.update', 'workspaces.delete', 'workspaces.import', 'workspaces.export', 'workspaces.switch', 'workspaces.exportPackage', 'workspaces.importPackage', 'backups.create', 'backups.list', 'backups.verify', 'backups.restore', 'backups.delete']);
// activity.list is served by the durable activity log (src/activity-log.js) through the dispatcher.
const READS = new Set(['history.list', 'bookmarks.list', 'workspace.snapshot', 'settings.get', 'search.query', 'workspaces.list', 'workspaces.get', 'workspaces.export', ...collections.flatMap(name => [`${name}.list`, `${name}.get`])]);
// Batches contain record writes only: these can be rolled back exactly.
export const BATCHABLE = Object.freeze(new Set([...Object.keys(recordShapes).flatMap(name => [`${name}.create`, `${name}.update`, `${name}.delete`]),
  'tasks.transition', 'conversations.message', 'artifacts.create', 'artifacts.annotate', 'artifacts.delete', 'bookmarks.create', 'bookmarks.delete', 'workspaces.update', 'settings.update']));
const WITH_EFFECTS = new Set(['workspaces.create', 'workspaces.switch', 'workspaces.archive', 'workspaces.delete', 'workspaces.import', 'workspaces.importPackage']);
const ID_TOKEN = /\b[a-z]{2,12}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const EXPORT_EXCLUDED = Object.freeze(['Browser sessions, tabs, cookies and site storage', 'Credentials, provider keys and model connection settings', 'Global site rules', 'Activity log and browsing history', 'Local search index and request identities', 'Local backups',
  'Site storage modes and exceptions: browser privacy policy for this profile; set them again after import',
  'Community list subscriptions: signed list state is verified on install; subscribe again to receive and track rules',
  'Approvals, autonomy ceilings and agent connection grants: authority is never transferred with data',
  'Shared collection participants and roles: grants to other workspaces are authority and must be given again',
  'Linked file and folder contents and local paths, service credentials and cached service content: relink or refresh after import',
  'Scheduled freshness check settings']);
/** Workspace-scoped collections handled outside recordShapes: shared collections, evidence conflicts and freshness policies. */
const KNOWLEDGE_COLLECTIONS = Object.freeze(['sharedCollections', 'conflicts', 'freshnessPolicies']);
// Workspace-scoped profile state that is deliberately not part of the export format (listed above with the reason).
const NOT_EXPORTED = new Set(['storagePolicies', 'siteLists', 'freshnessPolicies']);

export function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    if (url.href === 'about:blank') return url.href;
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (urlSecret.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}
// Capture text and binary fields are hashed components: never rewrite them.
function cleanExport(value, key = '', parent = '') {
  if (Array.isArray(value)) return value.map(item => cleanExport(item, '', key));
  // Quote selectors are cited evidence text, kept exactly so citations re-anchor after import.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => !secretKey.test(name)).map(([name, item]) => [name, (parent === 'versions' && name === 'text') || /Base64$/.test(name) || name === '$component' || (parent === 'citations' && ['exact', 'prefix', 'suffix'].includes(name)) ? item : cleanExport(item, name)]));
  if (typeof value === 'string' && (/url|endpoint/i.test(key) || (/^https?:\/\//i.test(value) && !/\s/.test(value)))) return sanitizeUrl(value);
  return value;
}
function normalizeHostname(value) {
  if (/[\s/@?#:\\]/.test(value)) throw new Error('Use a hostname without scheme, port or path');
  const hostname = domainToASCII(value.toLowerCase().replace(/\.$/, ''));
  if (!hostname || hostname.length > 253 || hostname.split('.').some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw new Error('Invalid hostname');
  return hostname;
}
function validateStoredState(data) {
  if (!Array.isArray(data.workspaces) || !data.workspaces.length || !collections.every(name => Array.isArray(data[name])) || !Array.isArray(data.activity) || !Array.isArray(data.history) || !data.settings || !Array.isArray(data.browserSession?.tabs)) throw new Error('Unsupported or invalid workspace schema; existing state has been preserved');
  const workspaceIds = new Set(data.workspaces.map(item => item.id));
  if (!data.workspaces.some(item => item.id === data.activeWorkspaceId && !item.archived)) throw new Error('Workspace state has no active workspace; existing state has been preserved');
  const allRecords = [...data.workspaces, ...collections.flatMap(name => data[name])];
  const ids = new Set();
  for (const record of allRecords) {
    if (!record || typeof record.id !== 'string' || ids.has(record.id)) throw new Error('Invalid or duplicate stored record ID; existing state has been preserved');
    ids.add(record.id);
  }
  for (const name of collections) for (const record of data[name]) {
    if (!(name === 'siteRules' && record.scope === 'global' && record.workspaceId === null) && !workspaceIds.has(record.workspaceId)) throw new Error('Invalid stored workspace reference; existing state has been preserved');
  }
}
function createRecord(fields, workspaceId, prefix = 'record') {
  const timestamp = now();
  return { id: uuid(prefix), workspaceId, ...fields, createdAt: timestamp, updatedAt: timestamp, revision: 1 };
}
function createWorkspace(name = 'My workspace') {
  const record = createRecord({ name, description: '', color: '#7563A8', icon: 'W', archived: false }, undefined, 'ws');
  delete record.workspaceId;
  return record;
}
function initialState() {
  const initial = createWorkspace();
  return { schemaVersion: CURRENT_SCHEMA_VERSION, activeWorkspaceId: initial.id, workspaces: [initial], ...Object.fromEntries(collections.map(name => [name, []])), history: [], activity: [], settings: { theme: 'system', model: { provider: 'compatible', endpoint: 'http://localhost:11434/v1', model: '' }, sidebarCollapsed: false, agentPanelOpen: false }, browserSession: { tabs: [], activeId: null }, handoffs: [],
    ...Object.fromEntries(KNOWLEDGE_COLLECTIONS.map(name => [name, []])) };
}
function artifactSummary(record) {
  const copy = clone(record);
  copy.versions = copy.versions.map(({ text, pngBase64, ...metadata }) => metadata);
  return copy;
}
const withoutFile = record => clone(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'fileBase64')));
function fsyncFile(path) { const fd = openSync(path, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function markReplayed(value) {
  if (value && typeof value === 'object') Object.defineProperty(value, REPLAYED, { value: true });
  return value;
}
function substitutePlaceholders(value, index, results) {
  if (typeof value === 'string') {
    const match = /^\$(\d+)\.id$/.exec(value);
    if (!match || !results) return value;
    const source = Number(match[1]);
    if (source >= index || typeof results[source]?.id !== 'string') throw fail('invalid_arguments', `Placeholder ${value} must name the id of an earlier batch result`);
    return results[source].id;
  }
  if (Array.isArray(value)) return value.map(item => substitutePlaceholders(item, index, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitutePlaceholders(item, index, results)]));
  return value;
}
const componentRef = z.strictObject({ $component: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0), encoding: z.enum(['base64', 'utf8']) }) });
const timestamp = z.string().max(100);
const historyEntry = z.object({ revision: z.number().int().min(1), content: z.string().max(500000), actor: z.string().max(200).default('human'), createdAt: timestamp, origin: z.unknown().optional() });
const messageSchema = z.object({ id: z.string().max(128).optional(), role: z.enum(['user', 'assistant', 'system', 'tool']), content: z.string().max(500000), createdAt: timestamp, model: z.string().max(200).optional(), localOnly: z.boolean().optional(), status: z.string().max(30).optional(), attachments: z.array(z.string().max(128)).max(1000).optional(),
  turnId: z.string().max(128).optional(), finishReason: finishReason.optional(), continuable: z.boolean().optional() });
const annotationSchema = z.object({ note: z.string().max(500000).default(''), tags: z.array(z.string().max(100)).max(100).optional(), revision: z.number().int().min(1).optional(), actor: z.string().max(200).optional(), createdAt: timestamp.optional() });
const versionSchema = z.object({ id: z.string().max(128).optional(), number: z.number().int().min(1).optional(), createdAt: timestamp.optional(), actor: z.string().max(200).optional(), method: z.string().max(50).optional(),
  url: z.string().max(16384).nullable().optional(), title: z.string().max(240).optional(), text: z.union([z.string().max(2000000), componentRef]).optional(), pngBase64: z.union([z.string().max(28000000), componentRef]).optional(),
  components: z.array(z.object({ type: z.string().max(100), size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(10).optional(),
  navigationVersion: z.number().int().nullable().optional(), limitations: z.array(z.string().max(2000)).max(50).optional(), redactionStatus: z.string().max(50).optional(), previousVersionId: z.string().max(128).nullable().optional(), origin: z.unknown().optional() });
const artifactSchema = z.object({ title: z.string().min(1).max(240), note: z.string().max(500000).default(''), tags: z.array(z.string().max(100)).max(100).default([]), versions: z.array(versionSchema).max(1000), annotations: z.array(annotationSchema).max(10000).default([]) });
const SYSTEM_FIELDS = { common: ['id', 'workspaceId', 'createdAt', 'updatedAt', 'revision'], materials: ['history', 'size', 'sha256', 'link', 'service', 'copiedFrom', 'superseded', 'derivedFrom', 'lastOrigin'],
  context: ['history', 'proposal', 'promotedFrom', 'promotionNote', 'superseded', 'derivedFrom', 'lastOrigin'], conversations: ['messages', 'turnManifests'], artifacts: ['versions', 'annotations'],
  siteRules: ['createdBy', 'revisions', 'lastReviewedAt', 'lastReviewedBy'] };
// Site-rule provenance (#19) travels with format 2 exports: who created the rule, its bounded revision history and review state.
const ruleRevisionSchema = z.object({ revision: z.number().int().min(1), actor: z.string().max(200), at: timestamp, summary: z.string().max(2400), changed: z.array(z.string().max(100)).max(50).default([]),
  previous: z.record(z.string().max(100), z.unknown()).optional() });
const packageManifest = z.strictObject({ format: z.literal('weft-package'), formatVersion: z.literal(1), createdAt: z.string().max(40), workspace: z.strictObject({ name: z.string().max(240) }),
  files: z.array(z.strictObject({ path: z.string().max(200), size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(1000000) });

/**
 * Workspace records over transactional SQLite metadata and content-addressed
 * component files. The in-memory `data` object keeps the established API;
 * every mutation commits the changed records atomically or rolls back.
 */
export class WorkspaceService {
  constructor({ directory, browser, onWarning = warning => console.warn(`Weft storage: ${warning.message}`), backups = null, clock = Date.now } = {}) {
    if (!directory) throw new Error('Workspace data directory is required');
    this.directory = directory;
    this.lock = acquireProfileLock(directory);
    this.browser = browser;
    this.queue = Promise.resolve();
    this.onWarning = onWarning;
    this.warned = new Set();
    this.clock = clock;
    try {
      this.refreshStorageWarnings();
      this.recoveredRestore = recoverInterruptedRestore(directory);
      cleanupBackupTemporary(directory);
      MetadataStore.cleanupTemporary(directory);
      this.openStorage();
      this.path = this.storage.path;
      this.storage.sweepOrphans();
    } catch (error) { this.storage?.close(); this.lock.release(); throw error; }
    const service = this;
    this.store = { get data() { return service.data; }, save: () => service.save() };
    this.backupPolicy = { automatic: Boolean(backups?.automatic), intervalHours: backups?.intervalHours ?? 24, keep: backups?.keep ?? 5, lastRunAt: null, lastError: null };
    if (this.backupPolicy.automatic) {
      this.backupTimer = setInterval(() => this.runAutomaticBackup(), 3600 * 1000);
      this.backupTimer.unref?.();
      setImmediate(() => this.runAutomaticBackup());
    }
  }
  get data() { return this._data; }
  // Restoring a structuredClone of state must keep component-backed fields.
  set data(value) { this._data = this.storage ? this.storage.reattach(value) : value; }
  openStorage() {
    const assertOwned = () => this.lock.assertOwned();
    const legacy = join(this.directory, LEGACY_FILE);
    if (!MetadataStore.exists(this.directory)) {
      if (existsSync(legacy)) this.migrateLegacy(legacy, assertOwned);
      else {
        if (this.storageWarnings.some(warning => ['SYNC_CONFLICT_COPY', 'SYNC_PLACEHOLDER'].includes(warning.code))) throw new Error('STORE_CONFLICT: Workspace copies/placeholders require human review before creating a new store.');
        MetadataStore.create({ directory: this.directory, state: initialState(), assertOwned, verify: false, info: { createdAt: now() } });
      }
    }
    const storage = new MetadataStore({ directory: this.directory, assertOwned, clock: this.clock }).open();
    try {
      if (existsSync(legacy)) this.finishLegacyMigration(storage, legacy);
      let data = storage.load();
      // A record collection introduced after this database was created starts empty.
      for (const name of collections) if (data[name] === undefined) data[name] = [];
      // Handoffs were added without a schema bump; older stores start with none.
      if (!Array.isArray(data.handoffs)) data.handoffs = [];
      // Shared collections, conflicts and freshness policies (#21, #23) were also added without a schema bump.
      for (const name of KNOWLEDGE_COLLECTIONS) if (!Array.isArray(data[name])) data[name] = [];
      if (data.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        const migrated = storage.reattach(migrateSchema(data, { validate: validateStoredState }));
        rejectSecretKeys(migrated);
        storage.preserveCopy(`pre-data-schema-${data.schemaVersion}`);
        storage.commit(migrated);
        data = migrated;
      } else validateStoredState(data);
      rejectSecretKeys(data);
      this.storage = storage;
      this.data = data;
    } catch (error) { storage.close(); throw error; }
  }
  /** Lossless one-time move from the JSON store; the original bytes are preserved under recovery/. */
  migrateLegacy(legacy, assertOwned) {
    if (statSync(legacy).size > MAX_FILE) throw new Error('STORE_SIZE_LIMIT: Workspace state exceeds supported 100 MiB size; existing state preserved.');
    const original = readFileSync(legacy);
    let raw;
    try { raw = JSON.parse(original.toString('utf8')); } catch { throw new Error('Workspace state is unreadable. Preserve workspace-state.json and restore from an export or backup.'); }
    const data = migrateSchema(raw, { validate: validateStoredState });
    rejectSecretKeys(data);
    const source = digest(original);
    this.preserveLegacy(original, source);
    MetadataStore.create({ directory: this.directory, state: data, assertOwned, kind: 'migrating', info: { createdAt: now(), migratedFrom: { file: LEGACY_FILE, sha256: source, schemaVersion: raw.schemaVersion, migratedAt: now() } } });
  }
  finishLegacyMigration(storage, legacy) {
    const bytes = readFileSync(legacy);
    const source = JSON.parse(storage.info('migratedFrom') || 'null');
    if (source?.sha256 !== digest(bytes)) throw new Error('STORE_CONFLICT: Both workspace.sqlite and a different workspace-state.json exist (an older Weft version may have written the JSON file). Neither was changed; review them and move one aside with Weft closed.');
    this.preserveLegacy(bytes, source.sha256);
    unlinkSync(legacy);
    syncDirectory(this.directory);
  }
  preserveLegacy(bytes, hash) {
    const directory = join(this.directory, RECOVERY_DIR);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `workspace-state.${hash}.json`);
    if (existsSync(path) && digest(readFileSync(path)) === hash) return path;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
      fsyncFile(temp);
      if (digest(readFileSync(temp)) !== hash) throw new Error('Migration backup verification failed; original preserved');
      renameSync(temp, path);
      syncDirectory(directory);
    } finally { rmSync(temp, { force: true }); }
    return path;
  }
  close() {
    this.closed = true;
    clearInterval(this.backupTimer);
    this.storage?.close();
    this.lock.release();
  }
  refreshStorageWarnings() {
    this.storageWarnings = storageWarnings(this.directory);
    for (const warning of this.storageWarnings) {
      const key = JSON.stringify(warning);
      if (!this.warned.has(key)) { this.warned.add(key); this.onWarning(warning); }
    }
    return this.storageWarnings;
  }

  recordVisit({ workspaceId, url, title, tabId }) {
    const cleanUrl = sanitizeUrl(url);
    if (!cleanUrl || cleanUrl === 'about:blank') return;
    const before = clone(this.data.history || []);
    this.data.history ??= [];
    const previous = this.data.history.at(-1);
    try {
      if (previous?.url === cleanUrl && previous.tabId === tabId && Date.now() - Date.parse(previous.visitedAt) < 2000) previous.title = String(title || cleanUrl).slice(0, 1000);
      else {
        this.data.history.push({ id: uuid('visit'), workspaceId, url: cleanUrl, title: String(title || cleanUrl).slice(0, 1000), tabId, visitedAt: now() });
        const current = this.data.history.filter(item => item.workspaceId === workspaceId);
        if (current.length > 1000) { const remove = new Set(current.slice(0, current.length - 1000).map(item => item.id)); this.data.history = this.data.history.filter(item => !remove.has(item.id)); }
      }
      this.save();
    } catch (error) { this.data.history = before; throw error; }
  }

  get activeWorkspaceId() { return this.data.activeWorkspaceId; }
  attachBrowser(browser) { this.browser = browser; }
  save(options = {}) {
    this.lock.assertOwned();
    return this.storage.commit(this.data, options);
  }
  /**
   * Discard uncommitted in-memory changes by returning to the last committed
   * state. Modules that share this store (handoffs, community lists, site
   * storage, extensions) call this on failure instead of restoring a partial
   * copy, so every collection and the activity entries of the failed change
   * roll back together.
   */
  rollback() { this.data = this.storage.revert(this.data); }
  /** Run a synchronous change to `data` from a sharing module, committing it in one transaction or rolling it back. */
  commitChange(work) {
    try { const result = work(); this.save(); return result; }
    catch (error) { this.rollback(); throw error; }
  }
  persistSession(session) {
    const before = this.data.browserSession;
    this.data.browserSession = {
      tabs: session.tabs.map(tab => ({ id: tab.id, workspaceId: tab.workspaceId, url: sanitizeUrl(tab.url) || 'about:blank', title: String(tab.title || '').slice(0, 1000), pinned: Boolean(tab.pinned), version: tab.version || 0, group: String(tab.group || '').slice(0, 100),
        controller: tab.controller === 'human' ? 'human' : 'available', ...(tab.controller === 'human' && tab.assistant && { assistant: String(tab.assistant).slice(0, 200) }) })),
      activeId: session.activeId ?? null,
    };
    try { this.save(); } catch (error) { this.data.browserSession = before; throw error; }
  }
  snapshot() {
    return { ...clone(this.data), storageWarnings: clone(this.refreshStorageWarnings()), artifacts: this.data.artifacts.map(artifactSummary), materials: this.data.materials.map(withoutFile) };
  }
  workspace(id = this.activeWorkspaceId) {
    const record = this.data.workspaces.find(item => item.id === id);
    if (!record) throw new Error('Workspace not found');
    return record;
  }
  /**
   * Find a record inside the caller's workspace. `shared: true` (reads only) also admits a
   * record shared into that workspace through an active collection membership (#21), so
   * people, internal models and agents meet the same collection boundary.
   */
  record(collection, id, context = {}, { shared = false } = {}) {
    const record = this.data[collection]?.find(item => item.id === id);
    if (!record) throw new Error(`${collection} record not found`);
    if (context.workspaceId && record.workspaceId && record.workspaceId !== context.workspaceId && !(shared && sharedAccess(this.data, collection, record, context.workspaceId))) throw new Error('PERMISSION_REQUIRED: record is outside the authorized workspace');
    return record;
  }
  /** Validate a command's arguments with its catalog schema (used by modules that compose record commands). */
  parseCommand(name, input) {
    const { requestId, dryRun, ...args } = workspaceSchemas[name].parse(input);
    return args;
  }
  /** Run a module command inside the mutation queue; it commits atomically or rolls back with its activity. */
  executeModule(work, context = {}) {
    const run = this.queue.then(() => { context.assertAuthorized?.(); this.storage.assertOpen(); return this.transact(work, { context }); });
    this.queue = run.catch(() => {});
    return run;
  }
  /** Insert a record created by a trusted module path (promotion, merge) with its server-set origin. */
  insertRecord(collection, fields, workspaceId, origin) {
    const record = createRecord(fields, workspaceId, collection.slice(0, 4));
    record.origin = origin;
    if (['materials', 'context'].includes(collection)) record.history = [{ revision: 1, content: record.content, actor: origin.actor, createdAt: record.createdAt, origin }];
    this.data[collection].push(record);
    this.log(`${collection}.create`, workspaceId, record.id, origin.actor, origin.promotion ? 'Promoted from a proposal' : origin.conflictId ? 'Created by conflict resolution' : '');
    return record;
  }
  /** Deep copy for callers, including verified component-backed content. */
  output(value) { return value === undefined ? null : this.storage.materialize(value); }
  log(action, workspaceId, targetId, actor = 'human', detail = '') {
    this.data.activity.push({ id: uuid('event'), workspaceId, targetId, action, actor, detail, createdAt: now() });
  }
  /** Ordinary activity retention (age/count). Records and artifacts are never removed by retention. */
  pruneActivity({ cutoff = null, maxEntries = null } = {}) {
    const run = this.queue.then(() => {
      const before = this.data.activity;
      let kept = cutoff ? before.filter(item => String(item.createdAt) >= cutoff) : before;
      if (maxEntries && kept.length > maxEntries) kept = kept.slice(-maxEntries);
      if (kept.length === before.length) return 0;
      return this.commitChange(() => { this.data.activity = kept; return before.length - kept.length; });
    });
    this.queue = run.catch(() => {});
    return run;
  }
  matchSiteRule(value, workspaceId = this.activeWorkspaceId) {
    return clone(effectiveRule(this.data.siteRules, value, workspaceId));
  }
  /** Every matching rule with explicit precedence; browser adds exceptions/security findings. */
  explainSiteRules(value, workspaceId = this.activeWorkspaceId, extras = {}) {
    this.workspace(workspaceId);
    return clone(explainRules(this.data.siteRules, value, workspaceId, extras));
  }
  getConversation(id) { return clone(this.record('conversations', id)); }
  appendMessage(id, message) { return this.execute('conversations.message', { id, ...message }); }
  recordTurnManifest(id, manifest) {
    const run = this.queue.then(() => {
      rejectSecretKeys(manifest);
      return this.transact(() => {
        const record = this.record('conversations', id);
        record.turnManifests ??= [];
        const index = record.turnManifests.findIndex(item => item.id === manifest.id);
        if (index < 0) record.turnManifests.push(clone(manifest));
        else record.turnManifests[index] = clone(manifest);
        this.log('chat.turn', record.workspaceId, id, 'model', JSON.stringify(manifest));
      }).then(() => undefined);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  executeHandoff(name, args = {}, context = {}) {
    const run = this.queue.then(() => executeHandoffCommand(this, name, args, context));
    this.queue = run.catch(() => {});
    return run;
  }
  recordTakeover(details) {
    const run = this.queue.then(() => recordTakeover(this, details));
    this.queue = run.catch(() => {});
    return run;
  }
  execute(name, args = {}, context = {}) {
    const run = this.queue.then(() => this.run(name, args, context));
    this.queue = run.catch(() => {});
    return run;
  }
  async run(name, input, context) {
    context.assertAuthorized?.();
    this.storage.assertOpen();
    if (name === 'batch.execute') return this.runBatch(input, context);
    const schema = workspaceSchemas[name];
    if (!schema) throw new Error(`Unknown workspace command: ${name}`);
    rejectSecretKeys(input);
    const { requestId, dryRun, ...args } = schema.parse(input);
    const scope = this.authorize(name, args, context);
    if (READS.has(name)) return this.read(name, args, context, scope);
    if (name === 'workspaces.exportPackage') return this.exportPackage(args.id, args.name, args.sensitiveTerms);
    if (name.startsWith('backups.')) return this.backupCommand(name, args, dryRun);
    const request = requestId && !dryRun ? this.requestIdentity(name, args, context, requestId) : null;
    if (request?.replay) return request.replay;
    const effects = [];
    return this.transact(() => this.apply(name, args, context, effects), { context, dryRun, request, effects, checkpoint: WITH_EFFECTS.has(name) ? this.storage.checkpoint() : null });
  }
  authorize(name, args, context) {
    const actor = context.actor || 'human';
    const admin = actor === 'human' || actor === 'admin';
    if (!admin && (/^siteRules\.(create|update|delete|review)$/.test(name) || HUMAN_ADMIN.has(name))) throw new Error('PERMISSION_REQUIRED: this action requires human administration');
    const workspaceId = args.workspaceId || context.workspaceId || this.activeWorkspaceId;
    if (context.workspaceId && args.workspaceId && context.workspaceId !== args.workspaceId) throw new Error('PERMISSION_REQUIRED: workspace is outside the authorized scope');
    this.workspace(workspaceId);
    if (name.startsWith('workspaces.') && context.workspaceId && args.id && args.id !== context.workspaceId) throw new Error('PERMISSION_REQUIRED: workspace is outside the authorized scope');
    return { actor, admin, workspaceId };
  }
  /** Run one mutation: commit atomically with its request identity, or roll back. */
  async transact(work, { context = {}, dryRun = false, request = null, effects = [], checkpoint = null } = {}) {
    let output;
    let released = [];
    try {
      const result = await work();
      context.assertAuthorized?.();
      if (dryRun) {
        const preview = { dryRun: true, applied: false, result: this.output(result), changes: this.storage.changes(this.data) };
        this.data = this.storage.revert(this.data);
        return preview;
      }
      output = this.output(result);
      ({ released } = this.save({ requests: request ? [{ ...request.record, result: output }] : [], deferCollection: effects.length > 0 }));
    } catch (error) {
      this.data = this.storage.revert(this.data);
      throw error;
    }
    if (effects.length) {
      try { for (const effect of effects) await effect(); }
      catch (error) {
        // Browser effects are best effort; keep durable state consistent with the browser.
        try { this.data = this.storage.stateFrom(checkpoint); this.save({ removeRequests: request ? [request.record] : [] }); } catch { /* The original error is more useful. */ }
        throw error;
      } finally { this.storage.collectGarbage(released); }
    }
    return output;
  }
  requestIdentity(name, args, context, requestId) {
    // Request identities are private to one caller identity: another client never receives this caller's stored result.
    const scope = `${String(context.actor || 'human')}${context.clientId ? `:${context.clientId}` : ''}`;
    const fingerprint = digest(canonicalJson({ command: name, args, workspaceId: context.workspaceId ?? null }));
    const existing = this.storage.request(scope, requestId);
    if (!existing) return { record: { scope, requestId, command: name, fingerprint, workspaceId: args.workspaceId ?? context.workspaceId ?? null } };
    if (existing.fingerprint !== fingerprint || existing.command !== name) throw fail('idempotency_conflict', 'requestId was already used with a different command or arguments; nothing was applied. Use a new requestId for a different request.', { notStarted: true });
    if (existing.result === null) throw fail('already_committed', 'requestId was already committed, but its result is no longer retained. Read current state instead of retrying.', { notStarted: true });
    if (existing.result === OMITTED_RESULT) throw fail('already_committed', 'requestId was already committed; its result exceeded the 1 MiB retention limit. Read current state instead of retrying.', { notStarted: true });
    return { replay: markReplayed(JSON.parse(existing.result)) };
  }
  async runBatch(input, context) {
    rejectSecretKeys(input);
    const { requestId, dryRun, commands } = workspaceSchemas['batch.execute'].parse(input);
    const label = (index, command) => `batch command ${index} (${command})`;
    const annotate = (error, index, command) => {
      if (Array.isArray(error.issues)) for (const issue of error.issues) issue.path = ['commands', index, 'args', ...(issue.path || [])];
      else error.message = `${label(index, command)}: ${error.message}`;
      return error;
    };
    const prepared = commands.map(({ command, args }, index) => {
      if (!BATCHABLE.has(command)) throw fail('invalid_arguments', `${label(index, command)} cannot run in an atomic batch. Page, browser, capture, import, backup and workspace-lifecycle commands cannot be rolled back; run them separately.`);
      if (Object.hasOwn(args, 'requestId') || Object.hasOwn(args, 'dryRun')) throw fail('invalid_arguments', `${label(index, command)}: requestId and dryRun apply to the whole batch`);
      try { rejectSecretKeys(args); this.authorize(command, workspaceSchemas[command].parse(args), context); }
      catch (error) { throw annotate(error, index, command); }
      return { command, args };
    });
    const request = requestId && !dryRun ? this.requestIdentity('batch.execute', { commands: prepared }, context, requestId) : null;
    if (request?.replay) return request.replay;
    return this.transact(async () => {
      const results = [];
      for (const [index, item] of prepared.entries()) {
        try {
          const { requestId: ignored, dryRun: alsoIgnored, ...args } = workspaceSchemas[item.command].parse(substitutePlaceholders(item.args, index, results));
          const effects = [];
          const result = await this.apply(item.command, args, context, effects);
          if (effects.length) throw new Error('Command has browser effects and cannot be batched');
          results.push(this.output(result));
        } catch (error) { throw annotate(error, index, item.command); }
      }
      return { atomic: true, count: results.length, results };
    }, { context, dryRun, request });
  }
  read(name, args, context, { workspaceId }) {
    const [collection, action] = name.split('.');
    if (name === 'history.list') return clone((this.data.history || []).filter(item => item.workspaceId === workspaceId).slice(-(args.limit || 100)).reverse());
    if (name === 'bookmarks.list') return this.data.materials.filter(item => item.workspaceId === workspaceId && item.kind === 'website' && item.pinned).map(withoutFile);
    if (name === 'workspace.snapshot') {
      const snapshot = this.snapshot();
      if (!context.workspaceId && !args.workspaceId) return snapshot;
      delete snapshot.storageWarnings;
      if (snapshot.siteLists) snapshot.siteLists = snapshot.siteLists.filter(item => item.workspaceId === workspaceId);
      snapshot.workspaces = snapshot.workspaces.filter(item => item.id === workspaceId);
      if (snapshot.storagePolicies) snapshot.storagePolicies = snapshot.storagePolicies.filter(item => item.workspaceId === workspaceId);
      for (const key of [...collections, 'activity', 'history', 'handoffs', 'conflicts', 'freshnessPolicies']) snapshot[key] = (snapshot[key] ?? []).filter(item => item.workspaceId === workspaceId);
      // Collections this workspace owns or participates in; members of other workspaces are visible only to the owner.
      snapshot.sharedCollections = (snapshot.sharedCollections ?? []).filter(item => item.workspaceId === workspaceId || item.members?.some(member => member.workspaceId === workspaceId && !member.revokedAt))
        .map(item => item.workspaceId === workspaceId ? item : { ...item, members: item.members.filter(member => member.workspaceId === workspaceId), history: [] });
      if (!['human', 'admin'].includes(context.actor ?? 'human')) snapshot.materials = snapshot.materials.map(item => forCaller('materials', item, context));
      snapshot.browserSession.tabs = snapshot.browserSession.tabs.filter(item => item.workspaceId === workspaceId);
      if (!snapshot.browserSession.tabs.some(tab => tab.id === snapshot.browserSession.activeId)) snapshot.browserSession.activeId = null;
      snapshot.activeWorkspaceId = workspaceId;
      return snapshot;
    }
    if (name === 'settings.get') return clone(this.data.settings);
    if (name === 'search.query') return this.search(args.query, workspaceId, args.limit || 50);
    if (name === 'workspaces.list') return clone(this.data.workspaces.filter(item => !context.workspaceId || item.id === context.workspaceId));
    if (name === 'workspaces.get') { if (context.workspaceId && args.id !== context.workspaceId) throw new Error('PERMISSION_REQUIRED'); return clone(this.workspace(args.id)); }
    if (name === 'workspaces.export') return this.exportWorkspace(args.id, args.sensitiveTerms);
    if (action === 'list') return this.data[collection].filter(item => item.workspaceId === workspaceId || (collection === 'siteRules' && item.scope === 'global')).map(item => collection === 'artifacts' ? artifactSummary(item) : collection === 'materials' ? forCaller(collection, withoutFile(item), context) : clone(item));
    const record = this.record(collection, args.id, context, { shared: ['materials', 'context', 'artifacts'].includes(collection) });
    if (collection === 'artifacts' && args.versionId) {
      const version = record.versions.find(item => item.id === args.versionId);
      if (!version) throw new Error('Artifact version not found');
      return { artifactId: record.id, workspaceId: record.workspaceId, ...this.output(version) };
    }
    return forCaller(collection, this.output(record), context);
  }
  /**
   * Ranked local full-text search. Results cite the record revision or exact capture version.
   * Records shared into the workspace through an active collection are included and labelled.
   */
  search(query, workspaceId, limit) {
    const format = (row, shared) => {
      const citation = { recordType: row.collection, recordId: row.record_id, revision: row.revision, versionId: row.version_id || null, versionNumber: row.version_number };
      return { type: row.collection, id: row.record_id, ...(row.version_id ? { versionId: row.version_id, versionNumber: row.version_number } : {}), revision: row.revision,
        localOnly: row.local_only === 1, title: row.title, content: String(row.excerpt || '').slice(0, 300), updatedAt: row.updated_at, score: Number((-row.score).toFixed(6)), match: row.match, citation, ...(shared && { shared }) };
    };
    const results = this.storage.search({ workspaceId, query, limit }).map(row => format(row, null));
    const shared = sharedInto(this.data, workspaceId);
    if (!shared.length) return results;
    const allowed = new Map(shared.map(item => [`${item.type}:${item.id}`, item]));
    for (const owner of new Set(shared.map(item => item.ownerWorkspaceId))) {
      for (const row of this.storage.search({ workspaceId: owner, query, limit })) {
        const entry = allowed.get(`${row.collection}:${row.record_id}`);
        if (entry) results.push(format(row, { collectionId: entry.collectionId, ownerWorkspaceId: entry.ownerWorkspaceId, role: entry.role }));
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  async apply(name, args, context, effects) {
    const { actor, admin, workspaceId } = this.authorize(name, args, context);
    const [collection, action] = name.split('.');
    if (name === 'history.clear') {
      if (!admin) throw new Error('History clearing requires human administration');
      this.data.history = (this.data.history || []).filter(item => item.workspaceId !== workspaceId);
      this.log(name, workspaceId, null, actor);
      return { cleared: true, workspaceId };
    }
    if (name === 'bookmarks.create') return this.apply('materials.create', workspaceSchemas['materials.create'].parse({ ...args, kind: 'website', pinned: true }), context, effects);
    if (name === 'bookmarks.delete') {
      const bookmark = this.record('materials', args.id, context);
      if (bookmark.kind !== 'website' || !bookmark.pinned) throw new Error('Bookmark not found');
      return this.apply('materials.delete', args, context, effects);
    }
    if (collection === 'workspaces') return this.mutateWorkspace(action, args, actor, effects);
    if (name === 'settings.update') {
      this.data.settings = { ...this.data.settings, ...args, model: { ...this.data.settings.model, ...args.model }, ...(args.automation && { automation: { ...this.data.settings.automation, ...args.automation } }) };
      this.log(name, workspaceId, workspaceId, actor);
      return this.data.settings;
    }
    if (name === 'conversations.message') {
      const record = this.record(collection, args.id, context);
      const { id, ...message } = args;
      record.messages.push({ id: uuid('msg'), ...message, createdAt: now() });
      this.touch(record); this.log(name, record.workspaceId, record.id, actor);
      return record;
    }
    if (name === 'siteRules.review') {
      if (!admin) throw new Error('PERMISSION_REQUIRED: site-rule review requires human administration');
      const record = this.record('siteRules', args.id, context);
      if (record.scope !== 'global' && context.workspaceId && record.workspaceId !== context.workspaceId) throw new Error('PERMISSION_REQUIRED: record is outside the authorized workspace');
      const changes = { lastReviewedAt: now(), lastReviewedBy: actor, ...(args.reviewBy !== undefined && { reviewBy: args.reviewBy }) };
      this.recordRuleRevision(record, changes, actor, args.note ? `Reviewed: ${args.note}` : 'Reviewed');
      Object.assign(record, changes); this.touch(record);
      this.log(name, record.workspaceId, record.id, actor, args.note || '');
      return record;
    }
    if (name === 'tasks.transition') {
      const record = this.record(collection, args.id, context);
      const prior = record.status;
      record.status = args.status;
      if (args.checkpoint !== undefined) record.checkpoint = args.checkpoint;
      if (args.status === 'completed') record.progress = 100;
      this.touch(record); this.log(name, record.workspaceId, record.id, actor, `${prior} → ${args.status}${args.cause ? `: ${args.cause}` : ''}`);
      return record;
    }
    if (collection === 'artifacts') return this.mutateArtifact(action, args, workspaceId, actor, context);
    if (collection === 'context' && !context.citationTexts) {
      const sources = quotedSources(args.citations ?? args.changes?.citations);
      if (sources.length) context = { ...context, citationTexts: await prefetchSourceTexts(this.data, workspaceId, sources, { protectedPaths: [this.directory] }) };
    }
    if (Object.hasOwn(recordShapes, collection)) return this.mutateRecord(collection, action, args, workspaceId, actor, admin, context);
    throw new Error(`Unsupported workspace command: ${name}`);
  }
  touch(record) { record.updatedAt = now(); record.revision += 1; }
  mutateWorkspace(action, args, actor, effects) {
    const switchBrowser = () => this.browser?.switchWorkspace?.(this.activeWorkspaceId);
    if (action === 'create') {
      const record = { ...createWorkspace(args.name), ...args };
      this.data.workspaces.push(record); this.data.activeWorkspaceId = record.id;
      this.log('workspaces.create', record.id, record.id, actor);
      effects.push(switchBrowser);
      return record;
    }
    if (action === 'import' || action === 'importPackage') {
      const { workspace, report } = action === 'import' ? this.importWorkspace(args.data, actor) : this.importPackage(args.name, actor);
      effects.push(switchBrowser);
      return { ...workspace, importReport: report };
    }
    const record = this.workspace(args.id);
    if (action === 'update') {
      if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw new Error('STALE_STATE: workspace changed');
      Object.assign(record, args.changes); this.touch(record);
    } else if (action === 'switch') {
      if (record.archived) throw new Error('Restore this workspace before switching to it');
      this.data.activeWorkspaceId = record.id;
      effects.push(switchBrowser);
    } else if (action === 'archive' || action === 'restore') {
      record.archived = action === 'archive'; this.touch(record);
      if (record.archived && record.id === this.activeWorkspaceId) this.selectRemaining(record.id);
      if (action === 'archive') effects.push(switchBrowser);
    } else if (action === 'delete') {
      if (record.id === this.activeWorkspaceId) this.selectRemaining(record.id);
      this.data.workspaces = this.data.workspaces.filter(item => item.id !== record.id);
      if (this.data.siteLists) this.data.siteLists = this.data.siteLists.filter(item => item.workspaceId !== record.id);
      if (this.data.storagePolicies) this.data.storagePolicies = this.data.storagePolicies.filter(item => item.workspaceId !== record.id);
      for (const key of [...collections, 'activity', 'history', 'handoffs', ...KNOWLEDGE_COLLECTIONS]) this.data[key] = (this.data[key] ?? []).filter(item => item.workspaceId !== record.id);
      // Access granted to the deleted workspace ends with it; the membership stays as history.
      for (const shared of this.data.sharedCollections) for (const member of shared.members ?? []) if (member.workspaceId === record.id && !member.revokedAt) Object.assign(member, { revokedAt: now(), revokedBy: actor, reason: 'workspace deleted' });
      this.data.browserSession.tabs = this.data.browserSession.tabs.filter(item => item.workspaceId !== record.id);
      effects.push(() => this.browser?.closeWorkspace?.(record.id), switchBrowser);
    } else if (action === 'duplicate') {
      const exported = this.exportWorkspace(record.id, undefined, { mode: 'package', keepLocalPaths: true });
      exported.workspace.name = args.name || `${record.name} copy`;
      const { workspace: copy } = this.importWorkspace(exported, actor, false, { resolver: { read: marker => this.storage.components.read(marker.sha256, marker.size) }, keepLocalPaths: true });
      this.log('workspaces.duplicate', copy.id, record.id, actor, 'Records, revisions and stored components copied. Browser sessions and credentials excluded.');
      return copy;
    } else throw new Error('Unsupported workspace action');
    this.log(`workspaces.${action}`, record.id, record.id, actor);
    return action === 'delete' ? { deleted: true, id: record.id } : record;
  }
  selectRemaining(excluding) {
    let next = this.data.workspaces.find(item => item.id !== excluding && !item.archived);
    if (!next) { next = createWorkspace(); this.data.workspaces.push(next); }
    this.data.activeWorkspaceId = next.id;
  }
  mutateRecord(collection, action, args, workspaceId, actor, admin, context) {
    let record;
    if (action === 'create') {
      const { workspaceId: ignored, origin: originArg, citations: citationArgs, ...fields } = args;
      if (!admin && collection === 'context' && TRUSTED_CATEGORIES.includes(fields.category)) throw new Error('PERMISSION_REQUIRED: only a human may establish trusted project context');
      if (collection === 'siteRules') this.validateRule(fields);
      if (collection === 'materials') this.validateMaterial(fields);
      record = createRecord(fields, collection === 'siteRules' && fields.scope === 'global' ? null : workspaceId, collection.slice(0, 4));
      if (collection === 'siteRules') { record.createdBy = actor; record.revisions = [{ revision: 1, actor, at: record.createdAt, summary: 'Created', changed: Object.keys(fields).sort() }]; }
      if (collection === 'conversations') record.messages = [];
      if (['materials', 'context'].includes(collection)) {
        // Provenance is set from the authenticated caller; arguments only add descriptive detail (#66).
        record.origin = originFor(context, originArg, context.originExtra);
        if (collection === 'context') record.citations = buildCitations(this.data, record.workspaceId, citationArgs, context.citationTexts);
        record.history = [{ revision: 1, content: record.content, actor, createdAt: record.createdAt, origin: record.origin }];
      }
      this.data[collection].push(record);
    } else {
      record = this.record(collection, args.id, context);
      if (!admin && collection === 'context' && [record.category, args.changes?.category].some(category => ['confirmed', 'instructions', 'decisions'].includes(category))) {
        throw new Error('PERMISSION_REQUIRED: trusted context requires human approval');
      }
      if (action === 'delete') this.data[collection] = this.data[collection].filter(item => item.id !== record.id);
      else if (action === 'update') {
        if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw new Error('STALE_STATE: record changed; reload before updating');
        if (!admin && collection === 'workflows' && record.enabled === false && args.changes.enabled === true) throw new Error('PERMISSION_REQUIRED: imported workflow requires human review');
        const { origin: originArg, citations: citationArgs, ...changes } = args.changes;
        const revisionOrigin = ['materials', 'context'].includes(collection) ? originFor(context, originArg, context.originExtra) : null;
        const updated = { ...record, ...changes };
        // Citations are append-only evidence: new ones are added, earlier ones keep their pinned versions.
        if (collection === 'context' && citationArgs?.length) updated.citations = [...(record.citations ?? []), ...buildCitations(this.data, record.workspaceId, citationArgs, context.citationTexts)].slice(-200);
        if (collection === 'siteRules') { this.validateRule(updated); updated.workspaceId = updated.scope === 'global' ? null : (record.workspaceId || workspaceId); this.recordRuleRevision(record, updated, actor, 'Updated'); }
        if (collection === 'materials') this.validateMaterial(updated);
        Object.assign(record, updated); this.touch(record);
        if (record.history && changes.content !== undefined) record.history.push({ revision: record.revision, content: record.content, actor, createdAt: now(), ...(revisionOrigin && { origin: revisionOrigin }) });
        if (revisionOrigin) record.lastOrigin = revisionOrigin;
      } else throw new Error('Unsupported record action');
      if (action === 'delete' && ['materials', 'context'].includes(collection)) this.forgetSharedItem(collection, record.id);
    }
    this.log(`${collection}.${action}`, record.workspaceId, record.id, actor);
    return action === 'delete' ? { deleted: true, id: record.id } : record;
  }
  /** A deleted record leaves every shared collection that listed it. */
  forgetSharedItem(type, id) {
    for (const collection of this.data.sharedCollections ?? []) if (collection.items?.some(item => item.type === type && item.id === id)) collection.items = collection.items.filter(item => !(item.type === type && item.id === id));
  }
  recordRuleRevision(record, updated, actor, summary) {
    const changed = Object.keys(updated).filter(key => !['revisions', 'updatedAt', 'revision'].includes(key) && JSON.stringify(record[key]) !== JSON.stringify(updated[key])).sort();
    const previous = Object.fromEntries(changed.map(key => [key, record[key] ?? null]));
    updated.revisions = record.revisions = [...(record.revisions ?? []), { revision: record.revision + 1, actor, at: now(), summary, changed, previous }].slice(-50);
  }
  validateRule(record) {
    record.hostname = normalizeHostname(record.hostname);
    if (!record.path.startsWith('/') || /[?#\\]/.test(record.path)) throw new Error('Site rule path must be an absolute URL path without query or fragment');
  }
  validateMaterial(record) {
    if (Object.hasOwn(record, 'fileBase64') && typeof record.fileBase64 === 'string') {
      if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(record.fileBase64)) throw new Error('Invalid base64 file');
      const bytes = Buffer.from(record.fileBase64, 'base64');
      if (bytes.length > 10 * 1024 * 1024) throw new Error('Stored materials are limited to 10 MiB');
      record.size = bytes.length; record.sha256 = digest(bytes);
      record.filename = String(record.filename || 'file').split(/[\\/]/).pop();
    }
  }
  async mutateArtifact(action, args, workspaceId, actor, context) {
    if (action === 'delete') {
      const record = this.record('artifacts', args.id, context);
      this.data.artifacts = this.data.artifacts.filter(item => item.id !== record.id);
      this.forgetSharedItem('artifacts', record.id);
      this.log('artifacts.delete', record.workspaceId, record.id, actor);
      return { id: record.id, deleted: true };
    }
    if (action === 'annotate') {
      const record = this.record('artifacts', args.id, context);
      record.note = args.note; if (args.tags) record.tags = args.tags;
      this.touch(record); record.annotations.push({ note: record.note, tags: record.tags, revision: record.revision, actor, createdAt: now() });
      this.log('artifacts.annotate', record.workspaceId, record.id, actor);
      return artifactSummary(record);
    }
    let source = args;
    if (action === 'capture') {
      if (!this.browser?.captureArtifact) throw new Error('Artifact capture requires a connected browser');
      if (this.browser.tab && this.browser.tab(args.tabId).workspaceId !== workspaceId) throw new Error('PERMISSION_REQUIRED: capture tab belongs to a different workspace');
      source = { ...await this.browser.captureArtifact(args, context), ...args };
    }
    if (source.text === undefined && !source.pngBase64) throw new Error('Artifact requires text or a PNG image');
    const components = [];
    if (source.text !== undefined) {
      if (typeof source.text !== 'string' || source.text.length > 2000000) throw new Error('Artifact text exceeds 2 million characters');
      components.push({ type: 'text/plain', size: Buffer.byteLength(source.text), sha256: digest(source.text) });
    }
    if (source.pngBase64) {
      const bytes = Buffer.from(source.pngBase64, 'base64');
      if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 8).equals(PNG)) throw new Error('Artifact images must be PNG and at most 20 MiB');
      source.pngBase64 = bytes.toString('base64');
      components.push({ type: 'image/png', size: bytes.length, sha256: digest(bytes) });
    }
    let record = args.artifactId ? this.record('artifacts', args.artifactId, context) : null;
    if (record && record.workspaceId !== workspaceId) throw new Error('Artifact belongs to a different workspace');
    if (!record) {
      record = createRecord({ title: source.title || 'Saved page', note: args.note || '', tags: args.tags || [], versions: [], annotations: [] }, workspaceId, 'artifact');
      this.data.artifacts.push(record);
    }
    const version = { id: uuid('version'), number: record.versions.length + 1, createdAt: now(), actor, origin: originFor(context), method: action === 'capture' ? 'browser-capture' : 'supplied-content', url: sanitizeUrl(source.url), title: source.title || record.title, components, text: source.text, pngBase64: source.pngBase64, navigationVersion: source.navigationVersion, limitations: [...(source.limitations || []), 'Stored text is untrusted source content. Active scripts and external resources are not replayed.', 'Captures may contain personal information; inspect before sharing.'], redactionStatus: 'not-reviewed', previousVersionId: record.versions.at(-1)?.id || null };
    record.versions.push(version); this.touch(record);
    this.log('artifacts.capture', workspaceId, record.id, actor, `Version ${version.number}`);
    return artifactSummary(record);
  }

  // ---- Export and import -------------------------------------------------------------
  /**
   * Format 2 exports keep revisions, revision history, conversations, turn
   * manifests, exact artifact versions with component hashes and annotations,
   * site-rule provenance (creator, revision history, review state) and handoff
   * history.
   * `package` mode references components by digest instead of inlining them.
   */
  exportWorkspace(id, sensitiveTerms, { mode = 'inline', keepLocalPaths = false } = {}) {
    const record = this.workspace(id);
    const plain = (name, item) => {
      const copy = mode === 'inline' ? this.output(item) : JSON.parse(this.storage.serialize(name, item, { write: false }).doc);
      return name === 'materials' ? exportMaterial(copy, { keepLocalPaths }) : copy;
    };
    const notExported = Object.entries(this.data).filter(([key, value]) => !collections.includes(key) && !['workspaces', 'activity', 'history', 'handoffs', ...KNOWLEDGE_COLLECTIONS].includes(key) && !NOT_EXPORTED.has(key) && Array.isArray(value) && value.some(item => item?.workspaceId === id)).map(([key, value]) => `${key} (${value.filter(item => item?.workspaceId === id).length} records not supported by this export format)`);
    const exported = cleanExport({ format: 'weft-workspace', schemaVersion: CURRENT_SCHEMA_VERSION, formatVersion: 2, exportedAt: now(), workspace: clone(record),
      ...Object.fromEntries(collections.map(name => [name, this.data[name].filter(item => item.workspaceId === id && !(name === 'siteRules' && item.scope === 'global')).map(item => plain(name, item))])),
      handoffs: (this.data.handoffs ?? []).filter(item => item.workspaceId === id).map(item => clone(item)),
      sharedCollections: exportCollections(this.data, id),
      conflicts: (this.data.conflicts ?? []).filter(item => item.workspaceId === id).map(item => clone(item)),
      linkedContentOmitted: linkedOmissions(this.data.materials.filter(item => item.workspaceId === id)),
      excluded: [...EXPORT_EXCLUDED, ...notExported],
      limitations: ['Browser sessions, cookies, credentials, provider keys, and global policies are excluded. Imported site rules and workflows remain inactive until reviewed and enabled.', 'Free-form content and screenshots can contain personal information. Review the export before sharing.'] });
    if (sensitiveTerms !== undefined) exported.residueScan = inspectExportResidue(JSON.stringify(mode === 'inline' ? exported : this.exportWorkspace(id), null, 2), sensitiveTerms);
    return exported;
  }
  transferPath(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.includes('..')) throw fail('invalid_arguments', 'Invalid package name');
    return join(this.directory, TRANSFERS_DIR, name);
  }
  /** Large-project transfer: a folder of verified component files plus a manifest, beyond REST/JSON size limits. */
  exportPackage(id, name, sensitiveTerms) {
    const target = this.transferPath(name);
    if (existsSync(target)) throw fail('invalid_arguments', 'A package with this name already exists; existing packages are never overwritten');
    const exported = this.exportWorkspace(id, undefined, { mode: 'package' });
    const markers = new Map();
    const collect = value => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') { if (componentRef.safeParse(value).success) markers.set(value.$component.sha256, value.$component.size); else Object.values(value).forEach(collect); }
    };
    collect(exported);
    const root = join(this.directory, TRANSFERS_DIR);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temp = join(root, `.tmp-${randomUUID()}`);
    mkdirSync(temp, { mode: 0o700 });
    try {
      const files = [];
      for (const [hash, size] of markers) { this.storage.components.copyTo(hash, join(temp, 'components'), size); files.push({ path: `components/${hash.slice(0, 2)}/${hash}`, size, sha256: hash }); }
      const records = JSON.stringify(exported, null, 2);
      writeFileSync(join(temp, 'workspace.json'), records, { flag: 'wx', mode: 0o600 });
      fsyncFile(join(temp, 'workspace.json'));
      files.unshift({ path: 'workspace.json', size: Buffer.byteLength(records), sha256: digest(records) });
      const manifest = { format: 'weft-package', formatVersion: 1, createdAt: now(), workspace: { name: exported.workspace.name }, files };
      writeFileSync(join(temp, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
      fsyncFile(join(temp, 'manifest.json'));
      renameSync(temp, target);
      syncDirectory(root);
      const result = { name, path: target, formatVersion: 1, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), excluded: exported.excluded, limitations: exported.limitations };
      if (sensitiveTerms !== undefined) result.residueScan = inspectExportResidue(JSON.stringify(this.exportWorkspace(id), null, 2), sensitiveTerms);
      return result;
    } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
  }
  importPackage(name, actor) {
    const folder = this.transferPath(name);
    const regular = (path, limit) => {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw fail('invalid_arguments', 'PACKAGE_INVALID: package entries must be regular files, not links');
      if (stat.size > limit) throw fail('request_too_large', 'PACKAGE_INVALID: package file exceeds its size limit');
      return stat;
    };
    const folderStat = lstatSync(folder, { throwIfNoEntry: false });
    if (!folderStat) throw fail('not_found', 'Package not found in the profile transfers folder');
    if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) throw fail('invalid_arguments', 'PACKAGE_INVALID: package must be a folder, not a link');
    regular(join(folder, 'manifest.json'), 64 * 1024 * 1024);
    let manifest;
    try { manifest = packageManifest.parse(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))); }
    catch { throw fail('invalid_arguments', 'PACKAGE_INVALID: manifest is unreadable or unsupported'); }
    const files = new Map();
    for (const file of manifest.files) {
      const match = /^components\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(file.path);
      if ((file.path !== 'workspace.json' && !match) || (match && (match[2] !== file.sha256 || !match[2].startsWith(match[1]))) || files.has(file.path)) throw fail('invalid_arguments', 'PACKAGE_INVALID: manifest lists a malformed or duplicate path');
      files.set(file.path, file);
    }
    const recordsEntry = files.get('workspace.json');
    if (!recordsEntry) throw fail('invalid_arguments', 'PACKAGE_INVALID: manifest does not list workspace.json');
    regular(join(folder, 'workspace.json'), MAX_PACKAGE_RECORDS_FILE);
    const records = readFileSync(join(folder, 'workspace.json'));
    if (records.length !== recordsEntry.size || digest(records) !== recordsEntry.sha256) throw fail('component_integrity', 'COMPONENT_INTEGRITY: package workspace.json failed SHA-256 verification');
    let data;
    try { data = JSON.parse(records.toString('utf8')); } catch { throw fail('invalid_arguments', 'PACKAGE_INVALID: workspace.json is not valid JSON'); }
    const resolver = { read: marker => {
      const entry = files.get(`components/${marker.sha256.slice(0, 2)}/${marker.sha256}`);
      if (!entry || entry.size !== marker.size) throw fail('invalid_arguments', 'PACKAGE_INVALID: a record references a component the manifest does not list');
      const path = componentPath(join(folder, 'components'), marker.sha256);
      regular(path, 64 * 1024 * 1024);
      const bytes = readFileSync(path);
      if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw fail('component_integrity', `COMPONENT_INTEGRITY: package component ${marker.sha256.slice(0, 12)} failed SHA-256 verification`);
      return bytes;
    } };
    return this.importWorkspace(data, actor, true, { resolver, maxBytes: MAX_PACKAGE_RECORDS_FILE });
  }
  /**
   * Import format 1 or 2 as a new workspace with new IDs. Structured references
   * are remapped and must resolve; free-form citations of exported IDs are
   * rewritten. Every lossy mapping is reported. Policies/workflows stay inactive.
   */
  importWorkspace(input, actor, activate = true, { resolver = null, maxBytes = MAX_FILE, keepLocalPaths = false } = {}) {
    let raw = input;
    if (typeof input === 'string') { if (Buffer.byteLength(input) > MAX_FILE) throw new Error('Import exceeds 100 MiB'); raw = JSON.parse(input); }
    if (!raw || typeof raw !== 'object' || raw.format !== 'weft-workspace' || !raw.workspace) throw new Error('Expected a versioned Weft workspace export');
    if (Buffer.byteLength(JSON.stringify(raw)) > maxBytes) throw new Error(`Import exceeds ${Math.round(maxBytes / 1024 / 1024)} MiB; use a package import for larger projects`);
    rejectSecretKeys(raw);
    const formatVersion = raw.formatVersion ?? 1;
    if (!Number.isSafeInteger(formatVersion) || formatVersion < 1 || formatVersion > 2) throw new Error('Unsupported workspace export format; it may be from a newer Weft version');
    raw = migrateSchema(raw, { kind: 'export' });
    const lossy = new Map();
    const loss = (collection, field, reason, count = 1) => { const key = `${collection}\u0000${field}\u0000${reason}`; const item = lossy.get(key) || { collection, field, reason, count: 0 }; item.count += count; lossy.set(key, item); };
    const nested = (collection, field, schema, items) => { for (const entry of Array.isArray(items) ? items : []) if (entry && typeof entry === 'object') for (const key of Object.keys(entry)) if (!Object.hasOwn(schema.shape, key)) loss(collection, `${field}.${key}`, 'nested field not supported by import; dropped'); };
    const workspaceFields = workspaceSchemas['workspaces.create'].parse({ name: raw.workspace.name, description: raw.workspace.description, color: raw.workspace.color, icon: raw.workspace.icon });
    const workspace = { ...createWorkspace(), ...workspaceFields, importedFrom: { exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt.slice(0, 100) : null, createdAt: timestamp.safeParse(raw.workspace.createdAt).success ? raw.workspace.createdAt ?? null : null, formatVersion } };
    const mapping = new Map([[raw.workspace.id, workspace.id]]);
    const knownKeys = new Set(['format', 'schemaVersion', 'formatVersion', 'exportedAt', 'workspace', 'limitations', 'excluded', 'residueScan', 'handoffs', 'sharedCollections', 'conflicts', 'linkedContentOmitted', ...collections]);
    for (const [key, value] of Object.entries(raw)) if (!knownKeys.has(key)) loss('export', key, Array.isArray(value) ? 'collection not supported by this Weft version; not imported' : 'unrecognized export field ignored', Array.isArray(value) ? value.length : 1);
    // First pass: allocate every new identifier so references resolve in any order.
    for (const collection of collections) {
      if (raw[collection] !== undefined && !Array.isArray(raw[collection])) throw new Error(`Invalid ${collection} collection`);
      if ((raw[collection]?.length || 0) > 10000) throw new Error('Import collection exceeds 10,000 records');
      for (const item of raw[collection] || []) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new Error('Invalid imported record');
        if (mapping.has(item.id)) throw new Error('Duplicate imported record ID');
        mapping.set(item.id, uuid(collection === 'artifacts' ? 'artifact' : collection.slice(0, 4)));
        if (collection === 'artifacts') for (const version of Array.isArray(item.versions) ? item.versions : []) if (typeof version?.id === 'string' && !mapping.has(version.id)) mapping.set(version.id, uuid('version'));
        if (collection === 'conversations') for (const message of Array.isArray(item.messages) ? item.messages : []) if (typeof message?.id === 'string' && !mapping.has(message.id)) mapping.set(message.id, uuid('msg'));
      }
    }
    for (const [key, prefix] of [['sharedCollections', 'coll'], ['conflicts', 'conflict']]) {
      if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error(`Invalid ${key} collection`);
      for (const item of raw[key] || []) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new Error(`Invalid imported ${key} record`);
        if (mapping.has(item.id)) throw new Error('Duplicate imported record ID');
        mapping.set(item.id, uuid(prefix));
      }
    }
    if (raw.handoffs !== undefined && !Array.isArray(raw.handoffs)) throw new Error('Invalid handoffs collection');
    for (const item of raw.handoffs || []) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new Error('Invalid imported handoff');
      if (mapping.has(item.id)) throw new Error('Duplicate imported record ID');
      mapping.set(item.id, uuid('handoff'));
    }
    const heavy = (value, encoding) => {
      if (typeof value === 'string') return { inline: value };
      if (!resolver) throw new Error('Component references require a package import');
      const marker = value.$component;
      if (marker.encoding !== encoding) throw new Error('Imported component has the wrong encoding');
      const bytes = resolver.read(marker);
      return { bytes, marker };
    };
    const lazy = (object, key, ref) => { this.storage.putComponent(ref.bytes); this.storage.defineLazy(object, key, ref.marker); };
    const imported = {};
    const stats = { structuredReferences: 0, freeFormCitations: 0, unresolvedCitations: new Set(), versions: 0, revisions: 0 };
    for (const collection of collections) {
      imported[collection] = (raw[collection] || []).map(item => {
        const system = [...SYSTEM_FIELDS.common, ...(SYSTEM_FIELDS[collection] || [])];
        const shape = collection === 'artifacts' ? null : recordShapes[collection];
        for (const key of Object.keys(item)) if (!system.includes(key) && !(shape ? Object.hasOwn(shape, key) : ['title', 'note', 'tags'].includes(key))) loss(collection, key, 'field not supported by import; dropped');
        let fields;
        const deferred = [];
        if (collection === 'artifacts') { nested(collection, 'annotations', annotationSchema, item.annotations); fields = this.importArtifact(item, { heavy, lazy, deferred, mapping, loss, stats }); }
        else {
          // Provenance and citations are system-derived: they are remapped below, never parsed as caller input.
          const picked = Object.fromEntries(Object.keys(shape).filter(key => item[key] !== undefined && !['origin', 'citations'].includes(key)).map(key => [key, item[key]]));
          let fileRef = null;
          if (collection === 'materials' && picked.fileBase64 && typeof picked.fileBase64 === 'object') {
            fileRef = heavy(componentRef.parse(picked.fileBase64), 'base64');
            delete picked.fileBase64;
          }
          fields = z.strictObject(shape).parse(picked);
          if (collection === 'siteRules') {
            if (fields.enabled || fields.scope !== 'workspace') loss(collection, 'enabled/scope', 'imported site rules are workspace-scoped and disabled until reviewed');
            fields.scope = 'workspace'; fields.enabled = false; this.validateRule(fields);
            if (item.provenance) loss(collection, 'provenance', 'community-list provenance is not imported; reinstall the list to track it');
            // Rule provenance: keep the creator, revision history and review state, then record the import as a revision.
            const revisions = item.revisions === undefined ? [] : z.array(ruleRevisionSchema).max(50).parse(item.revisions);
            const revision = Number.isSafeInteger(item.revision) && item.revision >= 1 ? item.revision : 1;
            fields.createdBy = typeof item.createdBy === 'string' ? item.createdBy.slice(0, 200) : `${actor} (import)`;
            if (item.lastReviewedAt !== undefined) { fields.lastReviewedAt = timestamp.parse(item.lastReviewedAt); fields.lastReviewedBy = z.string().max(200).parse(item.lastReviewedBy ?? 'unknown'); }
            fields.revisions = [...revisions, { revision, actor, at: now(), summary: 'Imported inactive for review', changed: ['enabled', 'scope'] }].slice(-50);
            stats.revisions += revisions.length;
          }
          if (collection === 'workflows') { if (fields.enabled) loss(collection, 'enabled', 'imported workflows are disabled until reviewed'); fields.enabled = false; }
          if (collection === 'materials') {
            if (fileRef) {
              if (fileRef.bytes.length > 10 * 1024 * 1024) throw new Error('Stored materials are limited to 10 MiB');
              fields.size = fileRef.bytes.length; fields.sha256 = fileRef.marker.sha256;
              fields.filename = String(fields.filename || 'file').split(/[\\/]/).pop();
              deferred.push(record => lazy(record, 'fileBase64', fileRef));
            } else this.validateMaterial(fields);
            if (typeof item.sha256 === 'string' && fields.sha256 && item.sha256 !== fields.sha256) throw fail('component_integrity', 'COMPONENT_INTEGRITY: imported material file does not match its recorded SHA-256');
          }
          if (collection === 'conversations') {
            nested(collection, 'messages', messageSchema, item.messages);
            fields.messages = z.array(messageSchema).max(10000).parse(item.messages || []).map(message => ({ ...message, id: mapping.get(message.id) || uuid('msg') }));
            if (item.turnManifests !== undefined) {
              const manifests = z.array(z.record(z.string(), z.unknown())).max(1000).parse(item.turnManifests);
              if (Buffer.byteLength(JSON.stringify(manifests)) > 5 * 1024 * 1024) throw new Error('Imported turn manifests exceed 5 MiB');
              fields.turnManifests = manifests;
            }
          }
          if (['materials', 'context'].includes(collection)) {
            Object.assign(fields, importContextFields(item, collection, { mapping, actor, loss, keepLocalPaths }));
            fields.origin ??= importedOrigin(null, actor, mapping);
            if (item.history !== undefined) { nested(collection, 'history', historyEntry, item.history); fields.history = z.array(historyEntry).max(10000).parse(item.history).map(entry => ({ revision: entry.revision, content: entry.content, actor: entry.actor, createdAt: entry.createdAt, ...(entry.origin !== undefined && { origin: importedOrigin(entry.origin, actor, mapping) }) })); stats.revisions += fields.history.length; }
            else { loss(collection, 'history', 'revision history absent in source; started a new history'); fields.history = [{ revision: 1, content: fields.content, actor, createdAt: now() }]; }
          }
        }
        const record = { id: mapping.get(item.id), workspaceId: workspace.id, ...fields,
          createdAt: timestamp.safeParse(item.createdAt).success && item.createdAt ? item.createdAt : now(), updatedAt: timestamp.safeParse(item.updatedAt).success && item.updatedAt ? item.updatedAt : now(),
          revision: Number.isSafeInteger(item.revision) && item.revision >= 1 ? item.revision : 1 };
        for (const apply of deferred) apply(record);
        return record;
      });
    }
    // Structured references must resolve inside the export; free-form citations are rewritten.
    const remap = (collection, field, id) => { if (!mapping.has(id)) throw new Error(`Invalid imported record reference in ${collection}.${field}`); stats.structuredReferences++; return mapping.get(id); };
    for (const [collection, records] of Object.entries(imported)) for (const record of records) {
      for (const key of ['evidence', 'materialIds', 'outputs']) if (Array.isArray(record[key])) record[key] = record[key].map(id => remap(collection, key, id));
      if (collection === 'conversations') for (const message of record.messages) if (Array.isArray(message.attachments)) message.attachments = message.attachments.map(id => remap(collection, 'messages.attachments', id));
      this.rewriteCitations(record, mapping, stats);
    }
    const handoffs = importHandoffs(raw.handoffs, { workspaceId: workspace.id, mapping, actor, loss });
    for (const record of handoffs) this.rewriteCitations(record, mapping, stats);
    const sharedCollections = importCollections(raw.sharedCollections, { workspaceId: workspace.id, mapping, actor, loss });
    const conflicts = importConflicts(raw.conflicts, { workspaceId: workspace.id, mapping, actor, loss });
    if (stats.unresolvedCitations.size) loss('all', 'free-form citations', 'identifiers not present in the export were left unchanged and do not resolve in the new workspace', stats.unresolvedCitations.size);
    this.data.workspaces.push(workspace);
    for (const collection of collections) this.data[collection].push(...imported[collection]);
    this.data.handoffs = [...(this.data.handoffs ?? []), ...handoffs];
    this.data.sharedCollections.push(...sharedCollections);
    this.data.conflicts.push(...conflicts);
    // Imported citation statuses are recomputed against the imported versions; nothing is taken on trust.
    let citations = 0;
    for (const record of imported.context) if (record.citations?.length) {
      const unresolved = new Set(record.citations.filter(item => item.reason === 'not_in_export').map(item => item.id));
      record.citations = recheckCitations(this.data, workspace.id, record).citations.map(item => unresolved.has(item.id) ? { ...item, status: 'unverified', reason: 'not_in_export' } : item);
      citations += record.citations.length;
    }
    if (activate) this.data.activeWorkspaceId = workspace.id;
    if (formatVersion === 1) loss('export', 'formatVersion', 'format 1 export: fields absent from the older format were initialized');
    const linked = [];
    for (const record of imported.materials) if (['website', 'linked-file', 'linked-folder', 'service'].includes(record.kind) || record.link || record.service) linked.push({ collection: 'materials', id: record.id, kind: record.kind, title: record.title, ...(record.url ? { url: record.url } : {}), ...(record.filename ? { filename: record.filename } : {}) });
    for (const record of imported.context) for (const source of record.sources || []) if (/^https?:/i.test(source)) linked.push({ collection: 'context', id: record.id, kind: 'source', url: source });
    for (const record of imported.artifacts) for (const version of record.versions) if (version.url) linked.push({ collection: 'artifacts', id: record.id, versionId: version.id, kind: 'live page', url: version.url });
    const report = {
      formatVersion, sourceSchemaVersion: raw.schemaVersion, newIds: true,
      records: { ...Object.fromEntries(collections.map(name => [name, imported[name].length])), handoffs: handoffs.length, sharedCollections: sharedCollections.length, conflicts: conflicts.length }, artifactVersions: stats.versions, revisionHistoryEntries: stats.revisions, citations,
      remapped: { identifiers: mapping.size, structuredReferences: stats.structuredReferences, freeFormCitations: stats.freeFormCitations },
      lossy: [...lossy.values()],
      excluded: [...new Set([...EXPORT_EXCLUDED, ...(Array.isArray(raw.excluded) ? raw.excluded.filter(item => typeof item === 'string').map(item => item.slice(0, 300)).slice(0, 100) : [])])],
      linkedSourcesNotIncluded: { count: linked.length, items: linked.slice(0, 1000) },
      policies: {
        siteRules: imported.siteRules.map(rule => ({ id: rule.id, hostname: rule.hostname, path: rule.path, includeSubdomains: rule.includeSubdomains, behavior: rule.behavior, mode: rule.mode, reason: rule.reason, enabled: false })),
        workflows: imported.workflows.map(workflow => ({ id: workflow.id, title: workflow.title, steps: workflow.steps.length, allowedSites: workflow.allowedSites, parameters: workflow.parameters, enabled: false })),
        activation: 'Imported site rules and workflows are inactive until a human reviews and enables them.',
      },
    };
    this.log('workspaces.import', workspace.id, workspace.id, actor, `Imported format ${formatVersion} with new IDs; ${report.lossy.length} lossy mapping types reported; policies and workflows inactive; no sessions or credentials imported`);
    return { workspace, report };
  }
  importArtifact(item, { heavy, lazy, deferred, mapping, loss, stats }) {
    const fields = artifactSchema.parse(item);
    fields.annotations = fields.annotations.map(annotation => ({ note: annotation.note, ...(annotation.tags ? { tags: annotation.tags } : {}), revision: annotation.revision ?? 1, actor: annotation.actor ?? 'human', createdAt: annotation.createdAt ?? now() }));
    const versionKeys = new Set(Object.keys(versionSchema.shape));
    fields.versions = fields.versions.map((version, index) => {
      const original = item.versions[index];
      for (const key of Object.keys(original)) if (!versionKeys.has(key)) loss('artifacts', `versions.${key}`, 'version field not supported by import; dropped');
      const components = [];
      let text; let png;
      if (version.text !== undefined) {
        text = heavy(version.text, 'utf8');
        if (text.bytes) {
          try { text.value = new TextDecoder('utf-8', { fatal: true }).decode(text.bytes); } catch { throw fail('component_integrity', 'COMPONENT_INTEGRITY: imported text component is not valid UTF-8'); }
          if (text.value.length > 2000000) throw new Error('Artifact text exceeds 2 million characters');
        }
        const bytes = text.bytes || Buffer.from(text.inline);
        components.push({ type: 'text/plain', size: bytes.length, sha256: text.marker?.sha256 || digest(bytes) });
      }
      if (version.pngBase64) {
        png = heavy(version.pngBase64, 'base64');
        const bytes = png.bytes || Buffer.from(png.inline, 'base64');
        if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 8).equals(PNG)) throw new Error('Invalid imported PNG');
        if (png.inline !== undefined) png.inline = bytes.toString('base64');
        components.push({ type: 'image/png', size: bytes.length, sha256: png.marker?.sha256 || digest(bytes) });
      }
      if (!components.length) throw new Error('Imported artifact has no offline content');
      if (version.components) {
        for (const claimed of version.components) {
          const actual = components.find(component => component.type === claimed.type);
          if (actual && (actual.sha256 !== claimed.sha256 || actual.size !== claimed.size)) throw fail('component_integrity', `COMPONENT_INTEGRITY: imported ${claimed.type} component does not match its recorded SHA-256; the export is damaged or was altered`);
        }
      } else loss('artifacts', 'versions.components', 'source had no component hashes; hashes computed at import');
      const previous = version.previousVersionId ? mapping.get(version.previousVersionId) : null;
      if (version.previousVersionId && !previous) loss('artifacts', 'versions.previousVersionId', 'previous version not in export; link removed');
      stats.versions++;
      const stored = { id: (version.id && mapping.get(version.id)) || uuid('version'), number: version.number ?? index + 1, createdAt: version.createdAt ?? now(), actor: version.actor ?? 'human', method: version.method ?? 'import',
        url: version.url ? sanitizeUrl(version.url) : '', title: version.title ?? fields.title, components, ...(text?.inline !== undefined ? { text: text.inline } : {}), ...(png?.inline !== undefined ? { pngBase64: png.inline } : {}),
        navigationVersion: version.navigationVersion ?? undefined, limitations: version.limitations ?? ['Imported content has not been independently verified.'], redactionStatus: version.redactionStatus ?? 'not-reviewed', previousVersionId: previous,
        provenance: { imported: true, sourceVersionId: version.id ?? null }, ...(version.origin !== undefined && { origin: importedOrigin(version.origin, 'import', mapping) }) };
      if (text?.bytes) deferred.push(() => lazy(stored, 'text', text));
      if (png?.bytes) deferred.push(() => lazy(stored, 'pngBase64', png));
      return stored;
    });
    return fields;
  }
  /** Rewrite exported identifiers cited inside free-form text. Captured text and hashed bytes are never altered. */
  rewriteCitations(record, mapping, stats) {
    const skip = new Set(['id', 'workspaceId', 'evidence', 'materialIds', 'outputs', 'attachments', 'previousVersionId', 'provenance', 'components', 'sha256', 'text', 'pngBase64', 'fileBase64', 'taskId', 'revisions',
      'origin', 'lastOrigin', 'citations', 'proposal', 'promotedFrom', 'superseded', 'derivedFrom', 'link', 'service', 'subjects', 'resolution', 'items', 'members']);
    const visit = value => {
      if (typeof value === 'string') return value.replace(ID_TOKEN, token => { if (mapping.has(token)) { stats.freeFormCitations++; return mapping.get(token); } stats.unresolvedCitations.add(token); return token; });
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === 'object') { for (const name of Object.keys(value)) if (!skip.has(name)) value[name] = visit(value[name]); }
      return value;
    };
    visit(record);
  }

  // ---- Backups -----------------------------------------------------------------------
  async backupCommand(name, args, dryRun) {
    if (name === 'backups.create') {
      const result = createBackup(this.storage, { kind: 'manual', note: args.note || '', clock: this.clock });
      if (result.status !== 'verified') throw fail('command_failed', `BACKUP_INVALID: the new backup failed verification (${result.problems.map(item => item.problem).join(', ')})`);
      return result;
    }
    if (name === 'backups.list') return { backups: listBackups(this.directory), policy: { ...this.backupPolicy }, location: join(this.directory, 'backups') };
    if (name === 'backups.verify') return verifyBackup(this.directory, args.id);
    if (name === 'backups.delete') return deleteBackup(this.directory, args.id);
    const verification = verifyBackup(this.directory, args.id);
    if (verification.status !== 'verified') throw fail('command_failed', `BACKUP_INVALID: backup failed verification; nothing was changed (${verification.problems.slice(0, 5).map(item => `${item.path}: ${item.problem}`).join('; ')})`);
    if (dryRun) {
      const current = Object.fromEntries(Object.entries(this.data).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
      return { dryRun: true, applied: false, result: { backup: verification }, changes: { current, restored: verification.counts } };
    }
    return this.restoreFrom(args.id);
  }
  restoreFrom(id) {
    const previousWorkspaces = new Set(this.data.workspaces.map(item => item.id));
    this.storage.close();
    let result;
    let failure;
    try { result = restoreBackup(this.directory, id, { clock: this.clock }); }
    catch (error) { failure = error; try { recoverInterruptedRestore(this.directory); } catch { /* reported below */ } }
    try { this.openStorage(); }
    catch (error) { throw fail('command_failed', `RESTORE_INCOMPLETE: ${failure?.message || error.message}. Restart Weft to finish recovery; originals are preserved under ${RECOVERY_DIR}/.`); }
    if (failure) throw failure;
    this.storage.sweepOrphans();
    this.log('backups.restore', this.activeWorkspaceId, this.activeWorkspaceId, 'human', `Restored ${id}; previous data preserved in ${result.preservedOriginal}`);
    this.save();
    const remaining = new Set(this.data.workspaces.map(item => item.id));
    return Promise.resolve().then(async () => {
      for (const workspaceId of previousWorkspaces) if (!remaining.has(workspaceId)) await this.browser?.closeWorkspace?.(workspaceId);
      await this.browser?.switchWorkspace?.(this.activeWorkspaceId);
      return { ...result, activeWorkspaceId: this.activeWorkspaceId };
    });
  }
  runAutomaticBackup() {
    const run = this.queue.then(() => {
      if (this.closed || !this.backupPolicy.automatic) return;
      try {
        const latest = listBackups(this.directory).find(item => item.kind === 'automatic' && item.status !== 'invalid');
        if (latest && this.clock() - Date.parse(latest.createdAt) < this.backupPolicy.intervalHours * 3600 * 1000) return;
        const result = createBackup(this.storage, { kind: 'automatic', clock: this.clock });
        if (result.status !== 'verified') throw new Error(`automatic backup failed verification: ${result.problems.map(item => item.problem).join(', ')}`);
        pruneBackups(this.directory, { kind: 'automatic', keep: this.backupPolicy.keep });
        this.backupPolicy.lastRunAt = new Date(this.clock()).toISOString();
        this.backupPolicy.lastError = null;
      } catch (error) {
        this.backupPolicy.lastError = error.message;
        this.onWarning({ code: 'BACKUP_FAILED', message: `Automatic backup failed: ${error.message}` });
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

