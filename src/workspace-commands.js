import { z } from 'zod';
import { citationInput, originInput } from './provenance.js';
import { pageField } from './pagination.js';
import { PHASES } from './task-phases.js';
import { taskPlan, workflowParameter, workflowStep, credentialRef } from './task-commands.js';
import { resourceSettingsShape } from './resources.js';

const id = z.string().min(1).max(128);
const text = z.string().max(500000);
const title = z.string().trim().min(1).max(240);
export const workspaceDetails = { instructions: z.string().max(20000).optional(), memory: z.string().max(50000).optional(), contextLocalOnly: z.boolean().optional(), workspaceType: z.enum(['general', 'project']).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() };
const optionalWorkspace = { workspaceId: id.optional() };
const httpUrl = z.string().max(16384).refine(value => {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}, 'Expected HTTP(S) URL without credentials');
const references = z.array(id).max(1000);
const reviewDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD review date');
const tags = z.array(z.string().max(100)).max(100);
const redactionLabel = z.string().max(60).optional();
const redactionSelector = z.strictObject({ start: z.number().int().min(0).optional(), end: z.number().int().min(0).optional(), literal: z.string().min(1).max(10000).optional(), caseSensitive: z.boolean().optional(),
  pattern: z.string().min(1).max(500).optional(), flags: z.string().regex(/^[imsu]{0,4}$/).optional(), detector: z.enum(['email', 'phone', 'payment-card', 'api-key', 'jwt']).optional(), label: redactionLabel })
  .refine(value => [value.start !== undefined || value.end !== undefined, value.literal !== undefined, value.pattern !== undefined, value.detector !== undefined].filter(Boolean).length === 1
    && ((value.start === undefined) === (value.end === undefined)), 'Use exactly one of {start,end}, literal, pattern or detector');
const redactionRegion = z.strictObject({ x: z.number().min(0).max(100000), y: z.number().min(0).max(100000), width: z.number().min(1).max(100000), height: z.number().min(1).max(100000), label: redactionLabel });
export const capturePolicy = z.enum(['exclude-restricted', 'derivatives-only', 'all']).describe('exclude-restricted (default) leaves restricted originals out; derivatives-only exports only sanitized derivative versions; all includes restricted originals.');
export const finishReason = z.enum(['stop', 'length', 'content_filter', 'other', 'cancelled', 'timeout', 'emergency_stop', 'disconnected']);
export const recordShapes = {
  memories: { title, content: z.string().max(4000), localOnly: z.boolean().default(true), scope: z.enum(['workspace', 'global']).default('workspace'), sources: z.array(z.string().max(1000)).max(20).default([]), origin: originInput.optional() },
  materials: { title, localOnly: z.boolean().default(false), kind: z.enum(['note', 'website', 'file', 'linked-file', 'linked-folder', 'service']).default('note'), content: text.default(''), url: httpUrl.nullable().optional(), filename: z.string().max(255).optional(), mimeType: z.string().max(128).optional(), fileBase64: z.string().max(14000000).optional(), note: text.optional(), tags: tags.default([]), pinned: z.boolean().default(false), origin: originInput.optional() },
  context: { title, localOnly: z.boolean().default(false), content: text.default(''), category: z.enum(['confirmed', 'findings', 'questions', 'instructions', 'decisions']).default('findings'), sources: z.array(z.string().max(16384)).max(100).default([]), tags: tags.default([]),
    citations: z.array(citationInput).max(50).default([]).describe('Exact citations (capture versions with quote selectors, record revisions or linked source versions); on update they are appended.'), origin: originInput.optional() },
  tasks: { title, objective: text.default(''), status: z.enum(PHASES).default('queued'), assignee: z.string().max(200).default('human'), progress: z.number().min(0).max(100).default(0), blocker: text.default(''), checkpoint: text.default(''), nextStep: text.default(''), evidence: references.default([]), materialIds: references.default([]), tabIds: z.array(z.number().int().positive()).max(100).default([]), outputs: references.default([]),
    plan: taskPlan.default([]).describe('Executable steps; run with tasks.start. Creating or saving a plan never runs it.'), modelId: id.nullable().optional().describe('Default model connection for model steps.') },
  conversations: { title: title.default('New conversation') },
  workflows: { title, watch: z.strictObject({ url: httpUrl, intervalMinutes: z.number().int().min(1).max(10080).default(5), cooldownMinutes: z.number().int().min(1).max(10080).default(5), contains: z.string().max(1000).optional() }).nullable().optional(), enabled: z.boolean().default(true), description: text.default(''), parameters: z.array(workflowParameter).max(100).default([]), steps: z.array(workflowStep).max(100).default([]), credentialRefs: z.array(credentialRef).max(50).default([]).describe('Opaque credential broker references; never secret values.'), allowedSites: z.array(z.string().max(255)).max(100).default([]), materialIds: references.default([]), expectedOutputs: text.default('') },
  siteRules: { enabled: z.boolean().default(true), hostname: z.string().trim().min(1).max(253), includeSubdomains: z.boolean().default(true), path: z.string().max(2048).default('/'), behavior: z.enum(['block', 'warn']).default('block'), mode: z.enum(['navigation', 'connection']).default('navigation'), reason: z.string().max(240).default('Personal preference'), note: text.default(''), scope: z.enum(['workspace', 'global']).default('workspace'), evidence: z.array(httpUrl).max(20).default([]), reviewBy: reviewDate.nullable().optional() },
};
export const modelShape = { provider: z.string().max(100).optional(), endpoint: httpUrl.optional(), model: z.string().max(200).optional() };
export const commandDefinitions = {
  'learning.status': ['Human reviews background learning configuration, progress and learned memory', optionalWorkspace],
  'learning.configure': ['Human opts into bounded background learning from saved materials, context, tasks and conversations; shared memory applies across workspaces', { ...optionalWorkspace, enabled: z.boolean(), modelId: id.optional(), global: z.boolean().default(false), acknowledgeEgress: z.boolean().optional() }],
  'learning.erase': ['Erase learned memory and pause learning; existing source fingerprints remain suppressed', { ...optionalWorkspace, scope: z.enum(['workspace', 'global', 'all']) }],
  'history.list': ['List recent workspace visits', { ...optionalWorkspace, limit: z.number().int().min(1).max(500).optional() }],
  'history.clear': ['Clear workspace browsing history (human only)', optionalWorkspace],
  'bookmarks.list': ['List pinned website materials', optionalWorkspace],
  'bookmarks.create': ['Bookmark a website as a pinned material', { ...optionalWorkspace, title, url: httpUrl }],
  'bookmarks.delete': ['Delete a bookmarked website material', { id }],
  'workspace.snapshot': ['Get persistent workspace state', optionalWorkspace],
  'workspaces.list': ['List workspaces', {}],
  'workspaces.get': ['Get one workspace', { id }],
  'workspaces.create': ['Create an empty workspace', { ...workspaceDetails, name: title, description: text.optional(), color: z.string().max(30).optional(), icon: z.string().max(50).optional() }],
  'workspaces.update': ['Update workspace details', { id, changes: z.strictObject({ ...workspaceDetails, name: title.optional(), description: text.optional(), color: z.string().max(30).optional(), icon: z.string().max(50).optional() }), expectedRevision: z.number().int().optional() }],
  'workspaces.switch': ['Switch active workspace', { id }],
  'workspaces.archive': ['Archive a workspace without deleting its contents', { id }],
  'workspaces.restore': ['Restore an archived workspace', { id }],
  'workspaces.duplicate': ['Copy project records; exclude sessions and credentials', { id, name: title.optional() }],
  'workspaces.delete': ['Permanently delete a workspace and its saved records', { id }],
  'workspaces.export': ['Export project records with optional exact-term residue scan and metadata review; images are unverifiable', { id, sensitiveTerms: z.array(z.string().min(1).max(200)).max(100).optional(), captures: capturePolicy.optional(),
    acknowledgePlaintext: z.boolean().optional().describe('Required when the profile is encrypted: the person confirmed that this export is written as plaintext.'),
    reviewMetadata: z.boolean().optional().describe('Add a review of URL query/path metadata and detection-assistance matches in exported fields.') }],
  'workspaces.import': ['Import a versioned project export as a new workspace', { data: z.unknown() }],
  'settings.get': ['Get non-secret application preferences', {}],
  'settings.update': ['Update application preferences; credentials are not accepted', { theme: z.enum(['system', 'light', 'dark']).optional(), appearance: z.strictObject({ accent: z.enum(['plum', 'ocean', 'forest', 'rose']).optional(), density: z.enum(['comfortable', 'compact']).optional(), textScale: z.number().min(0.85).max(1.3).optional() }).optional(), model: z.strictObject(modelShape).optional(), sidebarCollapsed: z.boolean().optional(), agentPanelOpen: z.boolean().optional(),
    automation: z.strictObject({ inputConcurrency: z.enum(['shared', 'exclusive']).optional().describe('shared lets agents act on available tabs; exclusive requires a lease.'),
      queueLimit: z.number().int().min(0).max(20).optional().describe('Agent input requests that may wait per tab; 0 rejects busy tabs immediately.'),
      queueTimeoutMs: z.number().int().min(0).max(60000).optional().describe('Longest wait for a queued input request.') }).optional().describe('Multi-agent input serialization settings.'),
    resources: resourceSettingsShape.optional() }],
  'search.query': ['Search project records and saved text locally (BM25, fused with opt-in local embeddings when enabled); page mode adds coverage and verified absence', { ...optionalWorkspace, query: z.string().max(1000), limit: z.number().int().min(1).max(200).optional(),
    passageChars: z.number().int().min(300).max(6000).optional().describe('Return a cited passage of this many characters instead of a short snippet.'),
    mode: z.enum(['auto', 'lexical', 'hybrid']).optional().describe('auto (default) fuses lexical and vector results when this workspace has embeddings enabled; lexical uses BM25 only; hybrid requires embeddings.') }],
  'search.status': ['Report lexical and optional embedding index coverage for a workspace, including background index rebuild progress', optionalWorkspace],
  'search.indexing': ['Human pauses or resumes the background full-text index rebuild; searches stay partial while it is paused', { ...optionalWorkspace,
    action: z.enum(['pause', 'resume']).describe('pause stops rebuilding after the current batch (a plaintext rebuild resumes at the next start); resume continues it.') }],
  'search.configureEmbeddings': ['Human enables or disables optional embeddings for a workspace using an existing model connection endpoint', { ...optionalWorkspace, enabled: z.boolean(),
    modelId: id.optional().describe('Existing model connection whose endpoint serves embeddings (Ollama /api/embed or OpenAI-compatible /embeddings).'),
    embeddingModel: z.string().trim().min(1).max(200).optional().describe('Embedding model name already available at that endpoint; Weft never downloads models.'),
    acknowledgeEgress: z.boolean().optional().describe('Required when the endpoint is not on this device: record text is sent to it for embedding.'),
    minSimilarity: z.number().min(0).max(1).optional().describe('Cosine similarity a vector match needs to count (default 0.35).') }],
  'search.reindex': ['Queue every record in a workspace for embedding and process the queue now', optionalWorkspace],
  'conversations.message': ['Append a durable conversation message', { id, localOnly: z.boolean().optional(), role: z.enum(['user', 'assistant', 'system', 'tool']), content: text, model: z.string().max(200).optional(), status: z.enum(['complete', 'interrupted', 'error']).optional(), attachments: references.optional(), turnId: id.optional(), finishReason: finishReason.optional(), continuable: z.boolean().optional() }],
  'tasks.transition': ['Change task state and record the cause', { id, status: recordShapes.tasks.status.removeDefault(), cause: z.string().max(2000).optional(), checkpoint: text.optional() }],
  'artifacts.list': ['List saved artifact metadata', optionalWorkspace],
  'artifacts.get': ['Read an offline artifact or exact immutable version', { id, versionId: id.optional() }],
  'artifacts.versions': ['List version metadata of one artifact in capture order, paged', { id, page: pageField.optional() }],
  'conversations.messages': ['List messages of one conversation in append order, paged', { id, page: pageField.optional() }],
  'artifacts.capture': ['Save page text, PNG and optionally a resource archive as an immutable offline version', { ...optionalWorkspace, tabId: z.number().int().positive().optional(), artifactId: id.optional(), title: title.optional(), note: text.optional(), tags: tags.optional(),
    kind: z.enum(['bundle', 'text', 'screenshot', 'archive']).default('bundle').describe('archive adds the serialized page and its resources as content-addressed components with a manifest.'),
    readyTimeoutMs: z.number().int().min(0).max(30000).optional().describe('archive: longest wait for the page to finish loading before capture (default 5000).'),
    maxDurationMs: z.number().int().min(1000).max(120000).optional().describe('archive: overall capture time limit (default 30000); a capture that runs out is saved as incomplete.'),
    maxResourceBytes: z.number().int().min(1024).max(32 * 1024 * 1024).optional().describe('archive: largest single resource stored (default 8 MiB); larger ones are listed as omitted.') }],
  'artifacts.create': ['Save supplied text or PNG as an untrusted offline artifact', { ...optionalWorkspace, artifactId: id.optional(), title, text: text.optional(), pngBase64: z.string().max(28000000).optional(), url: httpUrl.optional(), note: text.optional(), tags: tags.optional() }],
  'artifacts.annotate': ['Append a revision of artifact notes and tags', { id, note: text, tags: tags.optional() }],
  'artifacts.delete': ['Permanently delete a saved artifact and every version', { id }],
  'artifacts.compare': ['Compare two versions of an artifact: readable-text diff, resource-list diff and optional pixel diff', { id, fromVersionId: id, toVersionId: id,
    pixels: z.boolean().optional().describe('Compare screenshots pixel by pixel when both versions have one (default true).'), diffImage: z.boolean().optional().describe('Include a PNG highlighting changed pixels.') }],
  'artifacts.verify': ['Re-verify the SHA-256 of every stored component of an artifact, or of one version', { id, versionId: id.optional() }],
  'artifacts.review': ['Review a version for sensitive URL, path, query, title and source metadata with optional pattern-detection assistance', { id, versionId: id }],
  'artifacts.redact': ['Create a sanitized derivative version: text spans and image regions removed; the original is kept unchanged', { id, versionId: id,
    text: z.array(redactionSelector).max(500).default([]).describe('Text to remove: {start,end} offsets, {literal}, {pattern,flags} or {detector}; each optional label is kept, the removed text never is.'),
    regions: z.array(redactionRegion).max(200).default([]).describe('Screenshot rectangles in image pixels whose pixels are replaced with black.'),
    image: z.enum(['redact', 'omit']).default('redact').describe('omit leaves the screenshot out of the derivative.'),
    url: z.enum(['keep', 'origin-path', 'origin', 'remove']).default('origin-path').describe('How much of the source URL the derivative keeps.'),
    title: title.optional().describe('Derivative title; by default the source title with the text redactions applied.'),
    inaccessibleRegions: z.array(redactionRegion).max(200).optional().describe('Areas to mark as not visible or not captured (metadata only).'),
    preview: z.boolean().optional().describe('Return the derivative content without saving it.') }],
  'artifacts.readOriginal': ['Read a restricted original version; agents need an exact one-time human approval and the restricted_original data class', { id, versionId: id }],
  'artifacts.setAccess': ['Human sets whether agents may read a version (restricted originals are withheld, unindexed and excluded from exports by default)', { id, versionId: id, access: z.enum(['restricted', 'standard']) }],
  'artifacts.purgeContent': ['Human permanently removes the stored content of one version, keeping its metadata and hashes', { id, versionId: id }],
  'artifacts.preview': ['Human opens an archived version in the offline preview (scripts, network, navigation and forms disabled)', { id, versionId: id }],
  'artifacts.closePreview': ['Human closes the offline archive preview', {}],
  'siteRules.review': ['Human records a site-rule review and optionally schedules the next review date', { id, reviewBy: reviewDate.optional(), note: z.string().max(2000).optional() }],
};
for (const [collection, shape] of Object.entries(recordShapes)) {
  commandDefinitions[`${collection}.list`] = [`List ${collection}`, optionalWorkspace];
  commandDefinitions[`${collection}.get`] = [`Get ${collection} record`, { id }];
  commandDefinitions[`${collection}.create`] = [`Create ${collection} record`, { ...optionalWorkspace, ...shape }];
  commandDefinitions[`${collection}.update`] = [`Update ${collection} with optional revision check`, { id, changes: z.strictObject(Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, field.removeDefault ? field.removeDefault().optional() : field.optional()]))), expectedRevision: z.number().int().positive().optional() }];
  commandDefinitions[`${collection}.delete`] = [`Delete ${collection} record`, { id, expectedRevision: z.number().int().positive().optional() }];
}
// Expected state where a write can race another writer: revision checks on transitions, annotations and deletions.
commandDefinitions['tasks.transition'][1] = { ...commandDefinitions['tasks.transition'][1], expectedRevision: z.number().int().positive().optional() };
commandDefinitions['artifacts.annotate'][1] = { ...commandDefinitions['artifacts.annotate'][1], expectedRevision: z.number().int().positive().optional() };
commandDefinitions['artifacts.delete'][1] = { ...commandDefinitions['artifacts.delete'][1], expectedRevision: z.number().int().positive().optional() };
// Additive pagination: `page` switches a collection result to {items, nextCursor, total}.
for (const name of ['history.list', 'bookmarks.list', 'workspaces.list', 'search.query', 'artifacts.list', ...Object.keys(recordShapes).map(collection => `${collection}.list`)]) {
  commandDefinitions[name][1] = { ...commandDefinitions[name][1], page: pageField.optional() };
}
const packageName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'Use 1-100 letters, digits, dots, dashes or underscores; no paths').refine(value => !value.includes('..'), 'Package names cannot contain ..');
const backupId = z.string().regex(/^\d{8}T\d{6}Z-(?:manual|automatic)-[0-9a-f]{8}$/, 'Expected a backup identifier from backups.list');
Object.assign(commandDefinitions, {
  'workspaces.exportPackage': ['Write a large-project package folder (records, exact components, manifest) under the profile transfers folder', { id, name: packageName, sensitiveTerms: z.array(z.string().min(1).max(200)).max(100).optional(), captures: capturePolicy.optional(),
    acknowledgePlaintext: z.boolean().optional().describe('Required when the profile is encrypted: the person confirmed that this export is written as plaintext.') }],
  'workspaces.importPackage': ['Verify and import a package folder from the profile transfers folder as a new workspace', { name: packageName }],
  'batch.execute': ['Apply up to 100 record commands all-or-nothing in one transaction; page, browser and workspace-lifecycle commands are rejected', { commands: z.array(z.strictObject({ command: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).default({}) })).min(1).max(100) }],
  'backups.create': ['Create a verified local backup of the database and stored components', { note: z.string().max(500).optional() }],
  'backups.list': ['List local backups and automatic backup policy', {}],
  'backups.verify': ['Recompute backup digests, database integrity and component completeness', { id: backupId }],
  'backups.restore': ['Restore a verified backup; current data is preserved in the profile recovery folder', { id: backupId }],
  'backups.delete': ['Delete one local backup folder', { id: backupId }],
});
// Request identity: a retried mutation with the same requestId replays the
// original committed result instead of applying twice.
export const requestIdField = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits, dots, dashes, colons or underscores');
export const idempotentCommands = Object.freeze(Object.keys(commandDefinitions).filter(name => /\.(create|update|delete|transition|message|annotate|capture|redact|archive|restore|duplicate|import|importPackage|clear|execute)$/.test(name) && !name.startsWith('backups.')));
export const dryRunCommands = Object.freeze(Object.keys(commandDefinitions).filter(name => /\.delete$/.test(name) && !name.startsWith('backups.')).concat('history.clear', 'workspaces.import', 'workspaces.importPackage', 'backups.restore', 'batch.execute', 'artifacts.purgeContent'));
// Shapes such as optionalWorkspace are shared between commands: copy before extending.
for (const name of idempotentCommands) commandDefinitions[name][1] = { ...commandDefinitions[name][1], requestId: requestIdField.optional() };
for (const name of dryRunCommands) commandDefinitions[name][1] = { ...commandDefinitions[name][1], dryRun: z.boolean().optional() };
export const workspaceSchemas = Object.fromEntries(Object.entries(commandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
