import { z } from 'zod';

const id = z.string().min(1).max(128);
const text = z.string().max(500000);
const title = z.string().trim().min(1).max(240);
const optionalWorkspace = { workspaceId: id.optional() };
const httpUrl = z.string().max(16384).refine(value => {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}, 'Expected HTTP(S) URL without credentials');
const references = z.array(id).max(1000);
const tags = z.array(z.string().max(100)).max(100);
export const recordShapes = {
  materials: { title, localOnly: z.boolean().default(false), kind: z.enum(['note', 'website', 'file', 'linked-file', 'service']).default('note'), content: text.default(''), url: httpUrl.nullable().optional(), filename: z.string().max(255).optional(), mimeType: z.string().max(128).optional(), fileBase64: z.string().max(14000000).optional(), note: text.optional(), tags: tags.default([]), pinned: z.boolean().default(false) },
  context: { title, localOnly: z.boolean().default(false), content: text.default(''), category: z.enum(['confirmed', 'findings', 'questions', 'instructions', 'decisions']).default('findings'), sources: z.array(z.string().max(16384)).max(100).default([]), tags: tags.default([]) },
  tasks: { title, objective: text.default(''), status: z.enum(['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']).default('queued'), assignee: z.string().max(200).default('human'), progress: z.number().min(0).max(100).default(0), blocker: text.default(''), checkpoint: text.default(''), nextStep: text.default(''), evidence: references.default([]), materialIds: references.default([]), tabIds: z.array(z.number().int().positive()).max(100).default([]), outputs: references.default([]) },
  conversations: { title: title.default('New conversation') },
  workflows: { title, enabled: z.boolean().default(true), description: text.default(''), parameters: z.array(z.string().max(200)).max(100).default([]), steps: z.array(z.strictObject({ title, instruction: text, reviewRequired: z.boolean().default(true) })).max(100).default([]), allowedSites: z.array(z.string().max(255)).max(100).default([]), materialIds: references.default([]), expectedOutputs: text.default('') },
  siteRules: { enabled: z.boolean().default(true), hostname: z.string().trim().min(1).max(253), includeSubdomains: z.boolean().default(true), path: z.string().max(2048).default('/'), behavior: z.enum(['block', 'warn']).default('block'), mode: z.enum(['navigation', 'connection']).default('navigation'), reason: z.string().max(240).default('Personal preference'), note: text.default(''), scope: z.enum(['workspace', 'global']).default('workspace') },
};
export const modelShape = { provider: z.string().max(100).optional(), endpoint: httpUrl.optional(), model: z.string().max(200).optional() };
export const commandDefinitions = {
  'history.list': ['List recent workspace visits', { ...optionalWorkspace, limit: z.number().int().min(1).max(500).optional() }],
  'history.clear': ['Clear workspace browsing history (human only)', optionalWorkspace],
  'bookmarks.list': ['List pinned website materials', optionalWorkspace],
  'bookmarks.create': ['Bookmark a website as a pinned material', { ...optionalWorkspace, title, url: httpUrl }],
  'bookmarks.delete': ['Delete a bookmarked website material', { id }],
  'workspace.snapshot': ['Get persistent workspace state', optionalWorkspace],
  'workspaces.list': ['List workspaces', {}],
  'workspaces.get': ['Get one workspace', { id }],
  'workspaces.create': ['Create an empty workspace', { name: title, description: text.optional(), color: z.string().max(30).optional(), icon: z.string().max(50).optional() }],
  'workspaces.update': ['Update workspace details', { id, changes: z.strictObject({ name: title.optional(), description: text.optional(), color: z.string().max(30).optional(), icon: z.string().max(50).optional() }), expectedRevision: z.number().int().optional() }],
  'workspaces.switch': ['Switch active workspace', { id }],
  'workspaces.archive': ['Archive a workspace without deleting its contents', { id }],
  'workspaces.restore': ['Restore an archived workspace', { id }],
  'workspaces.duplicate': ['Copy project records; exclude sessions and credentials', { id, name: title.optional() }],
  'workspaces.delete': ['Permanently delete a workspace and its saved records', { id }],
  'workspaces.export': ['Export project records with optional exact-term residue scan; images are unverifiable', { id, sensitiveTerms: z.array(z.string().min(1).max(200)).max(100).optional() }],
  'workspaces.import': ['Import a versioned project export as a new workspace', { data: z.unknown() }],
  'settings.get': ['Get non-secret application preferences', {}],
  'settings.update': ['Update application preferences; credentials are not accepted', { theme: z.enum(['system', 'light', 'dark']).optional(), model: z.strictObject(modelShape).optional(), sidebarCollapsed: z.boolean().optional(), agentPanelOpen: z.boolean().optional(),
    automation: z.strictObject({ inputConcurrency: z.enum(['shared', 'exclusive']).optional().describe('shared lets agents act on available tabs; exclusive requires a lease.'),
      queueLimit: z.number().int().min(0).max(20).optional().describe('Agent input requests that may wait per tab; 0 rejects busy tabs immediately.'),
      queueTimeoutMs: z.number().int().min(0).max(60000).optional().describe('Longest wait for a queued input request.') }).optional().describe('Multi-agent input serialization settings.') }],
  'activity.list': ['List attributable activity', { ...optionalWorkspace, limit: z.number().int().min(1).max(1000).optional() }],
  'search.query': ['Search project records and saved text locally', { ...optionalWorkspace, query: z.string().max(1000), limit: z.number().int().min(1).max(200).optional() }],
  'conversations.message': ['Append a durable conversation message', { id, localOnly: z.boolean().optional(), role: z.enum(['user', 'assistant', 'system', 'tool']), content: text, model: z.string().max(200).optional(), status: z.enum(['complete', 'interrupted', 'error']).optional(), attachments: references.optional() }],
  'tasks.transition': ['Change task state and record the cause', { id, status: recordShapes.tasks.status.removeDefault(), cause: z.string().max(2000).optional(), checkpoint: text.optional() }],
  'artifacts.list': ['List saved artifact metadata', optionalWorkspace],
  'artifacts.get': ['Read an offline artifact or exact immutable version', { id, versionId: id.optional() }],
  'artifacts.capture': ['Save page text and/or PNG as an immutable offline reference', { ...optionalWorkspace, tabId: z.number().int().positive().optional(), artifactId: id.optional(), title: title.optional(), note: text.optional(), tags: tags.optional(), kind: z.enum(['bundle', 'text', 'screenshot']).default('bundle') }],
  'artifacts.create': ['Save supplied text or PNG as an untrusted offline artifact', { ...optionalWorkspace, artifactId: id.optional(), title, text: text.optional(), pngBase64: z.string().max(28000000).optional(), url: httpUrl.optional(), note: text.optional(), tags: tags.optional() }],
  'artifacts.annotate': ['Append a revision of artifact notes and tags', { id, note: text, tags: tags.optional() }],
  'artifacts.delete': ['Permanently delete a saved artifact and every version', { id }],
};
for (const [collection, shape] of Object.entries(recordShapes)) {
  commandDefinitions[`${collection}.list`] = [`List ${collection}`, optionalWorkspace];
  commandDefinitions[`${collection}.get`] = [`Get ${collection} record`, { id }];
  commandDefinitions[`${collection}.create`] = [`Create ${collection} record`, { ...optionalWorkspace, ...shape }];
  commandDefinitions[`${collection}.update`] = [`Update ${collection} with optional revision check`, { id, changes: z.strictObject(Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, field.removeDefault ? field.removeDefault().optional() : field.optional()]))), expectedRevision: z.number().int().positive().optional() }];
  commandDefinitions[`${collection}.delete`] = [`Delete ${collection} record`, { id }];
}
export const workspaceSchemas = Object.fromEntries(Object.entries(commandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
