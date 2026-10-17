import { commands, executeOutcome, normalizeCommand, validateCommand, CommandError } from './commands.js';
import { BATCHABLE } from './workspace.js';
import { commandDefinitions as workspaceCommands } from './workspace-commands.js';
import { resolveCommandTargets } from './admission.js';
import { getGuidance } from './guidance.js';

/** One command boundary for GUI, HTTP, CLI/MCP and future automation callers. */
export function createDispatcher({ workspace, browser, providers, clients, lists, admission, onEvent = () => {} }) {
  // Every contained command passes the same normalization, schema, target,
  // admission and client-grant checks as a standalone call before anything runs.
  function prepareBatch(validated, context) {
    const subs = validated.commands.map(({ command: name, args: input }, index) => {
      try {
        const prepared = normalizeCommand(name, input);
        if (!BATCHABLE.has(prepared.command)) throw new CommandError({ code: 'invalid_arguments', message: 'Only record commands can run in an atomic batch; page, browser, capture, import, backup and workspace-lifecycle commands cannot be rolled back.', field: 'command', allowed: [...BATCHABLE] });
        admission.assertAutomationAdmitted(context.actor, prepared.command);
        const args = validateCommand(prepared.command, prepared.args);
        if (context.clientId && context.workspaceIds.length === 1 && commands[prepared.command]?.inputSchema?.properties?.workspaceId && args.workspaceId == null) args.workspaceId = context.workspaceIds[0];
        const resolved = resolveCommandTargets(prepared.command, args, context, { workspace, browser, commands });
        if (context.clientId) {
          if (!resolved.target.workspaceId && context.workspaceIds.length === 1) resolved.target.workspaceId = context.workspaceIds[0];
          clients.assertAllowed(prepared.command, context, resolved.target);
        }
        return { command: prepared.command, args: resolved.args, target: resolved.target };
      } catch (error) {
        const details = error instanceof CommandError ? error.toJSON() : null;
        if (details) throw new CommandError({ ...details, message: `batch command ${index} (${name}): ${details.message}`, field: `commands.${index}.${details.field === 'command' ? 'command' : `args.${details.field}`}` });
        error.message = `batch command ${index} (${name}): ${error.message}`;
        throw error;
      }
    });
    const workspaces = [...new Set(subs.map(sub => sub.target.workspaceId).filter(Boolean))];
    const target = { workspaceId: workspaces.length === 1 ? workspaces[0] : null, tabId: null };
    if (context.clientId) {
      if (workspaces.length !== 1 || subs.some(sub => !sub.target.workspaceId)) throw Object.assign(new Error('A client batch must target exactly one authorized workspace'), { code: 'ambiguous_target' });
      clients.assertAllowed('batch.execute', context, target);
      context.workspaceId = target.workspaceId;
    }
    context.assertAuthorized = () => {
      admission.assertAutomationAdmitted(context.actor, 'batch.execute');
      for (const sub of subs) clients?.assertAllowed(sub.command, context, sub.target);
    };
    const args = { commands: subs.map(({ command, args }) => ({ command, args })) };
    if (validated.dryRun !== undefined) args.dryRun = validated.dryRun;
    if (validated.requestId !== undefined) args.requestId = validated.requestId;
    return { args, target };
  }
  return async (name, input = {}, caller = {}) => {
    const context = { actor: 'automation', ...caller };
    let target = { workspaceId: null, tabId: null };
    const outcome = await executeOutcome(async (command, validated) => {
      admission.assertAutomationAdmitted(context.actor, command);
      if (command === 'batch.execute') {
        const batch = prepareBatch(validated, context);
        target = batch.target;
        return workspace.execute('batch.execute', batch.args, context);
      }
      // A single-workspace grant is already an explicit target, not human focus.
      if (context.clientId && context.workspaceIds.length === 1 && commands[command]?.inputSchema?.properties?.workspaceId && validated.workspaceId == null) {
        validated.workspaceId = context.workspaceIds[0];
      }
      const resolved = resolveCommandTargets(command, validated, context, { workspace, browser, commands });
      const args = resolved.args;
      target = resolved.target;
      if (context.clientId) {
        if (!target.workspaceId && !['guide.get', 'browser.info', 'workspaces.list'].includes(command)) {
          if (context.workspaceIds.length !== 1) throw Object.assign(new Error('Specify a workspace target for this client command'), { code: 'ambiguous_target' });
          target.workspaceId = context.workspaceIds[0];
        }
        clients.assertAllowed(command, context, target);
        if (target.workspaceId) context.workspaceId = target.workspaceId;
        if (command === 'workspaces.list') return workspace.snapshot().workspaces.filter(item => context.workspaceIds.includes(item.id));
      }
      context.assertAuthorized = () => {
        admission.assertAutomationAdmitted(context.actor, command);
      if (command === 'batch.execute') {
        const batch = prepareBatch(validated, context);
        target = batch.target;
        return workspace.execute('batch.execute', batch.args, context);
      }
        clients?.assertAllowed(command, context, target);
      };
      if (command === 'guide.get') return getGuidance(args.topic);
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
      }
      const result = await browser.execute(command, args, context);
      return result;
    }, name, input);
    outcome.workspaceId = target.workspaceId ?? outcome.workspaceId;
    outcome.tabId = target.tabId ?? outcome.tabId;
    if (context.clientId && outcome.workspaceId && !context.workspaceIds.includes(outcome.workspaceId)) {
      outcome.workspaceId = null;
      outcome.tabId = null;
    }
    onEvent({ type: 'command', command: outcome.command, actor: context.actor,
      status: outcome.execution === 'succeeded' ? 'success' : 'failure', workspaceId: outcome.workspaceId, tabId: outcome.tabId, createdAt: new Date().toISOString() });
    return outcome;
  };
}
