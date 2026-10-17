import { z } from 'zod';
import { actionClassForCommand, dataClassesForCommand, effectForCommand, resourceForCommand, sensitiveCategoriesForCommand } from './autonomy.js';
import { autonomyCommandDefinitions } from './authority.js';
import { approvalCommandDefinitions } from './approvals.js';
import { activityCommandDefinitions } from './activity-log.js';
import { guidanceTopics } from './guidance.js';
import { commandDefinitions as workspaceDefinitions } from './workspace-commands.js';
import { providerCommandDefinitions } from './provider-commands.js';
import { clientCommandDefinitions } from './clients.js';
import { listCommandDefinitions } from './community-lists.js';
import { extensionCommandDefinitions } from './extensions.js';
import { pluginCommandAdminDefinitions } from './plugin-commands.js';
import { pluginCommandDefinitions } from './plugins/registry.js';
import { handoffCommandDefinitions } from './handoff-commands.js';
import { storageCommandDefinitions } from './site-storage.js';
import { threatCommandDefinitions } from './threat-intel.js';
import { downloadSafetyCommandDefinitions } from './download-safety.js';
import { updateCommandDefinitions } from './updater.js';
import { transferCommandDefinitions } from './transfers.js';
import { eventCommandDefinitions } from './events.js';
import { capabilityCommandDefinitions } from './capabilities.js';
import { PAGEABLE, pageField } from './pagination.js';

const tabId = z.number().int().positive().optional();
const workspaceId = z.string().min(1).max(200).optional();
const expectedVersion = z.number().int().positive().optional();
const page = { tabId, workspaceId, expectedVersion };
const ref = z.string().regex(/^f\d{1,6}e\d{1,9}$/).describe('Element ref from your latest page.snapshot (frame-scoped, for example f0e12).');
const snapshotId = z.string().max(64).describe('Snapshot that supplied the ref; must be your latest.');
const observationId = z.string().max(64).describe('snapshotId or captureId whose viewport geometry the coordinates were taken from.');
const key = z.string().regex(/^(?:[\x20-\x7e]|Enter|Tab|Backspace|Escape|Space|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|F(?:[1-9]|1[0-2]))$/)
  .describe('One printable character or a named key such as Enter, Tab, Escape or Down.');
const url = z.string().max(16384).refine(value => {
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password
      && (['http:', 'https:'].includes(parsed.protocol) || value === 'about:blank');
  } catch {
    return false;
  }
}, 'Expected an HTTP(S) URL without credentials or about:blank');
const cookieUrl = url.refine(value => value !== 'about:blank', 'Cookies require an HTTP(S) URL');
const definitions = {
  'guide.get': ['Read local agent workflow guidance', { topic: z.enum(guidanceTopics).default('start') }],
  'browser.resumeAutomation': ['Human resumes automation after emergency stop', {}],
  'browser.emergencyStop': ['Human emergency stop: revoke tab leases, stop loading, and pause running tasks', {}],
  'downloads.approve': ['Human authorizes retry of one blocked download in its original tab', { downloadId: z.number().int().positive() }],
  'browser.info': ['Get browser and Chromium versions', {}],
  'tabs.list': ['List tabs in a workspace', { workspaceId }],
  'tabs.new': ['Open a tab', { url: url.optional(), workspaceId }],
  'tabs.activate': ['Activate a tab', { tabId: tabId.unwrap() }],
  'tabs.close': ['Close a tab', { tabId: tabId.unwrap(), expectedVersion }],
  'tabs.move': ['Reopen a tab in another workspace isolated container', { tabId: tabId.unwrap(), workspaceId: workspaceId.unwrap(), expectedVersion }],
  'tabs.pin': ['Pin or unpin a tab', { tabId: tabId.unwrap(), pinned: z.boolean(), expectedVersion }],
  'tabs.duplicate': ['Duplicate a tab in its workspace', { tabId: tabId.unwrap() }],
  'tabs.claim': ['Claim tab input control', { tabId: tabId.unwrap(), controller: z.string().min(1).max(100).optional(), expectedVersion }],
  'tabs.takeover': ['Human takes control and revokes old versions', { tabId: tabId.unwrap() }],
  'tabs.release': ['Release tab input control', { tabId: tabId.unwrap() }],
  'tabs.setControlMode': ['Human sets the tab control mode: you-drive, assist (agent observes) or agent-drives', { tabId: tabId.unwrap(),
    mode: z.enum(['you-drive', 'assist', 'agent-drives']).describe('you-drive: only the person; assist: an agent may observe and propose; agent-drives: an agent may hold the input lease.'),
    agent: z.string().min(1).max(200).optional().describe('Actor identity to assist or drive; omit to let any agent claim.'),
    allowRawInput: z.boolean().optional().describe('agent-drives only: permit coordinate and keyboard input.'), expectedVersion }],
  'page.inspect': ['Inspect tab state and navigation version', page],
  'page.readable': ['Read text and links from the current page', page],
  'page.snapshot': ['Read a semantic/accessibility snapshot with frame-scoped element refs and coverage report', { ...page,
    maxNodes: z.number().int().min(1).max(3000).optional().describe('Maximum nodes to return (default 400); the result reports truncation.'),
    includeBoxes: z.boolean().optional().describe('Include viewport CSS-pixel boxes (default true).') }],
  'page.find': ['Find text in page; empty text clears results', { ...page, text: z.string().max(4096), forward: z.boolean().optional(), findNext: z.boolean().optional() }],
  'page.zoom': ['Set page zoom factor', { ...page, factor: z.number().min(0.25).max(5) }],
  'storage.info': ['Describe storage isolation and supported controls', { workspaceId }],
  'storage.clear': ['Clear site origin or entire workspace data (human administration)', { workspaceId, url: cookieUrl.optional() }],
  'page.allowOnce': ['Allow this blocked destination for this tab visit (human only; redirects and other destinations remain checked)', { tabId: tabId.unwrap(), acknowledgeSecurityRisk: z.boolean().optional() }],
  'siteRules.explain': ['Explain every site rule, security finding and exact-visit exception matching a URL, in precedence order', { url: cookieUrl, workspaceId, tabId }],
  'page.navigate': ['Navigate a tab', { ...page, url }],
  'page.back': ['Go back', page],
  'page.forward': ['Go forward', page],
  'page.reload': ['Reload a tab', page],
  'page.stop': ['Stop loading a tab', page],
  'page.title': ['Read the page title', page],
  'page.content': ['Read the page HTML', page],
  'page.evaluate': ['Evaluate JavaScript in the page (trusted automation only)', {
    ...page, expression: z.string().min(1).max(262144),
  }],
  'page.click': ['Click an element by snapshot ref or CSS selector', { ...page, selector: z.string().min(1).max(16384).optional().describe('CSS selector; supply this or ref.'), ref: ref.optional(), snapshotId: snapshotId.optional() }],
  'page.fill': ['Fill an input by snapshot ref or CSS selector and dispatch input/change events', {
    ...page, selector: z.string().min(1).max(16384).optional().describe('CSS selector; supply this or ref.'), ref: ref.optional(), snapshotId: snapshotId.optional(), value: z.string().max(262144),
  }],
  'page.clickAt': ['Click viewport coordinates (agents need raw input permission and a current observation)', { ...page,
    x: z.number().min(0).max(20000).describe('Viewport X in CSS pixels.'), y: z.number().min(0).max(20000).describe('Viewport Y in CSS pixels.'),
    observationId: observationId.optional(), button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left).'),
    clickCount: z.number().int().min(1).max(3).optional().describe('Click count (default 1).') }],
  'page.press': ['Press one key in the focused element (agents need raw input permission)', { ...page, key, observationId: observationId.optional() }],
  'page.screenshot': ['Capture a viewport, full-page, element or region PNG with capture metadata', { ...page, fullPage: z.boolean().optional().describe('Capture the whole document.'),
    ref: ref.optional(), snapshotId: snapshotId.optional(),
    rect: z.strictObject({ x: z.number().min(-20000).max(20000).describe('Viewport X in CSS pixels.'), y: z.number().min(-20000).max(20000).describe('Viewport Y in CSS pixels.'),
      width: z.number().min(1).max(20000).describe('Width in CSS pixels.'), height: z.number().min(1).max(20000).describe('Height in CSS pixels.') }).optional().describe('Viewport-relative region.'),
    scale: z.number().min(0.1).max(2).optional().describe('Resolution multiplier (default 1).'),
    maxWidth: z.number().int().min(16).max(8192).optional().describe('Maximum image width in pixels (default 4096); larger regions are cropped.'),
    maxHeight: z.number().int().min(16).max(8192).optional().describe('Maximum image height in pixels (default 4096); larger regions are cropped.'),
    observationId: observationId.optional() }],
  'page.pdf': ['Print a page to PDF as base64', page],
  'cookies.list': ['List cookies in a workspace session (human administration)', { url: cookieUrl.optional(), workspaceId }],
  'cookies.set': ['Set a cookie in a workspace session (human administration)', { workspaceId,
    url: cookieUrl, name: z.string().min(1).max(4096), value: z.string().max(16384),
    httpOnly: z.boolean().optional(), secure: z.boolean().optional(),
  }],
  'cookies.clear': ['Clear workspace cookies (human administration)', { workspaceId }],
  'downloads.list': ['List workspace downloads in this browser run', { workspaceId }],
  'downloads.cancel': ['Cancel a download', { downloadId: z.number().int().positive() }],
  'browser.close': ['Quit the browser and automation API', {}],
  ...workspaceDefinitions,
  ...providerCommandDefinitions,
  ...clientCommandDefinitions,
  ...listCommandDefinitions,
  ...approvalCommandDefinitions,
  ...autonomyCommandDefinitions,
  ...activityCommandDefinitions,
  ...pluginCommandAdminDefinitions,
  ...extensionCommandDefinitions,
  // Built-in plugin commands (plugin.<name>.<operation>) from validated manifests.
  ...pluginCommandDefinitions,
  ...handoffCommandDefinitions,
  ...storageCommandDefinitions,
  ...threatCommandDefinitions,
  ...downloadSafetyCommandDefinitions,
  ...updateCommandDefinitions,
  ...transferCommandDefinitions,
  ...eventCommandDefinitions,
  ...capabilityCommandDefinitions,
};
// Additive pagination for every potentially large collection (ADR 018).
for (const name of PAGEABLE) if (definitions[name] && !definitions[name][1].page) definitions[name][1] = { ...definitions[name][1], page: pageField.optional() };

for (const [name, [, shape]] of Object.entries(definitions)) if (name.startsWith('tabs.')) shape.workspaceId = workspaceId;

const humanOnly = new Set(['browser.resumeAutomation', 'browser.emergencyStop', 'downloads.approve', 'tabs.takeover', 'tabs.setControlMode', 'page.allowOnce',
  'cookies.list', 'cookies.set', 'cookies.clear', 'storage.clear', 'history.clear', 'settings.update',
  'workspaces.delete', 'workspaces.import', 'workspaces.export', 'workspaces.switch', 'models.save', 'models.delete', 'models.probe',
  'siteRules.create', 'siteRules.update', 'siteRules.delete', 'clients.create', 'clients.list', 'clients.update', 'clients.revoke', 'lists.install', 'lists.status', 'lists.rollback',
  'lists.subscribe', 'lists.preview', 'lists.update', 'lists.configure', 'lists.exception', 'lists.unsubscribe', 'lists.check', 'lists.matches',
  'approvals.approve', 'approvals.reject', 'autonomy.update', 'activity.configure',
  'plugins.enable', 'plugins.disable', 'workspaces.exportAs', 'tabs.setControlMode', ...Object.keys(extensionCommandDefinitions),
  'siteRules.review', 'storage.setSiteMode', 'storage.setDefaultMode', 'threats.install', 'threats.remove', 'threats.configureProvider', 'threats.update',
  'downloads.configureScanner', 'launches.approve', 'launches.deny', 'update.check', 'update.install', 'update.rollback', 'update.configure',
  'workspaces.exportPackage', 'workspaces.importPackage', 'backups.create', 'backups.list', 'backups.verify', 'backups.restore', 'backups.delete', 'search.configureEmbeddings']);
const readOnly = new Set(['browser.info', 'page.inspect', 'page.readable', 'page.snapshot', 'page.title', 'page.content',
  'page.screenshot', 'page.pdf', 'workspace.snapshot', 'search.query', 'workspaces.export', 'workspaces.exportAs', 'artifacts.render', 'activity.report',
  'page.extract', 'extensions.audit', 'plugins.invoke', 'update.status', 'backups.verify', 'search.status', 'transfers.read', 'events.list', 'weft.capabilities', 'conversations.messages', 'artifacts.versions', ...Object.keys(pluginCommandDefinitions).filter(name => ['local_read', 'external_read'].includes(actionClassForCommand(name)))]);
const descriptions = {
  tabId: 'Tab identifier; omit to use the active tab when supported.',
  workspaceId: 'Workspace identifier; omit to use the current workspace when supported.',
  expectedVersion: 'Last inspected tab version; rejects stale input.',
  expectedRevision: 'Last read record revision; rejects concurrent changes.',
  id: 'Identifier of the existing record.', url: 'HTTP(S) destination without credentials; about:blank only where supported.',
  changes: 'Fields to update; omitted fields remain unchanged.',
  requestId: 'Optional client-chosen idempotency key. Retrying the same command and arguments with it returns the original result (marked replayed) instead of applying twice; reusing it for different arguments fails with idempotency_conflict.',
  dryRun: 'When true, validate and compute the result and record changes without committing anything.',
  commands: 'Ordered record commands, each {command, args}; a string "$N.id" in args is replaced by the id returned by earlier command N.',
};
export const REPLAYED = Symbol.for('weft.replayed');
function describeShape(shape) {
  return Object.fromEntries(Object.entries(shape).map(([key, field]) => [key,
    field.describe(field.description || descriptions[key] || `${key.replace(/([A-Z])/g, ' $1')} value.`)]));
}
function describeNested(schema) {
  for (const [key, value] of Object.entries(schema.properties || {})) {
    value.description ||= descriptions[key] || `${key.replace(/([A-Z])/g, ' $1')} value.`;
    describeNested(value);
  }
  for (const variant of [...(schema.anyOf || []), ...(schema.oneOf || [])]) describeNested(variant);
  if (schema.items) describeNested(schema.items);
  return schema;
}
const schemas = Object.fromEntries(Object.entries(definitions).map(([name, [, shape]]) => [
  name, z.strictObject(describeShape(shape)),
]));
export const commands = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([name, [description]]) => {
    const read = readOnly.has(name) || /\.(list|get|info)$/.test(name);
    return [name, { description, inputSchema: describeNested(z.toJSONSchema(schemas[name])),
      humanOnly: humanOnly.has(name), actionClass: actionClassForCommand(name), resource: resourceForCommand(name),
      dataClasses: dataClassesForCommand(name), effect: effectForCommand(name), sensitiveCategories: sensitiveCategoriesForCommand(name),
      readOnly: read, destructive: /\.(delete|clear|close|remove)$/.test(name) || name === 'backups.restore' }];
  }),
));

export class CommandError extends Error {
  constructor(details) { super(details.message); this.name = 'CommandError'; Object.assign(this, details); }
  toJSON() { return Object.fromEntries(Object.entries(this).filter(([key]) => key !== 'name').concat([['message', this.message]])); }
}
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length];
}
const suggest = (value, allowed) => allowed.filter(item => typeof item === 'string')
  .map(item => [item, distance(String(value).slice(0, 200), item)])
  .filter(([, score]) => score <= 3).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([item]) => item);
/** HTTP status for every stable error code. Adding a code requires a status, an exit code and an outcome status. */
export const ERROR_HTTP_STATUS = Object.freeze({ unauthorized: 401, permission_required: 403, invalid_arguments: 400, invalid_json: 400,
  unknown_command: 400, idempotency_conflict: 409, already_committed: 409, component_integrity: 422, approval_required: 403, tab_busy: 409, action_interrupted: 409, site_blocked: 403, ambiguous_target: 400, target_mismatch: 403, human_required: 403, stale_state: 409, lease_conflict: 409, cancelled: 409, emergency_stop: 409,
  timeout: 504, deadline_exceeded: 504, not_found: 404, request_too_large: 413, unsupported_media_type: 415, unavailable: 503,
  command_failed: 422, unsupported: 422, transport_error: 503, unsupported_capability: 422 });
/**
 * Stable outcome taxonomy shared by GUI, CLI, MCP and REST. Every outcome carries exactly one
 * `status`; failures derive it from the error code so all surfaces classify a result identically.
 */
export const OUTCOME_STATUSES = Object.freeze(['succeeded', 'partial', 'blocked', 'approval_required', 'stale_state', 'conflict', 'unsupported', 'invalid', 'cancelled', 'timed_out', 'failed']);
export const ERROR_STATUS = Object.freeze({
  invalid_arguments: 'invalid', invalid_json: 'invalid', unknown_command: 'invalid', ambiguous_target: 'invalid', request_too_large: 'invalid',
  unauthorized: 'blocked', permission_required: 'blocked', human_required: 'blocked', target_mismatch: 'blocked', site_blocked: 'blocked',
  approval_required: 'approval_required', stale_state: 'stale_state',
  idempotency_conflict: 'conflict', already_committed: 'conflict', lease_conflict: 'conflict', tab_busy: 'conflict',
  unsupported_capability: 'unsupported', unsupported: 'unsupported', unsupported_media_type: 'unsupported',
  cancelled: 'cancelled', emergency_stop: 'cancelled', action_interrupted: 'cancelled',
  timeout: 'timed_out', deadline_exceeded: 'timed_out',
  not_found: 'failed', command_failed: 'failed', component_integrity: 'failed', transport_error: 'failed', unavailable: 'failed',
});
/** A completed command whose result explicitly reports incompleteness is partial, never plain success. */
export const isPartialResult = result => Boolean(result) && typeof result === 'object' && !Array.isArray(result)
  && (result.status === 'partial' || result.partial === true || result.complete === false);
export const outcomeStatus = outcome => outcome.error ? (ERROR_STATUS[outcome.error.code] ?? 'failed') : isPartialResult(outcome.result) ? 'partial' : 'succeeded';
export const API_VERSION = 1;
const schemaHint = name => `weft_reference({command:${JSON.stringify(name)}}); GET /v1/commands`;
export function toCommandError(error, commandName, input) {
  if (error instanceof CommandError) return error.toJSON();
  if (error?.issues) {
    const fields = error.issues.flatMap(issue => {
      const path = issue.path || [];
      let schema = (Object.hasOwn(commands, commandName) ? commands[commandName].inputSchema : undefined);
      for (const part of path) schema = schema?.properties?.[part] || schema?.items;
      const base = { code: 'invalid_arguments', field: path.join('.') || 'args', schema: schemaHint(commandName) };
      if (issue.code === 'unrecognized_keys') return issue.keys.map(key => ({ ...base,
        field: [...path, key].join('.'), message: 'Unknown field. Remove it or use an allowed field.',
        allowed: Object.keys(schema?.properties || {}), suggestions: suggest(key, Object.keys(schema?.properties || {})) }));
      if (issue.code === 'invalid_value') return [{ ...base, message: 'Choose one of the allowed values.', allowed: issue.values, suggestions: suggest(path.reduce((value, key) => value?.[key], input), issue.values) }];
      if (issue.code === 'invalid_type') return [{ ...base, message: `Required type: ${issue.expected}. Provide this field with the correct type.` }];
      if (['too_big', 'too_small'].includes(issue.code)) return [{ ...base, message: `${issue.code === 'too_big' ? 'Maximum' : 'Minimum'} ${issue.origin || 'value'} ${issue.code === 'too_big' ? 'size/value' : 'size/value'}: ${issue.maximum ?? issue.minimum}${issue.inclusive ? ' (inclusive)' : ' (exclusive)'}.` }];
      return [{ ...base, message: 'Invalid value. Check the command schema and its constraints.' }];
    });
    return { ...fields[0], issues: fields };
  }
  const message = error?.message || 'Command failed';
  const known = ERROR_HTTP_STATUS;
  let code = error?.code === 'SITE_BLOCKED' ? 'site_blocked' : Object.hasOwn(known, error?.code) ? error.code : 'command_failed';
  if (code === 'command_failed') {
    if (/stale|STALE_STATE/i.test(message)) code = 'stale_state';
    else if (/tab control|tab lease|Take over this tab/i.test(message)) code = 'lease_conflict';
    else if (/trusted browser interface|human administration|PERMISSION_REQUIRED|human approval/i.test(message)) code = 'permission_required';
    else if (/cancelled|canceled|AbortError/i.test(message) || error?.name === 'AbortError') code = 'cancelled';
    else if (/emergency stop/i.test(message)) code = 'emergency_stop';
    else if (/timed out|timeout/i.test(message)) code = 'timeout';
    else if (/not found|No active tab/i.test(message)) code = 'not_found';
  }
  const details = {};
  const workspaceId = value => typeof value === 'string' && /^ws_[a-f0-9-]{36}$/.test(value);
  if (code === 'ambiguous_target' && error.details) {
    if (Array.isArray(error.details.workspaceIds)) details.workspaceIds = error.details.workspaceIds.filter(workspaceId).slice(0, 1000);
    if (Array.isArray(error.details.tabs)) details.tabs = error.details.tabs
      .filter(tab => Number.isSafeInteger(tab?.tabId) && tab.tabId > 0 && workspaceId(tab.workspaceId)).slice(0, 1000)
      .map(({ tabId, workspaceId }) => ({ tabId, workspaceId }));
  }
  const authority = error?.details?.authority;
  if (['permission_required', 'human_required', 'approval_required'].includes(code) && authority && typeof authority === 'object') {
    const safe = {};
    if (['auto', 'auto_preapproved', 'approval', 'deny'].includes(authority.decision)) safe.decision = authority.decision;
    if (typeof authority.reason === 'string' && /^[a-z_]{1,64}$/.test(authority.reason)) safe.reason = authority.reason;
    if (typeof authority.actionClass === 'string' && /^[a-z_]{1,32}$/.test(authority.actionClass)) safe.actionClass = authority.actionClass;
    if (typeof authority.level === 'string' && /^[a-z]{1,16}$/.test(authority.level)) safe.level = authority.level;
    if (typeof authority.approvalId === 'string' && /^appr_[a-f0-9-]{36}$/.test(authority.approvalId)) safe.approvalId = authority.approvalId;
    if (typeof authority.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(authority.fingerprint)) safe.fingerprint = authority.fingerprint;
    if (typeof authority.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(authority.expiresAt)) safe.expiresAt = authority.expiresAt;
    details.authority = safe;
  }
  // Fixed vocabularies only: page-sourced or caller-supplied values never reach error details.
  const word = value => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value);
  if (code === 'stale_state' && word(error.details?.reason)) details.reason = error.details.reason;
  if (code === 'stale_state' && Array.isArray(error.details?.changed)) details.changed = error.details.changed.filter(item => ['url', 'width', 'height', 'scrollX', 'scrollY', 'devicePixelRatio'].includes(item));
  if (code === 'action_interrupted' && error.details) details.interrupted = { command: Object.hasOwn(commands, error.details.command) ? error.details.command : null, cancellable: false };
  if (code === 'tab_busy' && error.details) details.queued = Number.isSafeInteger(error.details.queued) ? error.details.queued : 0;
  if (code === 'site_blocked' && error.details && typeof error.details === 'object') {
    const text = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : null;
    details.blocked = { url: text(error.details.url, 16384), kind: ['security', 'preference'].includes(error.details.kind) ? error.details.kind : null, ruleId: text(error.details.ruleId, 200),
      hostname: text(error.details.hostname, 253), source: text(error.details.source, 50), mode: text(error.details.mode, 30), reason: text(error.details.reason), category: text(error.details.category, 50),
      stale: typeof error.details.stale === 'boolean' ? error.details.stale : null, exception: text(error.details.exception), explain: text(error.details.explain, 50) };
  }
  if (code === 'emergency_stop' && typeof error.details?.stoppedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(error.details.stoppedAt)) details.stoppedAt = error.details.stoppedAt;
  if (code === 'unsupported_capability') {
    if (['images', 'tools', 'streaming', 'contextWindow', 'visionFallback', 'embeddings'].includes(error.details?.capability)) details.capability = error.details.capability;
    if (typeof error.details?.modelId === 'string' && /^[\w.-]{1,128}$/.test(error.details.modelId)) details.modelId = error.details.modelId;
  }
  // Model turn stops report whether the partial reply was kept, never its text.
  if (['cancelled', 'timeout', 'emergency_stop'].includes(code) && typeof error.details?.turnId === 'string' && /^turn_[0-9a-f-]{36}$/.test(error.details.turnId)) {
    details.turnId = error.details.turnId;
    for (const key of ['partialSaved', 'continuable']) if (typeof error.details[key] === 'boolean') details[key] = error.details[key];
    if (['first_token', 'idle', 'total', 'request'].includes(error.details.deadline)) details.deadline = error.details.deadline;
  }
  // Deadlines report only whether execution started and what happened to it (fixed vocabulary).
  if (code === 'deadline_exceeded' && error.details && typeof error.details === 'object') {
    if (typeof error.details.started === 'boolean') details.started = error.details.started;
    if (['not_started', 'rolled_back', 'stopped', 'uncertain'].includes(error.details.effect)) details.effect = error.details.effect;
    for (const key of ['deadlineMs', 'elapsedMs']) if (Number.isSafeInteger(error.details[key]) && error.details[key] >= 0) details[key] = error.details[key];
    if (typeof error.details.turnId === 'string' && /^turn_[0-9a-f-]{36}$/.test(error.details.turnId)) details.turnId = error.details.turnId;
    if (typeof error.details.partialSaved === 'boolean') details.partialSaved = error.details.partialSaved;
  }
  // A field named by Weft's own validation (never caller text) locates the problem argument.
  const field = typeof error?.field === 'string' && /^[A-Za-z][\w.]{0,100}$/.test(error.field) ? error.field : null;
  return { code, message, field, schema: schemaHint(commandName), httpStatus: known[code], ...(Object.keys(details).length && { details }) };
}
export function validateCommand(name, args = {}) {
  if (!Object.hasOwn(schemas, name)) throw new CommandError({ code: 'unknown_command', message: 'Unknown command. Select a canonical command from the catalog.',
    field: 'command', allowed: Object.keys(commands), suggestions: suggest(name, Object.keys(commands)), schema: 'GET /v1/commands' });
  try { return schemas[name].parse(args); } catch (error) { throw new CommandError(toCommandError(error, name, args)); }
}
const aliases = Object.freeze({ 'tabs.open': 'tabs.new' });
export function normalizeCommand(name, args = {}) {
  const normalized = [];
  const command = Object.hasOwn(aliases, name) ? aliases[name] : name;
  if (command !== name) normalized.push({ from: name, to: command });
  const properties = Object.hasOwn(commands, command) ? commands[command].inputSchema.properties : undefined;
  if (!properties || !args || typeof args !== 'object' || Array.isArray(args)) return { command, args, normalized };
  const output = {};
  for (const [key, value] of Object.entries(args)) {
    let target = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === 'href' && ['tabs.new', 'page.navigate'].includes(command)) target = 'url';
    if (!Object.hasOwn(properties, target)) target = key;
    if (Object.hasOwn(output, target) || (target !== key && Object.hasOwn(args, target))) {
      throw new CommandError({ code: 'invalid_arguments', message: 'Alias and canonical field conflict; supply only one.', field: target, schema: schemaHint(command) });
    }
    Object.defineProperty(output, target, { value, enumerable: true });
    if (key !== target) normalized.push({ from: key, to: target });
  }
  return { command, args: output, normalized };
}
export const exitCodes = Object.freeze({ invalid_arguments: 2, invalid_json: 2, unknown_command: 2,
  stale_state: 3, idempotency_conflict: 3, already_committed: 3, lease_conflict: 3, tab_busy: 3, action_interrupted: 7, site_blocked: 4, permission_required: 4, approval_required: 5, human_required: 4, target_mismatch: 4, ambiguous_target: 2, unauthorized: 4, cancelled: 6,
  emergency_stop: 6, timeout: 7, deadline_exceeded: 7, transport_error: 7, unavailable: 7, unsupported_capability: 8 });
export const resultExitCode = outcome => outcome.error ? (exitCodes[outcome.error.code] || 1) : 0;
export const resultHttpStatus = outcome => outcome.error ? (outcome.error.httpStatus || ({ invalid_arguments: 400, unknown_command: 400, invalid_json: 400, stale_state: 409, lease_conflict: 409, permission_required: 403, human_required: 403, approval_required: 403, emergency_stop: 409, cancelled: 409, ambiguous_target: 400, target_mismatch: 403 }[outcome.error.code]) || 422) : 200;
/** Execution state of a failed command; a deadline reports whether the command started and how it ended. */
function failedExecution(details, error, validation) {
  if (['cancelled', 'emergency_stop'].includes(details.code)) return 'cancelled';
  if (details.code === 'deadline_exceeded') {
    const effect = details.details?.effect;
    return details.details?.started === false || effect === 'not_started' ? 'not_started' : effect === 'uncertain' ? 'uncertain' : 'cancelled';
  }
  return validation === 'failed' || error?.notStarted === true ? 'not_started' : 'failed';
}
export function errorOutcome(error, command = null, args = {}, normalized = [], validation = 'passed') {
  const details = toCommandError(error, command);
  return { schemaVersion: 1, command, status: ERROR_STATUS[details.code] ?? 'failed', execution: failedExecution(details, error, validation),
    validation, review: ['permission_required', 'human_required', 'approval_required', 'site_blocked'].includes(details.code) ? 'required' : 'not_required',
    workspaceId: typeof args?.workspaceId === 'string' && args.workspaceId.length <= 200 ? args.workspaceId : null, tabId: Number.isSafeInteger(args?.tabId) && args.tabId > 0 ? args.tabId : null, normalized, result: null, error: details };
}
export async function executeOutcome(execute, name, input = {}, { returnsOutcome = false } = {}) {
  let prepared;
  let args;
  try { prepared = normalizeCommand(name, input); args = validateCommand(prepared.command, prepared.args); }
  catch (error) { return errorOutcome(error, prepared?.command ?? name, input, prepared?.normalized ?? [], 'failed'); }
  try {
    const result = await execute(prepared.command, args);
    if (returnsOutcome && result?.schemaVersion === 1 && result.execution && Object.hasOwn(result, 'result') && Object.hasOwn(result, 'error')) {
      const outcome = { ...result, normalized: [...prepared.normalized, ...(result.normalized || [])] };
      return Object.hasOwn(outcome, 'status') ? outcome : { schemaVersion: 1, command: outcome.command, status: outcomeStatus(outcome), ...outcome };
    }
    return { schemaVersion: 1, command: prepared.command, status: isPartialResult(result) ? 'partial' : 'succeeded', execution: 'succeeded', validation: 'passed', review: 'not_required',
      workspaceId: args.workspaceId ?? (prepared.command !== 'page.evaluate' ? result?.workspaceId : null) ?? null, tabId: args.tabId ?? (prepared.command.startsWith('tabs.') ? result?.id : result?.tabId) ?? null,
      normalized: prepared.normalized, ...(typeof args.requestId === 'string' && { idempotency: { requestId: args.requestId, replayed: result?.[REPLAYED] === true } }), result: result ?? null, error: null };
  } catch (error) { return errorOutcome(error, prepared.command, args, prepared.normalized); }
}
