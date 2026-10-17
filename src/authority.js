import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fileStamp, writeVerifiedJson } from './storage-safety.js';
import { ACTION_CLASSES, AUTONOMY_LEVELS, ONCE_ONLY_CLASSES, actionClassForCommand, raiseActionClass, dataClassesForCommand, effectForCommand, effectiveLevel,
  evaluateAutonomy, resourceForCommand, sensitiveCategoriesForCommand, EXTERNAL_CLASSES } from './autonomy.js';
import { ActivityLog, summarizeArgs } from './activity-log.js';
import { ApprovalQueue, approvalFingerprint } from './approvals.js';

const level = z.enum(AUTONOMY_LEVELS);
export const autonomyCommandDefinitions = {
  'autonomy.get': ['Describe autonomy levels, action-class handling and the caller’s effective level for a workspace', { workspaceId: z.string().min(1).max(128).optional() }],
  'autonomy.update': ['Human sets the bootstrap-token level and/or, when level is supplied, a workspace autonomy ceiling (null removes it)', {
    workspaceId: z.string().min(1).max(128).optional(), level: level.nullable().optional(), bootstrapLevel: level.optional(),
  }],
};
const schemas = Object.fromEntries(Object.entries(autonomyCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const TERMINAL_TASK = ['completed', 'failed', 'cancelled'];
const human = context => ['human', 'admin'].includes(context.actor);
/** Inspectable typed denial shared by every surface. */
export function authorityError(code, message, authority) {
  return Object.assign(new Error(message), { code, notStarted: true, details: { authority } });
}
const BLOCK_COMMANDS = new Set(['browser.emergencyStop', 'approvals.reject']);
const OVERRIDE_COMMANDS = new Set(['page.allowOnce', 'downloads.approve', 'tabs.takeover', 'browser.resumeAutomation', 'approvals.approve']);
const GRANT_COMMANDS = new Set(['clients.create', 'clients.update', 'clients.revoke', 'collections.grant', 'collections.revoke']);
const SELF_LOGGED = new Set(['approvals.approve', 'approvals.reject', 'activity.configure']);
const POLICY_COMMANDS = new Set(['autonomy.update', 'activity.configure', 'settings.update', 'siteRules.create', 'siteRules.update', 'siteRules.delete', 'lists.install', 'lists.rollback']);

/**
 * One authorization layer for GUI, REST, CLI, MCP, in-process and internal model callers.
 * Order: hard floors -> client grant (workspace, resource, class, data, destination, task, usage) ->
 * autonomy gate -> approval queue evidence. Command arguments can never supply approval or widen scope.
 */
export class Authority {
  constructor({ directory = null, workspace, browser, clients, activity, approvals, clock = Date.now } = {}) {
    this.workspace = workspace;
    this.browser = browser;
    this.clients = clients;
    this.clock = clock;
    this.activity = activity ?? new ActivityLog({ directory, clock, onPrune: options => { workspace?.pruneActivity?.(options)?.catch?.(error => console.warn(`Weft activity retention: ${error.message}`)); } });
    this.approvals = approvals ?? new ApprovalQueue({ directory, clock });
    this.policy = { bootstrapLevel: 'autonomous', workspaces: {} };
    if (directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.path = join(directory, 'authority-policy.json');
      this.stamp = fileStamp(this.path);
      try {
        const saved = JSON.parse(readFileSync(this.path, 'utf8'));
        if (saved.version !== 1) throw new Error('Unsupported authority policy store');
        this.policy = { bootstrapLevel: level.parse(saved.bootstrapLevel), workspaces: Object.fromEntries(Object.entries(saved.workspaces || {}).map(([key, value]) => [key, level.parse(value)])) };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  save() { if (this.path) this.stamp = writeVerifiedJson(this.path, JSON.stringify({ version: 1, ...this.policy }), this.stamp); }
  record(entry) { try { return this.activity.append(entry); } catch (error) { console.warn(`Weft activity: ${error.message}`); return null; } }

  identityLevel(context) {
    if (context.clientId) return this.clients?.current?.(context.clientId)?.autonomy ?? context.autonomy ?? 'scoped';
    if (context.autonomy) return context.autonomy;
    if (context.actor === 'model-reader') return 'observe';
    if (context.actor === 'automation' || context.actor === undefined) return this.policy.bootstrapLevel;
    return 'assist';
  }
  levelFor(context, workspaceId) { return effectiveLevel(this.identityLevel(context), workspaceId ? this.policy.workspaces[workspaceId] : null); }
  taskOpen(taskId) {
    if (!taskId) return true;
    const task = this.workspace?.snapshot?.().tasks?.find(item => item.id === taskId);
    return Boolean(task) && !TERMINAL_TASK.includes(task.status);
  }
  destinationFor(command, args, target) {
    if (typeof args.url === 'string' && ['tabs.new', 'page.navigate'].includes(command)) return args.url;
    if (target.tabId == null || !this.browser?.tabs?.has?.(target.tabId)) return null;
    const tab = this.browser.tabs.get(target.tabId);
    try { return tab.blocked?.url || tab.view?.webContents?.getURL?.() || tab.url || null; } catch { return tab.url || null; }
  }
  /** Workspaces a command touches, including a tab's source workspace when it moves. */
  touchedWorkspaces(command, args, target) {
    const touched = new Set(target.workspaceId ? [target.workspaceId] : []);
    if (target.tabId != null && this.browser?.tabs?.has?.(target.tabId)) touched.add(this.browser.tabs.get(target.tabId).workspaceId);
    if (command === 'tabs.move' && args.tabId != null && this.browser?.tabs?.has?.(args.tabId)) touched.add(this.browser.tabs.get(args.tabId).workspaceId);
    return [...touched].filter(Boolean);
  }

  /**
   * Decide before execution. Throws a typed denial or approval request; returns decision evidence otherwise.
   * `deferApproval` (atomic batches) returns a needed approval as a decision instead of matching or requesting one;
   * `countUse: false` leaves client usage accounting to the caller.
   */
  authorize(command, args, context, target, spec = {}, { deferApproval = false, countUse = true } = {}) {
    const actionClass = spec.actionClass ?? actionClassForCommand(command);
    const base = { command, actor: context.actor ?? 'automation', clientId: context.clientId, workspaceId: target.workspaceId, tabId: target.tabId, taskId: context.taskId, actionClass };
    if (human(context)) return { decision: 'auto', reason: 'trusted_human', actionClass };
    const deny = (reason, message, extra = {}) => {
      const authority = { decision: 'deny', reason, actionClass, ...extra };
      this.record({ ...base, type: 'decision', decision: 'deny', reason, outcome: 'denied', summary: summarizeArgs(args) });
      return authorityError('permission_required', message, authority);
    };
    const humanOnly = Boolean(spec.humanOnly) || actionClass === 'administration';
    if (humanOnly) throw deny('human_only', `${command} requires the trusted browser interface (human only)`);
    const workspaceIds = this.touchedWorkspaces(command, args, target);
    const destination = this.destinationFor(command, args, target);
    if (context.clientId) {
      try {
        this.clients.assertAllowed(command, context, { workspaceId: target.workspaceId, workspaceIds, destination, actionClass,
          resource: resourceForCommand(command), dataClasses: [...(spec.dataClasses ?? dataClassesForCommand(command)), ...(args.allowReadTools || args.attachments?.some(item => item.kind === 'tab') ? ['page_content'] : [])], createsWorkspace: ['workspaces.create', 'workspaces.duplicate'].includes(command) });
      } catch (error) {
        const reason = error.details?.authority?.reason ?? 'client_scope';
        this.record({ ...base, type: 'decision', decision: 'deny', reason, outcome: 'denied', summary: summarizeArgs(args) });
        throw Object.assign(error, { notStarted: true, details: { authority: { decision: 'deny', reason, actionClass } } });
      }
      const taskId = this.clients?.current?.(context.clientId)?.taskId ?? context.taskId;
      if (taskId && !this.taskOpen(taskId)) throw deny('task_closed', 'This client grant is bound to a task that is no longer open');
    } else if (context.workspaceIds && workspaceIds.some(id => !context.workspaceIds.includes(id))) {
      throw deny('outside_workspace_grant', 'Workspace is outside this caller’s scope');
    }
    const workspaceCap = target.workspaceId ? this.policy.workspaces[target.workspaceId] : null;
    const effective = this.levelFor(context, target.workspaceId);
    const evidence = { actor: base.actor, actionClass, level: effective, humanOnly };
    let result = evaluateAutonomy(evidence);
    let approvalId;
    let approvedOnce = false;
    if (result.decision === 'approval' && deferApproval) return { ...result, actionClass, level: effective, destination };
    if (result.decision === 'approval') {
      const fingerprint = approvalFingerprint({ command, args, actor: base.actor, workspaceId: target.workspaceId, tabId: target.tabId, destination });
      const match = this.approvals.match({ fingerprint, actor: base.actor, command, workspaceId: target.workspaceId, destination, taskId: context.taskId, actionClass }, id => this.taskOpen(id));
      if (match.approvalId) { approvalId = match.approvalId; approvedOnce = Boolean(match.approvedOnce); result = evaluateAutonomy({ ...evidence, ...match }); }
      if (result.decision === 'approval') {
        const request = this.approvals.request({ fingerprint, actor: base.actor, clientId: context.clientId, command, args, actionClass,
          categories: sensitiveCategoriesForCommand(command), workspaceId: target.workspaceId, tabId: target.tabId, taskId: context.taskId, destination, reason: result.reason, level: effective });
        this.record({ ...base, type: 'approval', decision: 'approval', reason: result.reason, outcome: 'pending_approval', approvalId: request.id, summary: summarizeArgs(args) });
        throw authorityError('approval_required', `${command} needs human approval in the Weft window (request ${request.id}). Retry the identical command after approval; changed arguments need a new approval.`,
          { decision: 'approval', reason: result.reason, actionClass, level: effective, approvalId: request.id, fingerprint, expiresAt: new Date(request.expiresAt).toISOString() });
      }
    }
    if (result.decision === 'deny') throw deny(result.reason, `Autonomy level ${effective} does not permit ${actionClass} (${command})${workspaceCap ? '; the workspace has an autonomy ceiling' : ''}`, { level: effective });
    if (context.clientId && countUse) this.clients.recordUse?.(context.clientId);
    return { ...result, actionClass, level: effective, approvalId, approvedOnce, destination };
  }

  /**
   * Atomic batches (batch.execute): every contained command passes the same floors, client grant,
   * workspace scope and autonomy checks as a standalone call, with the caller's identity. If any
   * contained command needs approval, the batch needs one exact one-time approval bound to the
   * fingerprint of the whole normalized batch (every command and argument, requestId and dryRun):
   * a standing or per-command approval never covers a combination the human did not see.
   * Client usage and rate limits count every contained command before any of them runs.
   */
  authorizeBatch(subs, args, context, target) {
    if (human(context)) return { decision: 'auto', reason: 'trusted_human', actionClass: 'local_write', commands: subs.length };
    const decisions = subs.map(sub => {
      try { return this.authorize(sub.command, sub.args, context, sub.target, sub.spec, { deferApproval: true, countUse: false }); }
      catch (error) { error.message = `batch command ${sub.index} (${sub.command}): ${error.message}`; throw error; }
    });
    const actionClass = decisions.reduce((current, decision) => raiseActionClass(current, decision.actionClass), 'local_read');
    const actor = context.actor ?? 'automation';
    const base = { command: 'batch.execute', actor, clientId: context.clientId, workspaceId: target.workspaceId, taskId: context.taskId, actionClass };
    if (context.clientId) {
      try { this.clients.assertBudget?.(context.clientId, subs.length); }
      catch (error) {
        const reason = error.details?.authority?.reason ?? 'client_scope';
        this.record({ ...base, type: 'decision', decision: 'deny', reason, outcome: 'denied', summary: summarizeArgs(args) });
        throw Object.assign(error, { notStarted: true, details: { authority: { decision: 'deny', reason, actionClass } } });
      }
    }
    const pending = decisions.filter(decision => decision.decision === 'approval');
    const level = decisions.find(decision => decision.level)?.level ?? this.levelFor(context, target.workspaceId);
    let approvalId; let approvedOnce = false;
    if (pending.length) {
      const approvalClass = pending.reduce((current, decision) => raiseActionClass(current, decision.actionClass), 'local_read');
      if (subs.length > 20) {
        this.record({ ...base, type: 'decision', decision: 'deny', reason: 'batch_too_large_for_approval', outcome: 'denied', summary: summarizeArgs(args) });
        throw authorityError('permission_required', 'A batch that needs human approval may contain at most 20 commands so the approval shows every one; split it', { decision: 'deny', reason: 'batch_too_large_for_approval', actionClass: approvalClass, level });
      }
      const fingerprint = approvalFingerprint({ command: 'batch.execute', args, actor, workspaceId: target.workspaceId, tabId: null, destination: null });
      const match = this.approvals.match({ fingerprint, actor, command: 'batch.execute', workspaceId: target.workspaceId, destination: null, taskId: context.taskId, actionClass: approvalClass, allowStanding: false });
      if (match.approvalId) { approvalId = match.approvalId; approvedOnce = true; }
      else {
        const shown = { commands: `${subs.length} commands, applied all-or-nothing` };
        subs.forEach((sub, index) => { shown[`${index + 1}. ${sub.command}`] = JSON.stringify(summarizeArgs(sub.args)).slice(0, 400); });
        const request = this.approvals.request({ fingerprint, actor, clientId: context.clientId, command: 'batch.execute', args, actionClass: approvalClass,
          categories: [...new Set(subs.flatMap(sub => sensitiveCategoriesForCommand(sub.command)))], workspaceId: target.workspaceId, tabId: null, taskId: context.taskId,
          destination: null, reason: pending[0].reason, level, preview: shown });
        this.record({ ...base, type: 'approval', decision: 'approval', reason: pending[0].reason, outcome: 'pending_approval', approvalId: request.id, summary: summarizeArgs(args) });
        throw authorityError('approval_required', `batch.execute needs human approval in the Weft window (request ${request.id}). Retry the identical batch after approval; any change to its commands or arguments needs a new approval.`,
          { decision: 'approval', reason: pending[0].reason, actionClass: approvalClass, level, approvalId: request.id, fingerprint, expiresAt: new Date(request.expiresAt).toISOString() });
      }
    }
    if (context.clientId) for (let index = 0; index < subs.length; index++) this.clients.recordUse?.(context.clientId);
    return { decision: approvedOnce ? 'auto_preapproved' : decisions.some(decision => decision.decision === 'auto_preapproved') ? 'auto_preapproved' : 'auto',
      reason: approvedOnce ? 'approved_once' : 'batch_authorized', actionClass, level, approvalId, approvedOnce, commands: subs.length };
  }
  /** Give back a one-time approval consumed by a command that a pre-execution check refused before any effect. */
  restoreApproval(decision, { command, context, target, error }) {
    if (!decision?.approvedOnce || !decision.approvalId || error?.notStarted !== true) return false;
    const restored = this.approvals.restore(decision.approvalId);
    this.record({ type: 'approval', command, actor: context.actor ?? 'automation', clientId: context.clientId, workspaceId: target.workspaceId, tabId: target.tabId, taskId: context.taskId,
      actionClass: decision.actionClass, decision: 'approve', reason: restored ? 'approval_restored' : 'approval_expired', outcome: 'recorded', approvalId: decision.approvalId,
      detail: `Refused before execution (${error.code ?? 'error'}); the one-time approval ${restored ? 'remains available for a retry of the identical command' : 'had expired'}.` });
    return restored;
  }

  /** Durable activity for every non-trivial command outcome. Human reads (GUI polling) are not logged. */
  recordOutcome({ command, args, context, outcome, decision, spec = {}, batch = null }) {
    if (!command) return;
    const actionClass = decision?.actionClass ?? spec.actionClass ?? actionClassForCommand(command);
    // A batch is as irreversible as its most irreversible command.
    const effects = batch ? batch.map(item => effectForCommand(item.command)) : [];
    const effect = effects.includes('irreversible') ? 'irreversible' : effectForCommand(command);
    const isHuman = human(context);
    const code = outcome.error?.code;
    if (isHuman && effect === 'none' && !outcome.error) return;
    if (SELF_LOGGED.has(command)) return;
    if (['approval_required'].includes(code) || (code === 'permission_required' && outcome.error?.details?.authority)) return; // Already recorded by authorize().
    const external = effect === 'external';
    const replayed = outcome.idempotency?.replayed === true;
    const dryRun = outcome.execution === 'succeeded' && outcome.result?.dryRun === true && outcome.result?.applied === false;
    let label;
    if (replayed || dryRun) label = 'recorded';
    else if (outcome.execution === 'succeeded') label = outcome.result?.partial === true || outcome.result?.status === 'partial' ? 'partial' : external ? 'externally_uncertain' : 'completed';
    else if (outcome.validation === 'failed') label = 'failed';
    else if (external && decision && ['timeout', 'action_interrupted', 'cancelled', 'transport_error', 'command_failed', 'emergency_stop'].includes(code)) label = 'externally_uncertain';
    else label = outcome.execution === 'cancelled' ? 'cancelled' : 'failed';
    const type = GRANT_COMMANDS.has(command) ? 'grant' : POLICY_COMMANDS.has(command) ? 'policy' : BLOCK_COMMANDS.has(command) ? 'block'
      : OVERRIDE_COMMANDS.has(command) ? 'override' : /site rule/i.test(outcome.error?.message || '') || code === 'site_blocked' ? 'block'
      : ['artifacts.capture', 'artifacts.create'].includes(command) && !outcome.error ? 'artifact' : 'command';
    const result = outcome.result && typeof outcome.result === 'object' ? outcome.result : {};
    let version = Number.isSafeInteger(result.version) ? result.version : undefined;
    if (version === undefined && outcome.tabId != null && this.browser?.tabs?.has?.(outcome.tabId)) version = this.browser.tabs.get(outcome.tabId).version;
    const targetId = typeof result.id === 'string' ? result.id : typeof result.clientId === 'string' ? result.clientId : typeof args?.id === 'string' ? args.id : typeof args?.clientId === 'string' ? args.clientId : undefined;
    this.record({ type, command, actor: context.actor ?? 'automation', clientId: context.clientId, workspaceId: outcome.workspaceId, tabId: outcome.tabId, taskId: context.taskId,
      targetId, version, actionClass, decision: decision?.decision, reason: decision?.reason ?? (outcome.error ? code : undefined), outcome: label,
      irreversible: effect === 'irreversible' || external, external, approvalId: decision?.approvalId,
      summary: { ...summarizeArgs(args), ...(type === 'artifact' && { versions: Array.isArray(result.versions) ? result.versions.length : undefined }),
        ...(batch && { commands: batch.map(item => item.command).slice(0, 100) }), ...(replayed && { replayed: true }), ...(typeof args?.requestId === 'string' && { requestId: args.requestId.slice(0, 128) }) },
      detail: outcome.error ? `${code}: ${outcome.error.message}` : replayed ? 'Replayed the stored result of an earlier identical request; nothing was applied again.'
        : dryRun ? 'Dry run: validated and previewed; nothing was applied.' : external ? 'Accepted by the browser or provider; the external result is not verified by this record.' : undefined });
    // Each command applied by a committed batch is attributable on its own, linked to the batch entry by requestId and position.
    if (batch && outcome.execution === 'succeeded' && !replayed && !dryRun && Array.isArray(result.results)) {
      batch.forEach((item, index) => {
        const applied = result.results[index];
        this.record({ type: 'record', command: item.command, actor: context.actor ?? 'automation', clientId: context.clientId, workspaceId: item.workspaceId ?? outcome.workspaceId, taskId: context.taskId,
          targetId: typeof applied?.id === 'string' ? applied.id : typeof item.args?.id === 'string' ? item.args.id : undefined, actionClass: actionClassForCommand(item.command), decision: decision?.decision,
          outcome: 'completed', irreversible: effectForCommand(item.command) === 'irreversible', approvalId: decision?.approvalId,
          summary: { ...summarizeArgs(item.args), batchIndex: index, batchSize: batch.length, ...(typeof args?.requestId === 'string' && { requestId: args.requestId.slice(0, 128) }) },
          detail: 'Applied as part of an atomic batch.execute transaction.' });
      });
    }
  }
  /** Before running an external-effect command, record the attempt so an interruption leaves evidence of uncertainty. */
  recordAttempt({ command, args, context, target, decision }) {
    if (effectForCommand(command) !== 'external' || human(context)) return;
    this.record({ type: 'command', command, actor: context.actor ?? 'automation', clientId: context.clientId, workspaceId: target.workspaceId, tabId: target.tabId, taskId: context.taskId,
      actionClass: decision.actionClass, decision: decision.decision, reason: decision.reason, outcome: 'attempted', external: true, irreversible: true, approvalId: decision.approvalId, summary: summarizeArgs(args) });
  }

  execute(name, input, context) {
    if (name.startsWith('approvals.')) {
      const result = this.approvals.execute(name, input, context);
      if (name !== 'approvals.list') this.record({ type: name === 'approvals.approve' ? 'override' : 'block', command: name, actor: context.actor, workspaceId: result.workspaceId, targetId: result.id,
        approvalId: result.id, decision: name === 'approvals.approve' ? 'approve' : 'reject', reason: result.mode ?? 'rejected', outcome: 'completed', summary: { approvedCommand: result.command, mode: result.mode ?? 'reject' } });
      return result;
    }
    if (name.startsWith('activity.')) return this.executeActivity(name, input, context);
    const args = schemas[name].parse(input);
    if (name === 'autonomy.get') {
      const workspaceId = args.workspaceId ?? context.workspaceId ?? null;
      return { levels: [...AUTONOMY_LEVELS], actionClasses: [...ACTION_CLASSES], onceOnlyClasses: [...ONCE_ONLY_CLASSES], externalClasses: [...EXTERNAL_CLASSES],
        bootstrapLevel: this.policy.bootstrapLevel, workspaceId, workspaceCeiling: workspaceId ? this.policy.workspaces[workspaceId] ?? null : null,
        ...(human(context) && { workspaceCeilings: structuredClone(this.policy.workspaces) }),
        callerLevel: human(context) ? 'human' : this.levelFor(context, workspaceId),
        matrix: Object.fromEntries(AUTONOMY_LEVELS.map(lvl => [lvl, Object.fromEntries(ACTION_CLASSES.map(cls => [cls, evaluateAutonomy({ actor: 'agent', actionClass: cls, level: lvl }).decision]))])) };
    }
    if (!human(context) || context.source !== 'gui') throw authorityError('human_required', 'Autonomy policy changes require the trusted browser interface', { decision: 'deny', reason: 'human_only', actionClass: 'administration' });
    const before = structuredClone(this.policy);
    if (args.bootstrapLevel) this.policy.bootstrapLevel = args.bootstrapLevel;
    if (Object.hasOwn(args, 'level')) {
      if (!args.workspaceId) throw Object.assign(new Error('Specify workspaceId for a workspace autonomy ceiling'), { code: 'invalid_arguments' });
      this.workspace?.workspace?.(args.workspaceId);
      if (args.level === null || args.level === undefined) delete this.policy.workspaces[args.workspaceId];
      else this.policy.workspaces[args.workspaceId] = args.level;
    }
    try { this.save(); } catch (error) { this.policy = before; throw error; }
    return { bootstrapLevel: this.policy.bootstrapLevel, workspaceCeilings: structuredClone(this.policy.workspaces) };
  }
  executeActivity(name, input, context) {
    if (name === 'activity.verify') return this.activity.verify();
    if (name === 'activity.configure') {
      if (!human(context) || context.source !== 'gui') throw authorityError('human_required', 'Retention changes require the trusted browser interface', { decision: 'deny', reason: 'human_only', actionClass: 'administration' });
      return this.activity.configure(input);
    }
    const { scope, ...filters } = input;
    const visible = entry => human(context) || context.actor === 'automation' && !context.workspaceIds && !context.clientId
      ? true : Boolean(entry.workspaceId) && (context.workspaceIds ?? [context.workspaceId]).includes(entry.workspaceId);
    return this.activity.list(scope === 'all' ? { ...filters, workspaceId: undefined } : filters, visible);
  }
  pendingApprovals() { return this.approvals.pendingCount(); }
}
