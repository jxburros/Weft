import { commands, executeOutcome, normalizeCommand, validateCommand, errorOutcome, CommandError, API_VERSION, OUTCOME_STATUSES, ERROR_HTTP_STATUS, ERROR_STATUS, exitCodes } from './commands.js';
import { PAGEABLE, pageItems } from './pagination.js';
import { describeCapabilities, MAX_DEADLINE_MS, DEADLINE_GRACE_MS } from './capabilities.js';
import { domainEvents, listEvents } from './events.js';
import { EVENT_TYPES } from './server.js';
import { BATCHABLE } from './workspace.js';
import { commandDefinitions as workspaceCommands } from './workspace-commands.js';
import { resolveCommandTargets } from './admission.js';
import { getGuidance } from './guidance.js';
import { Authority } from './authority.js';
import { raiseActionClass } from './autonomy.js';
import { executeHookCommand, pluginCommandAdminDefinitions } from './plugin-commands.js';
import { PluginRegistry } from './plugins/registry.js';
import { Knowledge } from './knowledge.js';
import { LOCK_EXEMPT } from './encryption-commands.js';
import { lockedError } from './encryption.js';
import { TaskRuntime, RUNTIME_COMMANDS } from './task-runtime.js';
import { ResourceScheduler } from './resources.js';
import { ResumeService } from './resume.js';
import { executeBrowsingCommand } from './browsing-import.js';

const TARGETLESS = ['guide.get', 'browser.info', 'workspaces.list', 'approvals.list', 'autonomy.get', 'activity.verify', 'plugins.list', 'update.status', 'weft.capabilities', 'events.list', 'transfers.list', 'resources.status', 'display.status', 'display.show', 'captures.cancel', 'payments.status'];
// Commands that page natively; every other pageable command is paged here from its full list.
const NATIVE_PAGED = new Set(['search.query', 'conversations.messages', 'artifacts.versions', 'transfers.list']);
const DEADLINE = Symbol('deadline');
const hookCommands = new Set(['workspaces.exportAs', 'artifacts.render', 'activity.report', 'page.extract']);

/** One command boundary for GUI, HTTP, CLI/MCP, internal model tools, plugins and future automation callers. */
export function createDispatcher({ workspace, browser, providers, clients, lists, extensions, updates, credentials = null, payments = null, transfers = null, eventLog = null, plugins = new PluginRegistry(), knowledge, admission, authority, tasks, scheduler, resume, display, onEvent = () => {} }) {
  knowledge ??= new Knowledge({ workspace });
  // Agent concurrency, capture queue and budgets apply to every caller (#30), including task-runtime steps.
  // A locked encrypted profile has no settings to read; the defaults apply until unlock.
  scheduler ??= new ResourceScheduler({ settings: () => (workspace?.locked ? {} : workspace?.data?.settings) ?? {}, onEvent });
  resume ??= new ResumeService({ workspace, browser });
  // The gate is not optional: callers that do not supply an Authority still get one (durable when a profile directory is known).
  authority ??= new Authority({ directory: clients?.directory ?? workspace?.directory ?? null, workspace, browser, clients });
  // The credential broker contributes task-grant evidence and the approval preview for credentials.fill; nothing else.
  if (credentials) {
    authority.taskGrant ??= (...input) => credentials.taskGrant(...input);
    authority.approvalPreview ??= (...input) => credentials.approvalPreview(...input);
  }
  // Durable task runtime (ADR 016): task steps re-enter this dispatcher as the task's bound identity.
  tasks ??= new TaskRuntime({ workspace, browser, admission, clients, providers, credentials, onEvent });
  const runtimeCommands = new Set(RUNTIME_COMMANDS);
  // Payments (ADR 019) bind payments.submit approvals to the payment's terms, reconcile uncertain submissions for the
  // task runtime, and void unsubmitted payments when their task closes.
  if (payments) {
    authority.approvalBinding ??= (...input) => payments.approvalBinding(...input);
    payments.attach({ authority, tasks, clients });
    const previous = workspace?.onTaskTransition;
    if (workspace) workspace.onTaskTransition = notice => { previous?.(notice); payments.onTaskTransition(notice); };
    // A checkout tab with a payment awaiting approval or being submitted is never suspended (#30).
    if (browser) browser.paymentHold ??= tabId => payments.holdsTab(tabId);
  }

  /** Catalog metadata, with plugins.invoke raised to the invoked plugin operation's manifest-derived class. */
  const specFor = (command, args) => {
    const spec = commands[command] ?? {};
    // Package folders can hold any workspace's records: reading them is human administration.
    if (command === 'transfers.read' && args?.source?.kind === 'package') return { ...spec, actionClass: 'administration', dataClasses: [...new Set([...(spec.dataClasses ?? []), 'workspace_records', 'conversations'])] };
    if (command !== 'plugins.invoke') return spec;
    const classified = plugins.classify?.(args.name, args.operation);
    if (!classified) return spec;
    return { ...spec, actionClass: raiseActionClass(spec.actionClass, classified.actionClass),
      dataClasses: [...new Set([...(spec.dataClasses ?? []), ...classified.dataClasses])] };
  };

  /**
   * Prepare an atomic batch: every contained command gets the same normalization, schema
   * validation, admission and target resolution as a standalone call. A "$N.id" placeholder
   * targets the record created by earlier command N, so it inherits that command's workspace.
   */
  const prepareBatch = (validated, context) => {
    const subs = validated.commands.map(({ command: name, args: input }, index) => {
      try {
        const prepared = normalizeCommand(name, input);
        if (!BATCHABLE.has(prepared.command)) throw new CommandError({ code: 'invalid_arguments', message: 'Only record commands can run in an atomic batch; page, browser, capture, import, backup and workspace-lifecycle commands cannot be rolled back.', field: 'command', allowed: [...BATCHABLE] });
        if (Object.hasOwn(prepared.args, 'requestId') || Object.hasOwn(prepared.args, 'dryRun')) throw new CommandError({ code: 'invalid_arguments', message: 'requestId and dryRun apply to the whole batch', field: Object.hasOwn(prepared.args, 'requestId') ? 'requestId' : 'dryRun' });
        admission.assertAutomationAdmitted(context.actor, prepared.command);
        const args = validateCommand(prepared.command, prepared.args);
        if (context.workspaceIds?.length === 1 && commands[prepared.command]?.inputSchema?.properties?.workspaceId && args.workspaceId == null) args.workspaceId = context.workspaceIds[0];
        const placeholder = JSON.stringify(args).match(/"\$(\d+)\.id"/);
        const resolved = resolveCommandTargets(prepared.command, args, context, { workspace, browser, commands, transfers });
        return { index, command: prepared.command, args: resolved.args, target: resolved.target, spec: specFor(prepared.command, resolved.args), placeholder: placeholder ? Number(placeholder[1]) : null };
      } catch (error) {
        const details = error instanceof CommandError ? error.toJSON() : null;
        if (details) throw new CommandError({ ...details, message: `batch command ${index} (${name}): ${details.message}`, field: `commands.${index}.${details.field === 'command' ? 'command' : `args.${details.field}`}` });
        error.message = `batch command ${index} (${name}): ${error.message}`;
        throw error;
      }
    });
    for (const sub of subs) if (!sub.target.workspaceId && sub.placeholder !== null && sub.placeholder < sub.index) sub.target.workspaceId = subs[sub.placeholder].target.workspaceId;
    const workspaces = [...new Set(subs.map(sub => sub.target.workspaceId).filter(Boolean))];
    const scoped = !['human', 'admin'].includes(context.actor) && Boolean(context.workspaceIds || context.clientId);
    if (scoped) {
      for (const sub of subs) if (!sub.target.workspaceId) sub.target.workspaceId = workspaces.length === 1 ? workspaces[0] : context.workspaceIds?.length === 1 ? context.workspaceIds[0] : null;
      if (subs.some(sub => !sub.target.workspaceId)) throw Object.assign(new Error('Specify the workspace for every command in this batch'), { code: 'ambiguous_target' });
    }
    const batchArgs = { commands: subs.map(({ command, args }) => ({ command, args })) };
    if (validated.dryRun !== undefined) batchArgs.dryRun = validated.dryRun;
    if (validated.requestId !== undefined) batchArgs.requestId = validated.requestId;
    const all = [...new Set(subs.map(sub => sub.target.workspaceId).filter(Boolean))];
    return { subs, args: batchArgs, scoped, workspaces: all, target: { workspaceId: all.length === 1 ? all[0] : null, tabId: null } };
  };

  // Authorize and route one validated command. Plugin capabilities and hook commands re-enter
  // through `call`, so every nested read passes the same gate with the caller's own authority.
  const run = async (command, validated, context, target, state) => {
    state.args = validated;
    // A locked encrypted profile answers every surface with a typed locked error, before any target lookup reads workspace data.
    if (workspace?.locked && !LOCK_EXEMPT.has(command)) throw lockedError(workspace.encryption?.lockReason ?? 'locked');
    // The stopped-state latch refuses before any handler runs: nothing started.
    try { admission.assertAutomationAdmitted(context.actor, command); } catch (error) { error.notStarted = true; throw error; }
    // One concurrency slot per top-level agent command; nested plugin/hook reads reuse it.
    if (!context.slotHeld) { context.slotHeld = true; state.release = scheduler.admit(command, context); }
    if (context.clientId) {
      const grant = clients.current?.(context.clientId);
      // A task-bound grant names its task; the task runtime supplies the task a step belongs to.
      if (grant) { context.workspaceIds = [...grant.workspaceIds]; context.taskId = grant.taskId ?? (context.source === 'task' ? context.taskId : undefined); }
    }
    // A single-workspace grant is already an explicit target, not human focus.
    if (context.workspaceIds?.length === 1 && commands[command]?.inputSchema?.properties?.workspaceId && validated.workspaceId == null) {
      validated.workspaceId = context.workspaceIds[0];
    }
    if (command === 'batch.execute') return runBatch(validated, context, target, state);
    if (command.startsWith('encryption.') || (workspace?.locked && LOCK_EXEMPT.has(command))) {
      // Profile-level commands have no workspace or tab target and must work while locked.
      const spec = specFor(command, validated);
      state.spec = spec;
      state.decision = authority.authorize(command, validated, context, target, spec);
      if (context.signal?.aborted) throw Object.assign(new Error('The request deadline passed before the command started'), { code: 'deadline_exceeded', notStarted: true, details: { started: false, effect: 'not_started' } });
      context.markStarted?.();
      if (command === 'guide.get') return getGuidance(validated.topic);
      if (command.startsWith('display.')) {
        if (!display) throw Object.assign(new Error('Display controls are available only in the Weft application'), { code: 'unavailable' });
        return display.execute(command, validated, context);
      }
      return workspace.executeEncryption(command, validated, context);
    }
    const resolved = resolveCommandTargets(command, validated, context, { workspace, browser, commands, transfers });
    const args = resolved.args;
    Object.assign(target, resolved.target);
    if (context.workspaceIds && !['human', 'admin'].includes(context.actor)) {
      if (!target.workspaceId && !TARGETLESS.includes(command)) {
        if (context.workspaceIds.length !== 1) throw Object.assign(new Error('Specify a workspace target for this client command'), { code: 'ambiguous_target' });
        target.workspaceId = context.workspaceIds[0];
      }
    }
    const spec = specFor(command, args);
    state.spec = spec;
    // Every non-human command passes the shared gate here, before any handler runs.
    const decision = authority.authorize(command, args, context, target, spec);
    state.decision = decision;
    context.authorityDecision = decision;
    if (target.workspaceId && context.workspaceIds) context.workspaceId = target.workspaceId;
    context.assertAuthorized = () => {
      admission.assertAutomationAdmitted(context.actor, command);
      clients?.assertAllowed(command, context, { workspaceId: target.workspaceId, workspaceIds: authority.touchedWorkspaces(command, args, target),
        actionClass: spec.actionClass, ...(spec.dataClasses ? { dataClasses: spec.dataClasses } : {}), recheck: true });
    };
    if (context.clientId) {
      // Cost and time budgets are checked after the authority gate so out-of-scope requests are still reported as denials.
      try { clients?.assertBudgets?.(context.clientId, command, { pricing: command === 'chat.send' ? providers?.profiles?.find(profile => profile.id === args.modelId)?.pricing : undefined }); }
      catch (error) { authority.restoreApproval(decision, { command, context, target, error }); throw error; }
    }
    authority.recordAttempt({ command, args, context, target, decision });
    const scopedWorkspaces = () => workspace.snapshot().workspaces.filter(item => context.workspaceIds.includes(item.id));
    // Workspace-queued commands mark their own start when dequeued; everything else starts here.
    const queued = Object.hasOwn(workspaceCommands, command) || command.startsWith('handoffs.');
    const start = () => {
      if (context.signal?.aborted) throw Object.assign(new Error('The request deadline passed before the command started'), { code: context.signal.reason?.code === 'deadline_exceeded' ? 'deadline_exceeded' : 'cancelled', notStarted: true, details: { started: false, effect: 'not_started' } });
      if (!queued) context.markStarted?.();
    };
    try {
      start();
      if (args.page !== undefined && PAGEABLE.has(command) && !NATIVE_PAGED.has(command)) {
        const { page, ...rest } = args;
        if (rest.limit !== undefined) throw Object.assign(new Error('Use page.limit with page; limit is the unpaged result size'), { code: 'invalid_arguments', field: 'limit', notStarted: true });
        context.allItems = true;
        const items = command === 'workspaces.list' && context.workspaceIds ? scopedWorkspaces() : await route(command, rest, context, target);
        if (!Array.isArray(items)) throw new Error('This command did not return a list to page');
        const { workspaceId: ignored, ...filters } = rest;
        return pageItems(items, page, { command, scope: { workspaceId: target.workspaceId ?? null, filters } });
      }
      if (command === 'workspaces.list' && context.workspaceIds) return scopedWorkspaces();
      return await route(command, args, context, target);
    }
    catch (error) {
      // A one-time approval is spent only by a command that started; a pre-execution refusal gives it back.
      authority.restoreApproval(decision, { command, context, target, error });
      throw error;
    }
  };

  /** Batch path: per-command authority with the caller's identity, one transaction in the workspace store. */
  const runBatch = async (validated, context, target, state) => {
    const batch = prepareBatch(validated, context);
    state.args = batch.args;
    state.batch = batch.subs.map(sub => ({ command: sub.command, args: sub.args, workspaceId: sub.target.workspaceId }));
    Object.assign(target, batch.target);
    const spec = commands['batch.execute'];
    state.spec = spec;
    const decision = authority.authorizeBatch(batch.subs, batch.args, context, target);
    // After each command was authorized (so an out-of-scope command is reported as a denial), an agent batch stays in one workspace.
    if (batch.scoped && batch.workspaces.length !== 1) {
      const error = Object.assign(new Error('An agent batch must target exactly one workspace'), { code: 'ambiguous_target', notStarted: true });
      authority.restoreApproval(decision, { command: 'batch.execute', context, target, error });
      throw error;
    }
    state.decision = decision;
    context.authorityDecision = decision;
    if (target.workspaceId && context.workspaceIds) context.workspaceId = target.workspaceId;
    // Rechecked before commit: admission, client liveness and scope for every contained command.
    context.assertAuthorized = () => {
      admission.assertAutomationAdmitted(context.actor, 'batch.execute');
      for (const sub of batch.subs) {
        admission.assertAutomationAdmitted(context.actor, sub.command);
        clients?.assertAllowed(sub.command, context, { workspaceId: sub.target.workspaceId, actionClass: sub.spec.actionClass, ...(sub.spec.dataClasses ? { dataClasses: sub.spec.dataClasses } : {}), recheck: true });
      }
    };
    try { return await workspace.execute('batch.execute', batch.args, context); }
    catch (error) { authority.restoreApproval(decision, { command: 'batch.execute', context, target, error }); throw error; }
  };

  /** Costly captures run through the bounded queue; everything else routes directly. */
  const route = (command, args, context, target) => scheduler.isCapture(command)
    ? scheduler.capture({ command, context, workspaceId: target.workspaceId, tabId: target.tabId }, () => routeCommand(command, args, context, target))
    : routeCommand(command, args, context, target);

  const routeCommand = async (command, args, context, target) => {
    const call = async (nested, input) => {
      const nestedContext = { ...context };
      const value = await execute(nested, input, nestedContext);
      // A nested read can never widen the workspace of the outer command.
      if (target.workspaceId && nestedContext.resolvedWorkspaceId && nestedContext.resolvedWorkspaceId !== target.workspaceId) {
        throw Object.assign(new Error('Plugin input is outside the target workspace'), { code: 'target_mismatch' });
      }
      return value;
    };
    context.resolvedWorkspaceId = target.workspaceId;
    if (command === 'guide.get') return getGuidance(args.topic);
    if (command === 'weft.capabilities') return describeCapabilities({ commands, outcomeStatuses: OUTCOME_STATUSES, errorHttpStatus: ERROR_HTTP_STATUS, errorStatus: ERROR_STATUS, exitCodes,
      apiVersion: API_VERSION, eventTypes: EVENT_TYPES, eventRetention: eventLog ? { maxEvents: eventLog.maxEvents, maxAgeMs: eventLog.maxAgeMs, maxBytes: eventLog.maxBytes } : null,
      context, embeddings: Boolean(workspace.retrieval) });
    if (command === 'events.list') return listEvents(eventLog, args, context);
    if (command.startsWith('transfers.')) {
      if (!transfers) throw Object.assign(new Error('Chunked transfers are not available in this process'), { code: 'unavailable' });
      return transfers.execute(command, args, context);
    }
    if (command.startsWith('update.')) {
      if (!updates) throw Object.assign(new Error('Updates are not available in this process'), { code: 'unavailable' });
      return updates.execute(command, args, context);
    }
    if (hookCommands.has(command)) return executeHookCommand(command, args, context, { plugins, call });
    if (command.startsWith('plugin.') || Object.hasOwn(pluginCommandAdminDefinitions, command)) {
      return plugins.execute(command, command.startsWith('plugin.') ? { ...args, workspaceId: target.workspaceId ?? args.workspaceId } : args, context, { call });
    }
    if (command.startsWith('payments.')) {
      if (!payments) throw Object.assign(new Error('Payments are not available in this process'), { code: 'unavailable' });
      return payments.execute(command, args, context);
    }
    if (command.startsWith('credentials.')) {
      if (!credentials) throw Object.assign(new Error('The credential broker is not available in this process'), { code: 'unavailable' });
      return credentials.execute(command, args, context);
    }
    if (command.startsWith('extensions.')) {
      if (!extensions) throw Object.assign(new Error('Browser extensions are unavailable in this process'), { code: 'unavailable' });
      return extensions.execute(command, args, context);
    }
    if (/^(approvals|autonomy|activity)\./.test(command)) return authority.execute(command, args, context);
    if (command.startsWith('lists.')) return lists.execute(command, args, context);
    if (command.startsWith('clients.')) return clients.execute(command, args, context);
    if (command.startsWith('models.') || command.startsWith('chat.')) {
      if (['models.save', 'models.delete', 'models.probe'].includes(command) && context.actor !== 'human') throw Object.assign(new Error('Model configuration requires the trusted browser interface'), { code: 'human_required' });
      return providers.execute(command, args, context);
    }
    if (command.startsWith('handoffs.')) return workspace.executeHandoff(command, args, context);
    if (knowledge.handles(command)) return knowledge.execute(command, args, context);
    if (runtimeCommands.has(command)) return tasks.execute(command, args, context);
    if (command.startsWith('resume.') || command.startsWith('tabGroups.')) return resume.execute(command, args, context);
    if (command.startsWith('browsingData.')) return executeBrowsingCommand(command, args, context, { workspace });
    if (command.startsWith('display.')) {
      if (!display) throw Object.assign(new Error('Display controls are available only in the Weft application'), { code: 'unavailable' });
      return display.execute(command, args, context);
    }
    if (command === 'resources.status') {
      const visible = tab => !context.workspaceIds || context.workspaceIds.includes(tab.workspaceId);
      return { ...scheduler.status(context), memory: browser?.memoryStatus ?? null,
        suspendedTabs: [...(browser?.tabs?.values() ?? [])].filter(tab => tab.suspended && visible(tab)).map(tab => ({ tabId: tab.id, workspaceId: tab.workspaceId, at: tab.suspended.at, reason: tab.suspended.reason })),
        budgets: context.clientId ? clients?.budgetStatus?.(context.clientId) ?? null : null,
        notes: ['Idle suspension never touches leased, task-bound, busy, playing or edited tabs; a suspended tab reloads when opened or used.', 'Search indexing is incremental inside each record transaction rather than a deferred job.'] };
    }
    if (command === 'captures.list') return scheduler.list(context.workspaceIds ? { workspaceIds: context.workspaceIds, ...(args.workspaceId && { workspaceId: args.workspaceId }) } : args.workspaceId ? { workspaceId: args.workspaceId } : {});
    if (command === 'captures.cancel') return scheduler.cancel(args.jobId, context);
    if (Object.hasOwn(workspaceCommands, command)) return workspace.execute(command, args, context);
    if (command === 'browser.emergencyStop' && context.actor === 'human') {
      admission.stop();
      // Running model turns stop now and keep their partial replies, marked as stopped; plugin processes are terminated.
      if (providers.stopAll) providers.stopAll('emergency_stop'); else providers.close();
      plugins.close?.();
      // Runtime tasks stop scheduling; steps already submitted are reported separately and recorded when they return.
      const stopped = await tasks.emergencyStop();
      const result = await browser.execute(command, args, context);
      return { ...result, tasks: stopped };
    }
    const result = await browser.execute(command, args, context);
    if (command === 'browser.info' && result?.automation && ['human', 'admin'].includes(context.actor)) result.automation.pendingApprovals = authority.pendingApprovals();
    return result;
  };

  /** Nested (plugin/hook) dispatch: gated and recorded like any command, but publishes no live event or observer hook. */
  const execute = async (name, input, context) => {
    const target = { workspaceId: null, tabId: null };
    const state = {};
    const outcome = await executeOutcome((command, validated) => run(command, validated, context, target, state), name, input);
    authority.recordOutcome({ command: outcome.command, args: state.args ?? {}, context, outcome: { ...outcome, workspaceId: target.workspaceId ?? outcome.workspaceId, tabId: target.tabId ?? outcome.tabId },
      decision: state.decision, spec: state.spec ?? commands[outcome.command] ?? {}, batch: state.batch });
    if (outcome.error) throw new CommandError(outcome.error);
    return outcome.result;
  };

  /**
   * Run with an optional caller deadline. Before the command starts, an expired deadline means it
   * never will (every start point checks the signal); after it started, the signal asks it to stop
   * and the outcome reports whether it rolled back, stopped, or is still uncertain after a grace period.
   */
  const withDeadline = async (deadlineMs, context, state, work) => {
    const begun = Date.now();
    let timer;
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(DEADLINE), deadlineMs); timer.unref?.(); });
    const running = work();
    // The concurrency slot follows the work, not the reply: a timed-out command keeps its slot until it settles.
    state.running = running;
    const first = await Promise.race([running, expired]);
    clearTimeout(timer);
    if (first !== DEADLINE) {
      // The command observed the expired signal itself (for example a rollback just before commit).
      if (first.error?.code === 'deadline_exceeded' && first.error.details) Object.assign(first.error.details, { deadlineMs, elapsedMs: Date.now() - begun });
      return first;
    }
    const started = state.started === true;
    state.overdue = true;
    context.abortForDeadline();
    let settled = null;
    if (started) {
      let grace;
      settled = await Promise.race([running, new Promise(resolve => { grace = setTimeout(() => resolve(null), DEADLINE_GRACE_MS); grace.unref?.(); })]);
      clearTimeout(grace);
    }
    const details = { started, deadlineMs, elapsedMs: Date.now() - begun };
    // Completed just after the deadline: report the real (completed) result.
    if (settled && !settled.error) return { ...settled, deadline: { deadlineMs, exceeded: true } };
    if (settled?.error?.code === 'deadline_exceeded') { Object.assign(settled.error.details ??= {}, { deadlineMs, elapsedMs: details.elapsedMs }); return settled; }
    if (settled?.error && ['cancelled', 'timeout'].includes(settled.error.code)) {
      Object.assign(details, { effect: 'stopped', ...(settled.error.details?.turnId && { turnId: settled.error.details.turnId, partialSaved: settled.error.details.partialSaved }) });
    } else if (settled?.error) return settled;
    else details.effect = started ? 'uncertain' : 'not_started';
    const message = !started ? 'The request deadline passed before the command started; it will not run.'
      : details.effect === 'stopped' ? 'The request deadline passed; the command was stopped.' : 'The request deadline passed while the command was running; its effect is uncertain. Inspect current state before retrying.';
    return errorOutcome(Object.assign(new Error(message), { code: 'deadline_exceeded', details }), state.command ?? state.name ?? null, state.args ?? {}, state.normalized ?? []);
  };

  const dispatch = async (name, input = {}, caller = {}) => {
    const { deadlineMs, ...identity } = caller;
    const context = { actor: 'automation', ...identity };
    const target = { workspaceId: null, tabId: null };
    const state = { name, started: false };
    const began = Date.now();
    context.markStarted = () => { state.started = true; };
    let outcome;
    if (deadlineMs !== undefined && deadlineMs !== null) {
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) {
        outcome = errorOutcome(Object.assign(new Error(`deadlineMs must be an integer from 1 to ${MAX_DEADLINE_MS}`), { code: 'invalid_arguments' }), name, input, [], 'failed');
        outcome.error.field = 'deadlineMs';
      } else {
        // The deadline signal also follows the originating request's own cancellation.
        const controller = new AbortController();
        const upstream = identity.signal;
        if (upstream?.aborted) controller.abort(upstream.reason);
        else upstream?.addEventListener('abort', () => controller.abort(upstream.reason), { once: true });
        context.signal = controller.signal;
        context.abortForDeadline = () => controller.abort(Object.assign(new Error('Request deadline exceeded'), { code: 'deadline_exceeded' }));
        try { outcome = await withDeadline(deadlineMs, context, state, () => executeOutcome((command, validated) => { state.command = command; return run(command, validated, context, target, state); }, name, input)); }
        finally {
          // deadline_exceeded is returned promptly, but a command still running after its deadline keeps its slot until it settles.
          const release = state.release;
          if (release && state.overdue) { release.overdue?.(); state.running.then(release, release); } else release?.();
        }
      }
    } else {
      try { outcome = await executeOutcome((command, validated) => run(command, validated, context, target, state), name, input); }
      finally { state.release?.(); }
    }
    if (context.clientId && state.decision) {
      // Measured consumption: run time for every admitted command, spend only from provider-reported usage and a configured price.
      const cost = outcome.command === 'chat.send' ? outcome.result?.cost ?? null : null;
      clients?.recordConsumption?.(context.clientId, { runtimeMs: Date.now() - began, cost: cost && { amount: cost.amount, currency: cost.currency }, unpriced: outcome.command === 'chat.send' && outcome.execution === 'succeeded' && !cost });
    }
    outcome.workspaceId = target.workspaceId ?? outcome.workspaceId;
    outcome.tabId = target.tabId ?? outcome.tabId;
    if (context.workspaceIds && outcome.workspaceId && !context.workspaceIds.includes(outcome.workspaceId)) {
      outcome.workspaceId = null;
      outcome.tabId = null;
    }
    // Versioned request envelope: authenticated identity and linkage, never caller-asserted.
    outcome.request = { apiVersion: API_VERSION, requestId: typeof state.args?.requestId === 'string' ? state.args.requestId : null, actor: typeof context.actor === 'string' ? context.actor.slice(0, 64) : null,
      clientId: context.clientId ?? null, taskId: context.taskId ?? null, deadlineMs: Number.isSafeInteger(deadlineMs) ? deadlineMs : null };
    authority.recordOutcome({ command: outcome.command, args: state.args ?? {}, context, outcome, decision: state.decision, spec: state.spec ?? commands[outcome.command] ?? {}, batch: state.batch });
    const event = { type: 'command', command: outcome.command, actor: context.actor,
      status: outcome.execution === 'succeeded' ? 'success' : outcome.error?.code === 'approval_required' || outcome.error?.details?.authority ? 'blocked' : 'failure', outcome: outcome.status,
      workspaceId: outcome.workspaceId, tabId: outcome.tabId, createdAt: new Date().toISOString() };
    // Replay polling is not itself an event (it would feed the stream it reads).
    if (outcome.command !== 'events.list') onEvent(event);
    tasks.observe(event);
    // Handoff lifecycle changes are also published as metadata-only handoff events.
    if (outcome.execution === 'succeeded' && /^handoffs\.(create|accept|complete)$/.test(outcome.command) && outcome.result?.id) {
      const handoff = { type: 'handoff', command: outcome.command, actor: context.actor, status: outcome.result.status, workspaceId: outcome.workspaceId ?? outcome.result.workspaceId, handoffId: outcome.result.id,
        revision: outcome.result.revision, createdAt: event.createdAt };
      onEvent(handoff);
      tasks.observe(handoff);
    }
    // Task, artifact, policy, workspace and approval changes as typed, replayable metadata events.
    for (const domain of domainEvents(outcome, { actor: context.actor, batch: state.batch })) {
      if (context.workspaceIds && domain.workspaceId && !context.workspaceIds.includes(domain.workspaceId)) continue;
      onEvent(domain);
    }
    // A person's own commands on a recording tab become secret-free workflow steps.
    if (tasks.recordings.size && ['human', 'admin'].includes(context.actor)) tasks.recordCommand({ command: outcome.command, args: state.args ?? {}, outcome, context });
    // Observers get sanitized metadata after the outcome is final; they cannot change or delay it.
    if (Object.hasOwn(commands, outcome.command) && (!admission.status.stopped || ['human', 'admin'].includes(context.actor))) {
      void plugins.notify('after-command', { command: outcome.command, actor: String(context.actor).slice(0, 64), status: event.status === 'success' ? 'success' : 'failure',
        workspaceId: outcome.workspaceId ?? null, actionClass: state.spec?.actionClass ?? commands[outcome.command].actionClass, createdAt: event.createdAt }, context).catch(() => {});
    }
    return outcome;
  };
  dispatch.authority = authority;
  dispatch.scheduler = scheduler;
  dispatch.resume = resume;
  dispatch.plugins = plugins;
  dispatch.knowledge = knowledge;
  dispatch.tasks = tasks.attach({ dispatch, authority, providers, clients, browser, admission });
  return dispatch;
}
