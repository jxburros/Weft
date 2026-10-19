import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { workspaceSchemas, recordShapes, finishReason } from './workspace-commands.js';
import { acquireProfileLock, storageWarnings, syncDirectory } from './storage-safety.js';
import { CURRENT_SCHEMA_VERSION, migrateSchema } from './migrations.js';
import { secretKey, rejectSecretKeys, inspectExportResidue } from './export-safety.js';
import { MetadataStore, OMITTED_RESULT, RECOVERY_DIR, STORE_FILE, canonicalJson } from './store.js';
import { trackChanges, untracked } from './change-tracker.js';
import { serialize } from './helpers.js';
import { componentPath, sha256 } from './components.js';
import { cleanupBackupTemporary, createBackup, deleteBackup, listBackups, pruneBackups, recoverInterruptedRestore, restoreBackup, verifyBackup } from './backups.js';
import { executeHandoffCommand, importHandoffs, recordTakeover } from './handoffs.js';
import { effectiveRule, explainRules } from './site-rules.js';
import { originFor, importedOrigin } from './provenance.js';
import { TRUSTED_CATEGORIES, buildCitations, exportCollections, exportMaterial, forCaller, importCollections, importConflicts, importContextFields, linkedOmissions, prefetchSourceTexts, quotedSources, recheckCitations, sharedAccess, sharedInto } from './context-records.js';
import { archiveManifest, diffResources, diffText } from './archive.js';
import { clipRects, decodePng, diffImages, encodePng, fillRects } from './png.js';
import { DETECTION_SCOPE, redactText, reduceUrl, resolveSpans, reviewText, reviewUrl } from './redaction.js';
import { DEFAULT_PAGE_LIMIT, decodeCursor, encodeCursor, pageItems } from './pagination.js';
import { RRF_K, documentKey, reciprocalRankFusion } from './retrieval.js';
import { createKeyProtector, lockedError } from './encryption.js';
import { ProfileEncryption } from './profile-encryption.js';
import { encryptionSchemas } from './encryption-commands.js';
// Same registered symbol as commands.js PARTIAL_COVERAGE (not imported here to avoid an import cycle).
const PARTIAL_COVERAGE = Symbol.for('weft.partialCoverage');
import { applyTransition, appendTimeline, normalizePhase, sameIdentity, staleness, TERMINAL_PHASES } from './task-phases.js';

const collections = [...Object.keys(recordShapes), 'artifacts'];
const now = () => new Date().toISOString();
const clone = value => structuredClone(untracked(value));
const uuid = prefix => `${prefix}_${randomUUID()}`;
const digest = value => sha256(value);
const MAX_FILE = 100 * 1024 * 1024;
const MAX_PACKAGE_RECORDS_FILE = 256 * 1024 * 1024;
const LEGACY_FILE = 'workspace-state.json';
const TRANSFERS_DIR = 'transfers';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REPLAYED = Symbol.for('weft.replayed');
const WORKFLOW_EXECUTABLE = ['watch', 'steps', 'parameters', 'allowedSites', 'materialIds', 'credentialRefs'];
const urlSecret = /token|secret|password|credential|authorization|api.?key|session|signature|^code$|^key$/i;
const fail = (code, message, extra = {}) => Object.assign(new Error(`${code.toUpperCase()}: ${message}`), { code, ...extra });
const HUMAN_ADMIN = new Set(['memories.create', 'memories.update', 'memories.delete', 'search.configureEmbeddings', 'search.indexing', 'siteRules.review', 'settings.update', 'workspaces.delete', 'workspaces.import', 'workspaces.export', 'workspaces.switch', 'workspaces.exportPackage', 'workspaces.importPackage', 'backups.create', 'backups.list', 'backups.verify', 'backups.restore', 'backups.delete',
  'artifacts.setAccess', 'artifacts.purgeContent', 'artifacts.preview', 'artifacts.closePreview']);
// activity.list is served by the durable activity log (src/activity-log.js) through the dispatcher.
const READS = new Set(['history.list', 'bookmarks.list', 'workspace.snapshot', 'settings.get', 'workspaces.list', 'workspaces.get', 'workspaces.export', 'artifacts.versions', 'conversations.messages',
  'artifacts.compare', 'artifacts.verify', 'artifacts.review', 'artifacts.readOriginal', ...collections.flatMap(name => [`${name}.list`, `${name}.get`])]);
const isAgent = context => !['human', 'admin'].includes(context?.actor || 'human');
const RESTRICTED_NOTICE = 'Restricted original: its content, URL and title are withheld from agents. Use a sanitized derivative version, or ask a person to approve artifacts.readOriginal for this exact version.';
// Batches contain record writes only: these can be rolled back exactly.
export const BATCHABLE = Object.freeze(new Set([...Object.keys(recordShapes).flatMap(name => [`${name}.create`, `${name}.update`, `${name}.delete`]),
  'tasks.transition', 'conversations.message', 'artifacts.create', 'artifacts.annotate', 'artifacts.delete', 'bookmarks.create', 'bookmarks.delete', 'workspaces.update', 'settings.update']));
const WITH_EFFECTS = new Set(['workspaces.create', 'workspaces.switch', 'workspaces.archive', 'workspaces.delete', 'workspaces.import', 'workspaces.importPackage']);
// Candidates per index fused by reciprocal rank; hybrid result pages end after this many per index.
const HYBRID_WINDOW = 200;
const ID_TOKEN = /\b[a-z]{2,12}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const EXPORT_EXCLUDED = Object.freeze(['Browser sessions, tabs, cookies and site storage', 'Credentials, provider keys and model connection settings', 'Global site rules', 'Activity log and browsing history', 'Local search index and request identities', 'Local backups',
  'Site storage modes and exceptions: browser privacy policy for this profile; set them again after import',
  'Community list subscriptions: signed list state is verified on install; subscribe again to receive and track rules',
  'Approvals, autonomy ceilings and agent connection grants: authority is never transferred with data',
  'Shared collection participants and roles: grants to other workspaces are authority and must be given again',
  'Linked file and folder contents and local paths, service credentials and cached service content: relink or refresh after import',
  'Scheduled freshness check settings',
  'Tab groups and the last-view resume record: they describe this profile’s open tabs and layout, not project records']);
/** Workspace-scoped collections handled outside recordShapes: shared collections, evidence conflicts and freshness policies. */
const KNOWLEDGE_COLLECTIONS = Object.freeze(['sharedCollections', 'conflicts', 'freshnessPolicies']);
const PLAINTEXT_EXPORT = 'Exported from an encrypted profile: this export is NOT encrypted. Store or share it accordingly.';
// Workspace-scoped profile state that is deliberately not part of the export format (listed above with the reason).
const NOT_EXPORTED = new Set(['storagePolicies', 'siteLists', 'freshnessPolicies', 'tabGroups', 'resumeStates']);
// Workspace-scoped view state removed with its workspace.
const VIEW_STATE = ['tabGroups', 'resumeStates'];

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
  data.memories ??= []; // Additive collection for pre-1.3 profiles and legacy JSON migrations.
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
  return { schemaVersion: CURRENT_SCHEMA_VERSION, activeWorkspaceId: initial.id, workspaces: [initial], ...Object.fromEntries(collections.map(name => [name, []])), history: [], activity: [], settings: { theme: 'system', model: { provider: 'compatible', endpoint: 'http://localhost:11434/v1', model: '' }, sidebarCollapsed: false, agentPanelOpen: false }, browserSession: { tabs: [], activeId: null }, handoffs: [], tabGroups: [], resumeStates: [],
    ...Object.fromEntries(KNOWLEDGE_COLLECTIONS.map(name => [name, []])) };
}
/** Version metadata without content. Agents see restricted originals as withheld stubs that name their sanitized derivatives. */
function versionMetadata(record, version, agent = false) {
  const derivatives = record.versions.filter(item => item.derivedFrom === version.id).map(item => item.id);
  if (agent && version.access === 'restricted') {
    return { id: version.id, number: version.number, createdAt: version.createdAt, method: version.method, access: 'restricted', withheld: 'restricted_original',
      components: (version.components || []).map(({ type }) => ({ type })), ...(version.purged ? { purged: clone(version.purged) } : {}), derivatives, notice: RESTRICTED_NOTICE };
  }
  const copy = clone(version);
  delete copy.text; delete copy.pngBase64;
  if (copy.archive) copy.archive = archiveManifest(copy.archive);
  if (derivatives.length) copy.derivatives = derivatives;
  return copy;
}
function artifactSummary(record, { agent = false } = {}) {
  const { versions, ...rest } = record;
  return { ...clone(rest), versions: versions.map(version => versionMetadata(record, version, agent)) };
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
  navigationVersion: z.number().int().nullable().optional(), limitations: z.array(z.string().max(2000)).max(50).optional(), redactionStatus: z.string().max(50).optional(), previousVersionId: z.string().max(128).nullable().optional(),
  archive: z.lazy(() => archiveSchema).optional(), capture: z.record(z.string().max(100), z.unknown()).optional(), derivedFrom: z.string().max(128).nullable().optional(), derivedFromNumber: z.number().int().min(1).optional(),
  redactions: z.array(z.record(z.string().max(100), z.unknown())).max(100000).optional(), inaccessibleRegions: z.array(z.record(z.string().max(100), z.unknown())).max(1000).optional(),
  access: z.enum(['restricted']).optional(), accessChangedAt: timestamp.optional(), accessChangedBy: z.string().max(200).optional(), purged: z.object({ at: timestamp, by: z.string().max(200) }).optional(),
  review: z.record(z.string().max(100), z.unknown()).optional(), origin: z.unknown().optional() });
const archiveResourceSchema = z.object({ url: z.string().max(16384), role: z.enum(['document', 'frame', 'subresource']), mimeType: z.string().max(128).optional(), size: z.number().int().min(0).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  status: z.enum(['stored', 'omitted-size', 'omitted-budget', 'missing', 'failed', 'not-archived-script', 'purged']), contentId: z.string().max(512).optional(), transformed: z.array(z.string().max(100)).max(10).optional(),
  referencedAs: z.string().max(30).optional(), httpStatus: z.number().int().optional(), error: z.string().max(200).optional(), reason: z.string().max(300).optional(), bodyBase64: z.union([z.string().max(48 * 1024 * 1024), componentRef]).optional() });
const archiveSchema = z.object({ format: z.literal('weft-archive'), formatVersion: z.literal(1), generator: z.string().max(50).optional(), documentUrl: z.string().max(16384).optional(), snapshotUrl: z.string().max(16384).optional(),
  status: z.string().max(30).optional(), reason: z.string().max(500).optional(), resources: z.array(archiveResourceSchema).max(10000).default([]), counts: z.record(z.string().max(40), z.number().int().min(0)).default({}), storedBytes: z.number().int().min(0).optional(),
  limits: z.record(z.string().max(40), z.number()).optional(), transformations: z.record(z.string().max(60), z.number().int().min(0)).optional(), complete: z.boolean().optional(), stored: z.number().int().min(0).optional() });
const artifactSchema = z.object({ title: z.string().min(1).max(240), note: z.string().max(500000).default(''), tags: z.array(z.string().max(100)).max(100).default([]), versions: z.array(versionSchema).max(1000), annotations: z.array(annotationSchema).max(10000).default([]) });
const SYSTEM_FIELDS = { common: ['id', 'workspaceId', 'createdAt', 'updatedAt', 'revision'], materials: ['history', 'size', 'sha256', 'link', 'service', 'copiedFrom', 'superseded', 'derivedFrom', 'lastOrigin'],
  context: ['history', 'proposal', 'promotedFrom', 'promotionNote', 'superseded', 'derivedFrom', 'lastOrigin'], conversations: ['messages', 'turnManifests'], artifacts: ['versions', 'annotations'],
  tasks: ['timeline', 'operations', 'run', 'executor', 'workflowRun'],
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
  constructor({ directory, browser, onWarning = warning => console.warn(`Weft storage: ${warning.message}`), backups = null, clock = Date.now, keyProtector = null, encryption = {} } = {}) {
    if (!directory) throw new Error('Workspace data directory is required');
    this.directory = directory;
    this.lock = acquireProfileLock(directory);
    this.browser = browser;
    this.queue = Promise.resolve();
    this.onWarning = onWarning;
    this.warned = new Set();
    this.clock = clock;
    this.path = join(directory, STORE_FILE);
    // Workspace encryption (ADR 014). Hooks are set by the app: stop work before lock, restore tabs after unlock.
    this.encryption = new ProfileEncryption({ directory, protector: keyProtector ?? createKeyProtector(), ...(encryption.kdf && { kdfParams: encryption.kdf }), clock });
    this.encryptionHooks = { beforeLock: async () => {}, afterUnlock: async () => {} };
    // Profile files outside workspace-data that are sealed with the same keys (payment records, ADR 019) follow every key change.
    this.sealedStores = new Set();
    this.locked = false;
    try {
      this.refreshStorageWarnings();
      this.recoveredRestore = recoverInterruptedRestore(directory);
      cleanupBackupTemporary(directory);
      MetadataStore.cleanupTemporary(directory);
      this.recoveredEncryption = this.encryption.recoverPending();
      if (!this.encryption.tryAutoUnlock()) this.locked = true;
      else {
        this.openStorage();
        this.storage.sweepOrphans();
        if (this.encryption.keyring?.rotation) this.resumeRotation().catch(() => {});
      }
    } catch (error) { this.storage?.close(); this.encryption.forget(); this.lock.release(); throw error; }
    const service = this;
    this.store = { get data() { return service.data; }, save: () => service.save() };
    this.backupPolicy = { automatic: Boolean(backups?.automatic), intervalHours: backups?.intervalHours ?? 24, keep: backups?.keep ?? 5, lastRunAt: null, lastError: null };
    if (this.backupPolicy.automatic) {
      this.backupTimer = setInterval(() => this.runAutomaticBackup(), 3600 * 1000);
      this.backupTimer.unref?.();
      setImmediate(() => this.runAutomaticBackup());
    }
  }
  /** Workspace state; during a transaction, a change-tracking view of it (#108). */
  get data() { if (this.locked) throw lockedError(this.encryption.lockReason ?? 'locked'); return this.tracking?.proxy ?? this._data; }
  // Restoring a structuredClone of state must keep component-backed fields.
  set data(value) {
    // Replacing the whole state mid-transaction makes its change hints meaningless: that commit diffs everything.
    if (this.tracking) { this.tracking.finish(); this.tracking = null; }
    this._data = this.storage ? this.storage.reattach(untracked(value)) : untracked(value);
    this.revision = (this.revision ?? 0) + 1;
  }
  assertUnlocked() { if (this.locked) throw lockedError(this.encryption.lockReason ?? 'locked'); }
  /** Run work after every queued workspace operation, alone. */
  exclusive(work) {
    return serialize(this, work);
  }
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
    const storage = new MetadataStore({ directory: this.directory, assertOwned, clock: this.clock, keys: this.encryption.keys }).open();
    try {
      if (existsSync(legacy)) this.finishLegacyMigration(storage, legacy);
      let data = storage.load();
      // A record collection introduced after this database was created starts empty.
      for (const name of collections) if (data[name] === undefined) data[name] = [];
      // Handoffs were added without a schema bump; older stores start with none.
      if (!Array.isArray(data.handoffs)) data.handoffs = [];
      // Shared collections, conflicts and freshness policies (#21, #23) were also added without a schema bump.
      for (const name of KNOWLEDGE_COLLECTIONS) if (!Array.isArray(data[name])) data[name] = [];
      // One phase vocabulary (ADR 016): the older `waiting` task state is `waiting_on_human`.
      const legacyTasks = (data.tasks ?? []).filter(task => task.status === 'waiting');
      for (const task of legacyTasks) { task.status = 'waiting_on_human'; appendTimeline(task, { type: 'transition', from: 'waiting', to: 'waiting_on_human', actor: 'system', reason: 'legacy', at: now() }); }
      // Tab groups and resume records (#24) likewise start empty in older stores.
      for (const key of VIEW_STATE) if (!Array.isArray(data[key])) data[key] = [];
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
      if (legacyTasks.length) this.save();
    } catch (error) { storage.close(); throw error; }
    this.startIndexing();
  }

  // ---- Background search indexing (#30) ----------------------------------------------
  /**
   * A new or changed full-text index (FTS version change, or an encrypted profile's in-memory index after
   * unlock) is rebuilt in bounded batches (at most ~10 ms or 500 records each) between commands, never while
   * opening the workspace or handling a command. One short batch runs now so small stores are complete at once.
   * Searches meanwhile return partial results with coverage; search.status reports progress and a person can
   * pause and resume it (search.indexing).
   */
  startIndexing() {
    const storage = this.storage;
    if (!storage?.indexing) { this.scheduleScrub(); return; }
    if (this.indexingPaused) storage.indexing.paused = true;
    else {
      try { storage.indexStep({ maxRecords: 2000, budgetMs: 30 }); } catch (error) { this.indexingFailed(storage, error); return; }
      if (!storage.indexing) { this.scheduleScrub(); return; }
    }
    this.emitIndexing(storage.indexing.paused ? 'paused' : 'started', storage);
    this.scheduleIndexing();
  }
  /**
   * After a stale-index drop, scrub the freed pages (storage.scrubIfNeeded: VACUUM) on a later tick, never while
   * opening or inside a command. Runs again at the next open if interrupted (the marker is durable).
   */
  scheduleScrub() {
    const storage = this.storage;
    if (this.scrubTimer || this.closed || this.locked || !storage?.needsScrub || storage.indexing) return;
    this.scrubTimer = setTimeout(() => {
      this.scrubTimer = null;
      if (this.storage !== storage || !storage.db || this.closed || this.locked || storage.indexing) return;
      try { storage.scrubIfNeeded(); } catch (error) { this.onWarning({ code: 'SCRUB_FAILED', message: `Scrubbing pages freed by the old search index failed and will be retried: ${error.message}` }); }
    }, 0);
    this.scrubTimer.unref?.();
  }
  scheduleIndexing() {
    const storage = this.storage;
    if (this.indexTimer || this.closed || this.locked || !storage?.indexing || storage.indexing.paused || storage.indexing.error) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      if (this.storage !== storage || !storage.db || this.locked || !storage.indexing || storage.indexing.paused) return;
      let step;
      try { step = storage.indexStep(); } catch (error) { this.indexingFailed(storage, error); return; }
      if (step.complete) { this.emitIndexing('completed', storage, { processed: step.total, total: step.total }); this.scheduleScrub(); return; }
      const percent = Math.floor((step.done / Math.max(1, step.total)) * 10);
      if (percent > (storage.indexing.reported ?? 0)) { storage.indexing.reported = percent; this.emitIndexing('progress', storage); }
      this.scheduleIndexing();
    }, 0);
    this.indexTimer.unref?.();
  }
  indexingFailed(storage, error) {
    if (!storage.indexing) return;
    storage.indexing.error = String(error.message).slice(0, 300);
    this.onWarning({ code: 'SEARCH_INDEX_FAILED', message: `Search indexing stopped: ${error.message}. Searches stay partial; restart Weft to retry.` });
    this.emitIndexing('failed', storage);
  }
  emitIndexing(status, storage, counts = null) {
    const state = storage.indexing;
    try { this.onIndexingEvent?.({ type: 'indexing', status, processed: counts?.processed ?? state?.done ?? 0, total: counts?.total ?? state?.total ?? 0, createdAt: new Date(this.clock()).toISOString() }); } catch { /* events are best effort */ }
  }
  /** Pause or resume the background rebuild (human administration). A paused plaintext rebuild resumes at the next start. */
  indexingControl(action) {
    this.indexingPaused = action === 'pause';
    const storage = this.storage;
    if (storage?.indexing) {
      const changed = storage.indexing.paused !== this.indexingPaused;
      storage.indexing.paused = this.indexingPaused;
      if (changed) this.emitIndexing(this.indexingPaused ? 'paused' : 'resumed', storage);
      if (!this.indexingPaused) { storage.indexing.error = null; this.scheduleIndexing(); }
    }
    return { action, paused: this.indexingPaused, indexing: this.storage.indexingStatus(),
      notice: this.indexingPaused ? 'Search index rebuilding is paused. Searches return partial results until it is resumed (or Weft restarts).' : 'Search index rebuilding runs in the background between commands.' };
  }
  /** Resolves when the background rebuild has finished (or is paused or failed); for tools and tests. */
  async indexingIdle({ timeoutMs = 60000 } = {}) {
    const until = Date.now() + timeoutMs;
    while (this.storage?.indexing && !this.storage.indexing.paused && !this.storage.indexing.error && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    return this.storage?.indexingStatus?.() ?? null;
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
    clearTimeout(this.indexTimer);
    clearTimeout(this.scrubTimer);
    this.storage?.close();
    this.encryption.forget();
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
      this.save({ only: ['history'] });
    } catch (error) { this.data.history = before; throw error; }
  }

  get activeWorkspaceId() { return this.data.activeWorkspaceId; }
  get encrypted() { return this.encryption.enabled; }
  attachBrowser(browser) { this.browser = browser; }
  save(options = {}) {
    this.assertUnlocked();
    this.lock.assertOwned();
    const { hints, ...rest } = options;
    // Hinted commits (#108) diff only what the transaction touched. A stale tracking view used after its transaction,
    // and every 64th commit, fall back to a full diff so a change made outside the tracked path is still written.
    this.hintedCommits = ((this.hintedCommits ?? 0) + 1) % 64;
    const full = !hints || this.fullDiffNext || this.hintedCommits === 0;
    const result = this.storage.commit(this._data, full ? rest : { ...rest, hints });
    if (full) this.fullDiffNext = false;
    this.revision = (this.revision ?? 0) + 1;
    return result;
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
      tabs: session.tabs.map(tab => ({ id: tab.id, workspaceId: tab.workspaceId, url: sanitizeUrl(tab.url) || 'about:blank', title: String(tab.title || '').slice(0, 1000), pinned: Boolean(tab.pinned), version: tab.version || 0,
        ...(typeof tab.groupId === 'string' && { groupId: tab.groupId.slice(0, 128) }),
        // A suspended tab is restored unloaded at its saved scroll position (#30).
        ...(tab.suspended && { suspended: { at: String(tab.suspended.at || '').slice(0, 40), reason: String(tab.suspended.reason || '').slice(0, 60), scrollX: Number(tab.suspended.scrollX) || 0, scrollY: Number(tab.suspended.scrollY) || 0, zoom: Number(tab.suspended.zoom) || 1 } }),
        controller: tab.controller === 'human' ? 'human' : 'available', ...(tab.controller === 'human' && tab.assistant && { assistant: String(tab.assistant).slice(0, 200) }) })),
      activeId: session.activeId ?? null,
    };
    // Only the session row is written: frequent tab updates never re-serialize every record (#30).
    try { this.save({ only: ['browserSession'] }); } catch (error) { this.data.browserSession = before; throw error; }
  }
  snapshot({ agent = false } = {}) {
    this.assertUnlocked();
    const { learning, ...visible } = this._data;
    return { ...clone(visible), storageWarnings: clone(this.refreshStorageWarnings()), artifacts: this.data.artifacts.map(item => artifactSummary(item, { agent })), materials: this.data.materials.map(withoutFile) };
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
    // Search the plain array so only the record found counts as read by change tracking (#108).
    const list = this.data[collection];
    const index = untracked(list)?.findIndex(item => item.id === id) ?? -1;
    const record = index >= 0 ? list[index] : undefined;
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
    return serialize(this, () => { context.assertAuthorized?.(); this.assertUnlocked(); this.storage.assertOpen(); return this.transact(work, { context }); });
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
    return serialize(this, () => {
      const before = this.data.activity;
      let kept = cutoff ? before.filter(item => String(item.createdAt) >= cutoff) : before;
      if (maxEntries && kept.length > maxEntries) kept = kept.slice(-maxEntries);
      if (kept.length === before.length) return 0;
      return this.commitChange(() => { this.data.activity = kept; return before.length - kept.length; });
    });
  }
  matchSiteRule(value, workspaceId) {
    // While locked, no workspace page may load: fail closed.
    if (this.locked) return { id: null, hostname: null, behavior: 'block', mode: 'connection', reason: 'Weft is locked', source: 'encryption' };
    return clone(effectiveRule(this.data.siteRules, value, workspaceId ?? this.activeWorkspaceId));
  }
  /** Every matching rule with explicit precedence; browser adds exceptions/security findings. */
  explainSiteRules(value, workspaceId = this.activeWorkspaceId, extras = {}) {
    this.workspace(workspaceId);
    return clone(explainRules(this.data.siteRules, value, workspaceId, extras));
  }
  getConversation(id) { return clone(this.record('conversations', id)); }
  appendMessage(id, message) { return this.execute('conversations.message', { id, ...message }); }
  recordTurnManifest(id, manifest) {
    return serialize(this, () => {
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
  }

  executeHandoff(name, args = {}, context = {}) {
    return serialize(this, () => {
      if (context.signal?.aborted) throw Object.assign(new Error('The request deadline passed before the command started'), { code: context.signal.reason?.code === 'deadline_exceeded' ? 'deadline_exceeded' : 'cancelled', notStarted: true, details: { started: false, effect: 'not_started' } });
      context.markStarted?.();
      return executeHandoffCommand(this, name, args, context);
    });
  }
  /**
   * Create the target of a verified chunked upload (src/transfers.js). Runs the same apply/transact
   * path as artifacts.create and materials.create, including request identity; the upload replaces
   * only the per-request JSON size cap, never the stored-content limits.
   */
  commitUpload(name, args, context = {}, requestId) {
    return serialize(this, () => {
      context.assertAuthorized?.();
      this.assertUnlocked();
      this.storage.assertOpen();
      rejectSecretKeys(args);
      const fields = name === 'materials.create' ? workspaceSchemas[name].parse(args) : args;
      this.authorize(name, fields, context);
      const request = requestId ? this.requestIdentity(name, { ...fields, ...(fields.fileBase64 ? { fileBase64: digest(fields.fileBase64) } : {}), ...(fields.pngBase64 ? { pngBase64: digest(fields.pngBase64) } : {}), ...(fields.text ? { text: digest(fields.text) } : {}) }, context, requestId) : null;
      if (request?.replay) return request.replay;
      const effects = [];
      return this.transact(() => this.apply(name, { ...fields }, context, effects), { context, request, effects });
    });
  }
  recordTakeover(details) {
    return serialize(this, () => recordTakeover(this, details));
  }
  /** Task transitions committed by the last transaction are reported after commit (activity log, events). */
  flushNotices() {
    const notices = this.notices ?? [];
    this.notices = [];
    for (const notice of notices) try { this.onTaskTransition?.(notice); } catch (error) { console.warn(`Weft task activity: ${error.message}`); }
  }
  noteTransition(record, entry) { (this.notices ??= []).push({ taskId: record.id, workspaceId: record.workspaceId, ...entry }); return entry; }
  /** Validated phase change with attribution, persisted on the record and reported after commit. */
  transitionTask(record, to, options) {
    const entry = applyTransition(record, to, options);
    return this.noteTransition(record, entry);
  }
  /** Runtime-owned change to one task, committed in its own transaction through the mutation queue. */
  mutateTask(id, mutate) {
    return serialize(this, () => this.transact(() => {
      const record = this.record('tasks', id);
      const result = mutate(record, this);
      this.touch(record);
      return result === undefined ? record : result;
    }));
  }
  execute(name, args = {}, context = {}) {
    // Search reads and embedding administration wait on local model endpoints; they never hold the write queue.
    if (name.startsWith('learning.')) {
      if (!this.learning) throw new Error('Background learning is unavailable');
      return this.learning.execute(name, workspaceSchemas[name].parse(args), context);
    }
    if (name.startsWith('search.')) return this.searchCommand(name, args, context);
    return serialize(this, () => this.run(name, args, context));
  }
  async run(name, input, context) {
    // A command whose deadline passed while it waited in the queue never starts.
    if (context.signal?.aborted) throw Object.assign(new Error('The request deadline passed before the command started'), { code: context.signal.reason?.code === 'deadline_exceeded' ? 'deadline_exceeded' : 'cancelled', notStarted: true, details: { started: false, effect: 'not_started' } });
    context.markStarted?.();
    context.assertAuthorized?.();
    this.assertUnlocked();
    this.storage.assertOpen();
    if (name === 'batch.execute') return this.runBatch(input, context);
    const schema = workspaceSchemas[name];
    if (!schema) throw new Error(`Unknown workspace command: ${name}`);
    rejectSecretKeys(input);
    const { requestId, dryRun, ...args } = schema.parse(input);
    const scope = this.authorize(name, args, context);
    if (READS.has(name) || (name === 'artifacts.redact' && args.preview)) return this.read(name, args, context, scope);
    if (name === 'artifacts.preview' || name === 'artifacts.closePreview') return this.previewCommand(name, args, context);
    if (name === 'workspaces.exportPackage') { this.assertPlaintextExport(args); return this.exportPackage(args.id, args.name, args.sensitiveTerms, { captures: args.captures }); }
    if (name.startsWith('backups.')) return this.backupCommand(name, args, dryRun);
    const request = requestId && !dryRun ? this.requestIdentity(name, args, context, requestId) : null;
    if (request?.replay) return request.replay;
    const effects = [];
    const result = await this.transact(() => this.apply(name, args, context, effects), { context, dryRun, request, effects, checkpoint: WITH_EFFECTS.has(name) ? this.storage.checkpoint() : null });
    if (!dryRun && ['artifacts.setAccess', 'artifacts.purgeContent'].includes(name)) {
      // Removed index rows and documents must not linger in write-ahead-log frames.
      try { this.storage.secureCompact(); } catch (error) { this.onWarning({ code: 'COMPACT_FAILED', message: `Search index compaction failed: ${error.message}` }); }
      if (name === 'artifacts.purgeContent') {
        const hashes = result.componentHashes || [];
        delete result.componentHashes;
        const kept = hashes.filter(hash => this.storage.components.has(hash)).length;
        Object.assign(result, { componentsDeleted: hashes.length - kept, componentsKept: kept, backups: listBackups(this.directory).length,
          limitations: ['Component files are deleted from the profile; Weft cannot guarantee physical erasure from the storage device, filesystem snapshots or sync copies.',
            ...(kept ? [`${kept} component(s) are still used by another version or record (for example an unchanged screenshot in a derivative) and were kept.`] : []),
            'Existing backups and exports made before this purge still contain the content; delete them separately if required.'] });
      }
    }
    return result;
  }
  authorize(name, args, context) {
    const actor = context.actor || 'human';
    const admin = actor === 'human' || actor === 'admin';
    if (!admin && ['workspaces.create', 'workspaces.update'].includes(name) && ['instructions', 'contextLocalOnly'].some(field => Object.hasOwn(args.changes || args, field))) throw new Error('PERMISSION_REQUIRED: workspace instructions require human review');
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
    // Note what the change reads and writes so the commit diffs only that (#108). A nested transaction commits in full.
    const tracker = this.tracking || !this._data ? null : trackChanges(this._data, { onLate: () => { this.fullDiffNext = true; } });
    if (tracker) this.tracking = tracker;
    let hints = null;
    const stop = () => {
      if (!tracker) return;
      const found = tracker.finish();
      if (this.tracking === tracker) { this.tracking = null; hints = found; }
    };
    try {
      const result = await work();
      stop();
      context.assertAuthorized?.();
      // A deadline that passed while the change was prepared rolls it back instead of committing late.
      if (context.signal?.aborted && context.signal.reason?.code === 'deadline_exceeded') throw Object.assign(new Error('The request deadline passed before the change committed; nothing was saved'), { code: 'deadline_exceeded', details: { started: true, effect: 'rolled_back' } });
      if (dryRun) {
        const preview = { dryRun: true, applied: false, result: this.output(result), changes: this.storage.changes(this._data) };
        this.data = this.storage.revert(this._data, hints);
        this.notices = [];
        return preview;
      }
      output = this.output(result);
      ({ released } = this.save({ requests: request ? [{ ...request.record, result: output }] : [], deferCollection: effects.length > 0, hints }));
    } catch (error) {
      stop();
      this.notices = [];
      // The profile locked while this change was prepared (ADR 014): nothing is open to revert or commit.
      if (this.locked || !this.storage?.db) throw this.locked ? lockedError(this.encryption.lockReason ?? 'locked') : error;
      this.data = this.storage.revert(this._data, hints);
      throw error;
    }
    this.flushNotices();
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
    const fingerprint = this.storage.requestFingerprint(digest(canonicalJson({ command: name, args, workspaceId: context.workspaceId ?? null })));
    const existing = this.storage.request(scope, requestId);
    if (!existing) return { record: { scope, requestId, command: name, fingerprint, workspaceId: args.workspaceId ?? context.workspaceId ?? null } };
    // Identities committed before encryption was turned off cannot be re-fingerprinted: never apply them twice.
    if (existing.fingerprint === 'rekeyed') throw fail('already_committed', 'requestId was committed before workspace encryption was turned off; its arguments can no longer be compared. Read current state instead of retrying.', { notStarted: true });
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
    if (name === 'history.list') return clone((this.data.history || []).filter(item => item.workspaceId === workspaceId).slice(-(args.limit || (context.allItems ? Infinity : 100))).reverse());
    if (name === 'conversations.messages') {
      const record = this.record('conversations', args.id, context);
      const page = pageItems(record.messages, args.page, { command: name, scope: { id: record.id }, positional: true });
      return { conversationId: record.id, workspaceId: record.workspaceId, revision: record.revision, ...page, items: clone(page.items) };
    }
    if (name === 'artifacts.versions') {
      const record = this.record('artifacts', args.id, context);
      const page = pageItems(artifactSummary(record, { agent: isAgent(context) }).versions, args.page, { command: name, scope: { id: record.id }, positional: true });
      return { artifactId: record.id, workspaceId: record.workspaceId, revision: record.revision, ...page };
    }
    if (name === 'bookmarks.list') return this.data.materials.filter(item => item.workspaceId === workspaceId && item.kind === 'website' && item.pinned).map(withoutFile);
    if (name === 'workspace.snapshot') {
      // A cheap change marker (#109): every commit or state replacement moves it, as does a change in storage warnings.
      const revision = `${this.revision ?? 0}.${digest(JSON.stringify(this.refreshStorageWarnings())).slice(0, 12)}`;
      if (args.ifRevision === revision) return { unchanged: true, revision };
      const snapshot = this.snapshot({ agent: isAgent(context) });
      snapshot.revision = revision;
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
    if (name === 'workspaces.list') return clone(this.data.workspaces.filter(item => !context.workspaceId || item.id === context.workspaceId));
    if (name === 'workspaces.get') { if (context.workspaceId && args.id !== context.workspaceId) throw new Error('PERMISSION_REQUIRED'); return clone(this.workspace(args.id)); }
    if (name === 'workspaces.export') { this.assertPlaintextExport(args); return this.exportWorkspace(args.id, args.sensitiveTerms, { captures: args.captures, reviewMetadata: args.reviewMetadata }); }
    const derive = item => collection === 'tasks' && item.run?.inputs ? { ...item, staleness: staleness(item, this.data) } : item;
    if (action === 'list') return this.data[collection].filter(item => item.workspaceId === workspaceId || (collection === 'siteRules' && item.scope === 'global')).map(item => collection === 'artifacts' ? artifactSummary(item, { agent: isAgent(context) }) : collection === 'materials' ? forCaller(collection, withoutFile(item), context) : derive(clone(item)));
    // Shared-collection reads (#21) reach another workspace's records; restricted originals stay withheld from agents there too,
    // and reading an original or previewing a derivative of it stays within the owning workspace.
    const shared = ['materials', 'context'].includes(collection) || (collection === 'artifacts' && !['artifacts.readOriginal', 'artifacts.redact'].includes(name));
    const record = this.record(collection, args.id, context, { shared });
    if (collection === 'tasks') return derive(this.output(record));
    if (collection === 'artifacts') return this.readArtifact(name, record, args, context);
    return forCaller(collection, this.output(record), context);
  }
  attachRetrieval(retrieval) { this.retrieval = retrieval; }
  /** A profile store outside workspace-data sealed with this profile's keys: told about enable, disable, rotation, lock, unlock and restore. */
  attachSealedStore(store) { this.sealedStores.add(store); return store; }
  sealedStoreStep(step) { for (const store of this.sealedStores) store[step]?.(); }
  /** search.* commands: reads and embedding administration outside the write queue. */
  async searchCommand(name, input, context) {
    // A locked encrypted profile has no open store or decrypted index (ADR 014).
    this.assertUnlocked();
    if (context.signal?.aborted) throw Object.assign(new Error('The request deadline passed before the command started'), { code: context.signal.reason?.code === 'deadline_exceeded' ? 'deadline_exceeded' : 'cancelled', notStarted: true, details: { started: false, effect: 'not_started' } });
    context.markStarted?.();
    context.assertAuthorized?.();
    this.storage.assertOpen();
    rejectSecretKeys(input);
    const args = workspaceSchemas[name].parse(input);
    const { workspaceId } = this.authorize(name, args, context);
    if (name === 'search.query') return this.searchQuery(args, workspaceId, context);
    if (name === 'search.indexing') return this.indexingControl(args.action);
    if (name === 'search.status' && !this.retrieval) return { workspaceId, lexical: this.storage.lexicalCoverage(workspaceId), vector: { enabled: false, embedded: 0, pending: 0, unembedded: [], unembeddedCount: 0 } };
    if (!this.retrieval) throw Object.assign(new Error('Embeddings are unavailable in this process'), { code: 'unavailable' });
    return this.retrieval.execute(name, args, { ...context, workspaceId });
  }
  /**
   * Ranked local search. BM25 always; with embeddings enabled (mode auto/hybrid) lexical and
   * exact-cosine results are fused by reciprocal rank (k=60). Results cite the record revision or
   * exact capture version. Page mode adds coverage and an explicit (un)verified absence signal.
   */
  async searchQuery(args, workspaceId, context = {}) {
    const mode = args.mode ?? 'auto';
    if (args.page && args.limit !== undefined) throw Object.assign(new Error('Use page.limit with page; limit is the unpaged result size'), { code: 'invalid_arguments', field: 'limit' });
    const limit = args.page ? args.page.limit ?? DEFAULT_PAGE_LIMIT : args.limit || 50;
    const scope = { workspaceId, query: args.query, mode };
    const offset = args.page?.cursor ? decodeCursor(args.page.cursor, 'search.query', scope) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw Object.assign(new Error('Invalid page cursor; restart from the first page'), { code: 'invalid_arguments', field: 'page.cursor' });
    let vector = { used: false, reason: mode === 'lexical' ? 'lexical_mode' : 'not_enabled', matches: [] };
    if (mode !== 'lexical' && this.retrieval && String(args.query).trim()) vector = await this.retrieval.vectorSearch(workspaceId, args.query, { mode, signal: context.signal, limit: HYBRID_WINDOW });
    else if (mode === 'hybrid') throw Object.assign(new Error('Hybrid search needs embeddings, which are not enabled for this workspace'), { code: 'unsupported_capability', details: { capability: 'embeddings' } });
    // Fusion always ranks a fixed candidate window per index, so pages of one query never reorder.
    const window = vector.used ? HYBRID_WINDOW : Math.min(1000, offset + limit + 1);
    const own = this.storage.search({ workspaceId, query: args.query, limit: window });
    // Records shared into this workspace through an active collection (#21) are searched lexically in their owner's
    // index, limited to the shared items, and labelled; vectors stay per workspace.
    const sharedRows = this.sharedSearchRows(workspaceId, args.query, window);
    const lexical = sharedRows.length ? [...own, ...sharedRows].sort((x, y) => x.score - y.score).slice(0, window) : own;
    const rows = new Map(lexical.map((row, index) => [documentKey(row.collection, row.record_id, row.version_id), { row, lexicalRank: index + 1 }]));
    vector.matches.forEach((match, index) => {
      const key = documentKey(match.collection, match.recordId, match.versionId);
      const entry = rows.get(key) ?? { row: this.storage.document({ collection: match.collection, recordId: match.recordId, versionId: match.versionId, start: match.start }) };
      if (!entry.row) return;
      rows.set(key, { ...entry, passageStart: match.start, vectorRank: index + 1, similarity: match.similarity });
    });
    const ordered = vector.used
      ? reciprocalRankFusion([lexical.map(row => documentKey(row.collection, row.record_id, row.version_id)), vector.matches.map(match => documentKey(match.collection, match.recordId, match.versionId))])
        .map(({ key, score }) => ({ ...rows.get(key), fused: score })).filter(entry => entry.row)
      : [...rows.values()];
    const results = ordered.slice(offset, offset + limit).map(({ row, lexicalRank, vectorRank, similarity, fused, passageStart }) => {
      const start = passageStart ?? row.start ?? 0;
      const passage = args.passageChars ? this.storage.document({ collection: row.collection, recordId: row.record_id, versionId: row.version_id, start, length: args.passageChars }) : null;
      const citation = { recordType: row.collection, recordId: row.record_id, revision: row.revision, versionId: row.version_id || null, versionNumber: row.version_number };
      return { type: row.collection, id: row.record_id, ...(row.version_id ? { versionId: row.version_id, versionNumber: row.version_number } : {}), revision: row.revision,
        localOnly: row.local_only === 1, title: row.title, content: String(passage?.excerpt || row.excerpt || '').slice(0, args.passageChars || 300), ...(passage ? { passage: { start, maxChars: args.passageChars } } : {}), updatedAt: row.updated_at,
        score: Number((fused ?? -row.score).toFixed(6)), match: lexicalRank ? row.match : 'semantic', citation,
        ...(row.shared && { shared: row.shared }), ...(vector.used && { ranking: { method: 'rrf', k: RRF_K, lexicalRank: lexicalRank ?? null, vectorRank: vectorRank ?? null, similarity: similarity === undefined ? null : Number(similarity.toFixed(6)) } }) };
    });
    if (!args.page) {
      // Unpaged results stay a list; while the index is rebuilt the outcome is partial and carries the lexical coverage.
      const lexical = this.storage.indexing ? this.storage.lexicalCoverage(workspaceId) : null;
      if (lexical && !lexical.complete) Object.defineProperty(results, PARTIAL_COVERAGE, { value: { lexical } });
      return results;
    }
    const next = offset + results.length;
    const coverage = this.retrieval ? this.retrieval.status(workspaceId, { listLimit: 20 }) : { workspaceId, lexical: this.storage.lexicalCoverage(workspaceId), vector: { enabled: false, embedded: 0, pending: 0, unembedded: [], unembeddedCount: 0 } };
    const searched = ['lexical', ...(vector.used ? ['vector'] : [])];
    const lexicalComplete = coverage.lexical.complete !== false;
    const vectorComplete = !coverage.vector.enabled || (vector.used && coverage.vector.unembeddedCount === 0);
    const absence = offset === 0 && !results.length ? { verified: lexicalComplete && vectorComplete, searched,
      reason: !lexicalComplete ? `The search index is still being rebuilt (${coverage.lexical.unindexedRecords} record(s) in this workspace not indexed yet); the absence is not verified.`
        : vectorComplete ? 'No indexed document in this workspace matched; every indexed document was searched.' : !vector.used && coverage.vector.enabled ? `Vector search was not used (${vector.reason}); only lexical matching was checked.` : `${coverage.vector.unembeddedCount} document(s) have no embedding yet; they were checked lexically only.` } : null;
    return { items: results, nextCursor: next < ordered.length && results.length ? encodeCursor('search.query', scope, next) : null,
      total: vector.used ? ordered.length : this.storage.searchCount({ workspaceId, query: args.query }) + sharedRows.length, mode: vector.used ? 'hybrid' : 'lexical',
      vector: { used: vector.used, reason: vector.used ? null : vector.reason, ...(vector.error ? { error: vector.error } : {}) },
      ...((mode !== 'lexical' && coverage.vector.enabled && !vector.used) || !lexicalComplete ? { partial: true } : {}),
      coverage: { lexical: coverage.lexical, vector: coverage.vector }, absence };
  }
  /** Lexical rows of records shared into a workspace (active collection membership only), tagged with their collection. */
  sharedSearchRows(workspaceId, query, limit) {
    const shared = [...sharedInto(this.data, workspaceId), ...(this.data.memories || []).filter(m => m.scope === 'global' && m.workspaceId !== workspaceId).map(m => ({ type: 'memories', id: m.id, ownerWorkspaceId: m.workspaceId, collectionId: 'global-memory', role: 'reader' }))];
    if (!shared.length) return [];
    const allowed = new Map(shared.map(item => [`${item.type}:${item.id}`, item]));
    const rows = [];
    for (const owner of new Set(shared.map(item => item.ownerWorkspaceId))) {
      for (const row of this.storage.search({ workspaceId: owner, query, limit })) {
        const entry = allowed.get(`${row.collection}:${row.record_id}`);
        if (entry) rows.push({ ...row, shared: { collectionId: entry.collectionId, ownerWorkspaceId: entry.ownerWorkspaceId, role: entry.role } });
      }
    }
    return rows;
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
      this.data.settings = { ...this.data.settings, ...args, ...(args.appearance && { appearance: { ...this.data.settings.appearance, ...args.appearance } }), model: { ...this.data.settings.model, ...args.model }, ...(args.automation && { automation: { ...this.data.settings.automation, ...args.automation } }),
        ...(args.resources && { resources: { ...this.data.settings.resources, ...args.resources } }) };
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
      if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw Object.assign(new Error('STALE_STATE: task changed; reload before changing its state'), { notStarted: true, details: { reason: 'revision_changed' } });
      const prior = normalizePhase(record.status);
      this.assertRecordOnlyPhase(record, args.status);
      this.transitionTask(record, args.status, { actor, reason: admin ? 'human_request' : 'agent_request', note: args.cause ?? '' });
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
      for (const key of [...collections, 'activity', 'history', 'handoffs', ...KNOWLEDGE_COLLECTIONS, ...VIEW_STATE]) this.data[key] = (this.data[key] ?? []).filter(item => item.workspaceId !== record.id);
      // Access granted to the deleted workspace ends with it; the membership stays as history.
      for (const shared of this.data.sharedCollections) for (const member of shared.members ?? []) if (member.workspaceId === record.id && !member.revokedAt) Object.assign(member, { revokedAt: now(), revokedBy: actor, reason: 'workspace deleted' });
      this.data.browserSession.tabs = this.data.browserSession.tabs.filter(item => item.workspaceId !== record.id);
      effects.push(() => this.browser?.closeWorkspace?.(record.id), switchBrowser);
    } else if (action === 'duplicate') {
      const exported = this.exportWorkspace(record.id, undefined, { mode: 'package', keepLocalPaths: true, captures: 'all' });
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
      if (collection === 'tasks' && fields.status === 'uncertain') throw fail('invalid_arguments', 'Only the task runtime marks work uncertain', { field: 'status' });
      // Saving a workflow never authorizes it: one written by automation waits for human review.
      if (collection === 'workflows' && !admin) fields.enabled = false;
      record = createRecord(fields, collection === 'siteRules' && fields.scope === 'global' ? null : workspaceId, collection.slice(0, 4));
      if (collection === 'tasks') record.timeline = [{ type: 'created', to: record.status, actor, reason: 'created', at: record.createdAt }];
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
      if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw Object.assign(new Error('STALE_STATE: record changed; reload before changing it'), { notStarted: true, details: { reason: 'revision_changed' } });
      if (action === 'delete') this.data[collection] = this.data[collection].filter(item => item.id !== record.id);
      else if (action === 'update') {
        if (!admin && collection === 'workflows' && record.enabled === false && args.changes.enabled === true) throw new Error('PERMISSION_REQUIRED: imported workflow requires human review');
        // A non-human change to what a workflow does disables it until a person reviews it again.
        if (!admin && collection === 'workflows' && WORKFLOW_EXECUTABLE.some(key => args.changes[key] !== undefined)) args.changes.enabled = false;
        if (collection === 'tasks') this.guardTaskUpdate(record, args.changes, context, actor, admin);
        const { origin: originArg, citations: citationArgs, ...changes } = args.changes;
        const revisionOrigin = ['materials', 'context'].includes(collection) ? originFor(context, originArg, context.originExtra) : null;
        const updated = { ...record, ...changes };
        // Citations are append-only evidence: new ones are added, earlier ones keep their pinned versions.
        if (collection === 'context' && citationArgs?.length) updated.citations = [...(record.citations ?? []), ...buildCitations(this.data, record.workspaceId, citationArgs, context.citationTexts)].slice(-200);
        if (collection === 'siteRules') { this.validateRule(updated); updated.workspaceId = updated.scope === 'global' ? null : (record.workspaceId || workspaceId); this.recordRuleRevision(record, updated, actor, 'Updated'); }
        if (collection === 'materials') this.validateMaterial(updated);
        if (collection === 'workflows' && WORKFLOW_EXECUTABLE.some(key => Object.hasOwn(changes, key))) { delete updated.watchState; delete record.watchState; }
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
  /** Runtime-managed tasks change phase and plan only through the task runtime commands. */
  assertRecordOnlyPhase(record, to) {
    const from = normalizePhase(record.status);
    if (record.executor) throw fail('invalid_arguments', 'This task is run by the task runtime; use tasks.pause, tasks.continue, tasks.cancel or tasks.redirect', { field: 'status' });
    if (to === 'uncertain' || from === 'uncertain') throw fail('invalid_arguments', 'Uncertain work is resolved only with tasks.reconcile or tasks.retryStep', { field: 'status' });
  }
  guardTaskUpdate(record, changes, context, actor, admin) {
    if (changes.status !== undefined && changes.status !== normalizePhase(record.status)) {
      this.assertRecordOnlyPhase(record, changes.status);
      this.transitionTask(record, changes.status, { actor, reason: admin ? 'human_request' : 'agent_request' });
    }
    delete changes.status;
    if (record.executor && (changes.plan !== undefined || changes.modelId !== undefined)) {
      if (!admin && !sameIdentity(record.executor, context)) throw fail('permission_required', 'only a person or the task’s own executor may change its plan or model', { notStarted: true });
      if (!['queued', 'paused', ...TERMINAL_PHASES].includes(record.status)) throw fail('invalid_arguments', 'Change the steps of an active task with tasks.redirect', { field: 'changes.plan' });
    }
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
    if (action === 'redact') {
      const record = this.record('artifacts', args.id, context);
      const source = this.artifactVersion(record, args.versionId);
      const derived = this.buildDerivative(record, source, args, actor, context);
      const version = { id: uuid('version'), number: record.versions.length + 1, createdAt: now(), actor, ...derived.version, previousVersionId: record.versions.at(-1)?.id || null };
      const titleRedacted = derived.recordTitle !== record.title;
      if (titleRedacted) record.title = derived.recordTitle;
      record.versions.push(version); this.touch(record);
      this.log('artifacts.redact', record.workspaceId, record.id, actor, `Version ${version.number} derived from version ${source.number}: ${derived.version.redactions.length} redactions`);
      return { ...artifactSummary(record, { agent: isAgent(context) }), derivative: { versionId: version.id, number: version.number, derivedFrom: source.id, redactions: derived.version.redactions.length, unmatchedSelectors: derived.unmatched,
        artifactTitleRedacted: titleRedacted, remainingMatches: derived.remainingMatches, originalAccess: source.access === 'restricted' ? 'restricted' : 'standard',
        next: source.access === 'restricted' ? null : 'The original remains readable by agents until a person restricts it (artifacts.setAccess).' } };
    }
    if (action === 'setAccess') {
      const record = this.record('artifacts', args.id, context);
      const version = this.artifactVersion(record, args.versionId);
      const previous = version.access === 'restricted' ? 'restricted' : 'standard';
      if (args.access === 'restricted') version.access = 'restricted'; else delete version.access;
      version.accessChangedAt = now(); version.accessChangedBy = actor;
      this.touch(record);
      this.log('artifacts.setAccess', record.workspaceId, record.id, actor, `Version ${version.number}: ${previous} → ${args.access}`);
      return { id: record.id, versionId: version.id, access: args.access, previous, derivatives: record.versions.filter(item => item.derivedFrom === version.id).map(item => item.id),
        effects: args.access === 'restricted' ? ['Agents and model readers receive a withheld stub instead of this version.', 'The version is removed from the local search index.', 'Exports leave it out unless a person chooses to include restricted originals.']
          : ['Agents can read this version again and it is searchable.'] };
    }
    if (action === 'purgeContent') {
      const record = this.record('artifacts', args.id, context);
      const version = this.artifactVersion(record, args.versionId);
      if (version.purged) throw fail('invalid_arguments', 'This version\u2019s content was already purged');
      const hashes = new Set((version.components || []).map(item => item.sha256));
      for (const resource of version.archive?.resources || []) if (resource.sha256 && resource.status === 'stored') hashes.add(resource.sha256);
      // Assigning undefined (not delete) detaches component-backed fields; a deleted lazy field would be re-attached on commit.
      for (const key of ['text', 'pngBase64']) if (Object.hasOwn(version, key)) version[key] = undefined;
      for (const resource of version.archive?.resources || []) if (resource.status === 'stored') { resource.bodyBase64 = undefined; resource.status = 'purged'; }
      version.purged = { at: now(), by: actor };
      this.touch(record);
      this.log('artifacts.purgeContent', record.workspaceId, record.id, actor, `Version ${version.number} content purged; metadata and hashes kept`);
      return { id: record.id, versionId: version.id, purged: true, componentHashes: [...hashes] };
    }
    const expect = record => { if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw Object.assign(new Error('STALE_STATE: artifact changed; reload before changing it'), { notStarted: true, details: { reason: 'revision_changed' } }); return record; };
    if (action === 'delete') {
      const record = expect(this.record('artifacts', args.id, context));
      this.data.artifacts = this.data.artifacts.filter(item => item.id !== record.id);
      this.forgetSharedItem('artifacts', record.id);
      this.log('artifacts.delete', record.workspaceId, record.id, actor);
      return { id: record.id, deleted: true };
    }
    if (action === 'annotate') {
      const record = expect(this.record('artifacts', args.id, context));
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
    if (action === 'capture' && args.kind === 'archive' && !source.archive) throw new Error('Archive capture returned no archive');
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
    if (action === 'capture' && source.archive) components.push({ type: 'application/x-weft-archive-manifest', size: Buffer.byteLength(canonicalJson(archiveManifest(source.archive))), sha256: digest(canonicalJson(archiveManifest(source.archive))) });
    const version = { id: uuid('version'), number: record.versions.length + 1, createdAt: now(), actor, origin: originFor(context), method: action === 'capture' ? 'browser-capture' : 'supplied-content', url: sanitizeUrl(source.url), title: source.title || record.title, components, text: source.text, pngBase64: source.pngBase64, navigationVersion: source.navigationVersion,
      ...(action === 'capture' && source.archive ? { archive: source.archive } : {}), ...(action === 'capture' && source.capture ? { capture: source.capture } : {}),
      ...(action === 'capture' && Array.isArray(source.inaccessibleRegions) && source.inaccessibleRegions.length ? { inaccessibleRegions: source.inaccessibleRegions } : {}),
      limitations: [...(source.limitations || []), 'Stored text is untrusted source content. Active scripts and external resources are not replayed.', 'Captures may contain personal information; inspect before sharing.'], redactionStatus: 'not-reviewed', previousVersionId: record.versions.at(-1)?.id || null };
    record.versions.push(version); this.touch(record);
    this.log('artifacts.capture', workspaceId, record.id, actor, `Version ${version.number}`);
    return artifactSummary(record);
  }

  // ---- Artifact versions: views, archives, comparison and redaction --------------------
  artifactVersion(record, versionId) {
    const version = record.versions.find(item => item.id === versionId);
    if (!version) throw fail('not_found', 'Artifact version not found');
    return version;
  }
  /** Refuse agent access to a restricted original's content. */
  assertReadable(version, context, purpose = 'read') {
    if (isAgent(context) && version.access === 'restricted') {
      throw fail('permission_required', `${RESTRICTED_NOTICE} (${purpose})`, { details: { authority: { decision: 'deny', reason: 'restricted_original', actionClass: 'local_read' } } });
    }
  }
  /** One version with its verified text and image; archive bodies are never inlined (manifest only). */
  versionOutput(record, version, context, { agent = isAgent(context) } = {}) {
    const view = versionMetadata(record, version, agent);
    if (agent && version.access === 'restricted') return { artifactId: record.id, workspaceId: record.workspaceId, ...view };
    if (Object.hasOwn(version, 'text') && version.text !== undefined) view.text = version.text;
    if (version.pngBase64) view.pngBase64 = version.pngBase64;
    return { artifactId: record.id, workspaceId: record.workspaceId, ...view };
  }
  readArtifact(name, record, args, context) {
    const agent = isAgent(context);
    if (name === 'artifacts.get') {
      if (args.versionId) return this.versionOutput(record, this.artifactVersion(record, args.versionId), context);
      const { versions, ...rest } = record;
      return { ...clone(rest), versions: versions.map(version => { const { artifactId, workspaceId, ...view } = this.versionOutput(record, version, context); return view; }) };
    }
    if (name === 'artifacts.readOriginal') {
      // The authority gate requires an exact one-time human approval for every agent read; in-process callers without one are refused here too.
      if (agent && context.authorityDecision?.approvedOnce !== true) throw fail('permission_required', 'Reading an original requires an exact one-time human approval for this command', { details: { authority: { decision: 'deny', reason: 'restricted_original', actionClass: 'local_read' } } });
      const version = this.artifactVersion(record, args.versionId);
      return { ...this.versionOutput(record, version, context, { agent: false }), access: version.access === 'restricted' ? 'restricted' : 'standard' };
    }
    if (name === 'artifacts.verify') return this.verifyArtifact(record, args.versionId);
    if (name === 'artifacts.compare') return this.compareVersions(record, args, context);
    if (name === 'artifacts.review') return this.reviewVersion(record, this.artifactVersion(record, args.versionId), context);
    if (name === 'artifacts.redact') {
      const source = this.artifactVersion(record, args.versionId);
      const derived = this.buildDerivative(record, source, args, context.actor || 'human', context);
      return { preview: true, saved: false, derivedFrom: source.id, ...derived.version, unmatchedSelectors: derived.unmatched, artifactTitle: derived.recordTitle, remainingMatches: derived.remainingMatches };
    }
    throw new Error(`Unsupported artifact read: ${name}`);
  }
  /** Re-verify every stored component digest without changing anything. */
  verifyArtifact(record, versionId) {
    const versions = versionId ? [this.artifactVersion(record, versionId)] : record.versions;
    const check = (object, key, label) => {
      const marker = this.storage.componentMarker(object, key);
      if (!marker && typeof object[key] !== 'string') return null;
      if (!marker) return { component: label, status: 'pending', detail: 'Not yet committed' };
      try { this.storage.components.read(marker.sha256, marker.size); return { component: label, sha256: marker.sha256, size: marker.size, status: 'verified' }; }
      catch (error) { return { component: label, sha256: marker.sha256, size: marker.size, status: error.code === 'COMPONENT_MISSING' ? 'missing' : 'corrupt', detail: error.message }; }
    };
    const report = versions.map(version => {
      const items = [check(version, 'text', 'text/plain'), check(version, 'pngBase64', 'image/png'),
        ...(version.archive?.resources || []).filter(item => item.status === 'stored').map(item => check(item, 'bodyBase64', item.url))].filter(Boolean);
      return { versionId: version.id, number: version.number, ...(version.purged ? { purged: true } : {}), components: items, problems: items.filter(item => !['verified', 'pending'].includes(item.status)).length };
    });
    const problems = report.reduce((sum, item) => sum + item.problems, 0);
    return { id: record.id, status: problems ? 'damaged' : 'verified', problems, versions: report,
      scope: 'SHA-256 digests show that stored bytes are unchanged since they were saved. They do not prove that a website served this content, or when; Weft has no independent timestamp authority.' };
  }
  compareVersions(record, args, context) {
    const from = this.artifactVersion(record, args.fromVersionId), to = this.artifactVersion(record, args.toVersionId);
    for (const version of [from, to]) { this.assertReadable(version, context, 'compare'); if (version.purged) throw fail('invalid_arguments', `Version ${version.number} content was purged`); }
    const describe = version => ({ versionId: version.id, number: version.number, createdAt: version.createdAt, url: version.url || null, method: version.method, ...(version.derivedFrom ? { derivedFrom: version.derivedFrom } : {}),
      components: clone(version.components || []), archive: version.archive ? { complete: version.archive.complete ?? null, counts: clone(version.archive.counts || {}) } : null, captureComplete: version.capture?.complete ?? null });
    const hasText = version => Object.hasOwn(version, 'text') && typeof version.text === 'string';
    const text = hasText(from) && hasText(to) ? diffText(from.text, to.text) : { available: false, reason: 'One of the versions has no readable text component.' };
    const resources = from.archive?.resources && to.archive?.resources ? diffResources(from.archive.resources, to.archive.resources) : { available: false, reason: 'Resource comparison needs a resource archive in both versions.' };
    let pixels = { available: false, reason: 'Pixel comparison needs a screenshot in both versions.' };
    if (args.pixels === false) pixels = { available: false, reason: 'Not requested.' };
    else if (from.pngBase64 && to.pngBase64) {
      try { pixels = { available: true, ...diffImages(decodePng(Buffer.from(from.pngBase64, 'base64')), decodePng(Buffer.from(to.pngBase64, 'base64')), { diffImage: args.diffImage === true }) }; }
      catch (error) { pixels = { available: false, reason: String(error.message).slice(0, 200) }; }
    }
    const identical = text.identical !== false && (resources.totals ? Object.values(resources.totals).every(value => value === 0) : true) && (pixels.available ? pixels.changedPixels === 0 && pixels.comparable : true);
    return { id: record.id, from: describe(from), to: describe(to), identical, text, resources, pixels,
      limitations: ['Compares the stored captures only; differences can come from personalization, timing, lazy loading or capture limits rather than source changes.', 'Readable text excludes form fields, scripts and hidden content.'] };
  }
  /** Sensitive metadata review plus detection assistance. Findings carry masked previews, never the matched values. */
  reviewVersion(record, version, context) {
    this.assertReadable(version, context, 'review');
    const findings = [];
    if (version.url) findings.push(...reviewUrl(version.url, 'url'));
    findings.push(...reviewText(version.title, 'title'));
    for (const key of ['originalUrl', 'finalUrl']) if (version.capture?.[key]) findings.push(...reviewUrl(version.capture[key], `capture.${key}`));
    (version.capture?.stateChanges || []).forEach((change, index) => { if (change.url) findings.push(...reviewUrl(change.url, `capture.stateChanges.${index}.url`)); });
    const resourceFindings = [];
    (version.archive?.resources || []).forEach((resource, index) => resourceFindings.push(...reviewUrl(resource.url, `archive.resources.${index}.url`)));
    findings.push(...resourceFindings.slice(0, 200));
    findings.push(...reviewText(record.note, 'artifact.note'), ...(record.tags || []).flatMap((tag, index) => reviewText(tag, `artifact.tags.${index}`)),
      ...(record.annotations || []).flatMap((item, index) => reviewText(item.note, `artifact.annotations.${index}.note`)));
    const text = !version.purged && Object.hasOwn(version, 'text') && typeof version.text === 'string' ? reviewText(version.text, 'text') : [];
    return { id: record.id, versionId: version.id, number: version.number, findings, textFindings: text.slice(0, 500), totals: { metadata: findings.length, text: text.length, resourceUrls: resourceFindings.length },
      image: version.pngBase64 ? 'Screenshot text is not inspected (no OCR). Review the image yourself and draw redaction regions over anything sensitive.' : null,
      archive: version.archive ? 'Archived HTML, stylesheets and images are not redacted; sanitized derivatives leave the archive out.' : null,
      scope: DETECTION_SCOPE };
  }
  /** Build a sanitized derivative from a source version. Nothing is written here. */
  buildDerivative(record, source, args, actor, context) {
    this.assertReadable(source, context, 'redact');
    if (source.purged) throw fail('invalid_arguments', 'This version’s content was purged; nothing is left to redact');
    const hasText = Object.hasOwn(source, 'text') && typeof source.text === 'string';
    const selectors = args.text || [];
    if (!hasText && selectors.some(item => item.start !== undefined)) throw fail('invalid_arguments', 'Offset selectors need a version with readable text');
    const textResult = hasText ? redactText(source.text, selectors) : { text: undefined, redactions: [], unmatched: selectors.map((_, index) => index) };
    const metadataSelectors = selectors.filter(item => item.start === undefined);
    const title = args.title ?? redactText(source.title || record.title, metadataSelectors).text;
    let url = reduceUrl(source.url, args.url ?? 'origin-path');
    if (url && metadataSelectors.length && resolveSpans(url, metadataSelectors).spans.length) url = reduceUrl(url, 'origin');
    if (url && metadataSelectors.length && resolveSpans(url, metadataSelectors).spans.length) url = '';
    const regions = args.regions || [];
    let pngBase64;
    const regionRedactions = [];
    if (regions.length && (!source.pngBase64 || args.image === 'omit')) throw fail('invalid_arguments', 'Image regions need a version with a screenshot and image: "redact"');
    if (source.pngBase64 && args.image !== 'omit') {
      // Decoding and re-encoding replaces the pixels and drops every ancillary PNG chunk (text, EXIF, ICC).
      const image = decodePng(Buffer.from(source.pngBase64, 'base64'));
      const clipped = clipRects(regions, image.width, image.height);
      const outside = clipped.map((rect, index) => rect ? null : index).filter(index => index !== null);
      if (outside.length) throw fail('invalid_arguments', `Image regions ${outside.join(', ')} are outside the ${image.width}x${image.height} screenshot`);
      clipped.forEach((rect, index) => regionRedactions.push({ type: 'region', index, ...rect, label: String(regions[index].label || 'region').slice(0, 60), pixels: fillRects(image, [rect]) }));
      pngBase64 = encodePng(image).toString('base64');
    }
    if (textResult.text === undefined && !pngBase64) throw fail('invalid_arguments', 'The derivative would have no content: keep the screenshot or use a version with text');
    const components = [];
    if (textResult.text !== undefined) components.push({ type: 'text/plain', size: Buffer.byteLength(textResult.text), sha256: digest(textResult.text) });
    if (pngBase64) { const bytes = Buffer.from(pngBase64, 'base64'); components.push({ type: 'image/png', size: bytes.length, sha256: digest(bytes) }); }
    const inaccessible = [...(source.inaccessibleRegions || []).map(item => clone(item)), ...(args.inaccessibleRegions || []).map(rect => ({ ...rect, label: String(rect.label || 'not visible').slice(0, 60), source: 'reviewer' }))];
    const omitted = [...(source.archive ? ['resource archive'] : []), ...(source.capture ? ['capture URLs and state history'] : []), ...(source.pngBase64 && args.image === 'omit' ? ['screenshot'] : [])];
    const capture = source.capture ? JSON.parse(JSON.stringify({ startedAt: source.capture.startedAt, durationMs: source.capture.durationMs, readiness: source.capture.readiness ? { state: source.capture.readiness.state } : undefined,
      viewport: source.capture.viewport, complete: source.capture.complete, incomplete: source.capture.incomplete || [] })) : undefined;
    const version = { method: 'redaction', url, title: String(title).slice(0, 240), components, ...(textResult.text !== undefined ? { text: textResult.text } : {}), ...(pngBase64 ? { pngBase64 } : {}),
      derivedFrom: source.id, derivedFromNumber: source.number, redactions: [...textResult.redactions, ...regionRedactions], inaccessibleRegions: inaccessible,
      ...(capture ? { capture } : {}), navigationVersion: source.navigationVersion,
      review: { by: actor, at: now(), textSelectors: selectors.length, unmatchedSelectors: textResult.unmatched.length, regions: regions.length, urlMode: args.url ?? 'origin-path', omitted, detection: 'assistance-only' },
      limitations: [`Sanitized derivative of version ${source.number}. The original version is unchanged and keeps its own access setting.`,
        'Only the selected text spans and image regions were removed. Detection assistance can miss sensitive data, and text selectors do not remove text inside images.',
        ...(omitted.length ? [`Not carried into this derivative: ${omitted.join(', ')}.`] : []), 'Derived content is untrusted source content.'],
      redactionStatus: 'redacted' };
    // The artifact's own title is shown with every version: apply the same text selectors to it. Notes, tags and
    // annotations are human-written history and are not rewritten; matches there are reported for review.
    const recordTitle = metadataSelectors.length ? redactText(record.title, metadataSelectors).text.slice(0, 240) : record.title;
    const count = value => typeof value === 'string' && metadataSelectors.length ? resolveSpans(value, metadataSelectors).spans.length : 0;
    const remainingMatches = { note: count(record.note), tags: (record.tags || []).reduce((sum, tag) => sum + count(tag), 0), annotations: (record.annotations || []).reduce((sum, item) => sum + count(item.note), 0) };
    return { version, unmatched: textResult.unmatched, recordTitle, remainingMatches };
  }
  /** Human-only offline preview of an archived version in the browser's sandboxed preview view. */
  async previewCommand(name, args, context) {
    if (!this.browser?.openArchivePreview) throw fail('unsupported', 'The offline archive preview needs the Weft browser window');
    if (name === 'artifacts.closePreview') return this.browser.closeArchivePreview();
    const record = this.record('artifacts', args.id, context);
    const version = this.artifactVersion(record, args.versionId);
    if (version.purged) throw fail('invalid_arguments', 'This version’s content was purged');
    if (!version.archive?.resources?.length) throw fail('unsupported', 'This version has no resource archive; capture with kind "archive" to preview it offline');
    const resources = [];
    const unavailable = [];
    for (const resource of version.archive.resources) {
      if (resource.status !== 'stored') continue;
      try { resources.push({ url: resource.url, contentId: resource.contentId ?? null, role: resource.role, mimeType: resource.mimeType, bytes: Buffer.from(resource.bodyBase64, 'base64') }); }
      catch (error) {
        if (resource.role === 'document') throw fail('component_integrity', `The archived document failed verification: ${error.message}`);
        unavailable.push({ url: resource.url, status: error.code === 'COMPONENT_MISSING' ? 'missing' : 'corrupt' });
      }
    }
    const opened = await this.browser.openArchivePreview({ artifactId: record.id, versionId: version.id, title: version.title || record.title, documentUrl: version.archive.documentUrl, resources });
    return { ...opened, artifactId: record.id, versionId: version.id, number: version.number, unavailable,
      notStored: version.archive.resources.filter(item => item.status !== 'stored').length };
  }

  // ---- Export and import -------------------------------------------------------------
  /** Exports leave the encrypted store as plaintext: only after a person confirms, never silently. */
  assertPlaintextExport(args) {
    if (this.storage.encrypted && args.acknowledgePlaintext !== true) {
      throw fail('invalid_arguments', 'ENCRYPTED_EXPORT: This profile is encrypted at rest, but exports are plaintext. Pass acknowledgePlaintext: true after the person confirms the warning.', { field: 'acknowledgePlaintext', notStarted: true });
    }
  }
  /**
   * Format 2 exports keep revisions, revision history, conversations, turn
   * manifests, exact artifact versions with component hashes and annotations,
   * site-rule provenance (creator, revision history, review state) and handoff
   * history.
   * `package` mode references components by digest instead of inlining them.
   */
  exportWorkspace(id, sensitiveTerms, { mode = 'inline', keepLocalPaths = false, captures = 'exclude-restricted', reviewMetadata = false } = {}) {
    const record = this.workspace(id);
    const excludedContent = [];
    // Capture policy: restricted originals stay out unless a person chooses 'all'; 'derivatives-only' keeps sanitized derivatives alone.
    const exportable = (name, item) => {
      if (name !== 'artifacts') return item;
      const versions = item.versions.filter(version => {
        const reason = captures !== 'all' && version.access === 'restricted' ? 'restricted original'
          : captures === 'derivatives-only' && !version.derivedFrom ? 'not a sanitized derivative' : null;
        if (reason) excludedContent.push({ collection: 'artifacts', id: item.id, versionId: version.id, number: version.number, reason });
        return !reason;
      });
      if (!versions.length) { excludedContent.push({ collection: 'artifacts', id: item.id, reason: 'no exportable versions under this capture policy' }); return null; }
      return versions.length === item.versions.length ? item : { ...item, versions };
    };
    const plain = (name, item) => {
      const copy = mode === 'inline' ? this.output(item) : JSON.parse(this.storage.serialize(name, item, { write: false }).doc);
      return name === 'materials' ? exportMaterial(copy, { keepLocalPaths }) : copy;
    };
    const notExported = Object.entries(this.data).filter(([key, value]) => !collections.includes(key) && !['workspaces', 'activity', 'history', 'handoffs', ...KNOWLEDGE_COLLECTIONS].includes(key) && !NOT_EXPORTED.has(key) && Array.isArray(value) && value.some(item => item?.workspaceId === id)).map(([key, value]) => `${key} (${value.filter(item => item?.workspaceId === id).length} records not supported by this export format)`);
    const exported = cleanExport({ format: 'weft-workspace', schemaVersion: CURRENT_SCHEMA_VERSION, formatVersion: 2, exportedAt: now(), workspace: clone(record),
      ...Object.fromEntries(collections.map(name => [name, this.data[name].filter(item => item.workspaceId === id && !(name === 'siteRules' && item.scope === 'global')).map(item => exportable(name, item)).filter(Boolean).map(item => plain(name, item))])),
      handoffs: (this.data.handoffs ?? []).filter(item => item.workspaceId === id).map(item => clone(item)),
      sharedCollections: exportCollections(this.data, id),
      conflicts: (this.data.conflicts ?? []).filter(item => item.workspaceId === id).map(item => clone(item)),
      linkedContentOmitted: linkedOmissions(this.data.materials.filter(item => item.workspaceId === id)),
      excluded: [...EXPORT_EXCLUDED, ...notExported, ...(excludedContent.length ? [`${excludedContent.length} capture versions or artifacts left out by the capture policy (${captures}); see excludedContent`] : [])],
      capturePolicy: captures, excludedContent,
      limitations: ['Browser sessions, cookies, credentials, provider keys, and global policies are excluded. Imported site rules and workflows remain inactive until reviewed and enabled.', 'Free-form content and screenshots can contain personal information. Review the export before sharing.',
        'Sanitized derivatives remove only the spans and regions a reviewer selected; record titles, notes, tags and annotations are exported as written.', ...(this.storage.encrypted ? [PLAINTEXT_EXPORT] : [])] });
    exported.linkedSourcesNotIncluded = this.linkedSources(exported);
    if (reviewMetadata) exported.metadataReview = this.reviewExport(exported);
    if (sensitiveTerms !== undefined) exported.residueScan = inspectExportResidue(JSON.stringify(mode === 'inline' ? exported : this.exportWorkspace(id, undefined, { captures }), null, 2), sensitiveTerms);
    return exported;
  }
  /** Web pages, linked files, services and cited URLs referenced by exported records but not included as content. */
  linkedSources(exported) {
    const items = [];
    for (const record of exported.materials || []) if (['website', 'linked-file', 'service'].includes(record.kind)) items.push({ collection: 'materials', id: record.id, kind: record.kind, ...(record.url ? { url: record.url } : {}), ...(record.filename ? { filename: record.filename } : {}) });
    for (const record of exported.context || []) for (const source of record.sources || []) if (/^https?:/i.test(source)) items.push({ collection: 'context', id: record.id, kind: 'source', url: source });
    for (const record of exported.artifacts || []) for (const version of record.versions || []) if (version.url) items.push({ collection: 'artifacts', id: record.id, versionId: version.id, kind: 'live page', url: version.url });
    return { count: items.length, items: items.slice(0, 1000), note: 'These records cite live pages, files or services. Only the saved records travel with the export; the linked sources themselves are not included and may have changed.' };
  }
  /** Export metadata review: URL query/path findings and detection-assistance matches in exported text fields (masked). */
  reviewExport(exported) {
    const findings = [];
    const visit = (value, path, key = '') => {
      if (findings.length >= 1000) return;
      if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}.${index}`)); return; }
      if (value && typeof value === 'object') { for (const [name, item] of Object.entries(value)) if (!/Base64$/.test(name) && name !== '$component' && !['excluded', 'limitations', 'excludedContent', 'linkedSourcesNotIncluded'].includes(name)) visit(item, `${path}.${name}`, name); return; }
      if (typeof value !== 'string' || !value) return;
      if (/url|endpoint|source/i.test(key) || /^https?:\/\//i.test(value)) findings.push(...reviewUrl(value, path).filter(item => item.kind !== 'unparseable-url'));
      else if (!['id', 'workspaceId', 'sha256', 'createdAt', 'updatedAt'].includes(key)) findings.push(...reviewText(value, path));
    };
    visit(exported, '$');
    return { findings: findings.slice(0, 1000), truncated: findings.length >= 1000, scope: DETECTION_SCOPE };
  }
  transferPath(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.includes('..')) throw fail('invalid_arguments', 'Invalid package name');
    return join(this.directory, TRANSFERS_DIR, name);
  }
  /** Large-project transfer: a folder of verified component files plus a manifest, beyond REST/JSON size limits. */
  exportPackage(id, name, sensitiveTerms, { captures } = {}) {
    const target = this.transferPath(name);
    if (existsSync(target)) throw fail('invalid_arguments', 'A package with this name already exists; existing packages are never overwritten');
    const exported = this.exportWorkspace(id, undefined, { mode: 'package', captures });
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
      for (const [hash, size] of markers) { this.storage.components.exportTo(hash, join(temp, 'components'), size); files.push({ path: `components/${hash.slice(0, 2)}/${hash}`, size, sha256: hash }); }
      const records = JSON.stringify(exported, null, 2);
      writeFileSync(join(temp, 'workspace.json'), records, { flag: 'wx', mode: 0o600 });
      fsyncFile(join(temp, 'workspace.json'));
      files.unshift({ path: 'workspace.json', size: Buffer.byteLength(records), sha256: digest(records) });
      const manifest = { format: 'weft-package', formatVersion: 1, createdAt: now(), workspace: { name: exported.workspace.name }, files };
      writeFileSync(join(temp, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
      fsyncFile(join(temp, 'manifest.json'));
      renameSync(temp, target);
      syncDirectory(root);
      const result = { name, path: target, formatVersion: 1, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), excluded: exported.excluded, capturePolicy: exported.capturePolicy, excludedContent: exported.excludedContent,
        linkedSourcesNotIncluded: exported.linkedSourcesNotIncluded, limitations: exported.limitations, ...(this.storage.encrypted && { plaintext: true, warning: PLAINTEXT_EXPORT }) };
      if (sensitiveTerms !== undefined) result.residueScan = inspectExportResidue(JSON.stringify(this.exportWorkspace(id, undefined, { captures }), null, 2), sensitiveTerms);
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
    const workspaceFields = workspaceSchemas['workspaces.create'].parse({ name: raw.workspace.name, description: raw.workspace.description, color: raw.workspace.color, icon: raw.workspace.icon, memory: [raw.workspace.memory, raw.workspace.instructions ? `Imported instructions (review before use):\n${raw.workspace.instructions}` : ''].filter(Boolean).join('\n\n').slice(0, 50000), workspaceType: raw.workspace.workspaceType, dueDate: raw.workspace.dueDate, contextLocalOnly: raw.workspace.contextLocalOnly });
    const workspace = { ...createWorkspace(), ...workspaceFields, importedFrom: { exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt.slice(0, 100) : null, createdAt: timestamp.safeParse(raw.workspace.createdAt).success ? raw.workspace.createdAt ?? null : null, formatVersion } };
    const mapping = new Map([[raw.workspace.id, workspace.id]]);
    const knownKeys = new Set(['format', 'schemaVersion', 'formatVersion', 'exportedAt', 'workspace', 'limitations', 'excluded', 'residueScan', 'handoffs', 'sharedCollections', 'conflicts', 'linkedContentOmitted',
      'capturePolicy', 'excludedContent', 'linkedSourcesNotIncluded', 'metadataReview', ...collections]);
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
          if (collection === 'tasks' && picked.status === 'waiting') picked.status = 'waiting_on_human';
          fields = z.strictObject(shape).parse(picked);
          if (collection === 'tasks') this.importTaskState(item, fields, actor, loss);
          if (collection === 'memories') fields.scope = 'workspace';
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
  /** Imported tasks keep their timeline as history but never their executor, run state or operations: they never resume on their own. */
  importTaskState(item, fields, actor, loss) {
    const timeline = z.array(z.record(z.string().max(100), z.unknown())).max(500).safeParse(item.timeline ?? []);
    fields.timeline = timeline.success ? timeline.data.map(entry => JSON.parse(JSON.stringify(entry, (key, value) => typeof value === 'string' ? value.slice(0, 2000) : value))) : [];
    if (!timeline.success) loss('tasks', 'timeline', 'invalid task timeline dropped');
    if (item.executor || item.run) loss('tasks', 'executor/run', 'task runtime bindings and run state are not imported; a person starts imported tasks again');
    if (Array.isArray(item.operations) && item.operations.length) loss('tasks', 'operations', 'operation records are local execution evidence and are not imported', item.operations.length);
    if (['running', 'waiting_on_human', 'uncertain'].includes(fields.status) && (item.executor || item.run || fields.status === 'uncertain')) {
      loss('tasks', 'status', `imported ${fields.status} runtime task paused for review`);
      appendTimeline(fields, { type: 'transition', from: fields.status, to: 'paused', actor, reason: 'imported', note: 'Imported tasks never resume execution automatically.', at: now() });
      fields.status = 'paused';
    }
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
      let archive;
      if (version.archive) {
        archive = { ...version.archive, resources: version.archive.resources.map(resource => {
          const { bodyBase64, ...entry } = resource;
          if (bodyBase64 === undefined) return entry;
          const ref = heavy(bodyBase64, 'base64');
          const bytes = ref.bytes || Buffer.from(ref.inline, 'base64');
          if (entry.size !== bytes.length || entry.sha256 !== digest(bytes)) throw fail('component_integrity', `COMPONENT_INTEGRITY: imported archive resource ${String(entry.url).slice(0, 200)} does not match its recorded SHA-256; the export is damaged or was altered`);
          if (ref.inline !== undefined) return { ...entry, bodyBase64: bytes.toString('base64') };
          deferred.push(() => lazy(entry, 'bodyBase64', ref));
          return entry;
        }) };
        const manifest = canonicalJson(archiveManifest(archive));
        components.push({ type: 'application/x-weft-archive-manifest', size: Buffer.byteLength(manifest), sha256: digest(manifest) });
      }
      if (!components.length && !version.purged) throw new Error('Imported artifact has no offline content');
      if (version.components) {
        for (const claimed of version.components) {
          const actual = components.find(component => component.type === claimed.type);
          if (actual && (actual.sha256 !== claimed.sha256 || actual.size !== claimed.size)) throw fail('component_integrity', `COMPONENT_INTEGRITY: imported ${claimed.type} component does not match its recorded SHA-256; the export is damaged or was altered`);
        }
      } else loss('artifacts', 'versions.components', 'source had no component hashes; hashes computed at import');
      const previous = version.previousVersionId ? mapping.get(version.previousVersionId) : null;
      if (version.previousVersionId && !previous) loss('artifacts', 'versions.previousVersionId', 'previous version not in export; link removed');
      const derivedFrom = version.derivedFrom ? mapping.get(version.derivedFrom) ?? null : undefined;
      if (version.derivedFrom && !derivedFrom) loss('artifacts', 'versions.derivedFrom', 'source version of a sanitized derivative not in export (excluded or restricted); the derivative keeps its redaction metadata');
      stats.versions++;
      const stored = { id: (version.id && mapping.get(version.id)) || uuid('version'), number: version.number ?? index + 1, createdAt: version.createdAt ?? now(), actor: version.actor ?? 'human', method: version.method ?? 'import',
        url: version.url ? sanitizeUrl(version.url) : '', title: version.title ?? fields.title, components, ...(text?.inline !== undefined ? { text: text.inline } : {}), ...(png?.inline !== undefined ? { pngBase64: png.inline } : {}),
        navigationVersion: version.navigationVersion ?? undefined, limitations: version.limitations ?? ['Imported content has not been independently verified.'], redactionStatus: version.redactionStatus ?? 'not-reviewed', previousVersionId: previous,
        provenance: { imported: true, sourceVersionId: version.id ?? null }, ...(version.origin !== undefined && { origin: importedOrigin(version.origin, 'import', mapping) }),
        ...(archive ? { archive } : {}), ...(version.capture ? { capture: version.capture } : {}), ...(derivedFrom !== undefined ? { derivedFrom } : {}), ...(version.derivedFromNumber ? { derivedFromNumber: version.derivedFromNumber } : {}),
        ...(version.redactions ? { redactions: version.redactions } : {}), ...(version.inaccessibleRegions ? { inaccessibleRegions: version.inaccessibleRegions } : {}),
        ...(version.access ? { access: version.access, accessChangedAt: version.accessChangedAt ?? now(), accessChangedBy: version.accessChangedBy ?? 'import' } : {}), ...(version.purged ? { purged: version.purged } : {}), ...(version.review ? { review: version.review } : {}) };
      if (text?.bytes) deferred.push(() => lazy(stored, 'text', text));
      if (png?.bytes) deferred.push(() => lazy(stored, 'pngBase64', png));
      return stored;
    });
    return fields;
  }
  /** Rewrite exported identifiers cited inside free-form text. Captured text and hashed bytes are never altered. */
  rewriteCitations(record, mapping, stats) {
    const skip = new Set(['id', 'workspaceId', 'evidence', 'materialIds', 'outputs', 'attachments', 'previousVersionId', 'provenance', 'components', 'sha256', 'text', 'pngBase64', 'fileBase64', 'taskId', 'revisions',
      'origin', 'lastOrigin', 'citations', 'proposal', 'promotedFrom', 'superseded', 'derivedFrom', 'link', 'service', 'subjects', 'resolution', 'items', 'members', 'archive', 'capture', 'redactions']);
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
      return { dryRun: true, applied: false, result: { backup: verification }, changes: { current, restored: verification.counts, encryption: { current: this.storage.encrypted ? 'encrypted' : 'plaintext', restored: verification.encrypted ? 'encrypted' : 'plaintext' } } };
    }
    return this.restoreFrom(args.id);
  }
  restoreFrom(id) {
    const previousWorkspaces = new Set(this.data.workspaces.map(item => item.id));
    this.sealedStoreStep('beforeRestore');
    this.storage.close();
    let result;
    let failure;
    try { result = restoreBackup(this.directory, id, { clock: this.clock }); }
    catch (error) { failure = error; try { recoverInterruptedRestore(this.directory); } catch { /* reported below */ } }
    // The backup carries its own keyring (or none): reuse the in-memory profile key if it still fits, else lock.
    const keys = this.encryption.keys;
    this.encryption.keys = null;
    const encryption = this.encryption.adoptRestored(keys);
    if (encryption === 'locked') {
      this.storage = null; this._data = null; this.locked = true;
      this.sealedStoreStep('afterRestore');
      if (failure) throw failure;
      return Promise.resolve().then(async () => {
        await this.encryptionHooks.beforeLock?.({ persist: false });
        return { ...result, encryption, notice: 'The restored backup is encrypted with keys this session does not hold. Unlock with the recovery key or passphrase that was valid when the backup was made.' };
      });
    }
    try { this.openStorage(); }
    catch (error) { throw fail('command_failed', `RESTORE_INCOMPLETE: ${failure?.message || error.message}. Restart Weft to finish recovery; originals are preserved under ${RECOVERY_DIR}/.`); }
    if (failure) throw failure;
    this.storage.sweepOrphans();
    this.sealedStoreStep('afterRestore');
    result.encryption = this.storage.encrypted ? 'encrypted' : 'plaintext';
    // A backup taken mid-rotation carries both data keys; finish re-encrypting under the newest.
    if (this.encryption.keyring?.rotation) this.resumeRotation().catch(() => {});
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
    return serialize(this, () => {
      if (this.closed || this.locked || !this.backupPolicy.automatic) return;
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
  }

  // ---- Workspace encryption (ADR 014) ------------------------------------------------
  /** encryption.* commands. Status works while locked; everything else is human-only administration. */
  async executeEncryption(name, input = {}, context = {}) {
    const schema = encryptionSchemas[name];
    if (!schema) throw fail('unknown_command', `Unknown encryption command: ${name}`);
    const args = schema.parse(input);
    const human = context.actor === 'human';
    if (name === 'encryption.status') return this.encryption.status({ locked: this.locked, inventory: human && args.inventory === true });
    if (!human) throw fail('permission_required', 'PERMISSION_REQUIRED: workspace encryption is managed by a person in the Weft window', { notStarted: true });
    if (name === 'encryption.unlock') return this.unlockProfile(args);
    if (name === 'encryption.checkRecoveryKey') {
      if (!this.encryption.enabled) throw fail('invalid_arguments', 'This profile is not encrypted');
      return { valid: this.encryption.checkRecoveryKey(args.recoveryKey) };
    }
    if (name === 'encryption.lock') return this.lockProfile();
    if (name === 'encryption.enable') return this.enableEncryption(args, context);
    this.assertUnlocked();
    if (!this.encryption.enabled) throw fail('invalid_arguments', 'This profile is not encrypted');
    if (name === 'encryption.disable') return this.disableEncryption(context);
    if (name === 'encryption.configure') return this.exclusive(() => { this.assertUnlocked(); this.encryption.configure(args); this.logEncryption('encryption.configure', `Unlock: ${this.encryption.keyring.unlockMode}; passphrase ${this.encryption.keyring.wrappers.passphrase ? 'set' : 'not set'}`); return this.encryption.status({ locked: false }); });
    if (args.target === 'wrapping') {
      return this.exclusive(() => {
        this.assertUnlocked();
        const recoveryKey = this.encryption.rotateWrapping({ passphrase: args.passphrase ?? null });
        this.logEncryption('encryption.rotate', 'New profile key and recovery key; data keys re-wrapped');
        return { rotated: 'wrapping', recoveryKey, passphrase: Boolean(this.encryption.keyring.wrappers.passphrase), unlockMode: this.encryption.keyring.unlockMode,
          notice: 'Store this new recovery key now; it is shown only once. The previous recovery key and passphrase no longer unlock this profile (backups made earlier keep their own keyring and earlier keys). Make a new backup.' };
      });
    }
    await this.exclusive(() => { this.assertUnlocked(); this.encryption.beginDataKeyRotation(); this.logEncryption('encryption.rotate', `Data key rotation to version ${this.encryption.keyring.currentVersion} started`); });
    return this.resumeRotation();
  }
  logEncryption(action, detail) {
    try { this.commitChange(() => this.log(action, this.activeWorkspaceId, null, 'human', detail)); } catch { /* lifecycle outcome stands; durable activity also records the command */ }
  }
  async enableEncryption({ passphrase, unlockMode, removePlaintextCopies }, context = {}) {
    return this.exclusive(() => {
      this.assertUnlocked();
      if (this.encryption.keyring) throw fail('invalid_arguments', 'This profile is already encrypted');
      const recoveryKey = this.encryption.enable(this.storage, { passphrase: passphrase ?? null, unlockMode, onStep: context.onStep });
      this.reopenStorage();
      this.sealedStoreStep('afterEnable');
      const removed = removePlaintextCopies ? this.encryption.removePlaintextCopies() : [];
      const remaining = this.encryption.plaintextCopies();
      this.log('encryption.enable', this.activeWorkspaceId, null, 'human', `Workspace encryption on; unlock: ${unlockMode}${removed.length ? `; ${removed.length} plaintext copies overwritten and removed` : ''}`);
      this.save();
      let backup = null;
      try { backup = createBackup(this.storage, { kind: 'manual', note: 'First encrypted backup', clock: this.clock }); } catch (error) { backup = { status: 'failed', problem: error.message }; }
      return { enabled: true, recoveryKey, unlockMode, passphrase: Boolean(passphrase), removedPlaintextCopies: removed, plaintextCopies: remaining, backup: backup && { id: backup.id ?? null, status: backup.status },
        notice: 'Store the recovery key now; it is shown only once. If the recovery key, the passphrase and the OS key are all lost, the encrypted data cannot be recovered by anyone.',
        limitations: ['Earlier plaintext blocks may survive on SSDs, copy-on-write filesystems, snapshots and external backups; overwriting is best effort.', 'Chromium sessions, cookies, caches, downloads and the activity log are not covered (see coverage in encryption.status).'] };
    });
  }
  async disableEncryption(context = {}) {
    return this.exclusive(() => {
      this.assertUnlocked();
      if (this.encryption.keyring?.rotation) throw fail('invalid_arguments', 'Finish the data-key rotation before turning encryption off');
      this.sealedStoreStep('beforeDisable');
      this.encryption.disable(this.storage, { onStep: context.onStep });
      this.reopenStorage();
      this.log('encryption.disable', this.activeWorkspaceId, null, 'human', 'Workspace encryption turned off; data rewritten as plaintext');
      this.save();
      return { enabled: false, notice: 'Project data is now stored unencrypted. Backups made while encryption was on stay encrypted and need their recovery key.' };
    });
  }
  /** Close and reopen the store with the current key state (after enable/disable). */
  reopenStorage() {
    this.storage.close();
    this.storage = null;
    this.openStorage();
    this.storage.sweepOrphans();
  }
  async lockProfile() {
    if (!this.encryption.enabled) throw fail('invalid_arguments', 'Turn on workspace encryption before locking');
    if (this.locked) return { locked: true, alreadyLocked: true };
    await this.encryptionHooks.beforeLock?.({ persist: true });
    for (const store of this.sealedStores) await store.beforeLock?.();
    return this.exclusive(() => {
      if (this.locked) return { locked: true, alreadyLocked: true };
      try { this.log('encryption.lock', this.activeWorkspaceId, null, 'human', 'Workspace data locked'); this.save(); } catch { /* locking proceeds */ }
      this.storage.close();
      this.storage = null;
      this._data = null;
      this.encryption.forget();
      this.encryption.lockReason = 'locked';
      this.locked = true;
      return { locked: true };
    });
  }
  async unlockProfile({ method, secret }) {
    const result = await this.exclusive(() => {
      if (!this.encryption.enabled) throw fail('invalid_arguments', 'This profile is not encrypted');
      if (!this.locked) return { unlocked: true, alreadyUnlocked: true };
      this.encryption.unlock(method, secret);
      try { this.openStorage(); this.storage.sweepOrphans(); }
      catch (error) { this.storage?.close(); this.storage = null; this._data = null; this.encryption.forget(); throw error; }
      this.locked = false;
      // The store opened while still marked locked: start its background index rebuild now.
      this.scheduleIndexing();
      this.sealedStoreStep('afterUnlock');
      try { this.log('encryption.unlock', this.activeWorkspaceId, null, 'human', `Unlocked with ${method === 'os' ? 'the OS key' : method === 'passphrase' ? 'the passphrase' : 'the recovery key'}`); this.save(); } catch { /* unlocked regardless */ }
      return { unlocked: true, method };
    });
    if (!result.alreadyUnlocked) {
      if (this.encryption.keyring?.rotation) void this.resumeRotation().catch(() => {});
      await this.encryptionHooks.afterUnlock?.();
    }
    return { ...result, status: this.encryption.status({ locked: this.locked }) };
  }
  /**
   * Re-encrypt everything still under an older data key, one queued batch at a
   * time so commands interleave; then drop the old key. Resumes after a crash
   * or lock because each stored value names its key version.
   */
  resumeRotation({ batch = 500 } = {}) {
    if (this.rotationRun) return this.rotationRun;
    const from = this.encryption.keyring?.rotation?.from;
    this.rotationRun = (async () => {
      let reencrypted = 0;
      for (;;) {
        const step = await this.exclusive(() => { this.assertUnlocked(); return this.storage.reencryptStep({ limit: batch }); });
        reencrypted += step.reencrypted;
        this.rotationProgress = reencrypted;
        if (step.complete) break;
        await new Promise(resolve => setImmediate(resolve));
      }
      return this.exclusive(() => {
        this.assertUnlocked();
        this.sealedStoreStep('beforeFinishRotation');
        this.encryption.finishDataKeyRotation();
        this.storage.compact();
        this.log('encryption.rotate', this.activeWorkspaceId, null, 'human', `Data key rotation complete: ${reencrypted} values and components re-encrypted under version ${this.encryption.keyring.currentVersion}`);
        this.save();
        return { rotated: 'dataKey', from, keyVersion: this.encryption.keyring.currentVersion, reencrypted };
      });
    })().catch(error => {
      this.encryption.rotationError = error.message;
      if (error.code !== 'locked') this.onWarning({ code: 'ENCRYPTION_ROTATION_FAILED', message: `Data key rotation paused: ${error.message}` });
      throw error;
    }).finally(() => { this.rotationRun = null; });
    return this.rotationRun;
  }
}

