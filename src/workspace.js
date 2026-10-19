import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceSchemas, recordShapes } from './workspace-commands.js';
import { acquireProfileLock, storageWarnings, syncDirectory } from './storage-safety.js';
import { CURRENT_SCHEMA_VERSION, migrateSchema } from './migrations.js';
import { rejectSecretKeys } from './export-safety.js';
import { MetadataStore, OMITTED_RESULT, RECOVERY_DIR, STORE_FILE, canonicalJson } from './store.js';
import { trackChanges, untracked } from './change-tracker.js';
import { serialize } from './helpers.js';
import { cleanupBackupTemporary, listBackups, recoverInterruptedRestore } from './backups.js';
import { executeHandoffCommand, recordTakeover } from './handoffs.js';
import { effectiveRule, explainRules } from './site-rules.js';
import { originFor } from './provenance.js';
import { TRUSTED_CATEGORIES, buildCitations, forCaller, prefetchSourceTexts, quotedSources, sharedAccess, sharedInto } from './context-records.js';
import { DEFAULT_PAGE_LIMIT, decodeCursor, encodeCursor, pageItems } from './pagination.js';
import { RRF_K, documentKey, reciprocalRankFusion } from './retrieval.js';
import { createKeyProtector, lockedError } from './encryption.js';
import { ProfileEncryption } from './profile-encryption.js';
import { AutoLockSettings } from './auto-lock.js';
import { EVERYTHING_ID, EVERYTHING_NAME, ensureEverything, everythingRefusal, isEverything } from './everything.js';
import { applyTransition, appendTimeline, normalizePhase, sameIdentity, staleness, TERMINAL_PHASES } from './task-phases.js';
import { BATCHABLE, HUMAN_ADMIN, HYBRID_WINDOW, KNOWLEDGE_COLLECTIONS, LEGACY_FILE, MAX_FILE, PARTIAL_COVERAGE, READS, VIEW_STATE, WITH_EFFECTS, WORKFLOW_EXECUTABLE, artifactSummary, clone, collections, createRecord, createWorkspace, digest, fail, fsyncFile, initialState, isAgent, markReplayed, normalizeHostname, now, sanitizeUrl, substitutePlaceholders, uuid, validateStoredState, withoutFile } from './workspace-support.js';
import { workspaceArtifactMethods } from './workspace-artifacts.js';
import { workspaceTransferMethods } from './workspace-transfer.js';
import { workspaceEncryptionMethods } from './workspace-encryption.js';
export { BATCHABLE, sanitizeUrl } from './workspace-support.js';



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
    this.autoLock = new AutoLockSettings(directory);
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
      // Profiles created before the built-in Everything workspace (#99) gain it.
      const addedEverything = Array.isArray(data.workspaces) && ensureEverything(data, now());
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
      if (legacyTasks.length || addedEverything) this.save();
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
      // Recently closed tabs (#92) and remembered per-origin zoom (#93), per workspace.
      closed: (session.closed ?? this.data.browserSession?.closed ?? []).slice(-500).map(item => ({ id: String(item.id).slice(0, 64), workspaceId: item.workspaceId, url: sanitizeUrl(item.url) || 'about:blank',
        title: String(item.title || '').slice(0, 1000), pinned: Boolean(item.pinned), ...(typeof item.groupId === 'string' && { groupId: item.groupId.slice(0, 128) }),
        zoom: Math.min(5, Math.max(0.25, Number(item.zoom) || 1)), scrollX: Number(item.scrollX) || 0, scrollY: Number(item.scrollY) || 0, closedAt: String(item.closedAt || '').slice(0, 40) })),
      zoom: Object.fromEntries(Object.entries(session.zoom ?? this.data.browserSession?.zoom ?? {}).map(([workspaceId, origins]) => [workspaceId,
        Object.fromEntries(Object.entries(origins ?? {}).filter(([origin, factor]) => /^https?:\/\/[^/]+$/.test(origin) && Number.isFinite(factor)).slice(-200).map(([origin, factor]) => [origin.slice(0, 300), Math.min(5, Math.max(0.25, factor))]))])),
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
      if (snapshot.browserSession.closed) snapshot.browserSession.closed = snapshot.browserSession.closed.filter(item => item.workspaceId === workspaceId);
      if (snapshot.browserSession.zoom) snapshot.browserSession.zoom = { [workspaceId]: snapshot.browserSession.zoom[workspaceId] ?? {} };
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
      // Recently closed tabs are browsing history too (#92).
      if (this.data.browserSession?.closed) this.data.browserSession.closed = this.data.browserSession.closed.filter(item => item.workspaceId !== workspaceId);
      this.browser?.forgetClosed?.(workspaceId);
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
        ...(args.resources && { resources: { ...this.data.settings.resources, ...args.resources } }),
        ...(args.externalLinks && { externalLinks: { ...this.data.settings.externalLinks, ...args.externalLinks } }) };
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
    if (action === 'moveRecord') return this.moveRecord(args, actor);
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
    if (isEverything(record.id)) {
      if (action === 'delete' || action === 'archive') throw everythingRefusal(action);
      if (action === 'update' && args.changes.name !== undefined && args.changes.name !== EVERYTHING_NAME) throw everythingRefusal('rename');
    }
    if (action === 'update') {
      if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw new Error('STALE_STATE: workspace changed');
      Object.assign(record, args.changes); this.touch(record);
    } else if (action === 'switch') {
      if (record.archived) throw new Error('Restore this workspace before switching to it');
      // A workspace shown in its own window (#100) is not also shown in the main window.
      if (this.browser?.ownerOf && this.browser.ownerOf(record.id)?.id !== 1) throw fail('invalid_arguments', 'This workspace is open in its own window; focus that window, or move it back to the main window first', { field: 'id' });
      this.data.activeWorkspaceId = record.id;
      effects.push(switchBrowser);
    } else if (action === 'archive' || action === 'restore') {
      record.archived = action === 'archive'; this.touch(record);
      if (record.archived && record.id === this.activeWorkspaceId) this.selectRemaining(record.id);
      if (action === 'archive') effects.push(() => this.browser?.releaseWorkspace?.(record.id), switchBrowser);
    } else if (action === 'delete') {
      if (record.id === this.activeWorkspaceId) this.selectRemaining(record.id);
      this.data.workspaces = this.data.workspaces.filter(item => item.id !== record.id);
      if (this.data.siteLists) this.data.siteLists = this.data.siteLists.filter(item => item.workspaceId !== record.id);
      if (this.data.storagePolicies) this.data.storagePolicies = this.data.storagePolicies.filter(item => item.workspaceId !== record.id);
      for (const key of [...collections, 'activity', 'history', 'handoffs', ...KNOWLEDGE_COLLECTIONS, ...VIEW_STATE]) this.data[key] = (this.data[key] ?? []).filter(item => item.workspaceId !== record.id);
      // Access granted to the deleted workspace ends with it; the membership stays as history.
      for (const shared of this.data.sharedCollections) for (const member of shared.members ?? []) if (member.workspaceId === record.id && !member.revokedAt) Object.assign(member, { revokedAt: now(), revokedBy: actor, reason: 'workspace deleted' });
      this.data.browserSession.tabs = this.data.browserSession.tabs.filter(item => item.workspaceId !== record.id);
      if (this.data.browserSession.closed) this.data.browserSession.closed = this.data.browserSession.closed.filter(item => item.workspaceId !== record.id);
      if (this.data.browserSession.zoom) delete this.data.browserSession.zoom[record.id];
      // A person who confirmed the list may keep the deleted workspace's open pages: they reopen in Everything (#99),
      // in its own storage container, so sign-ins and page state do not move with them.
      const rescued = args.moveTabsToEverything ? [...(this.browser?.tabs?.values() ?? [])].filter(tab => tab.workspaceId === record.id).map(tab => this.browser.describe(tab))
        .filter(tab => tab.url && tab.url !== 'about:blank' && !tab.blocked).map(tab => ({ url: tab.url, pinned: tab.pinned })) : [];
      effects.push(() => this.browser?.releaseWorkspace?.(record.id), () => this.browser?.closeWorkspace?.(record.id), async () => {
        for (const tab of rescued) { try { await this.browser?.newTab?.(tab.url, EVERYTHING_ID, { pinned: tab.pinned }); } catch { /* a blocked or failed page is not reopened */ } }
      }, switchBrowser);
      this.log('workspaces.delete', record.id, record.id, actor, rescued.length ? `${rescued.length} open tab${rescued.length === 1 ? '' : 's'} reopened in Everything` : '');
      return { deleted: true, id: record.id, ...(args.moveTabsToEverything && { movedTabsToEverything: rescued.length }) };
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
  /**
   * Human-only move of a material or saved capture between workspaces (#99), for example out of Everything.
   * The record keeps its id, revisions and versions; references that would point across workspaces are
   * not rewritten, so the move is refused while a task, context record or shared collection in the source
   * workspace still refers to it.
   */
  moveRecord(args, actor) {
    const record = this.data[args.collection].find(item => item.id === args.id);
    if (!record) throw new Error(`${args.collection === 'artifacts' ? 'Capture' : 'Material'} not found`);
    const destination = this.workspace(args.workspaceId);
    if (destination.archived) throw new Error('Restore the destination workspace before moving records into it');
    if (record.workspaceId === destination.id) throw fail('invalid_arguments', 'The record is already in that workspace', { field: 'workspaceId' });
    if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw new Error('STALE_STATE: record changed');
    const source = record.workspaceId;
    const referencedBy = [
      ...this.data.tasks.filter(task => task.workspaceId === source && [...(task.evidence ?? []), ...(task.outputs ?? [])].includes(record.id)).map(task => `task ${task.id}`),
      ...this.data.context.filter(item => item.workspaceId === source && (item.citations ?? []).some(citation => citation.id === record.id || citation.captureId === record.id || citation.recordId === record.id)).map(item => `context ${item.id}`),
      ...(this.data.sharedCollections ?? []).filter(shared => (shared.items ?? []).some(item => item.id === record.id || item.itemId === record.id)).map(shared => `shared collection ${shared.id}`),
    ];
    if (referencedBy.length) throw fail('invalid_arguments', `Remove the references first: ${referencedBy.slice(0, 5).join(', ')}${referencedBy.length > 5 ? ', …' : ''}`, { field: 'id' });
    record.workspaceId = destination.id; this.touch(record);
    this.log('workspaces.moveRecord', source, record.id, actor, `Moved to ${destination.name}`);
    this.log('workspaces.moveRecord', destination.id, record.id, actor, `Moved from another workspace`);
    return args.collection === 'artifacts' ? artifactSummary(record) : withoutFile(record);
  }
  selectRemaining(excluding) {
    // A project workspace is preferred; the built-in Everything workspace is always there as the fallback.
    let next = this.data.workspaces.find(item => item.id !== excluding && !item.archived && !isEverything(item.id)) ?? this.data.workspaces.find(item => item.id !== excluding && !item.archived);
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




}

// Methods split out of the class (#119) keep their names and `this`; installed as non-enumerable like class methods.
for (const methods of [workspaceArtifactMethods, workspaceTransferMethods, workspaceEncryptionMethods]) {
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(methods))) Object.defineProperty(WorkspaceService.prototype, key, { ...descriptor, enumerable: false });
}
