import { createHash, randomUUID } from 'node:crypto';
import { commands, validateCommand, CommandError } from './commands.js';
import { taskCommandDefinitions, taskPlan, taskSchemas, executorSchema, workflowParameter } from './task-commands.js';
import { TERMINAL_PHASES, executorActor, isHumanContext, normalizePhase, sameIdentity, appendTimeline } from './task-phases.js';
import { matchDestination, validDestinationPattern } from './autonomy.js';
import { summarizeArgs, minimizeUrl } from './activity-log.js';
import { rejectSecretKeys } from './export-safety.js';
import { sanitizeUrl } from './workspace.js';

/**
 * Durable task runtime (ADR 016). Executes task plans step by step through the
 * shared dispatcher as the task's bound identity, so the authority gate,
 * client grants and approvals apply to every step. Before every step it
 * commits an operation record; external work whose outcome is unknown after an
 * interruption becomes `uncertain` and is never repeated without a recorded
 * determination or an explicit human duplicate-risk confirmation.
 */
export const RUNTIME_COMMANDS = Object.freeze(Object.keys(taskCommandDefinitions));
const FORBIDDEN_STEP_COMMANDS = new Set([...RUNTIME_COMMANDS, 'chat.send', 'chat.cancel', 'handoffs.create', 'browser.close', 'browser.emergencyStop', 'browser.resumeAutomation']);
// Browser commands that need a current inspection and expectedVersion from an automation identity.
const INPUT_COMMANDS = new Set(['credentials.fill', 'payments.submit', 'page.navigate', 'page.back', 'page.forward', 'page.reload', 'page.stop', 'page.evaluate', 'page.click', 'page.fill', 'page.clickAt', 'page.press', 'page.zoom', 'tabs.close', 'tabs.move', 'tabs.pin']);
const TAB_COMMANDS = name => name.startsWith('page.') || ['artifacts.capture', 'credentials.fill', 'payments.propose', 'payments.submit'].includes(name);
// Refusals that happen before any effect: the step did not run and may be attempted again safely.
const NOT_STARTED_CODES = new Set(['approval_required', 'permission_required', 'human_required', 'site_blocked', 'stale_state', 'lease_conflict', 'tab_busy', 'ambiguous_target',
  'target_mismatch', 'invalid_arguments', 'unknown_command', 'not_found', 'idempotency_conflict', 'unsupported_capability', 'locked', 'resource_busy', 'budget_exhausted']);
const INVALIDATION = { unknown_ref: 'ref_not_found', element_detached: 'element_removed', element_changed: 'element_changed' };
const GRANT_REASONS = new Set(['grant_inactive', 'usage_limit', 'rate_limit', 'task_closed']);
const OUTPUTS_STEP = '_outputs';
const MAX_OPERATIONS = 500;
const now = () => new Date().toISOString();
const typed = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sensitiveName = /pass|card|cvv|cvc|otp|one-time|ssn|token|secret|pin\b|security.?code/i;

/** Credential references are opaque. Without a credential broker (#6, ADR 017) no reference resolves. */
export const unavailableCredentials = Object.freeze({
  status: () => ({ available: false, reason: 'The credential broker is not available in this process; credential references cannot be resolved.' }),
});
/**
 * Adapter over the credential broker (src/credentials.js): a reference resolves when it is an active
 * credential id of the same workspace. Only metadata is read; secrets never leave the broker here.
 */
export function brokerCredentials(service) {
  return {
    refresh: () => service.refresh?.().catch(() => {}),
    status(ref, { workspaceId } = {}) {
      const entry = service.cache?.find(item => item.id === ref);
      if (!entry) return { available: false, reason: `No saved sign-in ${ref} exists in the credential vault` };
      if (workspaceId && entry.workspaceId !== workspaceId) return { available: false, reason: 'The saved sign-in belongs to another workspace' };
      if (entry.state !== 'active') return { available: false, reason: `The saved sign-in is ${entry.state}` };
      return { available: true, label: entry.label, account: entry.account ?? null };
    },
  };
}

export function normalizeParameters(list = []) {
  const seen = new Set();
  return list.map(item => {
    const parsed = workflowParameter.parse(item);
    const value = typeof parsed === 'string'
      ? { name: parsed.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'p_$1').slice(0, 64) || 'parameter', label: parsed, type: 'string', required: true }
      : { label: parsed.name, ...parsed };
    if (seen.has(value.name)) throw typed('invalid_arguments', `Duplicate workflow parameter ${value.name}`);
    seen.add(value.name);
    return value;
  });
}
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;
export function placeholders(value, found = new Set()) {
  if (typeof value === 'string') for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]);
  else if (Array.isArray(value)) value.forEach(item => placeholders(item, found));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => placeholders(item, found));
  return found;
}
/** Substitute {{name}}; a whole-string placeholder keeps the value's type. */
export function substitute(value, values) {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}$/.exec(value);
    if (whole) { if (!Object.hasOwn(values, whole[1])) throw typed('invalid_arguments', `Missing parameter ${whole[1]}`); return values[whole[1]]; }
    return value.replace(PLACEHOLDER, (_, name) => { if (!Object.hasOwn(values, name)) throw typed('invalid_arguments', `Missing parameter ${name}`); return String(values[name]); });
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, values)]));
  return value;
}
/** Validation sample: the runtime supplies the workspace and the task's tab when a step omits them. */
function withRuntimeTargets(command, args) {
  const properties = commands[command]?.inputSchema?.properties ?? {};
  return { ...(properties.workspaceId && args.workspaceId == null ? { workspaceId: 'ws_runtime' } : {}), ...(properties.tabId && args.tabId == null && TAB_COMMANDS(command) ? { tabId: 1 } : {}), ...args };
}
/** Expected-URL patterns: origin and path, `*` matches any characters; query and fragment are ignored. */
export function matchUrlPattern(pattern, url) {
  let target;
  try { target = new URL(url); } catch { return false; }
  const value = `${target.origin}${target.pathname}`;
  const regex = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return regex.test(value) || regex.test(`${value.replace(/\/$/, '')}`);
}

export class TaskRuntime {
  constructor({ workspace, browser = null, admission = null, clients = null, providers = null, credentials = unavailableCredentials, onEvent = () => {}, pollMs = 30000 } = {}) {
    Object.assign(this, { workspace, browser, admission, clients, providers, onEvent, pollMs });
    this.credentials = credentials?.execute && Array.isArray(credentials.cache) ? brokerCredentials(credentials) : credentials ?? unavailableCredentials;
    this.active = new Map();
    this.sensitive = new Map();
    this.recordings = new Map();
    this.reconcilers = new Map([['model', operation => this.lookupModelTurn(operation)]]);
    this.activity = null;
    if (workspace) workspace.onTaskTransition = notice => this.recordTransition(notice);
  }
  /** Called by createDispatcher: the runtime dispatches every step through the shared gate. */
  attach({ dispatch, authority, providers, clients, browser, admission }) {
    this.dispatch = dispatch;
    this.authority = authority;
    this.activity = authority?.activity ?? this.activity;
    this.providers ??= providers; this.clients ??= clients; this.browser ??= browser; this.admission ??= admission;
    if (this.browser) this.browser.onNavigate = details => this.recordNavigation(details);
    return this;
  }
  /**
   * Register a recorded-lookup reconciler for an operation kind or command (for example a
   * payment provider status lookup). It returns { status: 'completed'|'not_completed'|'unknown', detail?, evidence? }
   * and must not repeat the operation.
   */
  registerReconciler(kind, lookup) {
    if (typeof kind !== 'string' || !/^[a-z][\w.-]{1,63}$/i.test(kind) || typeof lookup !== 'function') throw new Error('Invalid reconciler registration');
    this.reconcilers.set(kind, lookup);
  }
  start() {
    clearInterval(this.timer);
    // Approval-resume polling reads task records: it does nothing while an encrypted profile is locked (ADR 014).
    this.timer = setInterval(() => { if (!this.workspace?.locked) this.resumeApprovals().catch(() => {}); }, this.pollMs);
    this.timer.unref?.();
    return this;
  }
  /**
   * An encrypted profile is about to lock (ADR 014): stop scheduling, and pause running or queued
   * runtime tasks as if by a person, so only a person continues them after unlock. Steps already
   * submitted cannot be recalled; their outcomes cannot be written while locked, so the startup
   * sweep run at unlock records attempted external steps as uncertain and local ones as interrupted.
   */
  async suspendForLock() {
    clearInterval(this.timer);
    this.timer = null;
    for (const recording of this.recordings.values()) recording.stopCapture?.();
    this.recordings.clear();
    if (this.workspace?.locked) return { paused: [] };
    const paused = [];
    for (const task of this.tasks().filter(item => item.executor && ['running', 'queued'].includes(normalizePhase(item.status)))) {
      const inFlight = this.submitted(task.id);
      await this.update(task.id, record => {
        record.run.pausedBy = 'human';
        this.setBlocker(record, { kind: 'locked', message: inFlight.length ? 'Weft was locked while a step was submitted; its outcome is checked when a person unlocks Weft. A person continues the task.' : 'Weft was locked; a person continues the task after unlocking.' });
        this.transition(record, 'paused', 'system', 'profile_locked', inFlight.length ? `Already submitted: ${inFlight.map(item => item.command).join(', ')}` : '');
      }).catch(() => {});
      paused.push(task.id);
    }
    return { paused };
  }
  close() { clearInterval(this.timer); for (const recording of this.recordings.values()) recording.stopCapture?.(); this.recordings.clear(); }
  audit(entry) { try { this.activity?.append(entry); } catch (error) { console.warn(`Weft task activity: ${error.message}`); } }
  recordTransition(notice) {
    this.audit({ type: 'task', command: 'tasks.transition', actor: notice.actor, workspaceId: notice.workspaceId, taskId: notice.taskId, targetId: notice.taskId, reason: notice.reason,
      outcome: 'recorded', summary: { from: notice.from ?? 'new', to: notice.to, ...(notice.stepId ? { stepId: notice.stepId } : {}) }, detail: notice.note });
    try { this.onEvent({ type: 'task', status: notice.to, taskId: notice.taskId, workspaceId: notice.workspaceId, actor: notice.actor }); } catch { /* events are best effort */ }
  }

  // ---- Records ---------------------------------------------------------------------------
  task(id, context = {}) { return structuredClone(this.workspace.record('tasks', id, context.workspaceId ? { workspaceId: context.workspaceId } : {})); }
  tasks() { return this.workspace.data.tasks; }
  update(id, mutate) { return this.workspace.mutateTask(id, mutate); }
  transition(record, to, actor, reason, note = '', stepId = null) {
    if (normalizePhase(record.status) === to) return null;
    return this.workspace.transitionTask(record, to, { actor, reason, note, stepId });
  }
  stepState(record, stepId) {
    record.run.steps ??= {};
    return (record.run.steps[stepId] ??= { phase: 'pending', attempts: 0 });
  }
  setBlocker(record, blocker) {
    record.run.blocker = blocker;
    record.blocker = blocker ? String(blocker.message ?? '').slice(0, 2000) : '';
  }
  operation(record, operationId) { return record.operations?.find(item => item.id === operationId); }
  lastOperation(record, stepId) { return [...(record.operations ?? [])].reverse().find(item => item.stepId === stepId); }
  unresolved(op) { return op && ['attempted', 'uncertain'].includes(op.status) && !['completed', 'not_completed', 'unknown'].includes(op.determination?.status); }

  // ---- Identity and steering ----------------------------------------------------------------
  /** Dispatcher context for the task's bound identity; never a human context. */
  identity(task) {
    const base = { source: 'task', taskId: task.id, workspaceIds: [task.workspaceId] };
    const executor = task.executor;
    if (executor?.type === 'client') {
      const grant = this.clients?.current?.(executor.clientId);
      return { ...base, actor: `client:${executor.clientId}`, clientId: executor.clientId, ...(grant ? { workspaceIds: [...grant.workspaceIds] } : {}) };
    }
    if (executor?.type === 'automation') return { ...base, actor: 'automation' };
    return { ...base, actor: executorActor(executor ?? { type: 'runner' }, task.id), autonomy: executor?.autonomy ?? 'scoped' };
  }
  actorOf(context) { return isHumanContext(context) ? 'human' : String(context.actor ?? 'automation'); }
  assertSteer(task, context) {
    if (isHumanContext(context) || sameIdentity(task.executor, context)) return;
    throw typed('permission_required', 'Only a person or the identity this task runs as may steer it', { notStarted: true, details: { authority: { decision: 'deny', reason: 'not_task_executor', actionClass: 'local_write' } } });
  }
  /** Humans bind any identity; agents (an existing grant) bind only themselves. */
  resolveExecutor(requested, context, workspaceId) {
    if (isHumanContext(context)) {
      const executor = executorSchema.parse(requested ?? { type: 'runner', autonomy: 'scoped' });
      if (executor.type === 'client') {
        const grant = this.clients?.current?.(executor.clientId);
        if (!grant) throw typed('invalid_arguments', 'That agent connection is expired, revoked or unknown', { field: 'executor.clientId' });
        if (!grant.workspaceIds.includes(workspaceId)) throw typed('invalid_arguments', 'That agent connection is not granted this task’s workspace', { field: 'executor.clientId' });
      }
      return executor;
    }
    const own = context.clientId ? { type: 'client', clientId: context.clientId } : context.actor === 'automation' ? { type: 'automation' } : null;
    if (!own || (requested && JSON.stringify(executorSchema.parse(requested)) !== JSON.stringify(own))) {
      throw typed('permission_required', 'Agents may start tasks only as themselves; a person chooses any other identity in Weft', { notStarted: true,
        details: { authority: { decision: 'deny', reason: 'executor_not_self', actionClass: 'local_write' } } });
    }
    return own;
  }
  label(executor) { return executor.type === 'client' ? `agent connection ${executor.clientId.slice(0, 8)}` : executor.type === 'automation' ? 'automation token' : `Weft task runner (${executor.autonomy})`; }

  // ---- Plans ---------------------------------------------------------------------------------
  /** Validate executable steps and assign stable ids. Saving a plan never runs it. */
  validatePlan(steps, taken = new Set(), { allowPlaceholders = false } = {}) {
    const plan = taskPlan.parse(steps);
    let counter = taken.size;
    return plan.map((step, index) => {
      const fail = (message, field = '') => { throw new CommandError({ code: 'invalid_arguments', message: `Step ${index + 1} (${step.title}): ${message}`, field: `steps.${index}${field ? `.${field}` : ''}` }); };
      let id = step.id;
      if (!id) { do id = `s${++counter}`; while (taken.has(id)); }
      if (taken.has(id) || id === OUTPUTS_STEP) fail('duplicate or reserved step id', 'id');
      taken.add(id);
      if (step.kind === 'command') {
        const spec = commands[step.command];
        if (!spec) fail(`unknown command ${step.command}`, 'command');
        if (spec.humanOnly || spec.actionClass === 'administration') fail(`${step.command} is human-only and cannot run inside a task`, 'command');
        if (FORBIDDEN_STEP_COMMANDS.has(step.command)) fail(`${step.command} cannot be a command step; use a model or handoff step, or the task controls`, 'command');
        try { rejectSecretKeys(step.args ?? {}); } catch (error) { fail(error.message, 'args'); }
        if (!placeholders(step.args ?? {}).size) {
          try { validateCommand(step.command, withRuntimeTargets(step.command, step.args ?? {})); } catch (error) { fail(error.message, 'args'); }
        } else if (!allowPlaceholders) fail('{{placeholders}} are available only in workflows', 'args');
      }
      if (step.expect?.urlPattern && !/^https?:\/\/[^/\s]+/.test(step.expect.urlPattern)) fail('urlPattern must start with an http(s) origin', 'expect.urlPattern');
      return { ...step, id };
    });
  }
  planDigest(plan) { return hash(plan.map(({ id, kind, command, args, prompt }) => ({ id, kind, command, args, prompt }))).slice(0, 16); }
  inputs(record) {
    const materials = Object.fromEntries((record.materialIds ?? []).flatMap(id => { const item = this.workspace.data.materials.find(material => material.id === id); return item ? [[id, item.revision]] : []; }));
    const workflow = record.workflowRun ? this.workspace.data.workflows.find(item => item.id === record.workflowRun.workflowId) : null;
    return { materials, ...(workflow ? { workflow: { id: workflow.id, revision: workflow.revision } } : {}), modelId: record.modelId ?? null, planDigest: this.planDigest(record.plan ?? []) };
  }

  // ---- Commands ------------------------------------------------------------------------------
  async execute(name, input, context = {}) {
    const args = taskSchemas[name].parse(input);
    switch (name) {
      case 'tasks.start': return this.startTask(args, context);
      case 'tasks.pause': return this.pause(args, context);
      case 'tasks.continue': return this.continueTask(args, context);
      case 'tasks.cancel': return this.cancel(args, context);
      case 'tasks.redirect': return this.redirect(args, context);
      case 'tasks.reassign': return this.reassign(args, context);
      case 'tasks.review': return this.review(args, context);
      case 'tasks.reconcile': return this.reconcile(args, context);
      case 'tasks.retryStep': return this.retryStep(args, context);
      case 'workflows.run': await this.credentials.refresh?.(); return this.runWorkflow(args, context);
      case 'workflows.validate': await this.credentials.refresh?.(); return this.validateWorkflow(this.workspace.record('workflows', args.id, context.workspaceId ? { workspaceId: context.workspaceId } : {}), args.parameters);
      case 'workflows.recordStart': return this.recordStart(args, context);
      case 'workflows.recordStop': return this.recordStop(args, context);
    }
    throw typed('unknown_command', `Unknown task runtime command ${name}`);
  }

  async startTask(args, context, extra = {}) {
    const task = this.task(args.id, context);
    const status = normalizePhase(task.status);
    if (task.executor && status !== 'queued') throw typed('stale_state', `Task is ${status}; use tasks.continue, tasks.retryStep or tasks.reconcile`, { notStarted: true });
    if (!task.executor && (TERMINAL_PHASES.includes(status) || ['running', 'uncertain'].includes(status))) throw typed('stale_state', `A ${status} task record cannot be started; reopen it as queued first`, { notStarted: true });
    if (!task.plan?.length) throw typed('invalid_arguments', 'This task has no executable steps; add steps to its plan before starting it', { field: 'plan' });
    const executor = this.resolveExecutor(args.executor, context, task.workspaceId);
    const plan = this.validatePlan(task.plan, new Set(), { allowPlaceholders: Boolean(task.workflowRun) });
    const actor = this.actorOf(context);
    const started = await this.update(task.id, record => {
      record.executor = executor;
      record.plan = plan;
      if (args.modelId !== undefined) record.modelId = args.modelId;
      record.assignee = this.label(executor);
      record.operations ??= [];
      record.run = { cursor: 0, steps: {}, startedAt: now(), startedBy: actor, tabId: extra.tabId ?? record.run?.tabId ?? record.tabIds?.[0] ?? null, planDigest: this.planDigest(plan) };
      record.run.inputs = this.inputs(record);
      this.setBlocker(record, null);
      record.progress = 0;
      record.nextStep = plan[0]?.title ?? '';
      this.transition(record, 'running', actor, 'started', `Runs as ${this.label(executor)}`);
    });
    this.schedule(task.id);
    return started;
  }

  async pause(args, context) {
    const task = this.task(args.id, context);
    this.assertManaged(task);
    this.assertSteer(task, context);
    const status = normalizePhase(task.status);
    if (!['running', 'waiting_on_human', 'queued'].includes(status)) throw typed('stale_state', `Task is ${status}, not running or waiting`, { notStarted: true });
    const submitted = this.submitted(task.id);
    return { ...(await this.update(task.id, record => {
      record.run.pausedBy = isHumanContext(context) ? 'human' : 'executor';
      this.transition(record, 'paused', this.actorOf(context), 'pause_requested', [args.note, submitted.length ? `${submitted.length} already-submitted step(s) finish and are recorded; nothing new is scheduled` : ''].filter(Boolean).join(' · '));
    })), submitted };
  }

  async cancel(args, context) {
    const task = this.task(args.id, context);
    this.assertManaged(task);
    this.assertSteer(task, context);
    const status = normalizePhase(task.status);
    if (TERMINAL_PHASES.includes(status)) throw typed('stale_state', `Task is already ${status}`, { notStarted: true });
    const submitted = this.submitted(task.id);
    // A running model turn is stopped (its partial reply is kept); other submitted work cannot be recalled.
    for (const item of submitted) if (item.kind === 'model' && task.run?.conversationId) await this.providers?.execute?.('chat.cancel', { conversationId: task.run.conversationId }, { actor: 'human' }).catch(() => {});
    return { ...(await this.update(task.id, record => {
      this.setBlocker(record, null);
      this.transition(record, 'cancelled', this.actorOf(context), 'cancel_requested', [args.note, submitted.length ? 'Work already submitted is reported, not undone' : ''].filter(Boolean).join(' · '));
    })), submitted };
  }

  submitted(taskId) {
    const slot = this.active.get(taskId);
    return slot?.inFlight ? [{ operationId: slot.inFlight.operationId, stepId: slot.inFlight.stepId, command: slot.inFlight.command, kind: slot.inFlight.kind, external: slot.inFlight.external }] : [];
  }
  assertManaged(task) {
    if (!task.executor || !task.run) throw typed('invalid_arguments', 'This task record is not run by the task runtime; start it with tasks.start or change its state with tasks.transition', { field: 'id' });
  }

  async continueTask(args, context) {
    const task = this.task(args.id, context);
    this.assertManaged(task);
    this.assertSteer(task, context);
    const human = isHumanContext(context);
    const status = normalizePhase(task.status);
    if (status === 'uncertain') throw typed('duplicate_risk', 'This task has external work with an unknown outcome. Record what happened with tasks.reconcile, or retry it with tasks.retryStep and confirmDuplicateRisk: true', { notStarted: true });
    if (!['paused', 'waiting_on_human'].includes(status)) throw typed('stale_state', `Task is ${status}; only paused or waiting tasks continue`, { notStarted: true });
    const step = task.plan[task.run.cursor];
    if (this.active.get(task.id)?.inFlight) throw typed('stale_state', 'A step submitted before the pause is still in flight; continue after its outcome is recorded', { notStarted: true });
    if (step && this.unresolved(this.lastOperation(task, step.id))) throw typed('duplicate_risk', 'The current step has an unresolved external operation; reconcile it first', { notStarted: true });
    if (!human && task.run.pausedBy === 'human') throw typed('permission_required', 'A person paused or stopped this task; only a person can continue it', { notStarted: true, details: { authority: { decision: 'deny', reason: 'human_paused', actionClass: 'local_write' } } });
    if (task.run.blocker?.kind === 'review' || task.run.blocker?.kind === 'expected_outputs') throw typed('human_required', 'This task is waiting at a review checkpoint; decide it with tasks.review', { notStarted: true });
    if ((args.disclosureAck || args.parameters) && !human) throw typed('human_required', 'Only a person acknowledges model disclosure or enters sensitive parameters', { notStarted: true });
    if (this.admission?.status?.stopped && !human) throw typed('emergency_stop', 'Automation is stopped. Resume it from the trusted browser interface.', { notStarted: true });
    if (this.admission?.status?.stopped) throw typed('emergency_stop', 'Automation is stopped; resume automation before continuing tasks', { notStarted: true });
    if (args.parameters) {
      rejectSecretKeys(args.parameters);
      const declared = new Set((task.workflowRun?.sensitive ?? []));
      for (const name of Object.keys(args.parameters)) if (!declared.has(name)) throw typed('invalid_arguments', `${name} is not a sensitive parameter of this run`, { field: `parameters.${name}` });
      this.sensitive.set(task.id, { ...(this.sensitive.get(task.id) ?? {}), ...args.parameters });
    }
    const result = await this.update(task.id, record => {
      if (args.disclosureAck && step) record.run.disclosureAck = step.id;
      record.run.pausedBy = null;
      this.setBlocker(record, null);
      this.transition(record, 'running', this.actorOf(context), 'continued', args.note ?? '');
    });
    this.schedule(task.id);
    return result;
  }

  async redirect(args, context) {
    const task = this.task(args.id, context);
    this.assertManaged(task);
    this.assertSteer(task, context);
    const status = normalizePhase(task.status);
    if (TERMINAL_PHASES.includes(status)) throw typed('stale_state', `Task is ${status}; reopen or create a new task`, { notStarted: true });
    const cursor = task.run.cursor;
    const current = task.plan[cursor];
    // Steps that started (or hold uncertain work) stay; everything not started may be replaced.
    const last = current ? this.lastOperation(task, current.id) : null;
    const keep = current && (this.active.get(task.id)?.inFlight || this.unresolved(last) || last?.status === 'interrupted') ? cursor + 1 : cursor;
    let replacement;
    if (args.steps) replacement = this.validatePlan(args.steps, new Set(task.plan.slice(0, keep).map(step => step.id)), { allowPlaceholders: Boolean(task.workflowRun) });
    const changed = ['objective', 'nextStep', 'modelId'].filter(key => args[key] !== undefined).concat(args.steps ? ['steps'] : []);
    if (!changed.length) throw typed('invalid_arguments', 'Supply objective, nextStep, modelId or steps to redirect the task', { field: 'steps' });
    return this.update(task.id, record => {
      for (const key of ['objective', 'nextStep', 'modelId']) if (args[key] !== undefined) record[key] = args[key];
      if (replacement) {
        record.plan = [...record.plan.slice(0, keep), ...replacement];
        record.run.planDigest = this.planDigest(record.plan);
        if (!args.nextStep) record.nextStep = record.plan[record.run.cursor]?.title ?? '';
      }
      appendTimeline(record, { type: 'redirect', actor: this.actorOf(context), reason: 'redirected', changed, ...(args.note ? { note: args.note } : {}), at: now() });
    });
  }

  async reassign(args, context) {
    const task = this.task(args.id, context);
    if (!isHumanContext(context)) throw typed('human_required', 'Only a person reassigns a task to another identity', { notStarted: true });
    const executor = args.executor ? this.resolveExecutor(args.executor, context, task.workspaceId) : null;
    if (!executor && args.assignee === undefined) throw typed('invalid_arguments', 'Supply executor or assignee', { field: 'executor' });
    return this.update(task.id, record => {
      if (executor) { record.executor = executor; record.assignee = this.label(executor); }
      if (args.assignee !== undefined) record.assignee = args.assignee;
      if (record.run?.blocker?.kind === 'grant') this.setBlocker(record, { kind: 'grant_changed', message: 'The task now runs as a different identity; continue it to retry the step.' });
      appendTimeline(record, { type: 'reassign', actor: 'human', reason: 'reassigned', to: record.assignee, ...(args.note ? { note: args.note } : {}), at: now() });
    });
  }

  async review(args, context) {
    const task = this.task(args.id, context);
    this.assertManaged(task);
    if (!isHumanContext(context)) throw typed('human_required', 'Review checkpoints are decided by a person in Weft', { notStarted: true });
    const blocker = task.run.blocker;
    if (normalizePhase(task.status) !== 'waiting_on_human' || !['review', 'expected_outputs'].includes(blocker?.kind) || blocker.stepId !== args.stepId) throw typed('stale_state', 'That step is not waiting for review', { notStarted: true });
    if (args.decision === 'edit' && !args.steps) throw typed('invalid_arguments', 'Edit needs the replacement steps', { field: 'steps' });
    if (args.decision === 'edit' && args.stepId === OUTPUTS_STEP) throw typed('invalid_arguments', 'Expected outputs are confirmed or rejected, not edited', { field: 'decision' });
    let replacement;
    if (args.decision === 'edit') replacement = this.validatePlan(args.steps, new Set(task.plan.slice(0, task.run.cursor).map(step => step.id)), { allowPlaceholders: Boolean(task.workflowRun) });
    const result = await this.update(task.id, record => {
      const entry = { type: 'review', actor: 'human', stepId: args.stepId, decision: args.decision, ...(args.note ? { note: args.note } : {}), at: now() };
      appendTimeline(record, entry);
      if (args.decision === 'reject') {
        this.setBlocker(record, { kind: 'review_rejected', stepId: args.stepId, message: `Review rejected${args.note ? `: ${args.note}` : ''}. Redirect or cancel the task.` });
        record.run.pausedBy = 'human';
        this.transition(record, 'paused', 'human', 'review_rejected', args.note ?? '', args.stepId);
        return;
      }
      if (replacement) { record.plan = [...record.plan.slice(0, record.run.cursor), ...replacement]; record.run.planDigest = this.planDigest(record.plan); }
      if (args.stepId === OUTPUTS_STEP) record.run.outputsConfirmed = true;
      else {
        const step = record.plan[record.run.cursor];
        const state = this.stepState(record, step.id);
        state.reviewed = true;
        if (step.kind === 'review') this.completeStep(record, step, { reviewedBy: 'human' });
      }
      this.setBlocker(record, null);
      this.transition(record, 'running', 'human', args.decision === 'edit' ? 'review_edited' : 'review_approved', args.note ?? '', args.stepId);
    });
    if (args.decision !== 'reject') this.schedule(task.id);
    return result;
  }

  async reconcile(args, context) {
    if (!isHumanContext(context)) throw typed('human_required', 'Determinations about uncertain work are recorded by a person', { notStarted: true });
    const task = this.task(args.id, context);
    const op = this.operation(task, args.operationId);
    if (!op) throw typed('not_found', 'Operation not found on this task');
    if (!this.unresolved(op) || this.active.get(task.id)?.inFlight?.operationId === op.id) throw typed('stale_state', `Operation is ${op.status}${op.determination ? ` (${op.determination.status})` : ''}; only unresolved uncertain work is reconciled`, { notStarted: true });
    let determination = { status: args.determination, source: 'human', actor: 'human', at: now(), ...(args.note ? { note: args.note } : {}), ...(args.evidence ? { evidence: args.evidence } : {}) };
    if (args.determination === 'lookup') {
      const lookup = this.reconcilers.get(op.reconcileKind ?? op.kind) ?? this.reconcilers.get(op.command);
      if (!lookup) throw typed('unsupported', `No recorded lookup exists for ${op.command}. Check the destination yourself and record completed or not_completed.`);
      const found = await lookup(structuredClone(op), { task, workspace: this.workspace });
      const status = ['completed', 'not_completed'].includes(found?.status) ? found.status : 'unknown';
      determination = { status, source: 'recorded_lookup', actor: 'human', at: now(), ...(found?.detail ? { detail: String(found.detail).slice(0, 2000) } : {}), ...(Array.isArray(found?.evidence) ? { evidence: found.evidence.slice(0, 20).map(String) } : {}) };
    }
    const result = await this.update(task.id, record => {
      const target = this.operation(record, op.id);
      target.lookups = [...(target.lookups ?? []), determination].slice(-20);
      appendTimeline(record, { type: 'reconcile', actor: 'human', reason: 'reconciled', operationId: op.id, stepId: op.stepId, determination: determination.status, source: determination.source, at: determination.at });
      if (determination.status === 'unknown') return;
      target.determination = determination;
      target.status = determination.status;
      const index = record.plan.findIndex(step => step.id === op.stepId);
      const step = record.plan[index];
      if (determination.status === 'completed' && step && index === record.run.cursor) this.completeStep(record, step, { reconciled: true, operationId: op.id });
      else if (step) this.stepState(record, step.id).phase = 'pending';
      if (normalizePhase(record.status) === 'uncertain') {
        this.setBlocker(record, args.continue ? null : { kind: 'reconciled', message: 'Outcome recorded; continue the task when ready.' });
        this.transition(record, args.continue ? 'running' : 'paused', 'human', 'reconciled', `${op.command}: ${determination.status} (${determination.source})`, op.stepId);
      }
    });
    this.audit({ type: 'task', command: 'tasks.reconcile', actor: 'human', workspaceId: task.workspaceId, taskId: task.id, targetId: op.id, reason: determination.source, outcome: 'recorded',
      summary: { operationId: op.id, operation: op.command, determination: determination.status, source: determination.source } });
    if (normalizePhase(result.status) === 'running') this.schedule(task.id);
    return { task: result, operationId: op.id, determination };
  }

  async retryStep(args, context) {
    if (!isHumanContext(context)) throw typed('human_required', 'Only a person retries a failed or uncertain step', { notStarted: true });
    const task = this.task(args.id, context);
    this.assertManaged(task);
    const stepId = args.stepId ?? task.plan[task.run.cursor]?.id;
    const index = task.plan.findIndex(step => step.id === stepId);
    if (index < 0 || index !== task.run.cursor) throw typed('invalid_arguments', 'Only the current step can be retried', { field: 'stepId' });
    if (this.active.get(task.id)?.inFlight) throw typed('stale_state', 'A step is still in flight', { notStarted: true });
    const op = this.lastOperation(task, stepId);
    const status = normalizePhase(task.status);
    if (!['failed', 'uncertain', 'paused'].includes(status)) throw typed('stale_state', `Task is ${status}; only failed, uncertain or paused steps are retried`, { notStarted: true });
    const uncertain = this.unresolved(op) && op.external;
    // No blind consequential retries: repeating uncertain external work needs an explicit human acceptance of the duplicate risk.
    if (uncertain && args.confirmDuplicateRisk !== true) {
      throw typed('duplicate_risk', `${op.command} may already have happened. Reconcile it, or retry with confirmDuplicateRisk: true to accept that it may happen twice.`, { notStarted: true });
    }
    const result = await this.update(task.id, record => {
      const target = op ? this.operation(record, op.id) : null;
      if (uncertain) target.determination = { status: 'unknown', source: 'human', actor: 'human', duplicateRiskAccepted: true, at: now(), ...(args.note ? { note: args.note } : {}) };
      this.stepState(record, stepId).phase = 'pending';
      this.stepState(record, stepId).retryAuthorized = true;
      record.run.pausedBy = null;
      this.setBlocker(record, null);
      this.transition(record, 'running', 'human', uncertain ? 'retry_confirmed' : 'retry', args.note ?? '', stepId);
    });
    if (uncertain) this.audit({ type: 'task', command: 'tasks.retryStep', actor: 'human', workspaceId: task.workspaceId, taskId: task.id, targetId: op.id, reason: 'duplicate_risk_accepted', outcome: 'recorded', summary: { operationId: op.id, operation: op.command } });
    this.schedule(task.id);
    return result;
  }

  // ---- Driving --------------------------------------------------------------------------------
  schedule(taskId) {
    if (this.active.has(taskId)) { this.active.get(taskId).again = true; return this.active.get(taskId).promise; }
    const slot = { inFlight: null, again: false };
    this.active.set(taskId, slot);
    slot.promise = (async () => {
      try { do { slot.again = false; await this.drive(taskId, slot); } while (slot.again); }
      catch (error) { await this.recover(taskId, error).catch(() => console.warn(`Weft task ${taskId}: ${error.message}`)); }
      finally { this.active.delete(taskId); }
    })();
    return slot.promise;
  }
  /** An unexpected runtime failure never leaves a task looking as if it still runs. */
  async recover(taskId, error) {
    await this.update(taskId, record => {
      const open = (record.operations ?? []).filter(op => op.status === 'attempted');
      for (const op of open) Object.assign(op, op.external ? { status: 'uncertain', error: { code: 'runtime_error', message: 'The runtime failed while this step was in flight; its outcome is unknown.' } } : { status: 'interrupted' });
      const uncertain = open.some(op => op.external);
      const phase = normalizePhase(record.status);
      this.setBlocker(record, { kind: uncertain ? 'uncertain' : 'runtime_error', message: `Task runtime error: ${String(error.message).slice(0, 300)}` });
      if (['running', 'paused'].includes(phase) && uncertain) this.transition(record, 'uncertain', 'system', 'external_outcome_unknown');
      else if (phase === 'running') this.transition(record, 'paused', 'system', 'step_failed', String(error.message).slice(0, 300));
    });
  }
  /** Settles when the task's current drive loop (if any) finishes; for tests and shutdown. */
  idle(taskId) { return this.active.get(taskId)?.promise ?? Promise.resolve(); }

  async drive(taskId, slot) {
    for (let guard = 0; guard < 1000; guard++) {
      let task;
      try { task = this.task(taskId); } catch { return; }
      if (normalizePhase(task.status) !== 'running') return;
      const actor = executorActor(task.executor, task.id);
      if (this.admission?.status?.stopped) {
        await this.update(taskId, record => { record.run.pausedBy = 'human'; this.setBlocker(record, { kind: 'emergency_stop', message: 'Automation is stopped; a person resumes automation and continues the task.' }); this.transition(record, 'paused', 'system', 'emergency_stop'); });
        return;
      }
      const step = task.plan[task.run.cursor];
      if (!step) {
        await this.update(taskId, record => {
          if (record.workflowRun?.expectedOutputs?.trim() && !record.run.outputsConfirmed) {
            this.setBlocker(record, { kind: 'expected_outputs', stepId: OUTPUTS_STEP, expectedOutputs: record.workflowRun.expectedOutputs, message: 'Confirm the expected outputs were produced before this run is complete.' });
            this.transition(record, 'waiting_on_human', actor, 'expected_outputs_review');
            return;
          }
          record.progress = 100; record.nextStep = '';
          this.setBlocker(record, null);
          this.transition(record, 'completed', actor, 'plan_completed', `${record.plan.length} step(s) completed`);
        });
        return;
      }
      const state = task.run.steps?.[step.id] ?? {};
      if ((step.kind === 'review' || step.reviewRequired) && !state.reviewed) {
        await this.update(taskId, record => {
          this.stepState(record, step.id).phase = 'waiting';
          this.setBlocker(record, { kind: 'review', stepId: step.id, instruction: step.instruction ?? '', message: `Review: ${step.title}` });
          this.transition(record, 'waiting_on_human', actor, 'review_required', '', step.id);
        });
        return;
      }
      if (step.kind === 'review') { await this.update(taskId, record => this.completeStep(record, step, {})); continue; }
      let outcome;
      try { outcome = await this.runStep(task, step, slot); }
      catch (error) {
        if (error.code !== 'invalid_arguments' || !/Missing parameter/.test(error.message)) throw error;
        outcome = await this.pauseFor(taskId, { kind: 'parameters_required', stepId: step.id, message: `${error.message}; redirect the step or rerun the workflow with the parameter.` }, 'parameters_required', { stepId: step.id });
      }
      if (outcome !== 'continue') return;
    }
  }

  completeStep(record, step, result) {
    const state = this.stepState(record, step.id);
    Object.assign(state, { phase: 'completed', completedAt: now(), ...(result && Object.keys(result).length ? { result } : {}) });
    record.run.cursor = Math.max(record.run.cursor, record.plan.findIndex(item => item.id === step.id) + 1);
    record.progress = Math.round(record.run.cursor / Math.max(1, record.plan.length) * 100);
    record.checkpoint = `Completed ${record.run.cursor} of ${record.plan.length}: ${step.title}`.slice(0, 2000);
    record.nextStep = record.plan[record.run.cursor]?.title ?? '';
    // Inputs the latest step result was produced from; later changes mark the results stale.
    record.run.inputs = this.inputs(record);
  }

  /** Parameter values for a workflow run: stored non-sensitive values plus in-memory sensitive ones. */
  values(task) {
    const run = task.workflowRun;
    if (!run) return {};
    const sensitive = this.sensitive.get(task.id) ?? {};
    const missing = (run.sensitive ?? []).filter(name => !Object.hasOwn(sensitive, name));
    return { values: { ...run.parameters, ...sensitive }, missing };
  }

  async pauseFor(taskId, blocker, reason, { phase = 'paused', stepId = null, note = '' } = {}) {
    await this.update(taskId, record => {
      this.setBlocker(record, blocker);
      if (normalizePhase(record.status) === 'running') this.transition(record, phase, executorActor(record.executor, record.id), reason, note || blocker?.message || '', stepId);
    });
    return 'stop';
  }

  async runStep(task, step, slot) {
    const context = this.identity(task);
    if (step.kind === 'handoff') return this.invoke(task, step, slot, context, 'handoffs.create', {
      workspaceId: task.workspaceId, to: step.to ?? 'human', objective: (task.objective || task.title).slice(0, 20000), nextStep: (step.instruction || step.title).slice(0, 20000), taskId: task.id,
      completedActions: task.plan.slice(0, task.run.cursor).map(item => item.title.slice(0, 2000)).slice(-100),
    }, { kind: 'handoff' });
    let parameters = {};
    if (task.workflowRun) {
      const { values, missing } = this.values(task);
      const needed = [...placeholders([step.args, step.prompt, step.instruction])];
      const absent = needed.filter(name => missing.includes(name));
      if (absent.length) return this.pauseFor(task.id, { kind: 'parameters_required', parameters: absent, message: `Enter ${absent.join(', ')} again to continue (sensitive values are never stored).` }, 'parameters_required', { stepId: step.id });
      parameters = values;
    }
    if (step.kind === 'model') {
      const modelId = step.modelId ?? task.modelId;
      if (!modelId) return this.pauseFor(task.id, { kind: 'model_required', stepId: step.id, message: 'Choose a model for this task (redirect with modelId) before its model step runs.' }, 'step_failed', { stepId: step.id });
      let conversationId = task.run.conversationId;
      if (!conversationId) {
        const created = await this.dispatch('conversations.create', { workspaceId: task.workspaceId, title: `Task: ${task.title}`.slice(0, 240), requestId: `task.${task.id}.conversation` }, context);
        if (created.error) return this.refused(task, step, created, null);
        conversationId = created.result.id;
        await this.update(task.id, record => { record.run.conversationId = conversationId; record.outputs = [...new Set([...(record.outputs ?? []), conversationId])]; });
      }
      const text = task.workflowRun ? substitute(step.prompt, parameters) : step.prompt;
      return this.invoke(task, step, slot, context, 'chat.send', { conversationId, modelId, text, ...(task.run.disclosureAck === step.id ? { disclosureAck: true } : {}) }, { kind: 'model' });
    }
    // Command step.
    const args = task.workflowRun ? substitute(structuredClone(step.args ?? {}), parameters) : structuredClone(step.args ?? {});
    const properties = commands[step.command].inputSchema.properties ?? {};
    if (properties.workspaceId && args.workspaceId == null) args.workspaceId = task.workspaceId;
    if (properties.tabId && args.tabId == null && TAB_COMMANDS(step.command) && task.run.tabId) args.tabId = task.run.tabId;
    const allowed = task.workflowRun?.allowedSites ?? [];
    const destination = typeof args.url === 'string' && ['tabs.new', 'page.navigate'].includes(step.command) ? args.url : null;
    if (allowed.length && destination && !matchDestination(allowed, destination)) {
      return this.pauseFor(task.id, { kind: 'destination_not_allowed', stepId: step.id, destination: minimizeUrl(destination), message: `${minimizeUrl(destination)} is outside this workflow’s allowed sites.` }, 'destination_not_allowed', { stepId: step.id });
    }
    if (args.tabId != null && (INPUT_COMMANDS.has(step.command) || step.expect?.urlPattern || allowed.length)) {
      // Inspect as the task identity: the browser requires the actor’s own current inspection before input.
      const inspected = await this.dispatch('page.inspect', { tabId: args.tabId, workspaceId: args.workspaceId ?? task.workspaceId }, context);
      if (inspected.error) return this.refused(task, step, inspected, null);
      const url = inspected.result?.url ?? '';
      if (step.expect?.urlPattern && !matchUrlPattern(step.expect.urlPattern, url)) {
        return this.pauseFor(task.id, { kind: 'invalidated', reason: 'url_mismatch', stepId: step.id, expected: step.expect.urlPattern, actual: minimizeUrl(url), message: `Step “${step.title}” expected ${step.expect.urlPattern} but the tab is at ${minimizeUrl(url)}; the site or flow may have changed.` }, 'invalidated_step', { stepId: step.id });
      }
      if (allowed.length && url && url !== 'about:blank' && !destination && !matchDestination(allowed, url)) {
        return this.pauseFor(task.id, { kind: 'destination_not_allowed', stepId: step.id, destination: minimizeUrl(url), message: `The tab is at ${minimizeUrl(url)}, outside this workflow’s allowed sites.` }, 'destination_not_allowed', { stepId: step.id });
      }
      if (INPUT_COMMANDS.has(step.command) && Object.hasOwn(properties, 'expectedVersion')) args.expectedVersion = inspected.result.version;
    }
    if (properties.requestId && args.requestId == null) args.requestId = `task.${task.id}.${step.id}.${hash(args).slice(0, 8)}`;
    // Sensitive run parameters live only in memory: approval previews withhold them.
    const sensitiveValues = (task.workflowRun?.sensitive ?? []).map(name => parameters[name]).filter(value => typeof value === 'string');
    return this.invoke(task, step, slot, sensitiveValues.length ? { ...context, sensitiveValues } : context, step.command, args, { kind: 'command' });
  }

  /** Commit an `attempted` operation record, dispatch as the task identity, then record the outcome. */
  async invoke(task, step, slot, context, command, args, { kind }) {
    const spec = commands[command];
    const external = spec.effect === 'external';
    const op = { id: `op_${randomUUID()}`, stepId: step.id, kind, command, actor: context.actor, external, actionClass: spec.actionClass, status: 'attempted', attemptedAt: now(),
      summary: summarizeArgs(args, command), ...(args.requestId ? { requestId: args.requestId } : {}), ...(kind === 'model' ? { conversationId: args.conversationId, modelId: args.modelId } : {}) };
    await this.update(task.id, record => {
      record.operations = [...(record.operations ?? []), op];
      if (record.operations.length > MAX_OPERATIONS) {
        const keep = record.operations.filter(item => this.unresolved(item));
        record.operations = [...record.operations.filter(item => !this.unresolved(item)).slice(-(MAX_OPERATIONS - keep.length)), ...keep];
      }
      const state = this.stepState(record, step.id);
      state.phase = 'running'; state.attempts = (state.attempts ?? 0) + 1; state.lastOperationId = op.id;
      if (record.run.disclosureAck === step.id && kind === 'model') delete record.run.disclosureAck;
    });
    slot.inFlight = { operationId: op.id, stepId: step.id, command, kind, external };
    let outcome;
    // A command step's deadline uses the shared request-deadline contract (ADR 018).
    try { outcome = await this.dispatch(command, args, { ...context, ...(kind === 'command' && step.deadlineMs ? { deadlineMs: step.deadlineMs } : {}) }); }
    catch (error) { outcome = { execution: 'failed', error: { code: error.code ?? 'command_failed', message: error.message } }; }
    finally { slot.inFlight = null; }
    if (!outcome.error) return this.succeeded(task, step, op, outcome, command, args);
    return this.refused(task, step, outcome, op);
  }

  async succeeded(task, step, op, outcome, command, args) {
    const result = outcome.result && typeof outcome.result === 'object' ? outcome.result : {};
    const reference = { ...(typeof result.id === 'string' ? { id: result.id } : {}), ...(typeof result.url === 'string' ? { url: minimizeUrl(result.url) } : {}),
      ...(typeof result.outcome === 'string' ? { outcome: result.outcome.slice(0, 40) } : {}), ...(outcome.idempotency?.replayed ? { replayed: true } : {}),
      ...(typeof result.turnId === 'string' ? { turnId: result.turnId, status: result.status, finishReason: result.finishReason } : {}),
      ...(typeof result.status === 'string' && !result.turnId ? { status: result.status.slice(0, 40) } : {}) };
    let after = 'continue';
    const allowed = task.workflowRun?.allowedSites ?? [];
    await this.update(task.id, record => {
      const target = this.operation(record, op.id);
      Object.assign(target, { status: 'completed', finishedAt: now(), result: reference, ...(op.external ? { note: 'Accepted by the browser or provider; the external result is not verified by this record.' } : {}) });
      if (command === 'tabs.new' && Number.isSafeInteger(result.id)) { record.run.tabId = result.id; record.tabIds = [...new Set([...(record.tabIds ?? []), result.id])].slice(-100); }
      if (command === 'artifacts.capture' && typeof result.id === 'string') record.evidence = [...new Set([...(record.evidence ?? []), result.id])];
      else if (/\.(create|message|annotate)$/.test(command) && typeof result.id === 'string') record.outputs = [...new Set([...(record.outputs ?? []), result.id])];
      if (step.kind === 'handoff') {
        this.stepState(record, step.id).handoffId = result.id;
        this.stepState(record, step.id).phase = 'waiting';
        this.setBlocker(record, { kind: 'handoff', stepId: step.id, handoffId: result.id, message: `Waiting for handoff ${result.id} to be completed by ${step.to ?? 'human'}.` });
        if (normalizePhase(record.status) === 'running') this.transition(record, 'waiting_on_human', executorActor(record.executor, record.id), 'handoff_waiting', '', step.id);
        after = 'stop';
        return;
      }
      this.completeStep(record, step, reference);
      const landed = typeof result.url === 'string' ? result.url : result.navigation?.url;
      if (allowed.length && landed && landed !== 'about:blank' && !matchDestination(allowed, landed)) {
        this.setBlocker(record, { kind: 'destination_not_allowed', stepId: step.id, destination: minimizeUrl(landed), message: `The step ended at ${minimizeUrl(landed)}, outside this workflow’s allowed sites.` });
        if (normalizePhase(record.status) === 'running') this.transition(record, 'paused', executorActor(record.executor, record.id), 'destination_not_allowed', '', step.id);
        after = 'stop';
      } else if (result.status === 'partial' && step.kind === 'model') {
        this.setBlocker(record, { kind: 'partial_output', stepId: step.id, message: `The model reply was partial (${result.finishReason}). Review it, then continue or redirect.` });
        if (normalizePhase(record.status) === 'running') this.transition(record, 'paused', executorActor(record.executor, record.id), 'partial_output', '', step.id);
        after = 'stop';
      }
    });
    return after;
  }

  /** Map a refused or failed step to a phase. Unknown outcomes of external work become uncertain. */
  async refused(task, step, outcome, op) {
    const error = outcome.error ?? {};
    const code = error.code;
    const reason = error.details?.authority?.reason;
    const notStarted = outcome.execution === 'not_started' || NOT_STARTED_CODES.has(code) || /^CLOUD_DISCLOSURE_REQUIRED/.test(error.message ?? '');
    const actor = executorActor(task.executor, task.id);
    const message = String(error.message ?? 'Step failed').slice(0, 1000);
    let phase = 'paused', why = 'step_failed', blocker = { kind: 'step_refused', stepId: step.id, code, message };
    let opStatus = notStarted ? 'not_started' : 'failed';
    if (code === 'already_committed' && op) return this.succeeded(task, step, op, { result: { replayed: true } }, step.command, {});
    if (code === 'approval_required') {
      phase = 'waiting_on_human'; why = 'approval_required';
      blocker = { kind: 'approval', stepId: step.id, approvalId: error.details?.authority?.approvalId ?? null, actionClass: error.details?.authority?.actionClass, message: `Approve ${step.command ?? op?.command ?? 'this step'} in Weft (request ${error.details?.authority?.approvalId ?? 'pending'}); the task continues after a decision.` };
    } else if (code === 'deadline_exceeded' && (notStarted || ['rolled_back', 'stopped'].includes(error.details?.effect))) {
      // The deadline stopped the step before any effect (or rolled it back): the step can be continued; an uncertain effect falls through below.
      why = 'deadline_exceeded'; opStatus = notStarted ? 'not_started' : 'interrupted';
      blocker = { kind: 'deadline', stepId: step.id, message: `The step's ${step.deadlineMs ?? ''} ms deadline passed ${notStarted ? 'before it started' : `and it was ${error.details?.effect === 'rolled_back' ? 'rolled back' : 'stopped'}`}. Continue to try again, or redirect the step.` };
    } else if (code === 'budget_exhausted') {
      // The task identity's grant budget (ADR 015) is spent: like an expired grant, a person renews it and continues.
      why = 'grant_inactive';
      blocker = { kind: 'grant', stepId: step.id, reason: 'budget_exhausted', message: `The task’s identity has used its ${error.details?.budget?.budget ?? ''} budget. A person renews the grant or reassigns the task, then continues it.` };
    } else if (code === 'resource_busy') {
      blocker = { kind: 'resource_busy', stepId: step.id, message: `Weft is busy (${error.details?.busy?.resource ?? 'resources'}); continue the task to try the step again.` };
    } else if (/^CLOUD_DISCLOSURE_REQUIRED/.test(error.message ?? '')) {
      phase = 'waiting_on_human'; why = 'disclosure_required';
      blocker = { kind: 'disclosure', stepId: step.id, message: 'Review what this model step sends (chat.preview), then continue with disclosureAck to acknowledge the destination.' };
    } else if (code === 'emergency_stop' && notStarted) {
      why = 'emergency_stop'; blocker = { kind: 'emergency_stop', stepId: step.id, message: 'Automation is stopped; a person resumes automation and continues the task.' };
    } else if (['permission_required', 'human_required'].includes(code)) {
      why = GRANT_REASONS.has(reason) ? 'grant_inactive' : 'permission_denied';
      blocker = { kind: GRANT_REASONS.has(reason) ? 'grant' : 'permission', stepId: step.id, reason: reason ?? code, message: GRANT_REASONS.has(reason)
        ? `The task’s identity can no longer act (${reason}). A person renews the grant or reassigns the task, then continues it.` : message };
    } else if (code === 'not_found' && /element/i.test(message) || code === 'stale_state' && INVALIDATION[error.details?.reason] || code === 'invalid_arguments' && /selector/i.test(message)) {
      why = 'invalidated_step';
      blocker = { kind: 'invalidated', stepId: step.id, reason: code === 'not_found' ? 'selector_not_found' : INVALIDATION[error.details?.reason] ?? 'invalid_selector', message: `Step “${step.title}” no longer matches the page (${message}). The site structure may have changed; edit or redirect the step.` };
    } else if (code === 'site_blocked') {
      blocker = { kind: 'site_blocked', stepId: step.id, message };
    } else if (!notStarted && step.kind === 'model' && error.details?.turnId) {
      opStatus = 'interrupted';
      blocker = { kind: 'model_interrupted', stepId: step.id, turnId: error.details.turnId, partialSaved: Boolean(error.details.partialSaved), message: `The model turn stopped (${code}). Continue to send it again, or redirect.` };
      why = code === 'emergency_stop' ? 'emergency_stop' : 'step_failed';
    } else if (!notStarted && op?.external && step.kind !== 'model') {
      opStatus = 'uncertain'; phase = 'uncertain'; why = 'external_outcome_unknown';
      blocker = { kind: 'uncertain', stepId: step.id, operationId: op.id, message: `${op.command} may or may not have taken effect (${code}). Record what happened, or retry with duplicate-risk confirmation.` };
    } else if (!notStarted && step.kind !== 'model') {
      phase = 'failed';
      blocker = { kind: 'step_failed', stepId: step.id, code, message };
    }
    await this.update(task.id, record => {
      if (op) Object.assign(this.operation(record, op.id), { status: opStatus, finishedAt: now(), error: { code, message: message.slice(0, 500), ...(reason ? { reason } : {}) } });
      const state = this.stepState(record, step.id);
      state.phase = phase === 'uncertain' ? 'uncertain' : phase === 'failed' ? 'failed' : 'pending';
      if (blocker.kind === 'approval') state.approvalId = blocker.approvalId;
      const current = normalizePhase(record.status);
      if (current === 'running') {
        this.setBlocker(record, blocker);
        this.transition(record, phase, actor, why, '', step.id);
      } else if (phase === 'uncertain' && current === 'paused') {
        // Paused while the step was in flight: unknown external outcomes still need a person.
        this.setBlocker(record, blocker);
        this.transition(record, 'uncertain', actor, why, 'Outcome of work submitted before the pause is unknown', step.id);
      }
    });
    return 'stop';
  }

  // ---- Events, interruptions and recovery ------------------------------------------------------
  /** Called by the dispatcher with each published event: resume tasks blocked on approvals and handoffs. */
  observe(event) {
    if (event?.type === 'command' && /^approvals\.(approve|reject)$/.test(event.command) && event.status === 'success') this.resumeApprovals().catch(() => {});
    if (event?.type === 'handoff' && event.handoffId && ['completed', 'declined', 'cancelled'].includes(event.status)) this.resumeHandoff(event.handoffId, event.status).catch(() => {});
  }
  async resumeApprovals() {
    const items = this.authority?.approvals?.items ?? [];
    this.authority?.approvals?.expire?.();
    for (const task of this.tasks().filter(item => normalizePhase(item.status) === 'waiting_on_human' && item.run?.blocker?.kind === 'approval')) {
      const approval = items.find(item => item.id === task.run.blocker.approvalId);
      if (!approval || approval.status === 'pending') continue;
      const decided = approval.status === 'approved' ? 'running' : 'paused';
      const reason = approval.status === 'approved' ? 'approval_approved' : approval.status === 'rejected' ? 'approval_rejected' : 'approval_expired';
      if (approval.status === 'consumed') continue;
      await this.update(task.id, record => {
        if (normalizePhase(record.status) !== 'waiting_on_human' || record.run.blocker?.approvalId !== approval.id) return;
        this.setBlocker(record, decided === 'running' ? null : { kind: reason, stepId: record.run.blocker.stepId, message: approval.status === 'rejected' ? `A person rejected the request${approval.rejectionReason ? `: ${approval.rejectionReason}` : ''}. Redirect or cancel the task.` : 'The approval request expired; continue the task to ask again.' });
        if (approval.status === 'rejected') record.run.pausedBy = 'human';
        this.transition(record, decided, 'human', reason, '', record.run.blocker?.stepId ?? null);
      });
      if (decided === 'running') this.schedule(task.id);
    }
  }
  async resumeHandoff(handoffId, status) {
    for (const task of this.tasks().filter(item => item.run?.blocker?.kind === 'handoff' && item.run.blocker.handoffId === handoffId)) {
      await this.update(task.id, record => {
        if (normalizePhase(record.status) !== 'waiting_on_human') return;
        const step = record.plan[record.run.cursor];
        if (status === 'completed') {
          this.completeStep(record, step, { handoffId, status });
          this.setBlocker(record, null);
          this.transition(record, 'running', 'human', 'handoff_completed', '', step.id);
        } else {
          this.setBlocker(record, { kind: 'handoff_closed', stepId: step.id, handoffId, message: `The handoff was ${status}. Redirect, continue to hand off again, or cancel.` });
          this.stepState(record, step.id).phase = 'pending';
          this.transition(record, 'paused', 'human', 'handoff_closed', status, step.id);
        }
      });
      if (status === 'completed') this.schedule(task.id);
    }
  }

  /** Emergency stop: no new steps are scheduled; already-submitted work is reported separately. */
  async emergencyStop() {
    const paused = [], submitted = [];
    for (const task of this.tasks().filter(item => item.executor && ['running', 'queued'].includes(normalizePhase(item.status)))) {
      const inFlight = this.submitted(task.id);
      submitted.push(...inFlight.map(item => ({ taskId: task.id, ...item })));
      await this.update(task.id, record => {
        record.run.pausedBy = 'human';
        this.setBlocker(record, { kind: 'emergency_stop', message: inFlight.length ? 'Emergency stop. A step was already submitted; its outcome is recorded when it returns.' : 'Emergency stop; resume automation and continue the task.' });
        this.transition(record, 'paused', 'human', 'emergency_stop', inFlight.length ? `Already submitted: ${inFlight.map(item => item.command).join(', ')}` : '');
      }).catch(() => {});
      paused.push(task.id);
    }
    return { paused, submitted };
  }

  /**
   * Startup sweep: running tasks with only local work in flight are paused (server_restart);
   * attempted external work with no recorded outcome becomes uncertain and needs a person.
   */
  async init() {
    for (const task of this.tasks().filter(item => item.executor && item.run)) {
      const pending = (task.operations ?? []).filter(op => op.status === 'attempted');
      const status = normalizePhase(task.status);
      if (!pending.length && status !== 'running') continue;
      const lookups = new Map();
      for (const op of pending.filter(item => item.kind === 'model')) lookups.set(op.id, await this.lookupModelTurn(op).catch(() => ({ status: 'unknown' })));
      await this.update(task.id, record => {
        let uncertain = false;
        for (const op of (record.operations ?? []).filter(item => item.status === 'attempted')) {
          const found = lookups.get(op.id);
          const step = record.plan.find(item => item.id === op.stepId);
          if (found && ['completed', 'not_completed'].includes(found.status)) {
            op.status = found.status;
            op.determination = { status: found.status, source: 'recorded_lookup', actor: 'system', at: now(), ...(found.detail ? { detail: found.detail } : {}) };
            if (found.status === 'completed' && step && record.plan.indexOf(step) === record.run.cursor) this.completeStep(record, step, { reconciled: true, operationId: op.id });
            else if (step) this.stepState(record, step.id).phase = 'pending';
          } else if (op.external) {
            op.status = 'uncertain'; op.finishedAt = now(); op.error = { code: 'interrupted', message: 'Weft stopped while this external step was in flight; its outcome is unknown.' };
            if (step) this.stepState(record, step.id).phase = 'uncertain';
            uncertain = true;
          } else {
            op.status = 'interrupted'; op.finishedAt = now();
            op.note = op.requestId ? 'Local write interrupted; repeating it with the same request ID replays a committed result instead of applying twice.' : 'Local step interrupted before its result was recorded.';
            if (step) this.stepState(record, step.id).phase = 'pending';
          }
        }
        const phase = normalizePhase(record.status);
        if (uncertain && ['running', 'paused'].includes(phase)) {
          const op = (record.operations ?? []).find(item => item.status === 'uncertain' && !item.determination);
          this.setBlocker(record, { kind: 'uncertain', stepId: op?.stepId, operationId: op?.id, message: `${op?.command ?? 'External work'} was in flight when Weft stopped. Record what happened, or retry with duplicate-risk confirmation.` });
          this.transition(record, 'uncertain', 'system', 'server_restart_uncertain', '', op?.stepId ?? null);
        } else if (phase === 'running') {
          this.setBlocker(record, { kind: 'server_restart', message: 'Weft restarted while this task was running; continue it when ready.' });
          this.transition(record, 'paused', 'system', 'server_restart');
        }
      });
    }
    return this;
  }

  /** Built-in recorded lookup: the conversation's turn manifest says whether a model turn finished. */
  async lookupModelTurn(op) {
    if (!op.conversationId) return { status: 'unknown' };
    let conversation;
    try { conversation = this.workspace.getConversation(op.conversationId); } catch { return { status: 'unknown', detail: 'Conversation no longer exists' }; }
    const manifest = (conversation.turnManifests ?? []).filter(item => item.createdAt >= op.attemptedAt).at(-1);
    if (!manifest) return { status: 'not_completed', detail: 'No turn was recorded after the attempt; the request was not sent.' };
    if (['complete', 'partial'].includes(manifest.status)) return { status: 'completed', detail: `Turn ${manifest.turnId} ${manifest.status}`, evidence: [manifest.turnId] };
    if (['failed', 'cancelled', 'stopped', 'timed-out'].includes(manifest.status)) return { status: 'not_completed', detail: `Turn ${manifest.turnId} ${manifest.status}` };
    return { status: 'unknown', detail: `Turn ${manifest.turnId} has no final status (the provider may have processed it)` };
  }

  // ---- Workflows ---------------------------------------------------------------------------------
  validateWorkflow(workflow, values, { forRun = false } = {}) {
    const errors = [], warnings = [];
    let parameters = [];
    try { parameters = normalizeParameters(workflow.parameters); } catch (error) { errors.push(error.message); }
    const declared = new Map(parameters.map(item => [item.name, item]));
    const resolved = {};
    // Workflow-level credential references are fixed credential parameters: {{name}} resolves to the opaque id.
    for (const ref of workflow.credentialRefs ?? []) {
      if (declared.has(ref.name)) { errors.push(`Credential reference ${ref.name} has the same name as a parameter`); continue; }
      declared.set(ref.name, { name: ref.name, label: ref.purpose || ref.name, type: 'credential', required: true, fixed: true });
      resolved[ref.name] = ref.ref;
    }
    if (values) {
      try { rejectSecretKeys(values); } catch { errors.push('Parameter names must not be secret field names; use a credential parameter for credentials'); }
      for (const name of Object.keys(values)) if (!declared.has(name) || declared.get(name).fixed) errors.push(`Unknown parameter ${name}`);
    }
    for (const parameter of parameters) {
      const supplied = values && Object.hasOwn(values, parameter.name) ? values[parameter.name] : parameter.default;
      if (supplied === undefined || (supplied === '' && parameter.required)) { if (parameter.required && values) errors.push(`Parameter ${parameter.name} is required`); continue; }
      const problem = this.checkParameter(parameter, supplied, workflow.workspaceId);
      if (problem) errors.push(`Parameter ${parameter.name}: ${problem}`);
      else resolved[parameter.name] = parameter.type === 'number' ? Number(supplied) : parameter.type === 'boolean' ? supplied === true || supplied === 'true' : supplied;
    }
    for (const site of workflow.allowedSites ?? []) if (!validDestinationPattern(site)) errors.push(`Allowed site ${site} is not a valid destination pattern (use example.com, *.example.com or https://example.com)`);
    for (const id of workflow.materialIds ?? []) if (!this.workspace.data.materials.some(item => item.id === id && item.workspaceId === workflow.workspaceId)) errors.push(`Required material ${id} is missing from this workspace`);
    for (const ref of workflow.credentialRefs ?? []) {
      const status = this.credentialStatus(ref.ref, workflow.workspaceId);
      if (!status.available) errors.push(`Credential reference ${ref.name}: ${status.reason}`);
    }
    const steps = (workflow.steps ?? []).map((step, index) => {
      const issues = [];
      const used = [...placeholders([step.args, step.prompt, step.instruction, step.title])];
      for (const name of used) {
        if (!declared.has(name)) issues.push(`uses undeclared parameter {{${name}}}`);
        else if (values && !Object.hasOwn(resolved, name)) issues.push(`parameter {{${name}}} has no value`);
        else if (declared.get(name).type === 'credential' && placeholders(step.args ?? {}).has(name) && !(step.command === 'credentials.fill' && step.args?.id === `{{${name}}}` && !placeholders({ ...step.args, id: '' }).has(name))) {
          issues.push(`credential parameter {{${name}}} can only be the id of a credentials.fill step; credentials are never typed by automation`);
        }
      }
      const kind = step.kind && step.kind !== 'instruction' ? step.kind : 'review';
      if (kind === 'command') {
        const spec = commands[step.command];
        if (!spec) issues.push(`unknown command ${step.command}`);
        else if (spec.humanOnly || spec.actionClass === 'administration') issues.push(`${step.command} is human-only`);
        else if (FORBIDDEN_STEP_COMMANDS.has(step.command)) issues.push(`${step.command} cannot be a workflow step`);
        else if (values && !issues.length) {
          try { validateCommand(step.command, withRuntimeTargets(step.command, substitute(step.args ?? {}, { ...resolved, ...Object.fromEntries(parameters.filter(item => !Object.hasOwn(resolved, item.name)).map(item => [item.name, item.type === 'credential' ? 'cred_00000000-0000-4000-8000-000000000000' : 'x'])) }))); }
          catch (error) { issues.push(`arguments: ${error.message}`); }
        }
        const url = step.args?.url;
        if (typeof url === 'string' && !placeholders(url).size && (workflow.allowedSites ?? []).length && !matchDestination(workflow.allowedSites, url)) issues.push(`${minimizeUrl(url)} is outside the allowed sites`);
      }
      if (step.recorded?.note) warnings.push(`Step ${index + 1}: ${step.recorded.note}`);
      if (kind === 'model' && !step.prompt) issues.push('model steps need a prompt');
      if (kind === 'command' && !step.command) issues.push('command steps need a command');
      for (const issue of issues) errors.push(`Step ${index + 1} (${step.title}): ${issue}`);
      return { index, title: step.title, kind, ...(step.command ? { command: step.command } : {}), placeholders: used, issues };
    });
    if (!steps.length) errors.push('The workflow has no steps');
    if (forRun && workflow.enabled === false) errors.unshift('This workflow is inactive. A person reviews and enables it before it can run.');
    return { ok: errors.length === 0, enabled: workflow.enabled !== false, errors, warnings: [...new Set(warnings)], parameters: parameters.map(({ default: value, ...item }) => ({ ...item, ...(value !== undefined && !item.sensitive ? { default: value } : {}) })), steps, resolved };
  }
  credentialStatus(ref, workspaceId) {
    try { const status = this.credentials.status(ref, { workspaceId }); return { available: Boolean(status?.available), reason: String(status?.reason ?? (status?.available ? '' : 'not available')).slice(0, 300) }; }
    catch (error) { return { available: false, reason: error.message }; }
  }
  checkParameter(parameter, value, workspaceId) {
    switch (parameter.type) {
      case 'number': return Number.isFinite(typeof value === 'number' ? value : Number(value)) && String(value).trim() !== '' ? null : 'expected a number';
      case 'boolean': return [true, false, 'true', 'false'].includes(value) ? null : 'expected true or false';
      case 'url': try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? null : 'expected an http(s) URL without credentials'; } catch { return 'expected an http(s) URL'; }
      case 'enum': return (parameter.options ?? []).includes(String(value)) ? null : `expected one of ${(parameter.options ?? []).join(', ')}`;
      case 'credential': { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) return 'expected an opaque credential reference'; const status = this.credentialStatus(value, workspaceId); return status.available ? null : status.reason; }
      default: return typeof value === 'string' || typeof value === 'number' ? (String(value).length <= 10000 ? null : 'too long') : 'expected text';
    }
  }

  async runWorkflow(args, context) {
    const workflow = this.workspace.record('workflows', args.id, context.workspaceId ? { workspaceId: context.workspaceId } : {});
    if (workflow.enabled === false) throw typed('permission_required', 'This workflow is inactive. A person reviews and enables it in Weft before it can run; saving or importing a workflow never authorizes it.', { notStarted: true, details: { authority: { decision: 'deny', reason: 'workflow_inactive', actionClass: 'local_write' } } });
    const report = this.validateWorkflow(workflow, args.parameters, { forRun: true });
    if (!report.ok) throw new CommandError({ code: 'invalid_arguments', message: `Workflow cannot run: ${report.errors.join('; ')}`.slice(0, 4000), field: 'parameters' });
    const executor = this.resolveExecutor(args.executor, context, workflow.workspaceId);
    if (args.tabId != null) {
      const tab = this.browser?.tabs?.get?.(args.tabId);
      if (!tab || tab.workspaceId !== workflow.workspaceId) throw typed('not_found', 'That tab is not open in this workflow’s workspace');
    }
    const definitions = new Map(report.parameters.map(item => [item.name, item]));
    const sensitive = Object.keys(report.resolved).filter(name => definitions.get(name)?.sensitive);
    const stored = Object.fromEntries(Object.entries(report.resolved).filter(([name]) => !definitions.get(name)?.sensitive));
    const plan = workflow.steps.map((step, index) => {
      const kind = step.kind && step.kind !== 'instruction' ? step.kind : 'review';
      const base = { id: `s${index + 1}`, kind, title: substitute(step.title, Object.fromEntries(Object.entries(report.resolved).map(([key, value]) => [key, definitions.get(key)?.sensitive ? `[${key}]` : value]))).slice(0, 240) };
      if (kind === 'review') return { ...base, instruction: step.instruction ?? '' };
      if (kind === 'handoff') return { ...base, ...(step.to ? { to: step.to } : {}), instruction: step.instruction ?? '', ...(step.reviewRequired ? { reviewRequired: true } : {}) };
      if (kind === 'model') return { ...base, prompt: step.prompt, ...(step.modelId ? { modelId: step.modelId } : {}), ...(step.reviewRequired ? { reviewRequired: true } : {}) };
      return { ...base, command: step.command, args: step.args ?? {}, ...(step.expect ? { expect: step.expect } : {}), ...(step.reviewRequired ? { reviewRequired: true } : {}) };
    });
    const created = await this.workspace.execute('tasks.create', { workspaceId: workflow.workspaceId, title: `${workflow.title} (run)`.slice(0, 240), objective: workflow.description || workflow.title,
      materialIds: [...(workflow.materialIds ?? [])], plan: plan.map(step => ({ ...step, args: step.args })), ...(args.modelId ? { modelId: args.modelId } : {}),
      ...(args.tabId ? { tabIds: [args.tabId] } : {}) }, { ...context });
    if (sensitive.length) this.sensitive.set(created.id, Object.fromEntries(sensitive.map(name => [name, report.resolved[name]])));
    await this.update(created.id, record => {
      record.workflowRun = { workflowId: workflow.id, workflowRevision: workflow.revision, title: workflow.title, parameters: stored, sensitive, allowedSites: [...(workflow.allowedSites ?? [])],
        expectedOutputs: workflow.expectedOutputs ?? '', credentialRefs: (workflow.credentialRefs ?? []).map(({ name, ref }) => ({ name, ref })), startedBy: this.actorOf(context) };
      appendTimeline(record, { type: 'workflow', actor: this.actorOf(context), reason: 'created', workflowId: workflow.id, workflowRevision: workflow.revision, at: now() });
    });
    if (!args.start) return this.task(created.id);
    return this.startTask({ id: created.id, executor: args.executor, ...(args.modelId ? { modelId: args.modelId } : {}) }, context, { tabId: args.tabId ?? null });
  }

  // ---- Secret-free recording -------------------------------------------------------------------
  recordStart(args, context) {
    if (!isHumanContext(context)) throw typed('human_required', 'Recording captures a person’s own actions and is started in Weft', { notStarted: true });
    const tab = this.browser?.tabs?.get?.(args.tabId);
    if (!tab) throw typed('not_found', 'Tab not found');
    if (this.recordings.has(args.tabId)) throw typed('stale_state', 'This tab is already recording', { notStarted: true });
    const recording = { tabId: args.tabId, workspaceId: tab.workspaceId, title: args.title ?? 'Recorded workflow', steps: [], parameters: [], startedAt: now(), lastInputAt: 0, expectNext: null, omitted: 0 };
    let current = '';
    try { current = tab.view?.webContents?.getURL?.() ?? ''; } catch { /* closed tab */ }
    if (current && current !== 'about:blank') recording.steps.push(this.recordedStep(recording, { command: 'page.navigate', args: { url: sanitizeUrl(current) }, title: `Open ${minimizeUrl(current)}`, source: 'navigation' }));
    recording.stopCapture = this.browser?.startRecordingCapture?.(args.tabId, event => this.recordPageEvent(args.tabId, event)) ?? null;
    this.recordings.set(args.tabId, recording);
    return { recording: true, tabId: args.tabId, pageCapture: Boolean(recording.stopCapture), steps: recording.steps.length,
      notice: recording.stopCapture ? 'Recording navigation, Weft commands and trusted clicks/changes in this tab. Typed values are never recorded; each filled field becomes a parameter.' : 'Recording navigation and Weft commands in this tab. Typed values are never recorded.' };
  }
  async recordStop(args, context) {
    if (!isHumanContext(context)) throw typed('human_required', 'Recording is stopped in Weft', { notStarted: true });
    const recording = this.recordings.get(args.tabId);
    if (!recording) throw typed('not_found', 'This tab is not recording');
    await recording.stopCapture?.flush?.();
    recording.stopCapture?.();
    this.recordings.delete(args.tabId);
    const summary = { steps: recording.steps.length, parameters: recording.parameters.length, omitted: recording.omitted };
    if (args.discard || !recording.steps.length) return { saved: false, ...summary };
    const workflow = await this.workspace.execute('workflows.create', { workspaceId: recording.workspaceId, title: recording.title, enabled: false,
      description: `Recorded ${recording.startedAt}. Review every step, parameter and allowed site before enabling.`, parameters: recording.parameters, steps: recording.steps,
      allowedSites: [...new Set(recording.steps.flatMap(step => { try { return step.args?.url && !placeholders(step.args.url).size ? [new URL(step.args.url).hostname] : []; } catch { return []; } }))] }, { actor: 'human', source: 'gui' });
    return { saved: true, workflow, ...summary };
  }
  recordedStep(recording, { command, args, title, source, note }) {
    const step = { title: title.slice(0, 240), instruction: '', reviewRequired: false, kind: 'command', command, args, recorded: { source, at: now(), ...(note ? { note } : {}) } };
    if (recording.expectNext && command !== 'page.navigate') step.expect = { urlPattern: recording.expectNext };
    recording.expectNext = null;
    return step;
  }
  addParameter(recording, hint, sensitive, password = false) {
    const name = `field_${recording.parameters.length + 1}`;
    recording.parameters.push(password
      ? { name, label: String(hint || name).slice(0, 200), type: 'credential', required: true, description: 'Saved sign-in (credential reference id from credentials.list) used to fill the login form.' }
      : sensitive
      ? { name, label: String(hint || name).slice(0, 200), type: 'credential', required: false, description: 'Sensitive field: a person fills it during the run.' }
      : { name, label: String(hint || name).slice(0, 200), type: 'string', required: true, description: 'Value typed during recording was not stored; supply it when running.' });
    return name;
  }
  /** Human commands on a recording tab become steps; values typed into fields never do. */
  recordCommand({ command, args, outcome, context }) {
    if (!isHumanContext(context) || outcome?.error) return;
    const recording = this.recordings.get(args?.tabId ?? outcome?.tabId);
    if (!recording || recording.steps.length >= 100) return;
    if (command === 'page.navigate') { recording.steps.push(this.recordedStep(recording, { command, args: { url: sanitizeUrl(args.url) }, title: `Open ${minimizeUrl(args.url)}`, source: 'command' })); recording.lastInputAt = Date.now(); }
    else if (['page.back', 'page.forward', 'page.reload'].includes(command)) recording.steps.push(this.recordedStep(recording, { command, args: {}, title: command.replace('page.', 'Go ').replace('Go reload', 'Reload'), source: 'command' }));
    else if (['page.click', 'page.fill'].includes(command)) this.recordElement(recording, { type: command === 'page.click' ? 'click' : 'fill', selector: args.selector, ref: args.ref, sensitive: sensitiveName.test(args.selector ?? '') }, 'command');
    else if (command === 'page.press') {
      if (/^[\x20-\x7e]$/.test(args.key)) { recording.omitted++; return; }
      recording.steps.push(this.recordedStep(recording, { command, args: { key: args.key }, title: `Press ${args.key}`, source: 'command' }));
    }
  }
  recordElement(recording, event, source) {
    if (!event.selector) {
      recording.steps.push({ title: 'Recorded element needs a selector', instruction: 'This action was recorded by snapshot ref, which is not stable. Replace this step with a selector-based command step.', reviewRequired: true, kind: 'instruction', recorded: { source, at: now(), note: 'ref-based action needs re-targeting' } });
      return;
    }
    if (event.type === 'click') { recording.steps.push(this.recordedStep(recording, { command: 'page.click', args: { selector: event.selector }, title: `Click ${event.label || event.selector}`.slice(0, 240), source })); recording.lastInputAt = Date.now(); }
    if (event.type === 'fill') {
      const sensitive = Boolean(event.sensitive) || sensitiveName.test(`${event.selector} ${event.label ?? ''}`);
      const password = sensitive && (event.password === true || /pass/i.test(`${event.selector} ${event.label ?? ''}`));
      const name = this.addParameter(recording, event.label || event.selector, sensitive, password);
      // A password field becomes a protected login step: the credential broker fills it from a saved sign-in chosen at run time.
      if (password) {
        if (recording.steps.at(-1)?.command !== 'credentials.fill') recording.steps.push(this.recordedStep(recording, { command: 'credentials.fill', args: { id: `{{${name}}}` }, title: 'Sign in with a saved sign-in', source,
          note: 'Login field: Weft fills it from a saved sign-in you choose when running; the typed password was not recorded.' }));
        else recording.parameters.pop();
        return;
      }
      const step = this.recordedStep(recording, { command: 'page.fill', args: { selector: event.selector, value: `{{${name}}}` }, title: `Fill ${event.label || event.selector}`.slice(0, 240), source,
        note: sensitive ? 'Sensitive field: a person fills it; it was never recorded and is not typed by automation.' : undefined });
      if (sensitive) step.kind = 'instruction', step.instruction = `Fill ${event.label || event.selector} yourself (sensitive field; never recorded or typed by automation).`, step.reviewRequired = true, delete step.command, delete step.args;
      recording.steps.push(step);
    }
  }
  recordPageEvent(tabId, event) {
    const recording = this.recordings.get(tabId);
    if (!recording || recording.steps.length >= 100 || !event || typeof event !== 'object') return;
    const selector = typeof event.selector === 'string' && event.selector.length <= 1000 ? event.selector : null;
    const label = typeof event.label === 'string' ? event.label.replace(/[\u0000-\u001f]/g, ' ').slice(0, 120) : '';
    if (!['click', 'fill'].includes(event.type) || !selector) return;
    this.recordElement(recording, { type: event.type, selector, label, sensitive: event.sensitive === true, password: event.password === true }, 'page');
  }
  recordNavigation({ tabId, url }) {
    const recording = this.recordings.get(tabId);
    if (!recording || recording.steps.length >= 100) return;
    const clean = sanitizeUrl(url);
    if (!clean || clean === 'about:blank') return;
    const last = recording.steps.at(-1);
    if (last?.command === 'page.navigate' && last.args.url === clean) return;
    let pattern;
    try { const parsed = new URL(clean); pattern = `${parsed.origin}${parsed.pathname}`; } catch { return; }
    // A navigation right after a recorded click or command is its effect: record it as the next step's expectation.
    if (Date.now() - recording.lastInputAt < 3000) { recording.expectNext = pattern; return; }
    recording.steps.push(this.recordedStep(recording, { command: 'page.navigate', args: { url: clean }, title: `Open ${minimizeUrl(clean)}`, source: 'navigation' }));
  }
}

