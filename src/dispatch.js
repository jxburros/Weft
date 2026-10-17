import { commands, executeOutcome, normalizeCommand, validateCommand, CommandError } from './commands.js';
import { BATCHABLE } from './workspace.js';
import { commandDefinitions as workspaceCommands } from './workspace-commands.js';
import { resolveCommandTargets } from './admission.js';
import { getGuidance } from './guidance.js';
import { Authority } from './authority.js';
import { raiseActionClass } from './autonomy.js';
import { executeHookCommand, pluginCommandAdminDefinitions } from './plugin-commands.js';
import { PluginRegistry } from './plugins/registry.js';

const TARGETLESS = ['guide.get', 'browser.info', 'workspaces.list', 'approvals.list', 'autonomy.get', 'activity.verify', 'plugins.list', 'update.status'];
const hookCommands = new Set(['workspaces.exportAs', 'artifacts.render', 'activity.report', 'page.extract']);

/** One command boundary for GUI, HTTP, CLI/MCP, internal model tools, plugins and future automation callers. */
export function createDispatcher({ workspace, browser, providers, clients, lists, extensions, updates, plugins = new PluginRegistry(), admission, authority, onEvent = () => {} }) {
  // The gate is not optional: callers that do not supply an Authority still get one (durable when a profile directory is known).
  authority ??= new Authority({ directory: clients?.directory ?? workspace?.directory ?? null, workspace, browser, clients });

  /** Catalog metadata, with plugins.invoke raised to the invoked plugin operation's manifest-derived class. */
  const specFor = (command, args) => {
    const spec = commands[command] ?? {};
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
        const resolved = resolveCommandTargets(prepared.command, args, context, { workspace, browser, commands });
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
    admission.assertAutomationAdmitted(context.actor, command);
    if (context.clientId) {
      const grant = clients.current?.(context.clientId);
      if (grant) { context.workspaceIds = [...grant.workspaceIds]; context.taskId = grant.taskId ?? undefined; }
    }
    // A single-workspace grant is already an explicit target, not human focus.
    if (context.workspaceIds?.length === 1 && commands[command]?.inputSchema?.properties?.workspaceId && validated.workspaceId == null) {
      validated.workspaceId = context.workspaceIds[0];
    }
    if (command === 'batch.execute') return runBatch(validated, context, target, state);
    const resolved = resolveCommandTargets(command, validated, context, { workspace, browser, commands });
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
    if (command === 'workspaces.list' && context.workspaceIds) return workspace.snapshot().workspaces.filter(item => context.workspaceIds.includes(item.id));
    authority.recordAttempt({ command, args, context, target, decision });
    return route(command, args, context, target);
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
    if (batch.scoped && batch.workspaces.length !== 1) throw Object.assign(new Error('An agent batch must target exactly one workspace'), { code: 'ambiguous_target', notStarted: true });
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
    return workspace.execute('batch.execute', batch.args, context);
  };

  const route = async (command, args, context, target) => {
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
    if (command.startsWith('update.')) {
      if (!updates) throw Object.assign(new Error('Updates are not available in this process'), { code: 'unavailable' });
      return updates.execute(command, args, context);
    }
    if (hookCommands.has(command)) return executeHookCommand(command, args, context, { plugins, call });
    if (command.startsWith('plugin.') || Object.hasOwn(pluginCommandAdminDefinitions, command)) {
      return plugins.execute(command, command.startsWith('plugin.') ? { ...args, workspaceId: target.workspaceId ?? args.workspaceId } : args, context, { call });
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
    if (Object.hasOwn(workspaceCommands, command)) return workspace.execute(command, args, context);
    if (command === 'browser.emergencyStop' && context.actor === 'human') {
      admission.stop();
      // Running model turns stop now and keep their partial replies, marked as stopped; plugin processes are terminated.
      if (providers.stopAll) providers.stopAll('emergency_stop'); else providers.close();
      plugins.close?.();
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

  const dispatch = async (name, input = {}, caller = {}) => {
    const context = { actor: 'automation', ...caller };
    const target = { workspaceId: null, tabId: null };
    const state = {};
    const outcome = await executeOutcome((command, validated) => run(command, validated, context, target, state), name, input);
    outcome.workspaceId = target.workspaceId ?? outcome.workspaceId;
    outcome.tabId = target.tabId ?? outcome.tabId;
    if (context.workspaceIds && outcome.workspaceId && !context.workspaceIds.includes(outcome.workspaceId)) {
      outcome.workspaceId = null;
      outcome.tabId = null;
    }
    authority.recordOutcome({ command: outcome.command, args: state.args ?? {}, context, outcome, decision: state.decision, spec: state.spec ?? commands[outcome.command] ?? {}, batch: state.batch });
    const event = { type: 'command', command: outcome.command, actor: context.actor,
      status: outcome.execution === 'succeeded' ? 'success' : outcome.error?.code === 'approval_required' || outcome.error?.details?.authority ? 'blocked' : 'failure',
      workspaceId: outcome.workspaceId, tabId: outcome.tabId, createdAt: new Date().toISOString() };
    onEvent(event);
    // Handoff lifecycle changes are also published as metadata-only handoff events.
    if (outcome.execution === 'succeeded' && /^handoffs\.(create|accept|complete)$/.test(outcome.command) && outcome.result?.id) {
      onEvent({ type: 'handoff', command: outcome.command, actor: context.actor, status: outcome.result.status, workspaceId: outcome.workspaceId ?? outcome.result.workspaceId, handoffId: outcome.result.id,
        revision: outcome.result.revision, createdAt: event.createdAt });
    }
    // Observers get sanitized metadata after the outcome is final; they cannot change or delay it.
    if (Object.hasOwn(commands, outcome.command) && (!admission.status.stopped || ['human', 'admin'].includes(context.actor))) {
      void plugins.notify('after-command', { command: outcome.command, actor: String(context.actor).slice(0, 64), status: event.status === 'success' ? 'success' : 'failure',
        workspaceId: outcome.workspaceId ?? null, actionClass: state.spec?.actionClass ?? commands[outcome.command].actionClass, createdAt: event.createdAt }, context).catch(() => {});
    }
    return outcome;
  };
  dispatch.authority = authority;
  dispatch.plugins = plugins;
  return dispatch;
}
