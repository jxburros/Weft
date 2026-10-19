import { isEverything } from './everything.js';
/** A process-wide latch, shared by every automation dispatcher and model loop. */
export class AutomationAdmission {
  constructor() { this.stoppedAt = null; }
  get status() { return { stopped: this.stoppedAt !== null, stoppedAt: this.stoppedAt }; }
  assertAutomationAdmitted(actor, command) {
    if (!['human', 'admin'].includes(actor) && this.stoppedAt !== null) {
      throw Object.assign(new Error('Automation is stopped. Resume it from the trusted browser interface.'), {
        code: 'emergency_stop', details: { command, stoppedAt: this.stoppedAt },
      });
    }
  }
  stop() { this.stoppedAt ??= new Date().toISOString(); return this.status; }
  resume(actor) {
    if (!['human', 'admin'].includes(actor)) throw Object.assign(new Error('Resuming automation requires the trusted browser interface'), { code: 'human_required' });
    this.stoppedAt = null;
    return this.status;
  }
}

/** Resolve once, before awaiting work, so human focus changes cannot retarget a call. */
export function resolveCommandTargets(name, input, context, { workspace, browser, commands, transfers = null }) {
  const args = { ...input };
  // Read-only lookup: the live state avoids copying every record per command.
  const state = workspace.data ?? workspace.snapshot();
  const human = ['human', 'admin'].includes(context.actor);
  // The built-in Everything workspace (#99) is never an implicit agent target: it does not make a profile
  // ambiguous, and an agent reaches it only by naming it (and, for a scoped client, through its grant).
  const candidates = state.workspaces.filter(value => !value.archived && (human || !isEverything(value.id))).map(value => value.id);
  const visible = id => !context.workspaceIds || context.workspaceIds.includes(id);
  const fields = commands[name]?.inputSchema?.properties ?? {};
  const pageTarget = name.startsWith('page.') || name === 'artifacts.capture';
  const fail = message => { throw Object.assign(new Error(message), { code: 'ambiguous_target', details: {
    workspaceIds: candidates.filter(visible), tabs: [...browser.tabs.values()].filter(tab => visible(tab.workspaceId)).map(tab => ({ tabId: tab.id, workspaceId: tab.workspaceId })),
  } }); };
  if (!human && candidates.length > 1) {
    if (Object.hasOwn(fields, 'workspaceId') && args.workspaceId == null) fail('Specify workspaceId when several workspaces exist');
    if (pageTarget && args.tabId == null) fail('Specify tabId when several workspaces exist');
  }
  const implicitTab = pageTarget && args.tabId == null;
  if (implicitTab) args.tabId = browser.activeId;
  const tab = args.tabId != null ? browser.tab(args.tabId) : null;
  if (!human && implicitTab && tab && isEverything(tab.workspaceId)) fail('The current tab is in Everything; specify tabId to act on it');
  if (Object.hasOwn(fields, 'workspaceId') && args.workspaceId == null && !(human && name === 'workspace.snapshot')) {
    args.workspaceId = tab?.workspaceId ?? workspace.activeWorkspaceId;
    if (!human && !tab && isEverything(args.workspaceId)) {
      if (candidates.length !== 1) fail('The current workspace is Everything; specify workspaceId');
      args.workspaceId = candidates[0];
    }
  }
  if (tab && args.workspaceId != null && name !== 'tabs.move' && tab.workspaceId !== args.workspaceId) {
    throw Object.assign(new Error('Tab belongs to a different workspace'), { code: 'target_mismatch' });
  }
  let workspaceId = args.workspaceId ?? tab?.workspaceId;
  if (!workspaceId && args.downloadId != null) workspaceId = browser.downloads.get(args.downloadId)?.record.workspaceId;
  if (!workspaceId && name.startsWith('workspaces.') && args.id) workspaceId = args.id;
  // Upload sessions belong to the workspace they were opened for.
  if (!workspaceId && typeof args.transferId === 'string') workspaceId = transfers?.sessions.get(args.transferId)?.workspaceId;
  if (!workspaceId) {
    const recordId = args.id ?? args.conversationId ?? args.artifactId ?? (args.source?.kind !== 'package' ? args.source?.id : undefined);
    if (recordId) for (const records of Object.values(state)) {
      if (!Array.isArray(records)) continue;
      const record = records.find(record => record.id === recordId && record.workspaceId);
      if (record) { workspaceId = record.workspaceId; break; }
    }
  }
  return { args, target: { workspaceId: workspaceId ?? null, tabId: tab?.id ?? null } };
}
