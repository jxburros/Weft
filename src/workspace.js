import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { workspaceSchemas, recordShapes, finishReason } from './workspace-commands.js';
import { acquireProfileLock, assertUnchanged, fileStamp, writeVerifiedJson, storageWarnings, syncDirectory } from './storage-safety.js';
import { CURRENT_SCHEMA_VERSION, migrateSchema } from './migrations.js';
import { secretKey, rejectSecretKeys, inspectExportResidue } from './export-safety.js';

const collections = [...Object.keys(recordShapes), 'artifacts'];
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const uuid = prefix => `${prefix}_${randomUUID()}`;
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_FILE = 100 * 1024 * 1024;
const urlSecret = /token|secret|password|credential|authorization|api.?key|session|signature|^code$|^key$/i;

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
function cleanExport(value, key = '') {
  if (Array.isArray(value)) return value.map(item => cleanExport(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => !secretKey.test(name)).map(([name, item]) => [name, cleanExport(item, name)]));
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
function artifactSummary(record) {
  const copy = clone(record);
  copy.versions = copy.versions.map(({ text, pngBase64, ...metadata }) => metadata);
  return copy;
}

/** Locked atomic JSON persistence; no encryption or live multi-process editing. */
export class WorkspaceService {
  constructor({ directory, browser, onWarning = warning => console.warn(`Weft storage: ${warning.message}`) } = {}) {
    if (!directory) throw new Error('Workspace data directory is required');
    this.directory = directory;
    this.path = join(directory, 'workspace-state.json');
    this.lock = acquireProfileLock(directory);
    this.browser = browser;
    this.queue = Promise.resolve();
    this.onWarning = onWarning;
    this.warned = new Set();
    try {
      this.stamp = fileStamp(this.path);
      this.refreshStorageWarnings();
      if (existsSync(this.path)) {
        if (statSync(this.path).size > MAX_FILE) throw new Error('Workspace state exceeds supported 100 MiB size');
        const original = readFileSync(this.path, 'utf8');
        let raw;
        try { raw = JSON.parse(original); } catch { throw new Error('Workspace state is unreadable. Preserve workspace-state.json and restore from an export or backup.'); }
        this.data = migrateSchema(raw, { validate: validateStoredState });
        rejectSecretKeys(this.data);
        if (raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
          assertUnchanged(this.path, this.stamp);
          const backup = `${this.path}.schema${raw.schemaVersion}-${digest(original)}.bak`;
          if (!existsSync(backup)) writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
          if (readFileSync(backup, 'utf8') !== original) throw new Error('Migration backup verification failed; original preserved');
          const backupFd = openSync(backup, 'r+');
          try { fsyncSync(backupFd); } finally { closeSync(backupFd); }
          syncDirectory(directory);
          this.save();
        }
      } else {
        if (this.storageWarnings.some(warning => ['SYNC_CONFLICT_COPY', 'SYNC_PLACEHOLDER'].includes(warning.code))) throw new Error('STORE_CONFLICT: Workspace copies/placeholders require human review before creating a new store.');
        const initial = createWorkspace();
        this.data = { schemaVersion: CURRENT_SCHEMA_VERSION, activeWorkspaceId: initial.id, workspaces: [initial], ...Object.fromEntries(collections.map(name => [name, []])), history: [], activity: [], settings: { theme: 'system', model: { provider: 'compatible', endpoint: 'http://localhost:11434/v1', model: '' }, sidebarCollapsed: false, agentPanelOpen: false }, browserSession: { tabs: [], activeId: null } };
        this.save();
      }
    } catch (error) { this.lock.release(); throw error; }
    const service = this;
    this.store = { get data() { return service.data; }, save: () => service.save() };
  }
  close() { this.lock.release(); }
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
    if (previous?.url === cleanUrl && previous.tabId === tabId && Date.now() - Date.parse(previous.visitedAt) < 2000) { previous.title = String(title || cleanUrl).slice(0, 1000); return; }
    this.data.history.push({ id: uuid('visit'), workspaceId, url: cleanUrl, title: String(title || cleanUrl).slice(0, 1000), tabId, visitedAt: now() });
    const current = this.data.history.filter(item => item.workspaceId === workspaceId);
    if (current.length > 1000) { const remove = new Set(current.slice(0, current.length - 1000).map(item => item.id)); this.data.history = this.data.history.filter(item => !remove.has(item.id)); }
    try { this.save(); } catch (error) { this.data.history = before; throw error; }
  }

  get activeWorkspaceId() { return this.data.activeWorkspaceId; }
  attachBrowser(browser) { this.browser = browser; }
  save() {
    this.lock.assertOwned();
    rejectSecretKeys(this.data);
    const serialized = JSON.stringify(this.data, null, 2);
    if (Buffer.byteLength(serialized) > MAX_FILE) throw new Error('Workspace storage exceeds supported 100 MiB limit; export and remove unneeded captures');
    this.stamp = writeVerifiedJson(this.path, serialized, this.stamp);
  }
  persistSession(session) {
    const before = this.data.browserSession;
    this.data.browserSession = {
      tabs: session.tabs.map(tab => ({ id: tab.id, workspaceId: tab.workspaceId, url: sanitizeUrl(tab.url) || 'about:blank', title: String(tab.title || '').slice(0, 1000), pinned: Boolean(tab.pinned), version: tab.version || 0, group: String(tab.group || '').slice(0, 100) })),
      activeId: session.activeId ?? null,
    };
    try { this.save(); } catch (error) { this.data.browserSession = before; throw error; }
  }
  snapshot() {
    return { ...clone(this.data), storageWarnings: clone(this.refreshStorageWarnings()), artifacts: this.data.artifacts.map(artifactSummary), materials: this.data.materials.map(({ fileBase64, ...record }) => clone(record)) };
  }
  workspace(id = this.activeWorkspaceId) {
    const record = this.data.workspaces.find(item => item.id === id);
    if (!record) throw new Error('Workspace not found');
    return record;
  }
  record(collection, id, context = {}) {
    const record = this.data[collection].find(item => item.id === id);
    if (!record) throw new Error(`${collection} record not found`);
    if (context.workspaceId && record.workspaceId && record.workspaceId !== context.workspaceId) throw new Error('PERMISSION_REQUIRED: record is outside the authorized workspace');
    return record;
  }
  log(action, workspaceId, targetId, actor = 'human', detail = '') {
    this.data.activity.push({ id: uuid('event'), workspaceId, targetId, action, actor, detail, createdAt: now() });
  }
  matchSiteRule(value, workspaceId = this.activeWorkspaceId) {
    let url;
    try { url = new URL(value); } catch { return null; }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const matching = this.data.siteRules.filter(rule => rule.enabled !== false && (rule.scope === 'global' || rule.workspaceId === workspaceId) && (hostname === rule.hostname || (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`))) && (rule.path === '/' || url.pathname === rule.path || url.pathname.startsWith(`${rule.path.replace(/\/$/, '')}/`)));
    return clone(matching.find(rule => rule.behavior === 'block' && rule.mode === 'connection') || matching.find(rule => rule.behavior === 'block') || matching[0] || null);
  }
  getConversation(id) { return clone(this.record('conversations', id)); }
  appendMessage(id, message) { return this.execute('conversations.message', { id, ...message }); }
  recordTurnManifest(id, manifest) {
    const run = this.queue.then(() => {
      rejectSecretKeys(manifest);
      const before = clone(this.data);
      try {
        const record = this.record('conversations', id);
        record.turnManifests ??= [];
        const index = record.turnManifests.findIndex(item => item.id === manifest.id);
        if (index < 0) record.turnManifests.push(clone(manifest));
        else record.turnManifests[index] = clone(manifest);
        this.log('chat.turn', record.workspaceId, id, 'model', JSON.stringify(manifest));
        this.save();
      } catch (error) { this.data = before; throw error; }
    });
    this.queue = run.catch(() => {});
    return run;
  }


  execute(name, args = {}, context = {}) {
    const run = this.queue.then(() => this.dispatch(name, args, context));
    this.queue = run.catch(() => {});
    return run;
  }
  async dispatch(name, input, context) {
    context.assertAuthorized?.();
    const schema = workspaceSchemas[name];
    if (!schema) throw new Error(`Unknown workspace command: ${name}`);
    rejectSecretKeys(input);
    const args = schema.parse(input);
    const actor = context.actor || 'human';
    const admin = actor === 'human' || actor === 'admin';
    if (!admin && (/^siteRules\.(create|update|delete)$/.test(name) || ['settings.update', 'workspaces.delete', 'workspaces.import', 'workspaces.export', 'workspaces.switch'].includes(name))) throw new Error('PERMISSION_REQUIRED: this action requires human administration');
    const workspaceId = args.workspaceId || context.workspaceId || this.activeWorkspaceId;
    if (context.workspaceId && args.workspaceId && context.workspaceId !== args.workspaceId) throw new Error('PERMISSION_REQUIRED: workspace is outside the authorized scope');
    this.workspace(workspaceId);
    const [collection, action] = name.split('.');
    if (collection === 'workspaces' && context.workspaceId && args.id && args.id !== context.workspaceId) throw new Error('PERMISSION_REQUIRED: workspace is outside the authorized scope');
    if (name === 'history.list') return clone((this.data.history || []).filter(item => item.workspaceId === workspaceId).slice(-(args.limit || 100)).reverse());
    if (name === 'history.clear') {
      if (!admin) throw new Error('History clearing requires human administration');
      const before = clone(this.data);
      try {
        this.data.history = (this.data.history || []).filter(item => item.workspaceId !== workspaceId);
        this.log(name, workspaceId, null, actor); this.save(); return { cleared: true, workspaceId };
      } catch (error) { this.data = before; throw error; }
    }
    if (name === 'bookmarks.list') return clone(this.data.materials.filter(item => item.workspaceId === workspaceId && item.kind === 'website' && item.pinned));
    if (name === 'bookmarks.create') return this.dispatch('materials.create', { ...args, kind: 'website', pinned: true }, context);
    if (name === 'bookmarks.delete') {
      const bookmark = this.record('materials', args.id, context);
      if (bookmark.kind !== 'website' || !bookmark.pinned) throw new Error('Bookmark not found');
      return this.dispatch('materials.delete', args, context);
    }
    if (name === 'workspace.snapshot') {
      const snapshot = this.snapshot();
      if (!context.workspaceId && !args.workspaceId) return snapshot;
      delete snapshot.storageWarnings;
      if (snapshot.siteLists) snapshot.siteLists = snapshot.siteLists.filter(item => item.workspaceId === workspaceId);
      snapshot.workspaces = snapshot.workspaces.filter(item => item.id === workspaceId);
      for (const key of [...collections, 'activity', 'history']) snapshot[key] = snapshot[key].filter(item => item.workspaceId === workspaceId);
      snapshot.browserSession.tabs = snapshot.browserSession.tabs.filter(item => item.workspaceId === workspaceId);
      if (!snapshot.browserSession.tabs.some(tab => tab.id === snapshot.browserSession.activeId)) snapshot.browserSession.activeId = null;
      snapshot.activeWorkspaceId = workspaceId;
      return snapshot;
    }
    if (name === 'settings.get') return clone(this.data.settings);
    if (name === 'activity.list') return clone(this.data.activity.filter(item => item.workspaceId === workspaceId).slice(-(args.limit || 100)).reverse());
    if (name === 'search.query') {
      const query = args.query.trim().toLocaleLowerCase();
      if (!query) return [];
      return collections.flatMap(type => this.data[type].filter(item => item.workspaceId === workspaceId).map(item => ({ type, id: item.id, localOnly: item.localOnly === true, title: item.title || item.hostname, content: item.content || item.objective || item.description || item.versions?.map(version => version.text || '').join('\n') || '', updatedAt: item.updatedAt }))).filter(item => `${item.title}\n${item.content}`.toLocaleLowerCase().includes(query)).slice(0, args.limit || 50).map(item => ({ ...item, content: item.content.slice(0, 300) }));
    }
    if (name === 'workspaces.list') return clone(this.data.workspaces.filter(item => !context.workspaceId || item.id === context.workspaceId));
    if (name === 'workspaces.get') { if (context.workspaceId && args.id !== context.workspaceId) throw new Error('PERMISSION_REQUIRED'); return clone(this.workspace(args.id)); }
    if (name === 'workspaces.export') return this.exportWorkspace(args.id, args.sensitiveTerms);
    if (collections.includes(collection) && action === 'list') return this.data[collection].filter(item => item.workspaceId === workspaceId || (collection === 'siteRules' && item.scope === 'global')).map(item => collection === 'artifacts' ? artifactSummary(item) : collection === 'materials' ? clone(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'fileBase64'))) : clone(item));
    if (collections.includes(collection) && action === 'get') {
      const record = this.record(collection, args.id, context);
      if (collection === 'artifacts' && args.versionId) {
        const version = record.versions.find(item => item.id === args.versionId);
        if (!version) throw new Error('Artifact version not found');
        return clone({ artifactId: record.id, workspaceId: record.workspaceId, ...version });
      }
      return clone(record);
    }
    const before = clone(this.data);
    try {
      let result;
      if (collection === 'workspaces') result = this.mutateWorkspace(action, args, actor);
      else if (name === 'settings.update') {
        this.data.settings = { ...this.data.settings, ...args, model: { ...this.data.settings.model, ...args.model } };
        this.log(name, workspaceId, workspaceId, actor);
        result = this.data.settings;
      } else if (name === 'conversations.message') {
        const record = this.record(collection, args.id, context);
        const { id, ...message } = args;
        record.messages.push({ id: uuid('msg'), ...message, createdAt: now() });
        this.touch(record); this.log(name, record.workspaceId, record.id, actor);
        result = record;
      } else if (name === 'tasks.transition') {
        const record = this.record(collection, args.id, context);
        const prior = record.status;
        record.status = args.status;
        if (args.checkpoint !== undefined) record.checkpoint = args.checkpoint;
        if (args.status === 'completed') record.progress = 100;
        this.touch(record); this.log(name, record.workspaceId, record.id, actor, `${prior} → ${args.status}${args.cause ? `: ${args.cause}` : ''}`);
        result = record;
      } else if (collection === 'artifacts') result = await this.mutateArtifact(action, args, workspaceId, actor, context);
      else if (Object.hasOwn(recordShapes, collection)) result = this.mutateRecord(collection, action, args, workspaceId, actor, admin, context);
      else throw new Error(`Unsupported workspace command: ${name}`);
      context.assertAuthorized?.();
      this.save();
      if (name === 'workspaces.delete') { this.data.history = this.data.history.filter(item => item.workspaceId !== args.id); this.save(); await this.browser?.closeWorkspace?.(args.id); }
      if (collection === 'workspaces' && ['switch', 'archive', 'delete', 'create', 'import'].includes(action)) await this.browser?.switchWorkspace?.(this.activeWorkspaceId);
      return clone(result);
    } catch (error) {
      this.data = before;
      // Browser effects are best effort; preserve consistency of durable state on failure.
      try { this.save(); } catch { /* Original error is more useful. */ }
      throw error;
    }
  }
  touch(record) { record.updatedAt = now(); record.revision += 1; }
  mutateWorkspace(action, args, actor) {
    if (action === 'create') {
      const record = { ...createWorkspace(args.name), ...args };
      this.data.workspaces.push(record); this.data.activeWorkspaceId = record.id;
      this.log('workspaces.create', record.id, record.id, actor);
      return record;
    }
    if (action === 'import') return this.importWorkspace(args.data, actor);
    const record = this.workspace(args.id);
    if (action === 'update') {
      if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw new Error('STALE_STATE: workspace changed');
      Object.assign(record, args.changes); this.touch(record);
    } else if (action === 'switch') {
      if (record.archived) throw new Error('Restore this workspace before switching to it');
      this.data.activeWorkspaceId = record.id;
    } else if (action === 'archive' || action === 'restore') {
      record.archived = action === 'archive'; this.touch(record);
      if (record.archived && record.id === this.activeWorkspaceId) this.selectRemaining(record.id);
    } else if (action === 'delete') {
      if (record.id === this.activeWorkspaceId) this.selectRemaining(record.id);
      this.data.workspaces = this.data.workspaces.filter(item => item.id !== record.id);
      if (this.data.siteLists) this.data.siteLists = this.data.siteLists.filter(item => item.workspaceId !== record.id);
      for (const key of [...collections, 'activity', 'history']) this.data[key] = this.data[key].filter(item => item.workspaceId !== record.id);
      this.data.browserSession.tabs = this.data.browserSession.tabs.filter(item => item.workspaceId !== record.id);
    } else if (action === 'duplicate') {
      const exported = this.exportWorkspace(record.id);
      exported.workspace.name = args.name || `${record.name} copy`;
      const copy = this.importWorkspace(exported, actor, false);
      this.log('workspaces.duplicate', copy.id, record.id, actor, 'Records and stored files copied. Browser sessions and credentials excluded.');
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
      const { workspaceId: ignored, ...fields } = args;
      if (!admin && collection === 'context' && ['confirmed', 'instructions', 'decisions'].includes(fields.category)) throw new Error('PERMISSION_REQUIRED: only a human may establish trusted project context');
      if (collection === 'siteRules') this.validateRule(fields);
      if (collection === 'materials') this.validateMaterial(fields);
      record = createRecord(fields, collection === 'siteRules' && fields.scope === 'global' ? null : workspaceId, collection.slice(0, 4));
      if (collection === 'conversations') record.messages = [];
      if (['materials', 'context'].includes(collection)) record.history = [{ revision: 1, content: record.content, actor, createdAt: record.createdAt }];
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
        const updated = { ...record, ...args.changes };
        if (collection === 'siteRules') { this.validateRule(updated); updated.workspaceId = updated.scope === 'global' ? null : (record.workspaceId || workspaceId); }
        if (collection === 'materials') this.validateMaterial(updated);
        Object.assign(record, updated); this.touch(record);
        if (record.history && args.changes.content !== undefined) record.history.push({ revision: record.revision, content: record.content, actor, createdAt: now() });
      } else throw new Error('Unsupported record action');
    }
    this.log(`${collection}.${action}`, record.workspaceId, record.id, actor);
    return action === 'delete' ? { deleted: true, id: record.id } : record;
  }
  validateRule(record) {
    record.hostname = normalizeHostname(record.hostname);
    if (!record.path.startsWith('/') || /[?#\\]/.test(record.path)) throw new Error('Site rule path must be an absolute URL path without query or fragment');
  }
  validateMaterial(record) {
    if (record.fileBase64 !== undefined) {
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
      if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Artifact images must be PNG and at most 20 MiB');
      source.pngBase64 = bytes.toString('base64');
      components.push({ type: 'image/png', size: bytes.length, sha256: digest(bytes) });
    }
    let record = args.artifactId ? this.record('artifacts', args.artifactId, context) : null;
    if (record && record.workspaceId !== workspaceId) throw new Error('Artifact belongs to a different workspace');
    if (!record) {
      record = createRecord({ title: source.title || 'Saved page', note: args.note || '', tags: args.tags || [], versions: [], annotations: [] }, workspaceId, 'artifact');
      this.data.artifacts.push(record);
    }
    const version = { id: uuid('version'), number: record.versions.length + 1, createdAt: now(), actor, method: action === 'capture' ? 'browser-capture' : 'supplied-content', url: sanitizeUrl(source.url), title: source.title || record.title, components, text: source.text, pngBase64: source.pngBase64, navigationVersion: source.navigationVersion, limitations: [...(source.limitations || []), 'Stored text is untrusted source content. Active scripts and external resources are not replayed.', 'Captures may contain personal information; inspect before sharing.'], redactionStatus: 'not-reviewed', previousVersionId: record.versions.at(-1)?.id || null };
    record.versions.push(version); this.touch(record);
    this.log('artifacts.capture', workspaceId, record.id, actor, `Version ${version.number}`);
    return artifactSummary(record);
  }
  exportWorkspace(id, sensitiveTerms) {
    const record = this.workspace(id);
    const exported = cleanExport({ format: 'weft-workspace', schemaVersion: CURRENT_SCHEMA_VERSION, exportedAt: now(), workspace: record, ...Object.fromEntries(collections.map(name => [name, this.data[name].filter(item => item.workspaceId === id && !(name === 'siteRules' && item.scope === 'global'))])), limitations: ['Browser sessions, cookies, credentials, provider keys, and global policies are excluded. Imported site rules and workflows remain inactive until reviewed and enabled.', 'Free-form content and screenshots can contain personal information. Review the export before sharing.'] });
    if (sensitiveTerms !== undefined) exported.residueScan = inspectExportResidue(JSON.stringify(exported, null, 2), sensitiveTerms);
    return exported;
  }
  importWorkspace(input, actor, activate = true) {
    let raw = input;
    if (typeof input === 'string') { if (Buffer.byteLength(input) > MAX_FILE) throw new Error('Import exceeds 100 MiB'); raw = JSON.parse(input); }
    if (!raw || typeof raw !== 'object' || raw.format !== 'weft-workspace' || !raw.workspace) throw new Error('Expected a versioned Weft workspace export');
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_FILE) throw new Error('Import exceeds 100 MiB');
    rejectSecretKeys(raw);
    raw = migrateSchema(raw, { kind: 'export' });
    const workspaceFields = workspaceSchemas['workspaces.create'].parse({ name: raw.workspace.name, description: raw.workspace.description, color: raw.workspace.color, icon: raw.workspace.icon });
    const workspace = { ...createWorkspace(), ...workspaceFields };
    const mapping = new Map([[raw.workspace.id, workspace.id]]);
    const imported = {};
    for (const collection of collections) {
      if (raw[collection] !== undefined && !Array.isArray(raw[collection])) throw new Error(`Invalid ${collection} collection`);
      if ((raw[collection]?.length || 0) > 10000) throw new Error('Import collection exceeds 10,000 records');
      imported[collection] = (raw[collection] || []).map(item => {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new Error('Invalid imported record');
        if (mapping.has(item.id)) throw new Error('Duplicate imported record ID');
        let fields;
        if (collection === 'artifacts') fields = this.validateImportedArtifact(item);
        else {
          fields = z.strictObject(recordShapes[collection]).parse(Object.fromEntries(Object.keys(recordShapes[collection]).filter(key => item[key] !== undefined).map(key => [key, item[key]])));
          if (collection === 'siteRules') { fields.scope = 'workspace'; fields.enabled = false; this.validateRule(fields); }
          if (collection === 'workflows') fields.enabled = false;
          if (collection === 'materials') this.validateMaterial(fields);
          if (collection === 'conversations') fields.messages = z.array(z.object({ id: z.string().max(128), role: z.enum(['user', 'assistant', 'system', 'tool']), content: z.string().max(500000), createdAt: z.string().max(100), model: z.string().max(200).optional(), localOnly: z.boolean().optional(), status: z.string().max(30).optional(), turnId: z.string().max(128).optional(), finishReason: finishReason.optional(), continuable: z.boolean().optional() })).max(10000).parse(item.messages || []);
        }
        const record = createRecord(fields, workspace.id, collection.slice(0, 4));
        mapping.set(item.id, record.id);
        return record;
      });
    }
    for (const records of Object.values(imported)) for (const record of records) for (const key of ['evidence', 'materialIds', 'outputs']) if (Array.isArray(record[key])) record[key] = record[key].map(id => { if (!mapping.has(id)) throw new Error('Invalid imported record reference'); return mapping.get(id); });
    this.data.workspaces.push(workspace);
    for (const collection of collections) this.data[collection].push(...imported[collection]);
    if (activate) this.data.activeWorkspaceId = workspace.id;
    this.log('workspaces.import', workspace.id, workspace.id, actor, 'Imported records with new IDs; policies and workflows inactive; no sessions or credentials imported');
    return workspace;
  }
  validateImportedArtifact(item) {
    const fields = z.object({ title: z.string().min(1).max(240), note: z.string().max(500000).default(''), tags: z.array(z.string().max(100)).max(100).default([]), versions: z.array(z.object({ text: z.string().max(2000000).optional(), pngBase64: z.string().max(28000000).optional(), title: z.string().max(240).optional(), url: z.string().max(16384).optional(), createdAt: z.string().max(100).optional() })).max(1000) }).parse(item);
    fields.annotations = [];
    fields.versions = fields.versions.map((version, index) => {
      const components = [];
      if (version.text !== undefined) components.push({ type: 'text/plain', size: Buffer.byteLength(version.text), sha256: digest(version.text) });
      if (version.pngBase64) {
        const bytes = Buffer.from(version.pngBase64, 'base64');
        if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid imported PNG');
        version.pngBase64 = bytes.toString('base64');
        components.push({ type: 'image/png', size: bytes.length, sha256: digest(bytes) });
      }
      if (!components.length) throw new Error('Imported artifact has no offline content');
      return { ...version, id: uuid('version'), number: index + 1, url: sanitizeUrl(version.url), components, method: 'import', actor: 'human', redactionStatus: 'not-reviewed', limitations: ['Imported content has not been independently verified.'] };
    });
    return fields;
  }
}
