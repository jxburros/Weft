import { commands, executeOutcome, validateCommand, CommandError } from './commands.js';
import { commandDefinitions as workspaceCommands } from './workspace-commands.js';
import { resolveCommandTargets } from './admission.js';
import { getGuidance } from './guidance.js';
import { Authority } from './authority.js';
import { raiseActionClass } from './autonomy.js';
import { executeHookCommand, pluginCommandAdminDefinitions } from './plugin-commands.js';
import { PluginRegistry } from './plugins/registry.js';

const TARGETLESS = ['guide.get', 'browser.info', 'workspaces.list', 'approvals.list', 'autonomy.get', 'activity.verify', 'plugins.list'];
const hookCommands = new Set(['workspaces.exportAs', 'artifacts.render', 'activity.report', 'page.extract']);

/** One command boundary for GUI, HTTP, CLI/MCP, internal model tools, plugins and future automation callers. */
export function createDispatcher({ workspace, browser, providers, clients, lists, extensions, plugins = new PluginRegistry(), admission, authority, onEvent = () => {} }) {
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
      decision: state.decision, spec: state.spec ?? commands[outcome.command] ?? {} });
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
    authority.recordOutcome({ command: outcome.command, args: state.args ?? {}, context, outcome, decision: state.decision, spec: state.spec ?? commands[outcome.command] ?? {} });
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
