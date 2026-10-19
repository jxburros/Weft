import { join } from 'node:path';
import { readJson, writeJsonDurable } from './atomic-json.js';

/**
 * Idle auto-lock for encrypted profiles (ADR 014 amendment). Off by default; a
 * person turns it on with encryption.configure. Idle means the person has not
 * used the computer (OS idle time), not that agents are quiet: agent commands
 * never keep the profile unlocked. Locking uses the same human-only lock path.
 */
const FILE = 'auto-lock.json';
export const AUTO_LOCK_LIMITS = Object.freeze({ minMinutes: 1, maxMinutes: 1440 });
const DEFAULTS = Object.freeze({ idleMinutes: null, onScreenLock: false });

export class AutoLockSettings {
  constructor(directory) { this.path = join(directory, FILE); }
  read() {
    let saved;
    try { saved = readJson(this.path, DEFAULTS); } catch { return { ...DEFAULTS, unreadable: true }; }
    const idleMinutes = Number.isInteger(saved?.idleMinutes) && saved.idleMinutes >= AUTO_LOCK_LIMITS.minMinutes && saved.idleMinutes <= AUTO_LOCK_LIMITS.maxMinutes ? saved.idleMinutes : null;
    return { idleMinutes, onScreenLock: saved?.onScreenLock === true };
  }
  /** `undefined` keeps a value; `null` minutes turns the idle timer off. */
  write({ idleMinutes, onScreenLock } = {}) {
    const current = this.read();
    const next = { idleMinutes: idleMinutes === undefined ? current.idleMinutes : idleMinutes, onScreenLock: onScreenLock === undefined ? current.onScreenLock : onScreenLock === true };
    writeJsonDurable(this.path, next);
    return next;
  }
}

/**
 * Polls OS idle time and locks once it passes the configured limit. `idleSeconds`
 * is Electron's powerMonitor.getSystemIdleTime (injected for tests); `lock`
 * receives the reason and must be the WorkspaceService lock path.
 */
export class IdleAutoLock {
  constructor({ settings, idleSeconds, lock, isUnlocked, intervalMs = 30_000 }) {
    Object.assign(this, { settings, idleSeconds, lock, isUnlocked, intervalMs });
    this.timer = null;
    this.locking = null;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.check().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }
  close() { clearInterval(this.timer); this.timer = null; }
  /** One idle check; returns the reason it locked, or null. */
  async check() {
    const { idleMinutes } = this.settings.read();
    if (!idleMinutes || !this.isUnlocked()) return null;
    const idle = Number(this.idleSeconds());
    if (!Number.isFinite(idle) || idle < idleMinutes * 60) return null;
    return this.fire('idle');
  }
  /** OS screen lock or system suspend; locks only when the person asked for it. */
  async screenLocked() {
    if (!this.settings.read().onScreenLock || !this.isUnlocked()) return null;
    return this.fire('screen_locked');
  }
  async fire(reason) {
    if (!this.locking) this.locking = Promise.resolve(this.lock(reason)).then(() => reason).finally(() => { this.locking = null; });
    return this.locking;
  }
}
