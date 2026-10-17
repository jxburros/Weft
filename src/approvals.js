import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fileStamp, writeVerifiedJson } from './storage-safety.js';
import { standingAllowed } from './autonomy.js';
import { summarizeArgs, minimizeUrl } from './activity-log.js';

/** The single approval queue for every surface. Approvals are created only by the gate and resolved only in the trusted GUI. */
export const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired', 'consumed', 'invalidated']);
const PENDING_MS = 15 * 60000;
const APPROVED_ONCE_MS = 15 * 60000;
const MAX_PENDING_PER_ACTOR = 25;
const id = z.string().regex(/^appr_[a-f0-9-]{36}$/);
export const approvalCommandDefinitions = {
  'approvals.list': ['List approval requests; agents see only their own requests', {
    status: z.enum([...APPROVAL_STATUSES, 'all']).default('pending'), limit: z.number().int().min(1).max(200).optional(),
  }],
  'approvals.approve': ['Human approves one pending request once, or as a standing approval for the same actor, command, workspace and destination', {
    id, mode: z.enum(['once', 'standing']).default('once'), standingMinutes: z.number().int().min(5).max(1440).default(60),
  }],
  'approvals.reject': ['Human rejects a pending approval request', { id, reason: z.string().max(500).optional() }],
};
const schemas = Object.fromEntries(Object.entries(approvalCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));

const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
/** Exact binding: command, validated arguments, actor and resolved target. Any difference produces a new request. */
export function approvalFingerprint({ command, args, actor, workspaceId, tabId, destination }) {
  return createHash('sha256').update(canonical({ command, args, actor, workspaceId: workspaceId ?? null, tabId: tabId ?? null, destination: destination ?? null })).digest('hex');
}
const origin = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : null; } catch { return null; } };
/** Human-facing preview of what is being approved; bounded. Agent-supplied text is shown as data. */
export function previewArgs(args) { return preview(args); }
/** Replace values a workflow run marked sensitive (kept only in memory) so they never reach the approval store. */
export function withholdValues(shown, values) {
  const secret = values.filter(value => typeof value === 'string' && value.length >= 2);
  if (!secret.length) return shown;
  return Object.fromEntries(Object.entries(shown).map(([key, value]) => [key, typeof value === 'string' ? secret.reduce((text, item) => text.split(item).join('[sensitive parameter withheld]'), value) : value]));
}
function preview(args) {
  const output = {};
  for (const [key, value] of Object.entries(args || {}).slice(0, 20)) {
    if (/token|secret|passw|credential|authorization|cookie|api.?key/i.test(key)) { output[key] = '[withheld]'; continue; }
    if (typeof value === 'string') output[key] = /url/i.test(key) ? minimizeUrl(value) : value.length > 400 ? `${value.slice(0, 400)}… (${value.length} characters)` : value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value;
    else output[key] = JSON.stringify(value).slice(0, 400);
  }
  return output;
}

export class ApprovalQueue {
  constructor({ directory = null, clock = Date.now, onChange = () => {} } = {}) {
    this.clock = clock;
    this.onChange = onChange;
    this.items = [];
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'approvals.json');
    this.stamp = fileStamp(this.path);
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.items)) throw new Error('Invalid approval store');
      this.items = saved.items.filter(item => item && /^appr_/.test(item.id) && APPROVAL_STATUSES.includes(item.status));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  save() {
    if (this.items.length > 1000) {
      const keep = new Set(this.items.filter(item => item.status === 'pending' || (item.status === 'approved')).map(item => item.id));
      const decided = this.items.filter(item => !keep.has(item.id));
      const drop = new Set(decided.slice(0, this.items.length - 1000).map(item => item.id));
      this.items = this.items.filter(item => !drop.has(item.id));
    }
    if (this.path) this.stamp = writeVerifiedJson(this.path, JSON.stringify({ version: 1, items: this.items }), this.stamp);
  }
  expire() {
    const now = this.clock();
    let changed = false;
    for (const item of this.items) {
      if (item.status === 'pending' && item.expiresAt <= now) { item.status = 'expired'; delete item.preview; changed = true; }
      if (item.status === 'approved' && (item.mode === 'standing' ? item.standingExpiresAt : item.expiresAt) <= now) { item.status = 'expired'; changed = true; }
    }
    if (changed) this.save();
  }
  /**
   * Consume matching approval evidence. Exact one-time approvals are consumed atomically;
   * standing approvals cover the same actor, command, workspace and destination origin until expiry.
   * `allowStanding: false` accepts only an exact one-time approval (atomic batches).
   * A consumed one-time approval is given back with restore() when the command is refused by a
   * pre-execution check before any effect, so a refused attempt does not use up the human's decision.
   */
  match({ fingerprint, actor, command, workspaceId, destination, taskId, actionClass, allowStanding = true }, isTaskOpen = () => true) {
    this.expire();
    const exact = this.items.find(item => item.status === 'approved' && item.mode === 'once' && item.fingerprint === fingerprint && item.actor === actor);
    if (exact) {
      exact.status = 'consumed'; exact.consumedAt = new Date(this.clock()).toISOString(); this.save(); this.onChange();
      return { approvedOnce: true, approvalId: exact.id };
    }
    if (!allowStanding || !standingAllowed(actionClass)) return {};
    const standing = this.items.find(item => item.status === 'approved' && item.mode === 'standing' && item.actor === actor && item.command === command
      && item.workspaceId === (workspaceId ?? null) && item.destinationOrigin === (origin(destination) ?? null)
      && (!item.taskId || (item.taskId === taskId && isTaskOpen(item.taskId))));
    if (standing) { standing.uses = (standing.uses ?? 0) + 1; this.save(); return { standing: true, approvalId: standing.id }; }
    return {};
  }
  /** Return a consumed one-time approval to approved when its command never started. Expiry still applies. */
  restore(approvalId) {
    const item = this.items.find(entry => entry.id === approvalId && entry.status === 'consumed' && entry.mode === 'once');
    if (!item) return false;
    delete item.consumedAt;
    item.status = item.expiresAt > this.clock() ? 'approved' : 'expired';
    item.restoredCount = (item.restoredCount ?? 0) + 1;
    this.save();
    this.onChange();
    return item.status === 'approved';
  }
  request({ fingerprint, actor, clientId, command, args, actionClass, categories, workspaceId, tabId, taskId, destination, reason, level, preview: shown, previewExtra = null }) {
    this.expire();
    const existing = this.items.find(item => item.status === 'pending' && item.fingerprint === fingerprint && item.actor === actor);
    if (existing) return structuredClone(existing);
    if (this.items.filter(item => item.status === 'pending' && item.actor === actor).length >= MAX_PENDING_PER_ACTOR) {
      throw Object.assign(new Error('Too many pending approval requests from this actor; wait for a human decision'), { code: 'permission_required', notStarted: true,
        details: { authority: { decision: 'deny', reason: 'approval_queue_full', actionClass } } });
    }
    const now = this.clock();
    const item = { id: `appr_${randomUUID()}`, status: 'pending', fingerprint, actor, clientId: clientId ?? null, command, actionClass, categories: categories ?? [], level: level ?? null,
      workspaceId: workspaceId ?? null, tabId: tabId ?? null, taskId: taskId ?? null, destinationOrigin: origin(destination), destination: destination ? minimizeUrl(destination) : null,
      reason, summary: summarizeArgs(args), preview: shown ?? { ...preview(args), ...(previewExtra ?? {}) }, createdAt: new Date(now).toISOString(), expiresAt: now + PENDING_MS, mode: null };
    this.items.push(item);
    this.save();
    this.onChange();
    return structuredClone(item);
  }
  /**
   * Void requests that no longer describe what would happen (ADR 019: payment terms changed, the
   * payment was cancelled or its task closed). Pending, approved and consumed one-time items become
   * `invalidated`; a consumed item can then never be given back.
   */
  invalidate(match, reason) {
    const now = new Date(this.clock()).toISOString();
    const changed = [];
    for (const item of this.items) {
      if (!['pending', 'approved', 'consumed'].includes(item.status) || !match(item)) continue;
      Object.assign(item, { status: 'invalidated', invalidatedAt: now, invalidationReason: String(reason ?? 'invalidated').slice(0, 64) });
      delete item.preview;
      changed.push(item.id);
    }
    if (changed.length) { this.save(); this.onChange(); }
    return changed;
  }
  pendingCount() { this.expire(); return this.items.filter(item => item.status === 'pending').length; }
  describe(item, human) {
    const { preview: shown, fingerprint, ...rest } = item;
    return { ...structuredClone(rest), expiresAt: new Date(item.expiresAt).toISOString(), ...(item.standingExpiresAt && { standingExpiresAt: new Date(item.standingExpiresAt).toISOString() }),
      fingerprint, ...(human && shown && { preview: structuredClone(shown) }) };
  }
  execute(name, input, context) {
    const args = schemas[name]?.parse(input);
    if (!args) throw new Error('Unknown approval command');
    const human = context.actor === 'human';
    this.expire();
    if (name === 'approvals.list') {
      const rows = this.items.filter(item => (human || item.actor === context.actor) && (args.status === 'all' || item.status === args.status)
        && (!context.workspaceIds || context.workspaceIds.includes(item.workspaceId)));
      return rows.slice(-(args.limit || 100)).reverse().map(item => this.describe(item, human));
    }
    // Resolution belongs to browser-owned UI. No API, CLI, MCP or model identity can approve, even with a human-sounding actor.
    if (!human || context.source !== 'gui') throw Object.assign(new Error('Approval decisions require the trusted browser interface'), { code: 'human_required', notStarted: true,
      details: { authority: { decision: 'deny', reason: 'human_only', actionClass: 'administration' } } });
    const item = this.items.find(entry => entry.id === args.id);
    if (!item) throw Object.assign(new Error('Approval request not found'), { code: 'not_found' });
    if (item.status !== 'pending') throw Object.assign(new Error(`Approval request is already ${item.status}`), { code: 'stale_state' });
    const now = this.clock();
    if (name === 'approvals.reject') {
      Object.assign(item, { status: 'rejected', decidedAt: new Date(now).toISOString(), decidedBy: 'human', rejectionReason: args.reason ? String(args.reason).slice(0, 500) : null });
    } else {
      if (args.mode === 'standing' && !standingAllowed(item.actionClass)) throw Object.assign(new Error('This action class requires an exact approval for every use; standing approval is not available'), { code: 'permission_required' });
      Object.assign(item, { status: 'approved', mode: args.mode, decidedAt: new Date(now).toISOString(), decidedBy: 'human', uses: 0,
        ...(args.mode === 'once' ? { expiresAt: now + APPROVED_ONCE_MS } : { standingExpiresAt: now + args.standingMinutes * 60000 }) });
    }
    delete item.preview;
    this.save();
    this.onChange();
    return this.describe(item, true);
  }
}
