import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { createKeyProtector } from '../src/encryption.js';
import { AutoLockSettings, IdleAutoLock } from '../src/auto-lock.js';
import { fakeSafeStorage, kdfParams } from './encryption-helpers.js';
import { closeAfter, closeQuietly, removeAfter } from './temp-profile.js';

const human = { actor: 'human', source: 'gui' };
function open(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-auto-lock-'));
  removeAfter(t, directory);
  const service = new WorkspaceService({ directory, onWarning() {}, keyProtector: createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' }), encryption: { kdf: kdfParams } });
  closeAfter(t, service, closeQuietly);
  return { service, directory };
}
const enc = (service, name, args = {}, context = human) => service.executeEncryption(name, args, context);
const monitor = (service, idle) => new IdleAutoLock({ settings: service.autoLock, idleSeconds: () => idle.seconds, isUnlocked: () => service.encryption.enabled && !service.locked, lock: reason => service.lockProfile({ reason }) });

test('auto-lock is off by default and settings survive bad files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-auto-lock-settings-'));
  removeAfter(t, directory);
  const settings = new AutoLockSettings(directory);
  assert.deepEqual(settings.read(), { idleMinutes: null, onScreenLock: false });
  assert.deepEqual(settings.write({ idleMinutes: 15 }), { idleMinutes: 15, onScreenLock: false });
  assert.deepEqual(settings.write({ onScreenLock: true }), { idleMinutes: 15, onScreenLock: true }, 'undefined keeps the other value');
  writeFileSync(join(directory, 'auto-lock.json'), JSON.stringify({ idleMinutes: 0.5, onScreenLock: 'yes' }));
  assert.deepEqual(settings.read(), { idleMinutes: null, onScreenLock: false }, 'out-of-range values never shorten or enable the timer');
  writeFileSync(join(directory, 'auto-lock.json'), '{');
  assert.equal(settings.read().idleMinutes, null);
});

test('a person sets idle auto-lock; OS idle time locks with the human lock path', async t => {
  const { service } = open(t);
  await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'manual', passphrase: 'correct horse battery staple' });
  const idle = { seconds: 10_000 };
  const lock = monitor(service, idle);
  assert.equal(await lock.check(), null, 'off by default even after hours idle');
  assert.equal(service.locked, false);

  await assert.rejects(enc(service, 'encryption.configure', { autoLockMinutes: 5 }, { actor: 'automation', source: 'api' }), error => error.code === 'permission_required', 'agents cannot change auto-lock');
  await assert.rejects(enc(service, 'encryption.configure', { autoLockMinutes: 0 }), error => error.name === 'ZodError' || error.code === 'invalid_arguments');
  const configured = await enc(service, 'encryption.configure', { autoLockMinutes: 5 });
  assert.deepEqual(configured.autoLock, { idleMinutes: 5, onScreenLock: false });
  assert.equal(configured.unlockMode, 'manual', 'changing only auto-lock leaves unlock options alone');
  assert.equal(configured.methods.passphrase.configured, true);
  assert.deepEqual((await enc(service, 'encryption.status', {}, { actor: 'automation', source: 'api' })).autoLock, { idleMinutes: 5, onScreenLock: false });

  idle.seconds = 4 * 60;
  assert.equal(await lock.check(), null, 'not idle long enough');
  assert.equal(await lock.screenLocked(), null, 'screen lock does not lock unless the person chose it');
  idle.seconds = 5 * 60;
  assert.equal(await lock.check(), 'idle');
  assert.equal(service.locked, true);
  const status = await enc(service, 'encryption.status');
  assert.equal(status.lockReason, 'idle');
  await assert.rejects(service.execute('materials.list', {}, human), error => error.code === 'locked');
  assert.equal(await lock.check(), null, 'already locked');

  await enc(service, 'encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' });
  const activity = service.data.activity.filter(item => item.action === 'encryption.lock');
  assert.match(activity.at(-1).detail, /automatically after the idle time/);
  await enc(service, 'encryption.configure', { lockOnScreenLock: true });
  idle.seconds = 0;
  assert.equal(await lock.screenLocked(), 'screen_locked');
  assert.equal((await enc(service, 'encryption.status')).lockReason, 'screen_locked');
  await enc(service, 'encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' });
  assert.deepEqual((await enc(service, 'encryption.configure', { autoLockMinutes: null, lockOnScreenLock: false })).autoLock, { idleMinutes: null, onScreenLock: false });
  idle.seconds = 10_000;
  assert.equal(await lock.check(), null, 'turned off again');
});

test('auto-lock never fires on an unencrypted profile and concurrent triggers lock once', async t => {
  const { service } = open(t);
  service.autoLock.write({ idleMinutes: 1, onScreenLock: true });
  const lock = monitor(service, { seconds: 10_000 });
  assert.equal(await lock.check(), null);
  assert.equal(await lock.screenLocked(), null);
  await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'manual', passphrase: 'correct horse battery staple' });
  let calls = 0;
  const counting = new IdleAutoLock({ settings: service.autoLock, idleSeconds: () => 10_000, isUnlocked: () => !service.locked, lock: async reason => { calls += 1; await service.lockProfile({ reason }); } });
  const results = await Promise.all([counting.check(), counting.screenLocked()]);
  assert.equal(calls, 1);
  assert.ok(results.every(Boolean));
  assert.equal(service.locked, true);
});
