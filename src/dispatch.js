import { commands, executeOutcome } from './commands.js';
import { commandDefinitions as workspaceCommands } from './workspace-commands.js';
import { resolveCommandTargets } from './admission.js';
import { getGuidance } from './guidance.js';
import { Authority } from './authority.js';

const TARGETLESS = ['guide.get', 'browser.info', 'workspaces.list', 'approvals.list', 'autonomy.get', 'activity.verify'];
/** One command boundary for GUI, HTTP, CLI/MCP, internal model tools and future automation callers. */
export function createDispatcher({ workspace, browser, providers, clients, lists, admission, authority, onEvent = () => {} }) {
  // The gate is not optional: callers that do not supply an Authority still get one (durable when a profile directory is known).
  authority ??= new Authority({ directory: clients?.directory ?? workspace?.directory ?? null, workspace, browser, clients });
  const dispatch = async (name, input = {}, caller = {}) => {
    const context = { actor: 'automation', ...caller };
    let target = { workspaceId: null, tabId: null };
    let decision = null;
    let validatedArgs = null;
    const outcome = await executeOutcome(async (command, validated) => {
      validatedArgs = validated;
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
      target = resolved.target;
      if (context.workspaceIds && !['human', 'admin'].includes(context.actor)) {
        if (!target.workspaceId && !TARGETLESS.includes(command)) {
          if (context.workspaceIds.length !== 1) throw Object.assign(new Error('Specify a workspace target for this client command'), { code: 'ambiguous_target' });
          target.workspaceId = context.workspaceIds[0];
        }
      }
      // Every non-human command passes the shared gate here, before any handler runs.
      decision = authority.authorize(command, args, context, target, commands[command] ?? {});
      if (target.workspaceId && context.workspaceIds) context.workspaceId = target.workspaceId;
      context.assertAuthorized = () => {
        admission.assertAutomationAdmitted(context.actor, command);
        clients?.assertAllowed(command, context, { workspaceId: target.workspaceId, workspaceIds: authority.touchedWorkspaces(command, args, target), recheck: true });
      };
      if (command === 'workspaces.list' && context.workspaceIds) return workspace.snapshot().workspaces.filter(item => context.workspaceIds.includes(item.id));
      authority.recordAttempt({ command, args, context, target, decision });
      if (command === 'guide.get') return getGuidance(args.topic);
      if (/^(approvals|autonomy|activity)\./.test(command)) return authority.execute(command, args, context);
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
      if (command === 'browser.info' && result?.automation && ['human', 'admin'].includes(context.actor)) result.automation.pendingApprovals = authority.pendingApprovals();
      return result;
    }, name, input);
    outcome.workspaceId = target.workspaceId ?? outcome.workspaceId;
    outcome.tabId = target.tabId ?? outcome.tabId;
    if (context.workspaceIds && outcome.workspaceId && !context.workspaceIds.includes(outcome.workspaceId)) {
      outcome.workspaceId = null;
      outcome.tabId = null;
    }
    authority.recordOutcome({ command: outcome.command, args: validatedArgs ?? {}, context, outcome, decision, spec: commands[outcome.command] ?? {} });
    onEvent({ type: 'command', command: outcome.command, actor: context.actor,
      status: outcome.execution === 'succeeded' ? 'success' : outcome.error?.code === 'approval_required' || outcome.error?.details?.authority ? 'blocked' : 'failure',
      workspaceId: outcome.workspaceId, tabId: outcome.tabId, createdAt: new Date().toISOString() });
    return outcome;
  };
  dispatch.authority = authority;
  return dispatch;
}
