import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rejectSecretKeys } from './export-safety.js';
import { handoffCommandDefinitions, handoffStatuses } from './handoff-commands.js';
import { sanitizeUrl as sanitize } from './workspace.js';

/**
 * Structured human/agent handoff records. A handoff captures what was done,
 * exact evidence, current tab state and versions, and the next step. It never
 * stores page content, input values, cookies or credentials. Accepting a
 * handoff requires the acceptor to inspect each referenced tab again before
 * input, because the state may have changed since the record was written.
 */
const schemas = Object.fromEntries(Object.entries(handoffCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));

// Best-effort value screening. Key-based secret rejection still applies to every field.
const secretValues = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bweft1\.[\w-]{10,}\.[\w-]{10,}/, /\b(?:sk|rk|pk)-[A-Za-z\d_-]{16,}/, /\bgh[opsur]_[A-Za-z\d]{20,}/,
  /\bAKIA[\dA-Z]{16}\b/, /\bBearer\s+[\w.~+/-]{16,}/i, /\b(?:password|passwd|pwd|passcode|otp|api[_ -]?key|secret|token)\s*[:=]\s*\S+/i];
const luhn = digits => [...digits].reverse().reduce((sum, digit, index) => { let value = Number(digit); if (index % 2) { value *= 2; if (value > 9) value -= 9; } return sum + value; }, 0) % 10 === 0;
const cardNumber = value => (value.match(/\b\d(?:[ -]?\d){12,18}\b/g) ?? []).some(match => luhn(match.replace(/\D/g, '')));
function rejectSecretValues(value, path = 'handoff') {
  if (typeof value === 'string') {
    if (secretValues.some(pattern => pattern.test(value)) || cardNumber(value)) throw Object.assign(new Error(`SECRET_FIELD: ${path} looks like it contains a credential, card number or one-time code. Handoffs must not store secrets.`), { code: 'SECRET_FIELD' });
  } else if (Array.isArray(value)) value.forEach((item, index) => rejectSecretValues(item, `${path}[${index}]`));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) rejectSecretValues(item, `${path}.${key}`);
}
const human = value => ['human', 'admin'].includes(value);
const now = () => new Date().toISOString();
const denied = message => Object.assign(new Error(`PERMISSION_REQUIRED: ${message}`), { code: 'permission_required' });
const addressedTo = (record, who) => human(who) ? true : record.to === who || (record.to === 'any-agent' && !human(who));

/** Executed inside the workspace mutation queue. */
export function executeHandoffCommand(service, name, input, context = {}) {
  context.assertAuthorized?.();
  const args = schemas[name]?.parse(input);
  if (!args) throw new Error(`Unknown handoff command: ${name}`);
  rejectSecretKeys(args);
  // A missing actor is never treated as a person: only the dispatcher's trusted GUI context is human.
  const who = context.actor || 'automation';
  service.data.handoffs ??= [];
  const workspaceId = args.workspaceId || context.workspaceId || service.activeWorkspaceId;
  if (context.workspaceId && args.workspaceId && context.workspaceId !== args.workspaceId) throw denied('workspace is outside the authorized scope');
  service.workspace(workspaceId);
  const find = () => {
    const record = service.data.handoffs.find(item => item.id === args.id);
    if (!record) throw Object.assign(new Error('Handoff not found'), { code: 'not_found' });
    if (context.workspaceId && record.workspaceId !== context.workspaceId) throw denied('handoff is outside the authorized workspace');
    return record;
  };
  if (name === 'handoffs.list') return structuredClone(service.data.handoffs.filter(item => item.workspaceId === workspaceId && (!args.status || item.status === args.status)));
  if (name === 'handoffs.get') return structuredClone(find());
  try {
    let record;
    if (name === 'handoffs.create') {
      // URLs are screened after secret-named query parameters are removed.
      rejectSecretValues({ ...args, evidence: [] });
      const browser = service.browser;
      const tabs = [...(browser?.tabs?.values() ?? [])].filter(tab => tab.workspaceId === workspaceId);
      const selected = args.tabIds ? args.tabIds.map(tabId => {
        const tab = tabs.find(item => item.id === tabId);
        if (!tab) throw Object.assign(new Error(`Tab ${tabId} is not open in this workspace`), { code: 'not_found' });
        return tab;
      }) : tabs.filter(tab => tab.controller === who);
      const references = args.evidence.map(item => verifyEvidence(service, workspaceId, item));
      rejectSecretValues(references, 'evidence');
      if (args.taskId) { const task = service.record('tasks', args.taskId, context); if (task.workspaceId !== workspaceId) throw denied('task is outside this workspace'); }
      const timestamp = now();
      record = { id: `handoff_${randomUUID()}`, workspaceId, kind: 'handoff', status: 'open', from: who, to: args.to, objective: args.objective,
        completedActions: args.completedActions, findings: args.findings, evidence: references, blocker: args.blocker, nextStep: args.nextStep,
        taskId: args.taskId ?? null, tabs: selected.map(tab => sanitizeTabState(browser.handoffTabState(tab, who))), interrupted: [],
        createdAt: timestamp, updatedAt: timestamp, revision: 1, history: [{ status: 'open', actor: who, at: timestamp }] };
      service.data.handoffs.push(record);
    } else {
      record = find();
      if (args.expectedRevision !== undefined && args.expectedRevision !== record.revision) throw Object.assign(new Error('STALE_STATE: handoff changed; reload before updating'), { code: 'stale_state' });
      if (name === 'handoffs.accept') {
        if (record.status !== 'open') throw new Error(`Handoff is ${record.status}, not open`);
        if (!addressedTo(record, who)) throw denied('this handoff is addressed to another recipient');
        const browser = service.browser;
        record.resume = record.tabs.map(saved => {
          const tab = browser?.tabs?.get(saved.tabId);
          if (!tab || tab.workspaceId !== record.workspaceId) return { tabId: saved.tabId, open: false };
          browser.requireInspection(saved.tabId, who);
          return { tabId: saved.tabId, open: true, versionAtHandoff: saved.navigationVersion, currentVersion: tab.version, changed: tab.version !== saved.navigationVersion, inspectionRequired: !human(who) };
        });
        Object.assign(record, { status: 'accepted', acceptedBy: who, acceptedAt: now() });
      } else {
        if (['completed', 'declined', 'cancelled'].includes(record.status)) throw new Error(`Handoff is already ${record.status}`);
        const participant = human(who) || [record.from, record.to, record.acceptedBy].includes(who) || (record.to === 'any-agent' && record.status === 'open');
        if (!participant) throw denied('only the sender, recipient or a person may close this handoff');
        if (args.status === 'cancelled' && !human(who) && who !== record.from) throw denied('only the sender or a person may cancel a handoff');
        if (args.note) rejectSecretValues(args.note, 'note');
        Object.assign(record, { status: args.status, completedBy: who, completedAt: now(), ...(args.note !== undefined && { note: args.note }) });
      }
      record.updatedAt = now(); record.revision += 1;
      record.history.push({ status: record.status, actor: who, at: record.updatedAt });
    }
    service.log(name, record.workspaceId, record.id, who, `${record.from} → ${record.to}: ${record.status}`);
    service.save();
    return structuredClone(record);
  } catch (error) { rollback(service); throw error; }
}
// The workspace store returns to its last committed state, so the handoff and its activity entry roll back together.
function rollback(service) { if (service.rollback) service.rollback(); }

function sanitizeTabState(state) {
  return { ...state, url: sanitize(state.url) || 'about:blank' };
}

function verifyEvidence(service, workspaceId, item) {
  const reference = { type: item.type, id: item.id, ...(item.versionId && { versionId: item.versionId }), ...(item.ref && { ref: item.ref }), ...(item.note && { note: item.note }) };
  if (item.type === 'url') {
    const url = sanitize(item.id);
    if (!url || url === 'about:blank') throw Object.assign(new Error('Evidence URLs must be HTTP(S)'), { code: 'invalid_arguments' });
    return { ...reference, id: url };
  }
  if (['snapshot', 'capture'].includes(item.type)) {
    // Browser observations are ephemeral; record the tab version they were taken at.
    const owner = [...(service.browser?.tabs?.values() ?? [])].find(tab => tab.observations?.byId.has(item.id));
    const observation = owner?.observations.byId.get(item.id);
    if (!observation || owner.workspaceId !== workspaceId) throw Object.assign(new Error(`Unknown ${item.type} ${item.id}; reference the current observation`), { code: 'not_found' });
    return { ...reference, tabId: owner.id, navigationVersion: observation.version, observedAt: observation.createdAt };
  }
  const collection = { artifact: 'artifacts', material: 'materials', context: 'context', task: 'tasks' }[item.type];
  const record = service.data[collection].find(value => value.id === item.id);
  if (!record || record.workspaceId !== workspaceId) throw Object.assign(new Error(`${item.type} ${item.id} not found in this workspace`), { code: 'not_found' });
  if (item.type === 'artifact') {
    const version = item.versionId ? record.versions.find(value => value.id === item.versionId) : record.versions.at(-1);
    if (!version) throw Object.assign(new Error('Artifact version not found'), { code: 'not_found' });
    return { ...reference, versionId: version.id, versionNumber: version.number, sha256: version.components?.map(component => component.sha256) ?? [] };
  }
  return { ...reference, revision: record.revision };
}

/** System record created when a person takes control from an agent. */
export function recordTakeover(service, details) {
  service.data.handoffs ??= [];
  if (!service.data.workspaces.some(item => item.id === details.workspaceId)) return null;
  const timestamp = now();
  const record = { id: `handoff_${randomUUID()}`, workspaceId: details.workspaceId, kind: 'takeover', status: 'open', from: details.previousController, to: 'human',
    objective: '', completedActions: [], findings: [], evidence: [], blocker: `Control boundary: ${details.reason}`, nextStep: 'Inspect current state; hand back with handoffs.create if the agent should continue.',
    taskId: null, tabs: [sanitizeTabState(details.tab)], interrupted: details.interrupted, cancelledQueue: details.cancelledQueue,
    createdAt: timestamp, updatedAt: timestamp, revision: 1, history: [{ status: 'open', actor: 'system', at: timestamp }] };
  try {
    service.data.handoffs.push(record);
    // Keep the newest 1,000 records per workspace.
    const own = service.data.handoffs.filter(item => item.workspaceId === record.workspaceId);
    if (own.length > 1000) { const drop = new Set(own.slice(0, own.length - 1000).map(item => item.id)); service.data.handoffs = service.data.handoffs.filter(item => !drop.has(item.id)); }
    service.log('handoffs.takeover', record.workspaceId, record.id, 'human', details.reason);
    service.save();
  } catch (error) { rollback(service); throw error; }
  return structuredClone(record);
}

const timestamp = z.string().max(100);
const importedTab = z.object({ tabId: z.number().int().nullable().optional(), url: z.string().max(16384).optional(), title: z.string().max(1000).optional(),
  navigationVersion: z.number().int().nullable().optional(), stateEpoch: z.number().int().optional(), controller: z.string().max(200).optional(),
  controlMode: z.string().max(100).optional(), latestSnapshotId: z.string().max(128).nullable().optional() });
const importedEvidence = z.object({ type: z.enum(['artifact', 'material', 'context', 'task', 'snapshot', 'capture', 'url']), id: z.string().min(1).max(16384),
  versionId: z.string().max(128).optional(), ref: z.string().max(64).optional(), note: z.string().max(2000).optional(), tabId: z.number().int().optional(),
  navigationVersion: z.number().int().nullable().optional(), observedAt: timestamp.optional(), versionNumber: z.number().int().optional(),
  sha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(10).optional(), revision: z.number().int().optional() });
const importedHandoff = z.object({ kind: z.enum(['handoff', 'takeover']).default('handoff'), status: z.enum(handoffStatuses), from: z.string().min(1).max(200), to: z.string().min(1).max(200),
  objective: z.string().max(20000).default(''), completedActions: z.array(z.string().max(2000)).max(100).default([]), findings: z.array(z.string().max(2000)).max(100).default([]),
  evidence: z.array(importedEvidence).max(100).default([]), blocker: z.string().max(20000).default(''), nextStep: z.string().max(20000).default(''),
  taskId: z.string().max(128).nullable().optional(), tabs: z.array(importedTab).max(20).default([]),
  interrupted: z.array(z.record(z.string().max(100), z.unknown())).max(100).default([]), cancelledQueue: z.array(z.record(z.string().max(100), z.unknown())).max(100).optional(),
  history: z.array(z.object({ status: z.string().max(30), actor: z.string().max(200), at: timestamp })).max(1000).default([]),
  acceptedBy: z.string().max(200).optional(), acceptedAt: timestamp.optional(), completedBy: z.string().max(200).optional(), completedAt: timestamp.optional(),
  note: z.string().max(20000).optional(), createdAt: timestamp.optional(), updatedAt: timestamp.optional(), revision: z.number().int().min(1).optional() });
const RECORD_EVIDENCE = new Set(['artifact', 'material', 'context', 'task']);

/**
 * Import handoff history from a format 2 export into a new workspace. Records get
 * new IDs and remapped references. Tabs and browser observations belong to the
 * exporting session, so a handoff that was still open or accepted is imported as
 * cancelled history: its tab IDs must never steer input in the new profile.
 */
export function importHandoffs(items, { workspaceId, mapping, actor, loss }) {
  if (items === undefined) return [];
  if (!Array.isArray(items) || items.length > 10000) throw new Error('Invalid imported handoffs collection');
  return items.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new Error('Invalid imported handoff');
    if (Buffer.byteLength(JSON.stringify(item)) > 1024 * 1024) throw new Error('Imported handoff exceeds 1 MiB');
    const fields = importedHandoff.parse(item);
    rejectSecretKeys(fields);
    rejectSecretValues(fields, 'imported handoff');
    const at = now();
    const evidence = fields.evidence.map(entry => {
      const copy = { ...entry };
      if (entry.type === 'url') { copy.id = sanitize(entry.id) || 'about:blank'; return copy; }
      if (!RECORD_EVIDENCE.has(entry.type)) return copy; // Browser observations are historical references.
      if (mapping.has(entry.id)) copy.id = mapping.get(entry.id);
      else { copy.unresolved = true; loss('handoffs', 'evidence', 'referenced record not in export; kept as an unresolved reference'); }
      if (entry.versionId) { if (mapping.has(entry.versionId)) copy.versionId = mapping.get(entry.versionId); else copy.unresolved = true; }
      return copy;
    });
    let taskId = fields.taskId ?? null;
    if (taskId && !mapping.has(taskId)) { loss('handoffs', 'taskId', 'related task not in export; link removed'); taskId = null; } else if (taskId) taskId = mapping.get(taskId);
    const record = { ...fields, id: mapping.get(item.id), workspaceId, evidence, taskId, tabs: fields.tabs.map(tab => ({ ...tab, url: sanitize(tab.url ?? '') || 'about:blank', imported: true })),
      createdAt: fields.createdAt ?? at, updatedAt: fields.updatedAt ?? at, revision: fields.revision ?? 1, imported: { at, by: actor } };
    if (['open', 'accepted'].includes(record.status)) {
      loss('handoffs', 'status', 'open or accepted handoffs are imported as cancelled history; their tabs belong to the exporting session');
      Object.assign(record, { importedStatus: record.status, status: 'cancelled', completedBy: actor, completedAt: at, updatedAt: at, revision: record.revision + 1 });
      record.history = [...record.history, { status: 'cancelled', actor, at }].slice(-1000);
    }
    return record;
  });
}
