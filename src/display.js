import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { z } from 'zod';

/**
 * Headless sessions and display handoff (#11, ADR 015). Weft always runs the same profile, GUI
 * renderer, policies and command catalog; "headless" only means the window is hidden and pages
 * render offscreen. A person attaches by launching Weft again, running `weft attach`
 * (display.show) or pressing nothing at all on a headed session. Detaching is human-only.
 */
export const displayCommandDefinitions = {
  'display.status': ['Read whether the Weft window is visible, how pages render, pending human decisions and how a person can attach', {}],
  'display.show': ['Show the Weft window so a person can inspect and take over the running session (attach); offscreen pages reload when shown', {}],
  'display.hide': ['Human hides the window and keeps this session running headless; open pages reload to render offscreen', {
    confirmReload: z.literal(true).describe('Confirms that open pages reload offscreen and lose unsent form input and in-page state.') }],
};
const schemas = Object.fromEntries(Object.entries(displayCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const human = context => ['human', 'admin'].includes(context.actor);

/** Display environment as Chromium sees it. `--ozone-platform=headless` is evaluated and unsupported (ADR 015). */
export function displayEnvironment({ platform = process.platform, env = process.env, ozone = '' } = {}) {
  if (ozone === 'headless') return { platform, displayServer: 'ozone-headless', supported: false,
    reason: 'Chromium’s headless Ozone platform gives windows and page views a 1×1 size in Electron 44, so pages cannot render or be captured at a usable size and no person can attach. Run headless Weft on a display server (a desktop session or Xvfb).' };
  if (platform === 'linux') {
    const server = env.WAYLAND_DISPLAY ? 'wayland' : env.DISPLAY ? 'x11' : null;
    return server ? { platform, displayServer: server, supported: true } : { platform, displayServer: null, supported: false, reason: 'No display server: start Weft under a desktop session or Xvfb (xvfb-run).' };
  }
  return { platform, displayServer: platform === 'darwin' ? 'quartz' : platform === 'win32' ? 'windows' : platform, supported: true };
}

export function profileFingerprint(userData) {
  let path = userData;
  try { path = realpathSync(userData); } catch { /* fingerprint the configured path */ }
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

export class DisplayController {
  constructor({ window, browser, launchedHeadless = false, userData, environment, pendingApprovals = () => 0, audit = () => {}, onEvent = () => {}, clock = Date.now }) {
    Object.assign(this, { window, browser, launchedHeadless, userData, environment, pendingApprovals, audit, onEvent, clock });
    this.transitions = [];
    this.attachedAt = launchedHeadless ? null : new Date(clock()).toISOString();
  }
  get visible() { return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible()); }

  status(context = {}) {
    const tabs = [...this.browser.tabs.values()];
    const pending = Number(this.pendingApprovals()) || 0;
    return {
      mode: this.visible ? 'headed' : 'headless', windowVisible: this.visible, launchedHeadless: this.launchedHeadless, attachedAt: this.visible ? this.attachedAt : null,
      renderMode: this.browser.offscreen ? 'offscreen' : 'onscreen',
      tabs: { total: tabs.length, offscreen: tabs.filter(tab => !tab.suspended && tab.renderMode === 'offscreen').length, onscreen: tabs.filter(tab => !tab.suspended && tab.renderMode !== 'offscreen').length, suspended: tabs.filter(tab => tab.suspended).length },
      pendingApprovals: pending,
      humanAttention: !this.visible && pending ? `${pending} agent request${pending === 1 ? '' : 's'} need${pending === 1 ? 's' : ''} a human decision. Run "weft attach" or launch Weft again to show the window.` : null,
      attach: { cli: 'weft attach', relaunch: 'Launching Weft again with this profile shows this window instead of starting a second browser.', command: 'display.show' },
      profile: { fingerprint: profileFingerprint(this.userData), ...(human(context) ? { userData: this.userData } : {}), partitions: 'persist:weft-<workspace id>' },
      environment: this.environment,
      transitions: this.transitions.slice(-10),
      limitations: ['Chromium cannot move a live offscreen page into a window: pages rendered while headless reload when a person opens them, and pages reload offscreen when the window is hidden. Unsent form input and in-page state do not survive that reload.',
        'Policies, approvals, leases and command contracts are the same with or without a window; approvals still need a person in the Weft window.'],
    };
  }

  async show({ source = 'command' } = {}) {
    if (!this.window || this.window.isDestroyed()) throw Object.assign(new Error('The Weft window is not available'), { code: 'unavailable' });
    if (this.visible) { this.window.focus(); return { ...this.status(), changed: false, notice: 'The window was already visible.' }; }
    this.window.show();
    this.window.focus();
    this.attachedAt = new Date(this.clock()).toISOString();
    const result = await this.browser.setDisplayHidden(false, 'display attached');
    return this.record('headless', 'headed', source, result);
  }

  async hide({ source = 'command' } = {}) {
    if (!this.window || this.window.isDestroyed()) throw Object.assign(new Error('The Weft window is not available'), { code: 'unavailable' });
    if (!this.visible) return { ...this.status(), changed: false, notice: 'The window was already hidden.' };
    this.window.hide();
    const result = await this.browser.setDisplayHidden(true, 'display detached');
    return this.record('headed', 'headless', source, result);
  }

  record(from, to, source, result) {
    const transition = { at: new Date(this.clock()).toISOString(), from, to, source, reloadedTabs: result.converted.map(item => item.tabId),
      unsavedInputLost: result.converted.filter(item => item.unsavedInputLost).map(item => item.tabId), reloadOnOpen: result.pendingOnOpen };
    this.transitions.push(transition);
    if (this.transitions.length > 50) this.transitions.shift();
    this.audit({ type: 'display', reason: to === 'headed' ? 'display_attached' : 'display_detached', outcome: 'recorded', summary: { source, reloaded: transition.reloadedTabs.length, reloadOnOpen: transition.reloadOnOpen.length } });
    this.onEvent({ type: 'display', status: to === 'headed' ? 'attached' : 'detached', createdAt: transition.at });
    return { ...this.status(), changed: true, transition,
      notice: to === 'headed' ? 'Window shown. Pages that rendered offscreen reload when you open them; their unsent form input and in-page state are not kept.'
        : 'Window hidden; Weft keeps running headless with the same profile. Open pages reloaded to render offscreen.' };
  }

  execute(name, input, context = {}) {
    const args = schemas[name].parse(input);
    if (name === 'display.status') return this.status(context);
    if (name === 'display.show') return this.show({ source: human(context) ? 'person' : 'command' });
    if (!human(context)) throw Object.assign(new Error('Only a person in the Weft window can hide it'), { code: 'human_required' });
    void args;
    return this.hide({ source: 'person' });
  }
}
