import { z } from 'zod';

/**
 * Domain events derived from final command outcomes (ADR 018). Every event is metadata only and
 * passes the server's field allowlist before retention or delivery; arguments, results, page
 * text, URLs, titles, model text and secrets never become event fields.
 */
const POLICY_COMMANDS = new Set(['siteRules.create', 'siteRules.update', 'siteRules.delete', 'siteRules.review', 'storage.setSiteMode', 'storage.setDefaultMode', 'storage.clear',
  'page.allowOnce', 'autonomy.update', 'clients.create', 'clients.update', 'clients.revoke', 'lists.install', 'lists.rollback', 'lists.subscribe', 'lists.update', 'lists.configure',
  'lists.exception', 'lists.unsubscribe', 'threats.install', 'threats.remove', 'threats.configureProvider', 'threats.update', 'extensions.install', 'extensions.enable', 'extensions.disable',
  'extensions.remove', 'plugins.enable', 'plugins.disable', 'downloads.configureScanner', 'downloads.approve', 'launches.approve', 'launches.deny', 'activity.configure', 'settings.update',
  'search.configureEmbeddings', 'tabs.setControlMode', 'browser.emergencyStop', 'browser.resumeAutomation', 'update.configure',
  'credentials.create', 'credentials.update', 'credentials.revoke', 'credentials.delete', 'credentials.grantTask', 'credentials.revokeGrant', 'credentials.configureProvider',
  'services.setCredential', 'services.revoke', 'freshness.configure']);
const WORKSPACE_COMMANDS = /^workspaces\.(create|update|archive|restore|duplicate|delete|import|importPackage|switch)$/;
const status = value => typeof value === 'string' && /^[a-z][a-z_]{0,31}$/.test(value) ? value : undefined;

function derive(command, result, base) {
  const events = [];
  // Phase changes (including tasks.transition and runtime steps) are published by the task runtime from each recorded
  // transition (ADR 016); outcomes add only creation, other edits and deletion so no change is published twice.
  if (/^tasks\.(create|update|delete)$/.test(command) && result?.id) {
    events.push({ ...base, type: 'task', command, taskId: result.id, status: { 'tasks.create': 'created', 'tasks.update': 'updated', 'tasks.delete': 'deleted' }[command], ...(Number.isSafeInteger(result.revision) && { revision: result.revision }),
      workspaceId: result.workspaceId ?? base.workspaceId });
  }
  if (/^artifacts\.(create|capture|annotate|delete)$/.test(command) && result?.id) {
    const latest = Array.isArray(result.versions) ? result.versions.at(-1) : null;
    // Archive captures (#16) report only whether the capture was complete; never URLs, resources or reasons.
    const archived = command === 'artifacts.capture' && latest?.capture ? (latest.capture.complete ? 'archive_saved' : 'archive_incomplete') : null;
    events.push({ ...base, type: 'artifact', command, artifactId: result.id, ...(latest?.id && { versionId: latest.id }), ...(Number.isSafeInteger(result.revision) && { revision: result.revision }),
      status: archived ?? { 'artifacts.create': 'version_saved', 'artifacts.capture': 'version_saved', 'artifacts.annotate': 'annotated', 'artifacts.delete': 'deleted' }[command], workspaceId: result.workspaceId ?? base.workspaceId });
  }
  // Redaction derivatives, access and retention decisions (#17): version identifiers only.
  if (command === 'artifacts.redact' && result?.id && result.derivative?.versionId) events.push({ ...base, type: 'artifact', command, artifactId: result.id, versionId: result.derivative.versionId, status: 'derivative_saved', workspaceId: result.workspaceId ?? base.workspaceId });
  if (['artifacts.setAccess', 'artifacts.purgeContent'].includes(command) && result?.id && result.versionId) {
    events.push({ ...base, type: 'artifact', command, artifactId: result.id, versionId: result.versionId, status: command === 'artifacts.purgeContent' ? 'content_purged' : result.access === 'restricted' ? 'restricted' : 'standard' });
  }
  // Shared collections (#21): lifecycle and grants, by collection identifier in the owner workspace.
  if (/^collections\.(create|update|delete|grant|revoke|addItem|removeItem)$/.test(command) && result?.id) {
    events.push({ ...base, type: 'collection', command, collectionId: result.id, status: { create: 'created', update: 'updated', delete: 'deleted', grant: 'granted', revoke: 'revoked', addItem: 'item_added', removeItem: 'item_removed' }[command.split('.')[1]],
      ...(Number.isSafeInteger(result.revision) && { revision: result.revision }), workspaceId: result.ownerWorkspaceId ?? base.workspaceId });
  }
  // Evidence conflicts (#66): opened and resolved, never their subjects' text.
  if (/^conflicts\.(create|resolve)$/.test(command) && result?.id) events.push({ ...base, type: 'conflict', command, conflictId: result.id, status: status(result.status), workspaceId: result.workspaceId ?? base.workspaceId });
  // Payments (#7, ADR 019): payment id and status only; never merchant, amounts, page text or card details.
  if (/^payments\.(propose|submit|cancel|reconcile|retry)$/.test(command) && typeof result?.id === 'string') {
    events.push({ ...base, type: 'payment', command, paymentId: result.id, status: status(result.status), workspaceId: result.workspaceId ?? base.workspaceId, ...(Number.isSafeInteger(result.tabId) && { tabId: result.tabId }) });
  }
  // Credential fills (#6): the sanitized fill status only; never the credential, origins, fields or page.
  if (command === 'credentials.fill' && result) events.push({ ...base, type: 'credential', command, status: status(result.status), ...(Number.isSafeInteger(result.tabId) && { tabId: result.tabId }) });
  if (POLICY_COMMANDS.has(command)) events.push({ ...base, type: 'policy', command, status: 'changed', ...(typeof result?.id === 'string' && { targetId: result.id }) });
  if (WORKSPACE_COMMANDS.test(command)) events.push({ ...base, type: 'workspace', command, status: command.split('.')[1].toLowerCase(), workspaceId: typeof result?.id === 'string' ? result.id : base.workspaceId });
  if (/^approvals\.(approve|reject)$/.test(command) && result?.id) events.push({ ...base, type: 'approval', command, approvalId: result.id, status: status(result.status), workspaceId: result.workspaceId ?? base.workspaceId });
  if (command === 'transfers.commit' && result?.result) {
    if (result.purpose === 'artifact') events.push(...derive('artifacts.create', result.result, base).map(event => ({ ...event, command })));
  }
  return events;
}

/** Events a final outcome implies, in addition to the generic `command` event. */
export function domainEvents(outcome, { actor, batch = null } = {}) {
  const createdAt = new Date().toISOString();
  const base = { actor, workspaceId: outcome.workspaceId ?? undefined, createdAt };
  const authority = outcome.error?.details?.authority;
  if (outcome.error?.code === 'approval_required' && authority?.approvalId) return [{ ...base, type: 'approval', command: outcome.command, approvalId: authority.approvalId, status: 'pending' }];
  if (outcome.execution !== 'succeeded') return [];
  if (outcome.command === 'batch.execute' && Array.isArray(batch) && Array.isArray(outcome.result?.results)) {
    return batch.flatMap((sub, index) => derive(sub.command, outcome.result.results[index], { ...base, workspaceId: sub.workspaceId ?? base.workspaceId }));
  }
  return derive(outcome.command, outcome.result, base);
}

export const eventCommandDefinitions = {
  'events.list': ['Replay retained metadata events after a cursor (the same ids as /v1/events Last-Event-ID); reports gaps', {
    after: z.string().max(200).optional().describe('Last event id you processed; omit to read the oldest retained events.'),
    limit: z.number().int().min(1).max(500).optional().describe('Maximum events to return (default 100).'),
    types: z.array(z.string().regex(/^[a-z][a-z_]{1,31}$/)).max(20).optional().describe('Only these event types (weft.capabilities lists the registered types).'),
  }],
};

/** events.list over the shared retention log, with the same workspace visibility as /v1/events. */
export function listEvents(eventLog, args, context) {
  if (!eventLog) throw Object.assign(new Error('Event replay is not available in this process'), { code: 'unavailable' });
  const limit = args.limit ?? 100;
  const visible = entry => !context.workspaceIds || (entry.event.workspaceId && context.workspaceIds.includes(entry.event.workspaceId));
  const wanted = entry => !args.types?.length || args.types.includes(entry.event.type);
  const { entries, gap } = args.after ? eventLog.since(args.after) : (eventLog.prune(), { entries: [...eventLog.entries], gap: null });
  const matching = entries.filter(entry => visible(entry) && wanted(entry));
  const items = matching.slice(0, limit).map(entry => ({ id: entry.id, ...entry.event }));
  // The cursor advances past everything inspected, including events filtered out by scope or type.
  const inspected = matching.length > limit ? entries.indexOf(matching[limit - 1]) : entries.length - 1;
  // With nothing new, the cursor is the log's current position (also on an empty log).
  const nextCursor = inspected >= 0 ? entries[inspected].id : `${eventLog.boot}-${eventLog.seq}`;
  return { items, nextCursor, more: matching.length > limit, gap: gap ? { ...gap, after: args.after } : null,
    retention: { maxEvents: eventLog.maxEvents, maxAgeMs: eventLog.maxAgeMs, maxBytes: eventLog.maxBytes, persisted: false } };
}
