import { z } from 'zod';

/** Plugin contract shared by built-in and third-party plugins. Data only: no imports of core services. */
export const PLUGIN_API_VERSION = 1;
// Ordered by restrictiveness; the last entry maps to the authority layer's 'unclassified' (exact approval for every use).
const ACTION_ORDER = ['local_read', 'external_read', 'local_write', 'external_write', 'code_exec', 'cloud_spend', 'administration', 'unclassified'];
const text = (max, min = 0) => z.string().min(min).max(max);
const bytes = 4 * 1024 * 1024;

/**
 * Named hook points. Core code invokes these only through the registry. Each
 * provider declares handler ids per point; keyed points are selected by id
 * (a format or extractor name) and observers (after-command) all receive the event.
 */
export const HOOK_POINTS = Object.freeze({
  'capture-format': {
    permission: 'workspaceRead', keyed: true,
    signature: '(capture: {artifactId, workspaceId, versionId, number, title, url, createdAt, method, text, components, limitations}) => {mimeType, content}',
    description: 'Render one authorized, immutable capture version as derived text. Images are never passed.',
    input: z.strictObject({ artifactId: text(200), workspaceId: text(200), versionId: text(200), number: z.number().int().positive(), title: text(1000), url: text(16384).nullable(), createdAt: text(64), method: text(64),
      text: text(2000000).nullable(), components: z.array(z.strictObject({ type: text(100), size: z.number().int().min(0), sha256: text(64) })).max(10), limitations: z.array(text(2000)).max(50) }),
    output: z.strictObject({ mimeType: z.enum(['text/markdown', 'text/plain', 'text/csv']), content: text(bytes) }),
  },
  'page-extract': {
    permission: 'pageRead', keyed: true,
    signature: '(snapshot: {url, title, text, links: [{text, url}]}) => {items: [{kind, text, start, end}]}',
    description: 'Extract untrusted items from a bounded readable page snapshot; every item cites exact text offsets.',
    input: z.strictObject({ url: text(16384), title: text(1000), text: text(500000), links: z.array(z.strictObject({ text: text(200), url: text(16384) })).max(100) }),
    output: z.strictObject({ items: z.array(z.strictObject({ kind: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), text: text(2000), start: z.number().int().min(0), end: z.number().int().min(0) })).max(1000) }),
  },
  'after-command': {
    permission: null, keyed: false,
    signature: '(event: {command, actor, status, workspaceId, actionClass, createdAt}) => void',
    description: 'Observe sanitized metadata after a command completes. Return values are ignored; results cannot be changed.',
    input: z.strictObject({ command: text(200), actor: text(64), status: z.enum(['success', 'failure']), workspaceId: text(200).nullable(), actionClass: text(40), createdAt: text(64) }),
    output: z.unknown(),
  },
  'activity-report': {
    permission: 'workspaceRead', keyed: true,
    signature: '(activity: {workspace: {id, name}, generatedAt, events: [{id, action, actor, targetId, detail, createdAt}]}) => {mimeType, content}',
    description: 'Render authorized, filtered workspace activity; reports must cite event ids.',
    input: z.strictObject({ workspace: z.strictObject({ id: text(200), name: text(240) }), generatedAt: text(64), events: z.array(z.strictObject({ id: text(200), action: text(200), actor: text(200), targetId: text(200).nullable(), detail: text(20000), createdAt: text(64) })).max(1000) }),
    output: z.strictObject({ mimeType: z.enum(['text/markdown', 'text/plain', 'text/csv']), content: text(bytes) }),
  },
  'export-format': {
    permission: 'workspaceRead', keyed: true,
    signature: '(snapshot: weft-workspace export object) => {mimeType, extension, content, exclusions: string[]}',
    description: 'Render an authorized workspace export snapshot. Plugins must list what they omit; core limitations are always appended.',
    input: z.looseObject({ format: z.literal('weft-workspace'), workspace: z.looseObject({ id: text(200), name: text(240) }) }),
    output: z.strictObject({ mimeType: z.enum(['text/markdown', 'text/plain', 'text/csv', 'application/json']), extension: z.string().regex(/^[a-z0-9]{1,10}$/), content: text(bytes), exclusions: z.array(text(2000)).max(100) }),
  },
});
export const HOOK_NAMES = Object.freeze(Object.keys(HOOK_POINTS));

const pluginName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'Plugin names use 2-40 lowercase letters, digits or hyphens');
const operation = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/, 'Operations are camelCase identifiers');
const handlerId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const permissions = z.strictObject({
  workspaceRead: z.boolean().default(false), pageRead: z.boolean().default(false),
  workspaceWrite: z.boolean().default(false), origins: z.array(z.string().max(300)).max(50).default([]), nativeAccess: z.boolean().default(false),
});
const hooks = z.strictObject(Object.fromEntries(HOOK_NAMES.map(name => [name, z.array(handlerId).min(1).max(10).optional()])));
const base = {
  name: pluginName, version: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/, 'Expected a semantic version such as 1.0.0'),
  apiVersion: z.literal(PLUGIN_API_VERSION), description: text(500, 1), permissions: permissions.default({}),
  hooks: hooks.default({}), requires: z.array(pluginName).max(10).default([]),
};
const zodType = z.custom(value => value instanceof z.ZodType, 'Built-in command inputs must be zod schemas');
const builtinManifest = z.strictObject({ ...base, commands: z.record(operation, z.strictObject({
  description: text(300, 1), actionClass: z.enum(ACTION_ORDER.slice(0, -1)), input: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), zodType),
})).default({}) });

// Third-party command inputs are a bounded JSON-schema subset. Patterns are
// refused (ReDoS); every string/array needs an explicit maximum.
const jsonField = z.lazy(() => z.union([
  z.strictObject({ type: z.literal('string'), description: text(300).optional(), minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(1).max(100000), enum: z.array(text(200)).min(1).max(100).optional() }),
  z.strictObject({ type: z.enum(['number', 'integer']), description: text(300).optional(), minimum: z.number().optional(), maximum: z.number().optional() }),
  z.strictObject({ type: z.literal('boolean'), description: text(300).optional() }),
  z.strictObject({ type: z.literal('array'), description: text(300).optional(), items: jsonField, maxItems: z.number().int().min(1).max(1000) }),
]));
const jsonInput = z.strictObject({ type: z.literal('object'), properties: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), jsonField).refine(value => Object.keys(value).length <= 30, 'At most 30 fields'), required: z.array(text(40)).max(30).default([]), additionalProperties: z.literal(false) });
export const READABLE_COLLECTIONS = Object.freeze(['materials', 'context', 'tasks', 'artifacts', 'activity']);
const externalManifest = z.strictObject({ ...base, commands: z.record(operation, z.strictObject({
  description: text(300, 1), actionClass: z.literal('local_read', { error: 'Third-party plugin commands are read-only (local_read); no write, network or native capability exists' }),
  input: jsonInput, reads: z.array(z.enum(READABLE_COLLECTIONS)).max(READABLE_COLLECTIONS.length).default([]),
})).refine(value => Object.keys(value).length <= 20, 'At most 20 commands').default({}) });

export class ManifestError extends Error {
  constructor(name, problems) { super(`Plugin manifest${name ? ` ${name}` : ''} refused: ${problems.join('; ')}`); this.code = 'invalid_arguments'; this.problems = problems; }
}
const zodProblems = error => error.issues?.map(issue => `${issue.path.join('.') || 'manifest'}: ${issue.message}`) ?? [error.message];

/** Declared capability problems are refusals, not silently dropped privileges. */
function policyProblems(manifest) {
  const problems = [];
  const p = manifest.permissions;
  if (p.workspaceWrite) problems.push('permissions.workspaceWrite: unsupported; plugins have no workspace write capability');
  if (p.origins.length) problems.push('permissions.origins: denied; plugins have no network egress capability');
  if (p.nativeAccess) problems.push('permissions.nativeAccess: denied; plugins never receive filesystem, process, Electron or credential access');
  for (const [point, ids] of Object.entries(manifest.hooks)) {
    const needed = HOOK_POINTS[point].permission;
    if (needed && !p[needed]) problems.push(`hooks.${point}: requires permissions.${needed}`);
    if (new Set(ids).size !== ids.length) problems.push(`hooks.${point}: duplicate handler id`);
  }
  for (const [op, command] of Object.entries(manifest.commands)) {
    if (command.reads?.length && !p.workspaceRead) problems.push(`commands.${op}.reads: requires permissions.workspaceRead`);
    for (const key of command.input.required ?? []) if (!Object.hasOwn(command.input.properties, key)) problems.push(`commands.${op}.input.required: unknown field ${key}`);
    if (Object.hasOwn(command.input, 'workspaceId') || Object.hasOwn(command.input.properties ?? {}, 'workspaceId')) problems.push(`commands.${op}.input.workspaceId: reserved; the core supplies the authorized workspace`);
  }
  if (manifest.requires.includes(manifest.name)) problems.push('requires: a plugin cannot require itself');
  return problems;
}

export function validateManifest(input, { builtin = false } = {}) {
  let manifest;
  try { manifest = (builtin ? builtinManifest : externalManifest).parse(input); }
  catch (error) { throw new ManifestError(typeof input?.name === 'string' ? input.name.slice(0, 40) : '', zodProblems(error)); }
  const problems = policyProblems(manifest);
  if (problems.length) throw new ManifestError(manifest.name, problems);
  return manifest;
}

/** The most restrictive of the declared class and what declared permissions imply feeds the autonomy gate. */
export function effectiveActionClass(manifest, operationName) {
  const declared = manifest.commands[operationName]?.actionClass ?? 'unclassified';
  const p = manifest.permissions;
  const implied = p.nativeAccess || p.origins.length ? 'unclassified' : p.workspaceWrite ? 'local_write' : p.pageRead ? 'external_read' : 'local_read';
  return ACTION_ORDER[Math.max(ACTION_ORDER.indexOf(declared), ACTION_ORDER.indexOf(implied))];
}

/** Authority data classes a plugin command can disclose, derived from its declared permissions and hooks. */
export function pluginDataClasses(manifest, operationName = null) {
  const p = manifest.permissions;
  const reads = operationName ? manifest.commands[operationName]?.reads ?? [] : [];
  return [...new Set([
    ...(p.workspaceRead ? ['workspace_records'] : []), ...(p.pageRead ? ['page_content'] : []),
    ...(manifest.hooks['after-command'] || reads.includes('activity') ? ['activity'] : []),
  ])];
}

/** Human-readable scope shown before enablement. */
export function describeScope(manifest) {
  const p = manifest.permissions;
  return [
    p.workspaceRead ? 'Reads records of the workspace a command or hook targets (never other workspaces)' : 'No workspace record access',
    p.pageRead ? 'Reads the bounded readable text of a page a person or agent explicitly targets' : 'No page access',
    'No workspace writes, network access, credentials, cookies, files, processes or Electron APIs',
    ...Object.entries(manifest.hooks).map(([point, ids]) => `Hook ${point}: ${ids.join(', ')}`),
    ...Object.keys(manifest.commands).map(op => `Command plugin.${manifest.name}.${op} (${effectiveActionClass(manifest, op)})`),
  ];
}

/** Restricted JSON schema → strict zod. Only the subset accepted by externalManifest exists. */
export function zodFromJsonInput(schema) {
  const field = spec => {
    let value;
    if (spec.type === 'string') {
      value = spec.enum ? z.enum(spec.enum) : z.string().max(spec.maxLength);
      if (!spec.enum && spec.minLength != null) value = value.min(spec.minLength);
    } else if (spec.type === 'number' || spec.type === 'integer') {
      value = spec.type === 'integer' ? z.number().int() : z.number();
      if (spec.minimum != null) value = value.min(spec.minimum);
      if (spec.maximum != null) value = value.max(spec.maximum);
    } else if (spec.type === 'boolean') value = z.boolean();
    else value = z.array(field(spec.items)).max(spec.maxItems);
    return spec.description ? value.describe(spec.description) : value;
  };
  return z.strictObject(Object.fromEntries(Object.entries(schema.properties).map(([key, spec]) => [key, schema.required.includes(key) ? field(spec) : field(spec).optional()])));
}
