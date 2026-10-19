import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_PANES, PANE_LAYOUTS, normalizeSizes, paneCount, panesFromSplit } from './panes.js';

/**
 * Project resume state and tab groups (#24). The resume record is per workspace view state
 * (section, active tab, split panes, panel layout, pinned resources); continuation links are
 * computed from current records so they never point at stale copies. Tab groups are workspace
 * records; tabs reference a group by id. Neither is exported: both describe this profile's tabs.
 */
export const RESUME_SECTIONS = Object.freeze(['overview', 'tabs', 'materials', 'context', 'tasks', 'conversations', 'artifacts', 'activity', 'approvals', 'workflows',
  'mailbox', 'settings', 'updates', 'privacy', 'downloads', 'history', 'bookmarks', 'browse']);
export const GROUP_COLORS = Object.freeze({ plum: 'Plum', sage: 'Sage', clay: 'Clay', sky: 'Sky', sand: 'Sand', rose: 'Rose', slate: 'Slate' });
const PIN_TYPES = Object.freeze({ material: 'materials', task: 'tasks', context: 'context', artifact: 'artifacts', conversation: 'conversations', workflow: 'workflows', handoff: 'handoffs' });
export const RESTORE_NOTICES = Object.freeze([
  'Tabs reopen by reloading their saved URLs; pages are not restored from memory.',
  'Sites may ask you to sign in again. Weft never stores passwords or replays logins.',
  'Unsent form input, media playback and other live page script state are not restored.',
  'Suspended tabs stay unloaded until you open or use them.',
  'Agent tab leases end with the session; tabs a person was driving stay with that person.',
]);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const PANE_RECORDS = Object.freeze({ artifact: 'artifacts', material: 'materials', task: 'tasks' });
const id = z.string().min(1).max(128);
const workspaceId = id.optional();
const name = z.string().trim().min(1).max(80);
const color = z.enum(Object.keys(GROUP_COLORS)).describe('Named color; the name is always shown as text too.');
const tabIds = z.array(z.number().int().positive()).max(200);
// One pane (#101): a live tab, a saved capture version, a material, a task, or the offline archive preview.
const paneItem = z.strictObject({ type: z.enum(['tab', 'artifact', 'material', 'task', 'preview']).describe('What the pane shows.'),
  id: z.union([id, z.number().int().positive()]).optional().describe('Tab id (number) or record id; omitted for the archive preview.'),
  versionId: id.optional().describe('Capture version shown in an artifact pane.') }).nullable();
const panesShape = z.strictObject({ layout: z.enum(Object.keys(PANE_LAYOUTS)).describe('1, 2-columns, 2-rows, 3-main, 3-columns or 4-grid.'),
  items: z.array(paneItem).max(MAX_PANES).describe('Pane contents in order; null leaves a pane empty.'),
  focused: z.number().int().min(0).max(MAX_PANES - 1).default(0).describe('Index of the focused pane.'),
  sizes: z.array(z.number().min(0).max(1)).max(2).optional().describe('Divider positions as fractions.') });
const pinned = z.array(z.strictObject({ type: z.enum([...Object.keys(PIN_TYPES), 'tab']).describe('Resource type.'), id: z.union([id, z.number().int().positive()]).describe('Record id, or a tab id for type tab.') })).max(50);

export const resumeCommandDefinitions = {
  'resume.get': ['Read a workspace resume record: last section, active tab, pane layout (1–4 panes), panel layout, pinned resources, continuation links to blockers, tasks and handoffs, and restore disclosures', { workspaceId }],
  'resume.save': ['Save the workspace last view: section, active tab, pane layout and focused pane, panel layout and pinned resources', { workspaceId,
    section: z.enum(RESUME_SECTIONS).optional().describe('Section to reopen.'),
    activeTabId: z.number().int().positive().nullable().optional().describe('Tab to reopen in this workspace.'),
    split: z.strictObject({ tabId: z.number().int().positive().nullable().describe('Second pane tab; null closes split view.'),
      focusedPane: z.enum(['primary', 'secondary']).default('primary').describe('Pane that had focus.') }).optional().describe('Legacy two-pane split view state; prefer panes.'),
    panes: panesShape.optional().describe('Pane layout of the browse area (1–4 panes of tabs, captures or documents).'),
    panels: z.strictObject({ sidebarCollapsed: z.boolean().optional().describe('Sidebar collapsed.'), agentPanelOpen: z.boolean().optional().describe('Agent panel open.'),
      conversationId: id.nullable().optional().describe('Conversation open in the agent panel.') }).optional().describe('Panel layout.'),
    pinned: pinned.optional().describe('Resources pinned to the overview, in order (replaces the list).') }],
  'tabGroups.list': ['List tab groups in a workspace with their tabs', { workspaceId }],
  'tabGroups.create': ['Create a named, colored tab group and optionally move tabs into it', { workspaceId, name, color: color.default('plum'), tabIds: tabIds.optional() }],
  'tabGroups.update': ['Rename, recolor, collapse or expand a tab group', { id, changes: z.strictObject({ name: name.optional(), color: color.optional(), collapsed: z.boolean().optional().describe('Collapsed in the tab strip.') }),
    expectedRevision: z.number().int().positive().optional() }],
  'tabGroups.delete': ['Delete a tab group; its tabs stay open and become ungrouped', { id }],
};
const schemas = Object.fromEntries(Object.entries(resumeCommandDefinitions).map(([key, [, shape]]) => [key, z.strictObject(shape)]));
const notFound = message => Object.assign(new Error(message), { code: 'not_found' });
const mismatch = message => Object.assign(new Error(message), { code: 'target_mismatch' });

export class ResumeService {
  constructor({ workspace, browser }) { this.workspace = workspace; this.browser = browser; }
  get data() { return this.workspace.data; }
  /** Serialize with record commands and commit (or roll back) in one transaction. */
  change(work) {
    const run = this.workspace.queue.then(() => this.workspace.commitChange(work));
    this.workspace.queue = run.catch(() => {});
    return run;
  }
  scope(args, context) {
    const target = args.workspaceId ?? context.workspaceId ?? this.workspace.activeWorkspaceId;
    if (context.workspaceId && target !== context.workspaceId) throw Object.assign(new Error('Workspace is outside the authorized scope'), { code: 'permission_required' });
    this.workspace.workspace(target);
    return target;
  }
  group(groupId, context) {
    const group = this.data.tabGroups.find(item => item.id === groupId);
    if (!group) throw notFound('Tab group not found');
    if (context.workspaceId && group.workspaceId !== context.workspaceId) throw Object.assign(new Error('Tab group is outside the authorized workspace'), { code: 'permission_required' });
    return group;
  }
  tabsOf(workspaceId) { return [...(this.browser?.tabs?.values() ?? [])].filter(tab => tab.workspaceId === workspaceId); }
  describeGroup(group) {
    return { ...structuredClone(group), colorName: GROUP_COLORS[group.color] ?? group.color, tabIds: this.tabsOf(group.workspaceId).filter(tab => tab.groupId === group.id).map(tab => tab.id) };
  }

  async execute(command, input, context = {}) {
    const args = schemas[command].parse(input);
    const actor = String(context.actor || 'human').slice(0, 200);
    if (command === 'resume.get') return this.get(this.scope(args, context));
    if (command === 'tabGroups.list') { const target = this.scope(args, context); return this.data.tabGroups.filter(group => group.workspaceId === target).map(group => this.describeGroup(group)); }
    if (command === 'resume.save') {
      const target = this.scope(args, context);
      const tabIn = tabId => { if (tabId == null) return null; const tab = this.browser?.tabs?.get(tabId); if (!tab) throw notFound(`Tab ${tabId} not found`); if (tab.workspaceId !== target) throw mismatch('Tab belongs to a different workspace'); return tabId; };
      const activeTabId = args.activeTabId === undefined ? undefined : tabIn(args.activeTabId);
      const split = args.split ? { tabId: tabIn(args.split.tabId), focusedPane: args.split.tabId == null ? 'primary' : args.split.focusedPane } : undefined;
      const panes = args.panes ? this.validatePanes(args.panes, target, tabIn) : undefined;
      if (args.panels?.conversationId) { const conversation = this.data.conversations.find(item => item.id === args.panels.conversationId); if (!conversation || conversation.workspaceId !== target) throw notFound('Conversation not found in this workspace'); }
      if (args.pinned) for (const item of args.pinned) {
        if (item.type === 'tab') { tabIn(typeof item.id === 'number' ? item.id : -1); continue; }
        const record = (this.data[PIN_TYPES[item.type]] ?? []).find(value => value.id === item.id);
        if (!record || record.workspaceId !== target) throw notFound(`Pinned ${item.type} ${item.id} not found in this workspace`);
      }
      return this.change(() => {
        let record = this.data.resumeStates.find(item => item.workspaceId === target);
        const now = new Date().toISOString();
        if (!record) { record = { id: `resume_${target}`, workspaceId: target, section: 'overview', activeTabId: null, split: { tabId: null, focusedPane: 'primary' }, panels: {}, pinned: [], createdAt: now, revision: 0 }; this.data.resumeStates.push(record); }
        if (args.section !== undefined) record.section = args.section;
        if (activeTabId !== undefined) record.activeTabId = activeTabId;
        if (split !== undefined) record.split = split;
        if (panes !== undefined) record.panes = panes;
        if (args.panels) record.panels = { ...record.panels, ...args.panels };
        if (args.pinned) record.pinned = args.pinned.map(item => ({ type: item.type, id: item.id }));
        Object.assign(record, { updatedAt: now, updatedBy: actor, revision: record.revision + 1 });
        return this.get(target);
      });
    }
    if (command === 'tabGroups.create') {
      const target = this.scope(args, context);
      const tabs = (args.tabIds ?? []).map(tabId => { const tab = this.browser?.tabs?.get(tabId); if (!tab) throw notFound(`Tab ${tabId} not found`); if (tab.workspaceId !== target) throw mismatch('Tab groups hold tabs from their own workspace only'); return tab; });
      if (this.data.tabGroups.filter(group => group.workspaceId === target).length >= 100) throw Object.assign(new Error('A workspace can have at most 100 tab groups'), { code: 'invalid_arguments' });
      const group = await this.change(() => {
        const now = new Date().toISOString();
        const record = { id: `tgrp_${randomUUID()}`, workspaceId: target, name: args.name, color: args.color, collapsed: false, createdBy: actor, createdAt: now, updatedAt: now, revision: 1 };
        this.data.tabGroups.push(record);
        return record;
      });
      for (const tab of tabs) tab.groupId = group.id;
      if (tabs.length) this.browser.persist();
      return this.describeGroup(group);
    }
    const group = this.group(args.id, context);
    if (command === 'tabGroups.update') {
      if (args.expectedRevision !== undefined && args.expectedRevision !== group.revision) throw Object.assign(new Error('Tab group changed; read it again before updating'), { code: 'stale_state' });
      await this.change(() => { Object.assign(group, args.changes, { updatedAt: new Date().toISOString(), revision: group.revision + 1 }); });
      return this.describeGroup(group);
    }
    // tabGroups.delete: tabs stay open and become ungrouped.
    const members = this.tabsOf(group.workspaceId).filter(tab => tab.groupId === group.id);
    await this.change(() => { this.data.tabGroups = this.data.tabGroups.filter(item => item.id !== group.id); });
    for (const tab of members) tab.groupId = null;
    if (members.length) this.browser.persist();
    return { deleted: true, id: group.id, ungroupedTabIds: members.map(tab => tab.id) };
  }

  /** Pane contents must exist in this workspace; a tab or record appears in one pane at most. */
  validatePanes(panes, target, tabIn) {
    const count = paneCount(panes.layout);
    if (panes.items.length > count) throw Object.assign(new Error(`Layout ${panes.layout} has ${count} pane${count === 1 ? '' : 's'}`), { code: 'invalid_arguments' });
    const seen = new Set();
    const items = panes.items.map(item => {
      if (!item) return null;
      if (item.type === 'preview') { if (seen.has('preview')) throw Object.assign(new Error('The archive preview can fill one pane'), { code: 'invalid_arguments' }); seen.add('preview'); return { type: 'preview' }; }
      if (item.id === undefined) throw Object.assign(new Error(`A ${item.type} pane needs an id`), { code: 'invalid_arguments' });
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) throw Object.assign(new Error('Each tab or record can be shown in one pane only'), { code: 'invalid_arguments' });
      seen.add(key);
      if (item.type === 'tab') { if (typeof item.id !== 'number') throw Object.assign(new Error('Tab panes use a numeric tab id'), { code: 'invalid_arguments' }); return { type: 'tab', id: tabIn(item.id) }; }
      const collection = PANE_RECORDS[item.type];
      const record = (this.data[collection] ?? []).find(value => value.id === item.id);
      if (!record || record.workspaceId !== target) throw notFound(`${item.type} ${item.id} not found in this workspace`);
      if (item.versionId !== undefined && !(record.versions ?? []).some(version => version.id === item.versionId)) throw notFound('Capture version not found');
      return { type: item.type, id: item.id, ...(item.versionId !== undefined && { versionId: item.versionId }) };
    });
    return { layout: panes.layout, items, focused: Math.min(panes.focused, count - 1), sizes: normalizeSizes(panes.layout, panes.sizes) };
  }

  /** Saved panes with items that no longer exist removed; an older record's split view becomes a two-pane layout. */
  panesView(record, live, activeTabId, splitTabId) {
    const source = record?.panes ?? panesFromSplit(activeTabId, { tabId: splitTabId, focusedPane: record?.split?.focusedPane });
    let missing = 0;
    const items = source.items.map(item => {
      if (!item) return null;
      if (item.type === 'preview') return item;
      const exists = item.type === 'tab' ? live.has(item.id) : (this.data[PANE_RECORDS[item.type]] ?? []).some(value => value.id === item.id && value.workspaceId === record?.workspaceId);
      if (!exists) { missing++; return null; }
      return item;
    });
    return { panes: { layout: source.layout, items, focused: source.focused ?? 0, sizes: normalizeSizes(source.layout, source.sizes), migratedFromSplit: !record?.panes }, missing };
  }

  /** Saved view plus continuation links computed from current records. */
  get(target) {
    const record = this.data.resumeStates.find(item => item.workspaceId === target);
    const tabs = this.tabsOf(target);
    const live = new Set(tabs.map(tab => tab.id));
    const link = (type, value) => ({ section: PIN_TYPES[type] ?? 'browse', kind: PIN_TYPES[type] ?? 'tabs', id: value, command: type === 'tab' ? 'tabs.activate' : `${PIN_TYPES[type]}.get` });
    const own = key => (this.data[key] ?? []).filter(item => item.workspaceId === target);
    const open = own('tasks').filter(task => !TERMINAL.has(task.status)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const taskLink = task => ({ id: task.id, title: task.title, status: task.status, blocker: task.blocker || null, nextStep: task.nextStep || null, checkpoint: task.checkpoint || null,
      tabIds: (task.tabIds ?? []).filter(tabId => live.has(tabId)), link: link('task', task.id) });
    const pinnedItems = (record?.pinned ?? []).map(item => {
      if (item.type === 'tab') { const tab = this.browser?.tabs?.get(item.id); return { ...item, exists: Boolean(tab && tab.workspaceId === target), title: tab ? this.browser.describe(tab).title : null, link: link('tab', item.id) }; }
      const value = own(PIN_TYPES[item.type]).find(entry => entry.id === item.id);
      return { ...item, exists: Boolean(value), title: value ? String(value.title || value.objective || value.blocker || value.id).slice(0, 240) : null, link: link(item.type, item.id) };
    });
    const activeTabId = record?.activeTabId != null && live.has(record.activeTabId) ? record.activeTabId : null;
    const splitTabId = record?.split?.tabId != null && live.has(record.split.tabId) ? record.split.tabId : null;
    const panes = this.panesView(record, live, activeTabId, splitTabId);
    return {
      workspaceId: target, saved: Boolean(record), updatedAt: record?.updatedAt ?? null, revision: record?.revision ?? 0,
      view: { section: record?.section ?? 'overview', activeTabId, split: { tabId: splitTabId, focusedPane: splitTabId ? record.split.focusedPane : 'primary' }, panes: panes.panes, panels: record?.panels ?? {} },
      missing: { activeTab: record?.activeTabId != null && !activeTabId, splitTab: record?.split?.tabId != null && !splitTabId, panes: panes.missing, pinned: pinnedItems.filter(item => !item.exists).length },
      pinned: pinnedItems,
      pinnedMaterials: own('materials').filter(item => item.pinned).slice(0, 20).map(item => ({ id: item.id, title: item.title, kind: item.kind, url: item.url ?? null, link: link('material', item.id) })),
      continue: {
        blockers: open.filter(task => task.blocker || task.run?.blocker || ['waiting_on_human', 'paused', 'uncertain'].includes(task.status)).slice(0, 20).map(taskLink),
        tasks: open.slice(0, 20).map(taskLink),
        handoffs: own('handoffs').filter(item => ['open', 'accepted'].includes(item.status)).slice(-20).reverse()
          .map(item => ({ id: item.id, status: item.status, kind: item.kind, objective: item.objective ?? null, blocker: item.blocker ?? null, nextStep: item.nextStep ?? null, from: item.from, to: item.to, link: { section: 'tasks', kind: 'handoffs', id: item.id, command: 'handoffs.get' } })),
      },
      tabs: { count: tabs.length, suspended: tabs.filter(tab => tab.suspended).length, groups: this.data.tabGroups.filter(group => group.workspaceId === target).map(group => this.describeGroup(group)) },
      notices: [...RESTORE_NOTICES],
    };
  }
}
