/**
 * Constants, schemas and small helpers shared by WorkspaceService (src/workspace.js) and the modules
 * split out of it (#119): workspace-artifacts.js, workspace-transfer.js and workspace-encryption.js.
 */
import { CURRENT_SCHEMA_VERSION } from './migrations.js';
import { archiveManifest } from './archive.js';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import { domainToASCII } from 'node:url';
import { everythingRecord } from './everything.js';
import { finishReason, recordShapes } from './workspace-commands.js';
import { randomUUID } from 'node:crypto';
import { secretKey } from './export-safety.js';
import { sha256 } from './components.js';
import { untracked } from './change-tracker.js';
import { z } from 'zod';

// Same registered symbol as commands.js PARTIAL_COVERAGE (not imported here to avoid an import cycle).
export const PARTIAL_COVERAGE = Symbol.for('weft.partialCoverage');
export const collections = [...Object.keys(recordShapes), 'artifacts'];
export const now = () => new Date().toISOString();
export const clone = value => structuredClone(untracked(value));
export const uuid = prefix => `${prefix}_${randomUUID()}`;
export const digest = value => sha256(value);
export const MAX_FILE = 100 * 1024 * 1024;
export const MAX_PACKAGE_RECORDS_FILE = 256 * 1024 * 1024;
export const LEGACY_FILE = 'workspace-state.json';
export const TRANSFERS_DIR = 'transfers';
export const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REPLAYED = Symbol.for('weft.replayed');
export const WORKFLOW_EXECUTABLE = ['watch', 'steps', 'parameters', 'allowedSites', 'materialIds', 'credentialRefs'];
const urlSecret = /token|secret|password|credential|authorization|api.?key|session|signature|^code$|^key$/i;
export const fail = (code, message, extra = {}) => Object.assign(new Error(`${code.toUpperCase()}: ${message}`), { code, ...extra });
export const HUMAN_ADMIN = new Set(['memories.create', 'memories.update', 'memories.delete', 'search.configureEmbeddings', 'search.indexing', 'siteRules.review', 'settings.update', 'workspaces.delete', 'workspaces.moveRecord', 'workspaces.import', 'workspaces.export', 'workspaces.switch', 'workspaces.exportPackage', 'workspaces.importPackage', 'backups.create', 'backups.list', 'backups.verify', 'backups.restore', 'backups.delete',
  'artifacts.setAccess', 'artifacts.purgeContent', 'artifacts.preview', 'artifacts.closePreview']);
// activity.list is served by the durable activity log (src/activity-log.js) through the dispatcher.
export const READS = new Set(['history.list', 'bookmarks.list', 'workspace.snapshot', 'settings.get', 'workspaces.list', 'workspaces.get', 'workspaces.export', 'artifacts.versions', 'conversations.messages',
  'artifacts.compare', 'artifacts.verify', 'artifacts.review', 'artifacts.readOriginal', ...collections.flatMap(name => [`${name}.list`, `${name}.get`])]);
export const isAgent = context => !['human', 'admin'].includes(context?.actor || 'human');
export const RESTRICTED_NOTICE = 'Restricted original: its content, URL and title are withheld from agents. Use a sanitized derivative version, or ask a person to approve artifacts.readOriginal for this exact version.';
// Batches contain record writes only: these can be rolled back exactly.
export const BATCHABLE = Object.freeze(new Set([...Object.keys(recordShapes).flatMap(name => [`${name}.create`, `${name}.update`, `${name}.delete`]),
  'tasks.transition', 'conversations.message', 'artifacts.create', 'artifacts.annotate', 'artifacts.delete', 'bookmarks.create', 'bookmarks.delete', 'workspaces.update', 'settings.update']));
export const WITH_EFFECTS = new Set(['workspaces.create', 'workspaces.switch', 'workspaces.archive', 'workspaces.delete', 'workspaces.import', 'workspaces.importPackage']);
// Candidates per index fused by reciprocal rank; hybrid result pages end after this many per index.
export const HYBRID_WINDOW = 200;
export const ID_TOKEN = /\b[a-z]{2,12}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
export const EXPORT_EXCLUDED = Object.freeze(['Browser sessions, tabs, cookies and site storage', 'Credentials, provider keys and model connection settings', 'Global site rules', 'Activity log and browsing history', 'Local search index and request identities', 'Local backups',
  'Site storage modes and exceptions: browser privacy policy for this profile; set them again after import',
  'Community list subscriptions: signed list state is verified on install; subscribe again to receive and track rules',
  'Approvals, autonomy ceilings and agent connection grants: authority is never transferred with data',
  'Shared collection participants and roles: grants to other workspaces are authority and must be given again',
  'Linked file and folder contents and local paths, service credentials and cached service content: relink or refresh after import',
  'Scheduled freshness check settings',
  'Tab groups and the last-view resume record: they describe this profile’s open tabs and layout, not project records']);
/** Workspace-scoped collections handled outside recordShapes: shared collections, evidence conflicts and freshness policies. */
export const KNOWLEDGE_COLLECTIONS = Object.freeze(['sharedCollections', 'conflicts', 'freshnessPolicies']);
export const PLAINTEXT_EXPORT = 'Exported from an encrypted profile: this export is NOT encrypted. Store or share it accordingly.';
// Workspace-scoped profile state that is deliberately not part of the export format (listed above with the reason).
export const NOT_EXPORTED = new Set(['storagePolicies', 'siteLists', 'freshnessPolicies', 'tabGroups', 'resumeStates']);
// Workspace-scoped view state removed with its workspace.
export const VIEW_STATE = ['tabGroups', 'resumeStates'];
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
export function cleanExport(value, key = '', parent = '') {
  if (Array.isArray(value)) return value.map(item => cleanExport(item, '', key));
  // Quote selectors are cited evidence text, kept exactly so citations re-anchor after import.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => !secretKey.test(name)).map(([name, item]) => [name, (parent === 'versions' && name === 'text') || /Base64$/.test(name) || name === '$component' || (parent === 'citations' && ['exact', 'prefix', 'suffix'].includes(name)) ? item : cleanExport(item, name)]));
  if (typeof value === 'string' && (/url|endpoint/i.test(key) || (/^https?:\/\//i.test(value) && !/\s/.test(value)))) return sanitizeUrl(value);
  return value;
}
export function normalizeHostname(value) {
  if (/[\s/@?#:\\]/.test(value)) throw new Error('Use a hostname without scheme, port or path');
  const hostname = domainToASCII(value.toLowerCase().replace(/\.$/, ''));
  if (!hostname || hostname.length > 253 || hostname.split('.').some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw new Error('Invalid hostname');
  return hostname;
}
export function validateStoredState(data) {
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
export function createRecord(fields, workspaceId, prefix = 'record') {
  const timestamp = now();
  return { id: uuid(prefix), workspaceId, ...fields, createdAt: timestamp, updatedAt: timestamp, revision: 1 };
}
export function createWorkspace(name = 'My workspace') {
  const record = createRecord({ name, description: '', color: '#7563A8', icon: 'W', archived: false }, undefined, 'ws');
  delete record.workspaceId;
  return record;
}
export function initialState() {
  const initial = createWorkspace();
  // Everything (#99) is built in (the GUI shows it first in the rail); a new profile still opens on its own project workspace.
  return { schemaVersion: CURRENT_SCHEMA_VERSION, activeWorkspaceId: initial.id, workspaces: [initial, everythingRecord(initial.createdAt)], ...Object.fromEntries(collections.map(name => [name, []])), history: [], activity: [], settings: { theme: 'system', model: { provider: 'compatible', endpoint: 'http://localhost:11434/v1', model: '' }, sidebarCollapsed: false, agentPanelOpen: false }, browserSession: { tabs: [], activeId: null }, handoffs: [], tabGroups: [], resumeStates: [],
    ...Object.fromEntries(KNOWLEDGE_COLLECTIONS.map(name => [name, []])) };
}
/** Version metadata without content. Agents see restricted originals as withheld stubs that name their sanitized derivatives. */
export function versionMetadata(record, version, agent = false) {
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
export function artifactSummary(record, { agent = false } = {}) {
  const { versions, ...rest } = record;
  return { ...clone(rest), versions: versions.map(version => versionMetadata(record, version, agent)) };
}
export const withoutFile = record => clone(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'fileBase64')));
export function fsyncFile(path) { const fd = openSync(path, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function markReplayed(value) {
  if (value && typeof value === 'object') Object.defineProperty(value, REPLAYED, { value: true });
  return value;
}
export function substitutePlaceholders(value, index, results) {
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
export const componentRef = z.strictObject({ $component: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0), encoding: z.enum(['base64', 'utf8']) }) });
export const timestamp = z.string().max(100);
export const historyEntry = z.object({ revision: z.number().int().min(1), content: z.string().max(500000), actor: z.string().max(200).default('human'), createdAt: timestamp, origin: z.unknown().optional() });
export const messageSchema = z.object({ id: z.string().max(128).optional(), role: z.enum(['user', 'assistant', 'system', 'tool']), content: z.string().max(500000), createdAt: timestamp, model: z.string().max(200).optional(), localOnly: z.boolean().optional(), status: z.string().max(30).optional(), attachments: z.array(z.string().max(128)).max(1000).optional(),
  turnId: z.string().max(128).optional(), finishReason: finishReason.optional(), continuable: z.boolean().optional() });
export const annotationSchema = z.object({ note: z.string().max(500000).default(''), tags: z.array(z.string().max(100)).max(100).optional(), revision: z.number().int().min(1).optional(), actor: z.string().max(200).optional(), createdAt: timestamp.optional() });
export const versionSchema = z.object({ id: z.string().max(128).optional(), number: z.number().int().min(1).optional(), createdAt: timestamp.optional(), actor: z.string().max(200).optional(), method: z.string().max(50).optional(),
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
export const artifactSchema = z.object({ title: z.string().min(1).max(240), note: z.string().max(500000).default(''), tags: z.array(z.string().max(100)).max(100).default([]), versions: z.array(versionSchema).max(1000), annotations: z.array(annotationSchema).max(10000).default([]) });
export const SYSTEM_FIELDS = { common: ['id', 'workspaceId', 'createdAt', 'updatedAt', 'revision'], materials: ['history', 'size', 'sha256', 'link', 'service', 'copiedFrom', 'superseded', 'derivedFrom', 'lastOrigin'],
  context: ['history', 'proposal', 'promotedFrom', 'promotionNote', 'superseded', 'derivedFrom', 'lastOrigin'], conversations: ['messages', 'turnManifests'], artifacts: ['versions', 'annotations'],
  tasks: ['timeline', 'operations', 'run', 'executor', 'workflowRun'],
  siteRules: ['createdBy', 'revisions', 'lastReviewedAt', 'lastReviewedBy'] };
// Site-rule provenance (#19) travels with format 2 exports: who created the rule, its bounded revision history and review state.
export const ruleRevisionSchema = z.object({ revision: z.number().int().min(1), actor: z.string().max(200), at: timestamp, summary: z.string().max(2400), changed: z.array(z.string().max(100)).max(50).default([]),
  previous: z.record(z.string().max(100), z.unknown()).optional() });
export const packageManifest = z.strictObject({ format: z.literal('weft-package'), formatVersion: z.literal(1), createdAt: z.string().max(40), workspace: z.strictObject({ name: z.string().max(240) }),
  files: z.array(z.strictObject({ path: z.string().max(200), size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(1000000) });
