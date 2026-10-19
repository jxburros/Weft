/**
 * Workspace encryption: enable, disable, lock, unlock and data-key rotation through the profile keys (ADR 014).
 * WorkspaceService methods moved verbatim from src/workspace.js (#119) and installed on WorkspaceService.prototype there, so
 * `this` is the service and every method keeps its name.
 */
import { createBackup } from './backups.js';
import { encryptionSchemas } from './encryption-commands.js';
import { fail } from './workspace-support.js';

export const workspaceEncryptionMethods = {
  // ---- Workspace encryption (ADR 014) ------------------------------------------------
  /** encryption.* commands. Status works while locked; everything else is human-only administration. */
  async executeEncryption(name, input = {}, context = {}) {
    const schema = encryptionSchemas[name];
    if (!schema) throw fail('unknown_command', `Unknown encryption command: ${name}`);
    const args = schema.parse(input);
    const human = context.actor === 'human';
    if (name === 'encryption.status') return { ...this.encryption.status({ locked: this.locked, inventory: human && args.inventory === true }), autoLock: this.autoLock.read() };
    if (!human) throw fail('permission_required', 'PERMISSION_REQUIRED: workspace encryption is managed by a person in the Weft window', { notStarted: true });
    if (name === 'encryption.unlock') return this.unlockProfile(args);
    if (name === 'encryption.checkRecoveryKey') {
      if (!this.encryption.enabled) throw fail('invalid_arguments', 'This profile is not encrypted');
      return { valid: this.encryption.checkRecoveryKey(args.recoveryKey) };
    }
    if (name === 'encryption.lock') return this.lockProfile();
    if (name === 'encryption.enable') return this.enableEncryption(args, context);
    this.assertUnlocked();
    if (!this.encryption.enabled) throw fail('invalid_arguments', 'This profile is not encrypted');
    if (name === 'encryption.disable') return this.disableEncryption(context);
    if (name === 'encryption.configure') return this.exclusive(() => {
      this.assertUnlocked();
      const { autoLockMinutes, lockOnScreenLock, ...unlock } = args;
      const changesUnlock = unlock.unlockMode !== undefined || unlock.passphrase !== undefined;
      if (changesUnlock) this.encryption.configure(unlock);
      const autoLock = autoLockMinutes !== undefined || lockOnScreenLock !== undefined ? this.autoLock.write({ idleMinutes: autoLockMinutes, onScreenLock: lockOnScreenLock }) : this.autoLock.read();
      this.logEncryption('encryption.configure', [changesUnlock && `Unlock: ${this.encryption.keyring.unlockMode}; passphrase ${this.encryption.keyring.wrappers.passphrase ? 'set' : 'not set'}`,
        `Auto-lock: ${autoLock.idleMinutes ? `after ${autoLock.idleMinutes} min idle` : 'off'}${autoLock.onScreenLock ? ', on screen lock' : ''}`].filter(Boolean).join('; '));
      return { ...this.encryption.status({ locked: false }), autoLock };
    });
    if (args.target === 'wrapping') {
      return this.exclusive(() => {
        this.assertUnlocked();
        const recoveryKey = this.encryption.rotateWrapping({ passphrase: args.passphrase ?? null });
        this.logEncryption('encryption.rotate', 'New profile key and recovery key; data keys re-wrapped');
        return { rotated: 'wrapping', recoveryKey, passphrase: Boolean(this.encryption.keyring.wrappers.passphrase), unlockMode: this.encryption.keyring.unlockMode,
          notice: 'Store this new recovery key now; it is shown only once. The previous recovery key and passphrase no longer unlock this profile (backups made earlier keep their own keyring and earlier keys). Make a new backup.' };
      });
    }
    await this.exclusive(() => { this.assertUnlocked(); this.encryption.beginDataKeyRotation(); this.logEncryption('encryption.rotate', `Data key rotation to version ${this.encryption.keyring.currentVersion} started`); });
    return this.resumeRotation();
  },
  logEncryption(action, detail) {
    try { this.commitChange(() => this.log(action, this.activeWorkspaceId, null, 'human', detail)); } catch { /* lifecycle outcome stands; durable activity also records the command */ }
  },
  async enableEncryption({ passphrase, unlockMode, removePlaintextCopies }, context = {}) {
    return this.exclusive(() => {
      this.assertUnlocked();
      if (this.encryption.keyring) throw fail('invalid_arguments', 'This profile is already encrypted');
      const recoveryKey = this.encryption.enable(this.storage, { passphrase: passphrase ?? null, unlockMode, onStep: context.onStep });
      this.reopenStorage();
      this.sealedStoreStep('afterEnable');
      const removed = removePlaintextCopies ? this.encryption.removePlaintextCopies() : [];
      const remaining = this.encryption.plaintextCopies();
      this.log('encryption.enable', this.activeWorkspaceId, null, 'human', `Workspace encryption on; unlock: ${unlockMode}${removed.length ? `; ${removed.length} plaintext copies overwritten and removed` : ''}`);
      this.save();
      let backup = null;
      try { backup = createBackup(this.storage, { kind: 'manual', note: 'First encrypted backup', clock: this.clock }); } catch (error) { backup = { status: 'failed', problem: error.message }; }
      return { enabled: true, recoveryKey, unlockMode, passphrase: Boolean(passphrase), removedPlaintextCopies: removed, plaintextCopies: remaining, backup: backup && { id: backup.id ?? null, status: backup.status },
        notice: 'Store the recovery key now; it is shown only once. If the recovery key, the passphrase and the OS key are all lost, the encrypted data cannot be recovered by anyone.',
        limitations: ['Earlier plaintext blocks may survive on SSDs, copy-on-write filesystems, snapshots and external backups; overwriting is best effort.', 'Chromium sessions, cookies, caches, downloads and the activity log are not covered (see coverage in encryption.status).'] };
    });
  },
  async disableEncryption(context = {}) {
    return this.exclusive(() => {
      this.assertUnlocked();
      if (this.encryption.keyring?.rotation) throw fail('invalid_arguments', 'Finish the data-key rotation before turning encryption off');
      this.sealedStoreStep('beforeDisable');
      this.encryption.disable(this.storage, { onStep: context.onStep });
      this.reopenStorage();
      this.log('encryption.disable', this.activeWorkspaceId, null, 'human', 'Workspace encryption turned off; data rewritten as plaintext');
      this.save();
      return { enabled: false, notice: 'Project data is now stored unencrypted. Backups made while encryption was on stay encrypted and need their recovery key.' };
    });
  },
  /** Close and reopen the store with the current key state (after enable/disable). */
  reopenStorage() {
    this.storage.close();
    this.storage = null;
    this.openStorage();
    this.storage.sweepOrphans();
  },
  /** Human lock, or the person's idle/screen-lock auto-lock setting (`reason` idle or screen_locked). */
  async lockProfile({ reason = 'locked' } = {}) {
    if (!this.encryption.enabled) throw fail('invalid_arguments', 'Turn on workspace encryption before locking');
    if (this.locked) return { locked: true, alreadyLocked: true };
    await this.encryptionHooks.beforeLock?.({ persist: true });
    for (const store of this.sealedStores) await store.beforeLock?.();
    return this.exclusive(() => {
      if (this.locked) return { locked: true, alreadyLocked: true };
      const detail = reason === 'idle' ? 'Workspace data locked automatically after the idle time the person set' : reason === 'screen_locked' ? 'Workspace data locked automatically when the screen locked' : 'Workspace data locked';
      try { this.log('encryption.lock', this.activeWorkspaceId, null, 'human', detail); this.save(); } catch { /* locking proceeds */ }
      this.storage.close();
      this.storage = null;
      this._data = null;
      this.encryption.forget();
      this.encryption.lockReason = reason;
      this.locked = true;
      return { locked: true };
    });
  },
  async unlockProfile({ method, secret }) {
    const result = await this.exclusive(() => {
      if (!this.encryption.enabled) throw fail('invalid_arguments', 'This profile is not encrypted');
      if (!this.locked) return { unlocked: true, alreadyUnlocked: true };
      this.encryption.unlock(method, secret);
      try { this.openStorage(); this.storage.sweepOrphans(); }
      catch (error) { this.storage?.close(); this.storage = null; this._data = null; this.encryption.forget(); throw error; }
      this.locked = false;
      // The store opened while still marked locked: start its background index rebuild now.
      this.scheduleIndexing();
      this.sealedStoreStep('afterUnlock');
      try { this.log('encryption.unlock', this.activeWorkspaceId, null, 'human', `Unlocked with ${method === 'os' ? 'the OS key' : method === 'passphrase' ? 'the passphrase' : 'the recovery key'}`); this.save(); } catch { /* unlocked regardless */ }
      return { unlocked: true, method };
    });
    if (!result.alreadyUnlocked) {
      if (this.encryption.keyring?.rotation) void this.resumeRotation().catch(() => {});
      await this.encryptionHooks.afterUnlock?.();
    }
    return { ...result, status: this.encryption.status({ locked: this.locked }) };
  },
  /**
   * Re-encrypt everything still under an older data key, one queued batch at a
   * time so commands interleave; then drop the old key. Resumes after a crash
   * or lock because each stored value names its key version.
   */
  resumeRotation({ batch = 500 } = {}) {
    if (this.rotationRun) return this.rotationRun;
    const from = this.encryption.keyring?.rotation?.from;
    this.rotationRun = (async () => {
      let reencrypted = 0;
      for (;;) {
        const step = await this.exclusive(() => { this.assertUnlocked(); return this.storage.reencryptStep({ limit: batch }); });
        reencrypted += step.reencrypted;
        this.rotationProgress = reencrypted;
        if (step.complete) break;
        await new Promise(resolve => setImmediate(resolve));
      }
      return this.exclusive(() => {
        this.assertUnlocked();
        this.sealedStoreStep('beforeFinishRotation');
        this.encryption.finishDataKeyRotation();
        this.storage.compact();
        this.log('encryption.rotate', this.activeWorkspaceId, null, 'human', `Data key rotation complete: ${reencrypted} values and components re-encrypted under version ${this.encryption.keyring.currentVersion}`);
        this.save();
        return { rotated: 'dataKey', from, keyVersion: this.encryption.keyring.currentVersion, reencrypted };
      });
    })().catch(error => {
      this.encryption.rotationError = error.message;
      if (error.code !== 'locked') this.onWarning({ code: 'ENCRYPTION_ROTATION_FAILED', message: `Data key rotation paused: ${error.message}` });
      throw error;
    }).finally(() => { this.rotationRun = null; });
    return this.rotationRun;
  },
};
