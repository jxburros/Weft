import { z } from 'zod';
import { inspectExportResidue } from './export-safety.js';

const id = z.string().min(1).max(128);
const pluginName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).describe('Plugin name from plugins.list.');
const handler = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Plugin administration and core commands whose output comes from a named hook. */
export const pluginCommandAdminDefinitions = {
  'plugins.list': ['List built-in and discovered third-party plugins with permissions, hooks, scope and status; never runs plugin code', {}],
  'plugins.enable': ['Human enables a plugin; third-party grants bind the reviewed manifest and code digests', {
    name: pluginName, manifestSha256: digest.optional().describe('Manifest digest shown by plugins.list (required for third-party plugins).'),
    codeSha256: digest.optional().describe('Code digest shown by plugins.list (required for third-party plugins).'),
    allowAutomation: z.boolean().default(false).describe('Also let automation callers use this third-party plugin; off by default.'),
  }],
  'plugins.disable': ['Human disables a plugin or revokes a third-party grant; running plugin processes are terminated', { name: pluginName }],
  'plugins.invoke': ['Run a read-only command of an enabled third-party plugin in its sandbox; result is untrusted data', {
    name: pluginName, operation: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/).describe('Operation listed for the plugin.'),
    args: z.record(z.string().max(40), z.unknown()).default({}).describe('Arguments validated against the plugin operation schema.'), workspaceId: id.optional(),
  }],
  'workspaces.exportAs': ['Human exports workspace records through an export-format plugin (formats in plugins.list)', {
    id, format: handler.describe('Export format id, for example markdown.'), sensitiveTerms: z.array(z.string().min(1).max(200)).max(100).optional(),
    acknowledgePlaintext: z.boolean().optional().describe('Required when the profile is encrypted: the person confirmed that this export is plaintext.'),
  }],
  'artifacts.render': ['Render one immutable capture version through a capture-format plugin as untrusted derived text', {
    id, versionId: id.optional(), format: handler.describe('Capture format id, for example markdown.'),
  }],
  'activity.report': ['Render attributable workspace activity through an activity-report plugin', {
    workspaceId: id.optional(), format: handler.describe('Report format id, for example markdown.'), limit: z.number().int().min(1).max(1000).optional(),
  }],
  'page.extract': ['Extract untrusted items with exact text offsets from a readable page snapshot through a page-extract plugin', {
    tabId: z.number().int().positive().optional(), workspaceId: id.optional(), extractor: handler.describe('Extractor id, for example citations.'),
  }],
};

const provenance = provider => ({ plugin: provider.plugin, version: provider.version, builtin: provider.builtin, handler: provider.id });

/**
 * Core side of the hook points. Inputs are gathered through `call`, which
 * re-enters the dispatcher with the caller's own authority, so a plugin never
 * sees data its caller could not read.
 */
export async function executeHookCommand(name, args, context, { plugins, call }) {
  if (name === 'workspaces.exportAs') {
    if (!['human', 'admin'].includes(context.actor)) throw Object.assign(new Error('PERMISSION_REQUIRED: workspace export requires human administration'), { code: 'permission_required' });
    const provider = plugins.first('export-format', args.format, context);
    const snapshot = await call('workspaces.export', { id: args.id, ...(args.acknowledgePlaintext === true && { acknowledgePlaintext: true }) });
    const rendered = await provider.run(snapshot);
    const result = { format: args.format, mimeType: rendered.mimeType, extension: rendered.extension, content: rendered.content, workspaceId: args.id,
      exclusions: [...rendered.exclusions, ...snapshot.limitations], provenance: provenance(provider) };
    if (args.sensitiveTerms) result.residueScan = inspectExportResidue(JSON.stringify({ content: rendered.content }), args.sensitiveTerms);
    return result;
  }
  if (name === 'artifacts.render') {
    const provider = plugins.first('capture-format', args.format, context);
    const artifact = await call('artifacts.get', { id: args.id });
    const version = args.versionId ? artifact.versions.find(item => item.id === args.versionId) : artifact.versions.at(-1);
    if (!version) throw Object.assign(new Error('Artifact version not found'), { code: 'not_found' });
    const rendered = await provider.run({ artifactId: artifact.id, workspaceId: artifact.workspaceId, versionId: version.id, number: version.number, title: version.title || artifact.title,
      url: version.url ?? null, createdAt: version.createdAt, method: version.method, text: version.text ?? null, components: version.components ?? [], limitations: version.limitations ?? [] });
    return { ...rendered, artifactId: artifact.id, versionId: version.id, workspaceId: artifact.workspaceId, untrusted: true,
      limitations: ['Derived rendering of untrusted capture text; the immutable capture version remains the evidence.', ...(version.pngBase64 ? ['Image components are not passed to plugins and are not rendered.'] : [])], provenance: provenance(provider) };
  }
  if (name === 'activity.report') {
    const provider = plugins.first('activity-report', args.format, context);
    const workspace = await call('workspaces.get', { id: args.workspaceId });
    // Durable activity is read page by page through the gated activity.list (200 per page), newest first.
    const wanted = args.limit ?? 200;
    const events = [];
    let cursor;
    do {
      const page = await call('activity.list', { workspaceId: workspace.id, limit: Math.min(200, wanted - events.length), ...(cursor && { cursor }) });
      events.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && events.length < wanted);
    const describe = entry => [entry.outcome, entry.decision, entry.reason, entry.actionClass].filter(Boolean).join(' · ') + (entry.detail ? ` — ${entry.detail}` : '');
    const rendered = await provider.run({ workspace: { id: workspace.id, name: workspace.name }, generatedAt: new Date().toISOString(),
      events: events.map(event => ({ id: event.id, action: `${event.type}${event.command ? ` ${event.command}` : ''}`, actor: String(event.actor ?? 'unknown').slice(0, 200),
        targetId: event.targetId ?? null, detail: describe(event).slice(0, 20000), createdAt: event.at })) });
    return { ...rendered, workspaceId: workspace.id, eventIds: events.map(event => event.id), provenance: provenance(provider) };
  }
  if (name === 'page.extract') {
    const provider = plugins.first('page-extract', args.extractor, context);
    const snapshot = await call('page.readable', { tabId: args.tabId, workspaceId: args.workspaceId });
    const input = { url: String(snapshot.url).slice(0, 16384), title: String(snapshot.title).slice(0, 1000), text: String(snapshot.text).slice(0, 500000), links: (snapshot.links ?? []).slice(0, 100) };
    const { items } = await provider.run(input);
    // Every item must quote the snapshot exactly at its stated offsets.
    for (const item of items) if (item.end <= item.start || item.end > input.text.length || input.text.slice(item.start, item.end) !== item.text) {
      throw Object.assign(new Error(`Plugin ${provider.plugin} returned an item whose text does not match its source offsets`), { code: 'command_failed' });
    }
    return { url: input.url, title: input.title, tabId: args.tabId, workspaceId: args.workspaceId, extractor: args.extractor, items, untrusted: true, provenance: provenance(provider) };
  }
  throw Object.assign(new Error(`Unknown hook command ${name}`), { code: 'unknown_command' });
}
