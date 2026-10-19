import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readJson, writeJsonDurable } from './atomic-json.js';
import { classify } from './autonomy.js';

/**
 * Per-site web permissions (#90) and popup allowances (#97). Decisions are made only by a person in
 * Weft's own interface, keyed by workspace and top-level origin, and kept in a policy file outside the
 * workspace records, so exports, imports and moving a tab to another workspace never carry them.
 * Pages, agents and automation can trigger a request; they can never answer one.
 */
export const PROMPTED_PERMISSIONS = Object.freeze({
  camera: 'Use your camera', microphone: 'Use your microphone', geolocation: 'Know your location', notifications: 'Show notifications',
  'clipboard-read': 'See text and images you copied', 'display-capture': 'Share your screen or a window', midi: 'Use MIDI devices', sensors: 'Use motion and light sensors',
});
/** Requests Weft denies without asking. Listed so Site controls can say so. */
export const UNPROMPTED_PERMISSIONS = Object.freeze({
  usb: 'USB devices', serial: 'Serial ports', hid: 'HID devices', bluetooth: 'Bluetooth devices', midiSysex: 'MIDI system-exclusive messages',
  'idle-detection': 'Idle detection', 'window-management': 'Window placement', mediaKeySystem: 'Protected media (DRM)', pointerLock: 'Pointer lock',
  keyboardLock: 'Keyboard lock', fullscreen: 'Fullscreen', 'storage-access': 'Cross-site storage access', 'top-level-storage-access': 'Cross-site storage access',
  'speaker-selection': 'Speaker selection', fileSystem: 'File system access', 'clipboard-sanitized-write': 'Writing to the clipboard', unknown: 'Unrecognized requests',
});
/** Decisions that can be remembered per site. Popups use the same store with their own permission name. */
export const STORED_PERMISSIONS = Object.freeze([...Object.keys(PROMPTED_PERMISSIONS), 'popups']);
export const PROMPT_DECISIONS = Object.freeze(['allow-once', 'allow-while-open', 'allow-always', 'block', 'block-always']);
const SENSOR_NAMES = new Set(['sensors', 'accelerometer', 'gyroscope', 'magnetometer', 'ambient-light-sensor']);
const PROMPT_TTL_MS = 60_000;
const PROMPT_GESTURE_MS = 5_000;
const PROMPTS_PER_DOCUMENT = 3;
const RATE_WINDOW_MS = 60_000;

const workspaceId = z.string().min(1).max(200).optional();
const origin = z.string().max(2048).refine(value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value; } catch { return false; } },
  'Expected an http(s) origin such as https://example.com').describe('Top-level site origin, for example https://meet.example.com.');
export const permissionCommandDefinitions = {
  'permissions.list': ['List per-site permission and popup decisions, pending prompts and which requests Weft asks about or always denies', { workspaceId }],
  'permissions.respond': ['Human answers a pending browser-owned permission prompt (deny when dismissed)', {
    promptId: z.string().regex(/^perm_[0-9a-f-]{36}$/).describe('Pending prompt id from permissions.list or the tab protection state.'),
    decision: z.enum(PROMPT_DECISIONS).describe('allow-once: this page only; allow-while-open: until the site has no open tab in this workspace; allow-always / block-always: remembered for the site in this workspace; block: until the site is closed.'),
    sourceId: z.string().min(1).max(200).optional().describe('Screen sharing only: the screen or window chosen in the source picker.') }],
  'permissions.set': ['Human reviews or revokes a remembered site permission or popup decision in a workspace', { workspaceId, origin,
    permission: z.enum(STORED_PERMISSIONS), decision: z.enum(['allow', 'block', 'ask']).describe('ask removes every remembered and open-site decision, so the site must ask again.') }],
  'permissions.configure': ['Human turns the global "never ask" setting on or off (every prompted request is denied without a prompt)', { neverAsk: z.boolean() }],
  'permissions.stop': ['Human stops camera, microphone or screen sharing on a tab: one-page grants end and the page reloads', { tabId: z.number().int().positive(), workspaceId }],
  'popups.allow': ['Human opens a blocked popup once in a new tab, optionally allowing popups from the site in this workspace from now on', {
    tabId: z.number().int().positive(), workspaceId, popupId: z.string().regex(/^pop_\d{1,9}$/).describe('Blocked popup id from the tab protection state (blockedPopups).'),
    always: z.boolean().default(false).describe('Also allow popups from this site in this workspace (revoke in Site controls).') }],
};
export const PERMISSION_ADMIN_COMMANDS = Object.freeze(['permissions.respond', 'permissions.set', 'permissions.configure', 'permissions.stop', 'popups.allow']);
classify('local_read', 'permissions.list');
classify('administration', PERMISSION_ADMIN_COMMANDS);

const failure = (code, message, details) => Object.assign(new Error(message), { code, ...(details && { details }) });
export function topOrigin(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : null; } catch { return null; }
}

/** Weft permission names for one Electron permission request or check. */
export function weftPermissions(permission, details = {}) {
  if (permission === 'media') {
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : details.mediaType ? [details.mediaType] : [];
    const names = [...new Set(types.map(type => type === 'video' ? 'camera' : type === 'audio' ? 'microphone' : null).filter(Boolean))];
    return names.length ? names : ['camera', 'microphone'];
  }
  if (SENSOR_NAMES.has(permission)) return ['sensors'];
  if (Object.hasOwn(PROMPTED_PERMISSIONS, permission)) return [permission];
  return [];
}
/** getDisplayMedia's preliminary media request carries no device types; the display-media handler then decides it. */
export const isDisplayPreflight = (permission, details = {}) => permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0 && Boolean(details.securityOrigin);

export class SitePermissions {
  constructor({ path = null, browser, now = () => Date.now(), audit = () => {} } = {}) {
    Object.assign(this, { path, browser, now, audit });
    const saved = path ? readJson(path, { version: 1, neverAsk: false, decisions: [] }) : { version: 1, neverAsk: false, decisions: [] };
    this.neverAsk = saved.neverAsk === true;
    this.decisions = Array.isArray(saved.decisions) ? saved.decisions.filter(item => item && STORED_PERMISSIONS.includes(item.permission) && ['allow', 'block'].includes(item.decision)
      && typeof item.workspaceId === 'string' && topOrigin(item.origin) === item.origin) : [];
    // In-memory only: "while open" and "until closed" decisions, one-page grants and pending prompts.
    this.open = new Map();
    this.once = new Map();
    this.prompts = new Map();
    this.rates = new Map();
  }

  save() { if (this.path) writeJsonDurable(this.path, { version: 1, neverAsk: this.neverAsk, decisions: this.decisions }); }
  key(workspace, siteOrigin, permission) { return `${workspace}|${siteOrigin}|${permission}`; }
  stored(workspace, siteOrigin, permission) { return this.decisions.find(item => item.workspaceId === workspace && item.origin === siteOrigin && item.permission === permission) ?? null; }

  /** Current answer without asking: 'allow', 'block' or null (ask). */
  decisionFor(tab, siteOrigin, permission) {
    if (!tab || !siteOrigin) return 'block';
    if (this.once.get(`${tab.id}|${tab.documentSerial ?? 0}|${permission}`)) return 'allow';
    const open = this.open.get(this.key(tab.workspaceId, siteOrigin, permission));
    if (open) return open.decision;
    return this.stored(tab.workspaceId, siteOrigin, permission)?.decision ?? null;
  }

  /** Permission check handler: true only for a current allow decision. Never prompts. */
  check(tab, permission, requestingOrigin, details = {}) {
    if (!tab || this.browser?.hidden) return false;
    const site = topOrigin(tab.view?.webContents?.getURL?.() || tab.url);
    if (!site) return false;
    // Embedded frames from another origin never use the top-level site's grant.
    const requester = topOrigin(requestingOrigin || details.requestingUrl || '') ?? site;
    if (requester !== site) return false;
    const names = weftPermissions(permission, details);
    return names.length > 0 && names.every(name => this.decisionFor(tab, site, name) === 'allow');
  }

  /** Why a request cannot show a prompt now, or null. Background, suspended, headless and agent-only input never prompt. */
  ineligible(tab) {
    if (!tab) return 'unknown_tab';
    if (this.browser?.hidden || tab.renderMode === 'offscreen') return 'headless';
    if (tab.suspended) return 'suspended';
    const human = Boolean(tab.lastHumanInput && this.now() - tab.lastHumanInput < PROMPT_GESTURE_MS);
    const foreground = tab.id === this.browser?.activeId && tab.workspaceId === this.browser?.workspaceId
      || tab.id === this.browser?.viewport?.splitTabId;
    if (!foreground && !human) return 'background';
    const agent = (tab.controller && !['human', 'available'].includes(tab.controller)) || tab.inFlight;
    if (agent && !human) return 'agent_input';
    if (this.neverAsk) return 'never_ask';
    const rateKey = `${tab.id}|${tab.documentSerial ?? 0}`;
    const recent = (this.rates.get(rateKey) ?? []).filter(at => this.now() - at < RATE_WINDOW_MS);
    this.rates.set(rateKey, recent);
    if (recent.length >= PROMPTS_PER_DOCUMENT) return 'rate_limited';
    return null;
  }

  denied(tab, permissions, kind) {
    if (!tab) return;
    const field = kind === 'user' ? 'permissionUserDenials' : 'permissionDenials';
    tab[field] ??= {};
    for (const name of permissions) tab[field][name] = (tab[field][name] ?? 0) + 1;
  }

  used(tab, permissions) {
    if (!tab) return;
    tab.permissionUses ??= { document: tab.documentSerial ?? 0, permissions: [] };
    if (tab.permissionUses.document !== (tab.documentSerial ?? 0)) tab.permissionUses = { document: tab.documentSerial ?? 0, permissions: [] };
    tab.permissionUses.permissions = [...new Set([...tab.permissionUses.permissions, ...permissions])];
  }

  /**
   * Permission request handler. Answers immediately from a decision when one applies; otherwise queues one
   * browser-owned prompt that only a person can answer, or denies when no prompt may be shown.
   */
  request(tab, permission, details, callback, { sources = null, display = false } = {}) {
    const names = display ? ['display-capture'] : weftPermissions(permission, details);
    const answer = allowed => { try { callback(allowed); } catch { /* the page went away */ } };
    if (!display && isDisplayPreflight(permission, details)) return answer(true);
    if (!names.length) { this.denied(tab, [permission], 'auto'); return answer(false); }
    const site = topOrigin(tab?.view?.webContents?.getURL?.() || tab?.url);
    const requester = topOrigin(details?.requestingUrl || details?.securityOrigin || '') ?? site;
    if (!tab || !site || requester !== site) { this.denied(tab, names, 'auto'); return answer(false); }
    const decisions = names.map(name => this.decisionFor(tab, site, name));
    if (decisions.every(value => value === 'allow') && !display) { this.used(tab, names); return answer(true); }
    if (decisions.some(value => value === 'block')) { this.denied(tab, names, 'user'); return answer(false); }
    const existing = [...this.prompts.values()].find(item => item.tabId === tab.id);
    if (existing) {
      if (!display && !existing.display && existing.permissions.join() === names.join() && existing.document === (tab.documentSerial ?? 0)) { existing.callbacks.push(answer); return; }
      this.denied(tab, names, 'auto'); return answer(false);
    }
    const reason = this.ineligible(tab);
    if (reason) { this.denied(tab, names, 'auto'); return answer(false); }
    this.rates.get(`${tab.id}|${tab.documentSerial ?? 0}`).push(this.now());
    const prompt = { id: `perm_${randomUUID()}`, tabId: tab.id, workspaceId: tab.workspaceId, origin: site, permissions: names, display, document: tab.documentSerial ?? 0,
      createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + PROMPT_TTL_MS).toISOString(), callbacks: [answer], sources };
    prompt.timer = setTimeout(() => this.settle(prompt, false, 'dismissed'), PROMPT_TTL_MS);
    prompt.timer.unref?.();
    this.prompts.set(prompt.id, prompt);
    this.browser?.onSitePrompt?.({ kind: 'permission', tabId: tab.id });
    this.browser?.persist?.();
  }

  settle(prompt, allowed, outcome, value) {
    if (!this.prompts.has(prompt.id)) return;
    clearTimeout(prompt.timer);
    this.prompts.delete(prompt.id);
    const tab = this.browser?.tabs?.get(prompt.tabId);
    if (!allowed) this.denied(tab, prompt.permissions, outcome === 'dismissed' ? 'auto' : 'user');
    else this.used(tab, prompt.permissions);
    for (const answer of prompt.callbacks) answer(value ?? allowed);
    this.audit({ type: 'decision', reason: `site_permission_${outcome}`, outcome: 'recorded', workspaceId: prompt.workspaceId, tabId: prompt.tabId,
      summary: { origin: prompt.origin, permissions: prompt.permissions } });
    this.browser?.persist?.();
  }

  /** A navigation or close ends one-page grants and pending prompts for the old document. */
  documentChanged(tab, closed = false) {
    for (const key of this.once.keys()) if (key.startsWith(`${tab.id}|`)) this.once.delete(key);
    for (const prompt of [...this.prompts.values()]) if (prompt.tabId === tab.id) this.settle(prompt, false, 'dismissed');
    tab.permissionUses = null;
    tab.sharing = null;
    if (closed) for (const key of this.rates.keys()) if (key.startsWith(`${tab.id}|`)) this.rates.delete(key);
    this.pruneOpen();
  }

  /** "While open" decisions end once no tab in that workspace shows the site. */
  pruneOpen() {
    const open = new Set([...(this.browser?.tabs?.values() ?? [])].map(tab => `${tab.workspaceId}|${topOrigin(tab.view?.webContents?.getURL?.() || tab.url)}`));
    for (const key of this.open.keys()) { const [workspace, siteOrigin] = key.split('|'); if (!open.has(`${workspace}|${siteOrigin}`)) this.open.delete(key); }
  }

  /** Prompt state for one tab (the browser-owned prompt in the trusted interface). Sources carry names only. */
  promptFor(tabId) {
    const prompt = [...this.prompts.values()].find(item => item.tabId === tabId);
    return prompt ? { id: prompt.id, origin: prompt.origin, permissions: prompt.permissions, display: prompt.display, expiresAt: prompt.expiresAt,
      sources: prompt.sources?.map(source => ({ id: source.id, name: String(source.name ?? '').slice(0, 200), kind: String(source.id).startsWith('screen') ? 'screen' : 'window',
        thumbnail: source.thumbnail?.toDataURL?.() ?? null })) ?? null } : null;
  }

  popupsAllowed(tab) {
    const site = topOrigin(tab?.view?.webContents?.getURL?.() || tab?.url);
    return Boolean(site && this.decisionFor(tab, site, 'popups') === 'allow');
  }

  forget(workspace, siteOrigin = null) {
    const before = this.decisions.length;
    this.decisions = this.decisions.filter(item => !(item.workspaceId === workspace && (!siteOrigin || item.origin === siteOrigin)));
    for (const key of this.open.keys()) { const [w, o] = key.split('|'); if (w === workspace && (!siteOrigin || o === siteOrigin)) this.open.delete(key); }
    if (this.decisions.length !== before) this.save();
  }

  list(workspace) {
    const open = [...this.open.entries()].map(([key, value]) => { const [w, o, p] = key.split('|'); return { workspaceId: w, origin: o, permission: p, decision: value.decision, scope: value.scope }; })
      .filter(item => item.workspaceId === workspace);
    return { workspaceId: workspace, neverAsk: this.neverAsk,
      decisions: [...this.decisions.filter(item => item.workspaceId === workspace).map(item => ({ ...item, scope: 'always' })), ...open],
      pending: [...this.prompts.values()].filter(item => item.workspaceId === workspace).map(item => ({ ...this.promptFor(item.tabId), tabId: item.tabId })),
      prompted: PROMPTED_PERMISSIONS, deniedWithoutPrompt: UNPROMPTED_PERMISSIONS,
      notice: 'Only a person can answer a prompt, in Weft\'s own interface. Decisions belong to this workspace and site; exports, imports and moving a tab never copy them. Background, suspended and headless tabs, and pages only an agent is driving, are denied without a prompt.' };
  }

  execute(name, args, context) {
    const human = ['human', 'admin'].includes(context?.actor);
    const workspace = args.workspaceId ?? this.browser?.workspaceId;
    if (name === 'permissions.list') return this.list(workspace);
    if (!human) throw failure('permission_required', `${name} requires the trusted browser interface`);
    if (name === 'permissions.configure') {
      this.neverAsk = args.neverAsk;
      this.save();
      if (this.neverAsk) for (const prompt of [...this.prompts.values()]) this.settle(prompt, false, 'denied');
      this.audit({ type: 'policy', reason: 'site_permission_never_ask', outcome: 'recorded', summary: { neverAsk: this.neverAsk } });
      return { neverAsk: this.neverAsk };
    }
    if (name === 'permissions.set') {
      const before = this.stored(workspace, args.origin, args.permission);
      this.decisions = this.decisions.filter(item => item !== before);
      this.open.delete(this.key(workspace, args.origin, args.permission));
      if (args.decision !== 'ask') this.decisions.push({ workspaceId: workspace, origin: args.origin, permission: args.permission, decision: args.decision, at: new Date(this.now()).toISOString(), by: 'human' });
      this.save();
      this.audit({ type: 'policy', reason: args.decision === 'ask' ? 'site_permission_revoked' : `site_permission_${args.decision}`, outcome: 'recorded', workspaceId: workspace,
        summary: { origin: args.origin, permission: args.permission } });
      return { workspaceId: workspace, origin: args.origin, permission: args.permission, decision: args.decision,
        notice: args.decision === 'ask' ? 'Revoked. The site must ask again; a camera, microphone or screen share already running stops when the page reloads.' : 'Saved for this site in this workspace.' };
    }
    if (name === 'permissions.respond') {
      const prompt = this.prompts.get(args.promptId);
      if (!prompt) throw failure('not_found', 'Permission prompt not found or already answered');
      const tab = this.browser?.tabs?.get(prompt.tabId);
      if (!tab || (tab.documentSerial ?? 0) !== prompt.document) { this.settle(prompt, false, 'dismissed'); throw failure('stale_state', 'The page changed; the request was denied', { reason: 'navigated' }); }
      const allow = args.decision.startsWith('allow');
      if (prompt.display && allow && ['allow-while-open', 'allow-always'].includes(args.decision)) throw failure('invalid_arguments', 'Screen sharing is allowed one page at a time (allow-once)');
      for (const permission of prompt.permissions) {
        if (args.decision === 'allow-once') this.once.set(`${tab.id}|${prompt.document}|${permission}`, true);
        else if (['allow-while-open', 'block'].includes(args.decision)) this.open.set(this.key(prompt.workspaceId, prompt.origin, permission), { decision: allow ? 'allow' : 'block', scope: allow ? 'while-open' : 'until-closed' });
        else {
          this.decisions = this.decisions.filter(item => !(item.workspaceId === prompt.workspaceId && item.origin === prompt.origin && item.permission === permission));
          this.decisions.push({ workspaceId: prompt.workspaceId, origin: prompt.origin, permission, decision: allow ? 'allow' : 'block', at: new Date(this.now()).toISOString(), by: 'human' });
        }
      }
      if (['allow-always', 'block-always'].includes(args.decision)) this.save();
      if (prompt.display) {
        if (!allow) { this.settle(prompt, false, 'denied', {}); return { promptId: prompt.id, decision: args.decision }; }
        const source = prompt.sources?.find(item => item.id === args.sourceId);
        if (!source) throw failure('invalid_arguments', 'Choose the screen or window to share', { field: 'sourceId' });
        tab.sharing = { kind: String(source.id).startsWith('screen') ? 'screen' : 'window', name: String(source.name ?? '').slice(0, 200), since: new Date(this.now()).toISOString(), document: prompt.document };
        this.settle(prompt, true, 'allowed', { video: source });
      } else this.settle(prompt, allow, allow ? 'allowed' : 'denied');
      return { promptId: prompt.id, decision: args.decision, origin: prompt.origin, permissions: prompt.permissions };
    }
    if (name === 'permissions.stop') {
      const tab = this.browser.tab(args.tabId);
      for (const key of this.once.keys()) if (key.startsWith(`${tab.id}|`)) this.once.delete(key);
      for (const permission of ['camera', 'microphone', 'display-capture']) this.open.delete(this.key(tab.workspaceId, topOrigin(tab.view.webContents.getURL?.() || tab.url), permission));
      tab.sharing = null; tab.permissionUses = null;
      tab.view.webContents.reload?.();
      this.audit({ type: 'decision', reason: 'site_permission_stopped', outcome: 'recorded', workspaceId: tab.workspaceId, tabId: tab.id });
      return { tabId: tab.id, stopped: true, notice: 'The page reloaded, which ends camera, microphone and screen sharing. Remembered "always" decisions stay until you revoke them.' };
    }
    throw failure('unknown_command', `Unknown permission command ${name}`);
  }

  close() { for (const prompt of [...this.prompts.values()]) this.settle(prompt, false, 'dismissed'); }
}
