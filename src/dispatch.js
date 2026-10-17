import { commands, executeOutcome } from './commands.js';
import { commandDefinitions as workspaceCommands } from './workspace-commands.js';
import { resolveCommandTargets } from './admission.js';
import { getGuidance } from './guidance.js';

/** One command boundary for GUI, HTTP, CLI/MCP and future automation callers. */
export function createDispatcher({ workspace, browser, providers, clients, lists, admission, onEvent = () => {} }) {
  return async (name, input = {}, caller = {}) => {
    const context = { actor: 'automation', ...caller };
    let target = { workspaceId: null, tabId: null };
    const outcome = await executeOutcome(async (command, validated) => {
      admission.assertAutomationAdmitted(context.actor, command);
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
        clients?.assertAllowed(command, context, target);
      };
      if (command === 'guide.get') return getGuidance(args.topic);
      if (command.startsWith('lists.')) return lists.execute(command, args, context);
      if (command.startsWith('clients.')) return clients.execute(command, args, context);
      if (command.startsWith('models.') || command.startsWith('chat.')) {
        if (['models.save', 'models.delete', 'models.probe'].includes(command) && context.actor !== 'human') throw Object.assign(new Error('Model configuration requires the trusted browser interface'), { code: 'human_required' });
        return providers.execute(command, args, context);
      }
      if (Object.hasOwn(workspaceCommands, command)) return workspace.execute(command, args, context);
      if (command === 'browser.emergencyStop' && context.actor === 'human') {
        admission.stop();
        // Running model turns stop now and keep their partial replies, marked as stopped.
        if (providers.stopAll) providers.stopAll('emergency_stop'); else providers.close();
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
