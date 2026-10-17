import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DisplayController, displayEnvironment, profileFingerprint } from '../src/display.js';

test('display environment: Ozone headless and a missing Linux display server are reported as unsupported', () => {
  const ozone = displayEnvironment({ platform: 'linux', env: {}, ozone: 'headless' });
  assert.equal(ozone.supported, false);
  assert.match(ozone.reason, /1×1/);
  assert.equal(displayEnvironment({ platform: 'linux', env: {} }).supported, false);
  assert.equal(displayEnvironment({ platform: 'linux', env: { DISPLAY: ':99' } }).displayServer, 'x11');
  assert.equal(displayEnvironment({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } }).displayServer, 'wayland');
  assert.equal(displayEnvironment({ platform: 'win32', env: {} }).supported, true);
});

test('display controller: attach and detach transitions, human-only hiding, profile identity without paths for agents', async t => {
  const profile = mkdtempSync(join(tmpdir(), 'weft-display-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  let visible = false;
  const window = { isDestroyed: () => false, isVisible: () => visible, show() { visible = true; }, hide() { visible = false; }, focus() {} };
  const calls = [];
  const browser = { tabs: new Map([[1, { id: 1, renderMode: 'offscreen' }], [2, { id: 2, suspended: { at: 'x' } }]]), offscreen: true,
    async setDisplayHidden(hidden, reason) { calls.push([hidden, reason]); this.offscreen = hidden; return { converted: hidden ? [] : [{ tabId: 1, renderMode: 'onscreen', unsavedInputLost: false }], pendingOnOpen: [] }; } };
  const audits = [], events = [];
  let pending = 2;
  const display = new DisplayController({ window, browser, launchedHeadless: true, userData: profile, environment: displayEnvironment({ platform: 'linux', env: { DISPLAY: ':1' } }),
    pendingApprovals: () => pending, audit: entry => audits.push(entry), onEvent: event => events.push(event) });
  const agent = { actor: 'client:00000000-0000-4000-8000-000000000000' };
  const status = display.execute('display.status', {}, agent);
  assert.equal(status.mode, 'headless');
  assert.match(status.humanAttention, /2 agent requests need a human decision/);
  assert.equal(status.profile.fingerprint, createHash('sha256').update(realpathSync(profile)).digest('hex').slice(0, 16));
  assert.equal(status.profile.fingerprint, profileFingerprint(profile));
  assert.equal(status.profile.userData, undefined);
  assert.equal(display.execute('display.status', {}, { actor: 'human' }).profile.userData, profile);
  assert.deepEqual(status.tabs, { total: 2, offscreen: 1, onscreen: 0, suspended: 1 });
  const shown = await display.execute('display.show', {}, agent);
  assert.equal(shown.mode, 'headed');
  assert.deepEqual(shown.transition.reloadedTabs, [1]);
  assert.equal(shown.transition.source, 'command');
  assert.equal((await display.execute('display.show', {}, agent)).changed, false, 'showing twice is a no-op');
  assert.throws(() => display.execute('display.hide', { confirmReload: true }, agent), error => error.code === 'human_required');
  assert.throws(() => display.execute('display.hide', {}, { actor: 'human' }), /confirmReload/, 'hiding needs the explicit reload acknowledgement');
  pending = 0;
  const hidden = await display.execute('display.hide', { confirmReload: true }, { actor: 'human' });
  assert.equal(hidden.mode, 'headless');
  assert.equal(hidden.humanAttention, null);
  assert.deepEqual(calls, [[false, 'display attached'], [true, 'display detached']]);
  assert.deepEqual(audits.map(entry => entry.reason), ['display_attached', 'display_detached']);
  assert.deepEqual(events.map(event => [event.type, event.status]), [['display', 'attached'], ['display', 'detached']]);
});
