import { z } from 'zod';
import { actionClassForCommand } from './autonomy.js';
import { guidanceTopics } from './guidance.js';
import { commandDefinitions as workspaceDefinitions } from './workspace-commands.js';
import { providerCommandDefinitions } from './provider-commands.js';

const tabId = z.number().int().positive().optional();
const workspaceId = z.string().min(1).max(200).optional();
const expectedVersion = z.number().int().positive().optional();
const page = { tabId, workspaceId, expectedVersion };
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
  'page.inspect': ['Inspect tab state and navigation version', page],
  'page.readable': ['Read text and links from the current page', page],
  'page.find': ['Find text in page; empty text clears results', { ...page, text: z.string().max(4096), forward: z.boolean().optional(), findNext: z.boolean().optional() }],
  'page.zoom': ['Set page zoom factor', { ...page, factor: z.number().min(0.25).max(5) }],
  'storage.info': ['Describe storage isolation and supported controls', { workspaceId }],
  'storage.clear': ['Clear site origin or entire workspace data (human administration)', { workspaceId, url: cookieUrl.optional() }],
  'page.allowOnce': ['Allow this blocked destination for this tab visit (human only; redirects and other destinations remain checked)', { tabId: tabId.unwrap() }],
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
  'page.click': ['Click a CSS selector', { ...page, selector: z.string().min(1).max(16384) }],
  'page.fill': ['Fill an input and dispatch input/change events', {
    ...page, selector: z.string().min(1).max(16384), value: z.string().max(262144),
  }],
  'page.screenshot': ['Capture a PNG as base64', { ...page, fullPage: z.boolean().optional() }],
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
};

for (const [name, [, shape]] of Object.entries(definitions)) if (name.startsWith('tabs.')) shape.workspaceId = workspaceId;

const humanOnly = new Set(['browser.resumeAutomation', 'browser.emergencyStop', 'downloads.approve', 'tabs.takeover', 'page.allowOnce',
  'cookies.list', 'cookies.set', 'cookies.clear', 'storage.clear', 'history.clear', 'settings.update',
  'workspaces.delete', 'workspaces.import', 'workspaces.export', 'workspaces.switch', 'models.save', 'models.delete',
  'siteRules.create', 'siteRules.update', 'siteRules.delete']);
const readOnly = new Set(['browser.info', 'page.inspect', 'page.readable', 'page.title', 'page.content',
  'page.screenshot', 'page.pdf', 'workspace.snapshot', 'search.query', 'workspaces.export']);
const descriptions = {
  tabId: 'Tab identifier; omit to use the active tab when supported.',
  workspaceId: 'Workspace identifier; omit to use the current workspace when supported.',
  expectedVersion: 'Last inspected tab version; rejects stale input.',
  expectedRevision: 'Last read record revision; rejects concurrent changes.',
  id: 'Identifier of the existing record.', url: 'HTTP(S) destination without credentials; about:blank only where supported.',
  changes: 'Fields to update; omitted fields remain unchanged.',
};
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
      humanOnly: humanOnly.has(name), actionClass: actionClassForCommand(name),
      readOnly: read, destructive: /\.(delete|clear|close)$/.test(name) }];
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
  const known = { unauthorized: 401, permission_required: 403, invalid_arguments: 400, invalid_json: 400,
    unknown_command: 400, ambiguous_target: 400, target_mismatch: 403, human_required: 403, stale_state: 409, lease_conflict: 409, cancelled: 409, emergency_stop: 409,
    timeout: 504, not_found: 404, request_too_large: 413, unsupported_media_type: 415, unavailable: 503,
    command_failed: 422, transport_error: 503 };
  let code = Object.hasOwn(known, error?.code) ? error.code : 'command_failed';
  if (code === 'command_failed') {
    if (/stale|STALE_STATE/i.test(message)) code = 'stale_state';
    else if (/tab control|tab lease|Take over this tab/i.test(message)) code = 'lease_conflict';
    else if (/trusted browser interface|human administration|PERMISSION_REQUIRED|human approval/i.test(message)) code = 'permission_required';
    else if (/cancelled|canceled|AbortError/i.test(message) || error?.name === 'AbortError') code = 'cancelled';
    else if (/emergency stop/i.test(message)) code = 'emergency_stop';
    else if (/timed out|timeout/i.test(message)) code = 'timeout';
    else if (/not found|No active tab/i.test(message)) code = 'not_found';
  }
  return { code, message, field: null, schema: schemaHint(commandName), httpStatus: known[code] };
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
  stale_state: 3, lease_conflict: 3, permission_required: 4, human_required: 4, target_mismatch: 4, ambiguous_target: 2, unauthorized: 4, cancelled: 6,
  emergency_stop: 6, timeout: 7, transport_error: 7, unavailable: 7 });
export const resultExitCode = outcome => outcome.error ? (exitCodes[outcome.error.code] || 1) : 0;
export const resultHttpStatus = outcome => outcome.error ? (outcome.error.httpStatus || ({ invalid_arguments: 400, unknown_command: 400, invalid_json: 400, stale_state: 409, lease_conflict: 409, permission_required: 403, human_required: 403, emergency_stop: 409, cancelled: 409, ambiguous_target: 400, target_mismatch: 403 }[outcome.error.code]) || 422) : 200;
export function errorOutcome(error, command = null, args = {}, normalized = [], validation = 'passed') {
  const details = toCommandError(error, command);
  return { schemaVersion: 1, command, execution: ['cancelled', 'emergency_stop'].includes(details.code) ? 'cancelled' : validation === 'failed' ? 'not_started' : 'failed',
    validation, review: ['permission_required', 'human_required'].includes(details.code) ? 'required' : 'not_required',
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
      return { ...result, normalized: [...prepared.normalized, ...(result.normalized || [])] };
    }
    return { schemaVersion: 1, command: prepared.command, execution: 'succeeded', validation: 'passed', review: 'not_required',
      workspaceId: args.workspaceId ?? (prepared.command !== 'page.evaluate' ? result?.workspaceId : null) ?? null, tabId: args.tabId ?? (prepared.command.startsWith('tabs.') ? result?.id : result?.tabId) ?? null,
      normalized: prepared.normalized, result: result ?? null, error: null };
  } catch (error) { return errorOutcome(error, prepared.command, args, prepared.normalized); }
}
