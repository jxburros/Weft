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
export function resolveCommandTargets(name, input, context, { workspace, browser, commands }) {
  const args = { ...input };
  const state = workspace.snapshot();
  const candidates = state.workspaces.filter(value => !value.archived).map(value => value.id);
  const human = ['human', 'admin'].includes(context.actor);
  const fields = commands[name]?.inputSchema?.properties ?? {};
  const pageTarget = name.startsWith('page.') || name === 'artifacts.capture';
  const fail = message => { throw Object.assign(new Error(message), { code: 'ambiguous_target', details: {
    workspaceIds: candidates, tabs: [...browser.tabs.values()].map(tab => ({ tabId: tab.id, workspaceId: tab.workspaceId })),
  } }); };
  if (!human && candidates.length > 1) {
    if (Object.hasOwn(fields, 'workspaceId') && args.workspaceId == null) fail('Specify workspaceId when several workspaces exist');
    if (pageTarget && args.tabId == null) fail('Specify tabId when several workspaces exist');
  }
  if (pageTarget && args.tabId == null) args.tabId = browser.activeId;
  let tab = args.tabId != null ? browser.tab(args.tabId) : null;
  if (Object.hasOwn(fields, 'workspaceId') && args.workspaceId == null) args.workspaceId = tab?.workspaceId ?? workspace.activeWorkspaceId;
  if (tab && args.workspaceId != null && name !== 'tabs.move' && tab.workspaceId !== args.workspaceId) {
    throw Object.assign(new Error('Tab belongs to a different workspace'), { code: 'target_mismatch' });
  }
  let workspaceId = args.workspaceId ?? tab?.workspaceId;
  if (!workspaceId && args.downloadId != null) workspaceId = browser.downloads.get(args.downloadId)?.record.workspaceId;
  if (!workspaceId && name.startsWith('workspaces.') && args.id) workspaceId = args.id;
  if (!workspaceId) {
    const recordId = args.id ?? args.conversationId ?? args.artifactId;
    if (recordId) for (const records of Object.values(state)) {
      if (!Array.isArray(records)) continue;
      const record = records.find(record => record.id === recordId && record.workspaceId);
      if (record) { workspaceId = record.workspaceId; break; }
    }
  }
  return { args, target: { workspaceId: workspaceId ?? null, tabId: tab?.id ?? null } };
}
