import { commands, executeOutcome, validateCommand } from './commands.js';
import { commandDefinitions as workspaceCommands } from './workspace-commands.js';
import { resolveCommandTargets } from './admission.js';
import { getGuidance } from './guidance.js';
import { executeHookCommand, pluginCommandAdminDefinitions } from './plugin-commands.js';
import { PluginRegistry } from './plugins/registry.js';

const hookCommands = new Set(['workspaces.exportAs', 'artifacts.render', 'activity.report', 'page.extract']);

/** One command boundary for GUI, HTTP, CLI/MCP and future automation callers. */
export function createDispatcher({ workspace, browser, providers, clients, lists, extensions, plugins = new PluginRegistry(), admission, onEvent = () => {} }) {
  // Authorize and route one validated command. Plugin capabilities and hook
  // commands re-enter here, so nested reads carry the caller's own authority.
  const run = async (command, validated, context, target) => {
    admission.assertAutomationAdmitted(context.actor, command);
    // A single-workspace grant is already an explicit target, not human focus.
    if (context.clientId && context.workspaceIds.length === 1 && commands[command]?.inputSchema?.properties?.workspaceId && validated.workspaceId == null) {
      validated.workspaceId = context.workspaceIds[0];
    }
    const resolved = resolveCommandTargets(command, validated, context, { workspace, browser, commands });
    const args = resolved.args;
    Object.assign(target, resolved.target);
    if (context.clientId) {
      if (!target.workspaceId && !['guide.get', 'browser.info', 'workspaces.list'].includes(command)) {
        if (context.workspaceIds.length !== 1) throw Object.assign(new Error('Specify a workspace target for this client command'), { code: 'ambiguous_target' });
        target.workspaceId = context.workspaceIds[0];
      }
      clients.assertAllowed(command, context, target, commands[command]?.actionClass);
      if (target.workspaceId) context.workspaceId = target.workspaceId;
      if (command === 'workspaces.list') return workspace.snapshot().workspaces.filter(item => context.workspaceIds.includes(item.id));
    }
    context.assertAuthorized = () => {
      admission.assertAutomationAdmitted(context.actor, command);
      clients?.assertAllowed(command, context, target, commands[command]?.actionClass);
    };
    const call = async (nested, input) => {
      const nestedContext = { ...context };
      const value = await run(nested, validateCommand(nested, input), nestedContext, { workspaceId: null, tabId: null });
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
    if (command.startsWith('lists.')) return lists.execute(command, args, context);
    if (command.startsWith('clients.')) return clients.execute(command, args, context);
    if (command.startsWith('models.') || command.startsWith('chat.')) {
      if (['models.save', 'models.delete'].includes(command) && context.actor !== 'human') throw Object.assign(new Error('Model configuration requires the trusted browser interface'), { code: 'human_required' });
      return providers.execute(command, args, context);
    }
    if (Object.hasOwn(workspaceCommands, command)) return workspace.execute(command, args, context);
    if (command === 'browser.emergencyStop' && context.actor === 'human') {
      admission.stop();
      providers.close();
      plugins.close?.();
    }
    return browser.execute(command, args, context);
  };

  return async (name, input = {}, caller = {}) => {
    const context = { actor: 'automation', ...caller };
    const target = { workspaceId: null, tabId: null };
    const outcome = await executeOutcome((command, validated) => run(command, validated, context, target), name, input);
    outcome.workspaceId = target.workspaceId ?? outcome.workspaceId;
    outcome.tabId = target.tabId ?? outcome.tabId;
    if (context.clientId && outcome.workspaceId && !context.workspaceIds.includes(outcome.workspaceId)) {
      outcome.workspaceId = null;
      outcome.tabId = null;
    }
    const event = { type: 'command', command: outcome.command, actor: context.actor,
      status: outcome.execution === 'succeeded' ? 'success' : 'failure', workspaceId: outcome.workspaceId, tabId: outcome.tabId, createdAt: new Date().toISOString() };
    onEvent(event);
    // Observers get sanitized metadata after the outcome is final; they cannot change or delay it.
    if (Object.hasOwn(commands, outcome.command) && (!admission.status.stopped || ['human', 'admin'].includes(context.actor))) {
      void plugins.notify('after-command', { command: outcome.command, actor: String(context.actor).slice(0, 64), status: event.status, workspaceId: outcome.workspaceId ?? null,
        actionClass: commands[outcome.command].actionClass, createdAt: event.createdAt }, context).catch(() => {});
    }
    return outcome;
  };
}
