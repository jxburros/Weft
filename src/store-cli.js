import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquireProfileLock } from './storage-safety.js';
import { listBackups, recoverInterruptedRestore, restoreBackup, verifyBackup } from './backups.js';

export const storeUsage = `Usage: weft store backups <workspace-data directory>
       weft store verify <workspace-data directory> <backup id>
       weft store restore <workspace-data directory> <backup id>

Offline maintenance with Weft closed. Works even when the database is damaged:
restore verifies the backup first and moves current data to recovery/ rather
than deleting it.`;

/** Offline backup maintenance for a closed profile; holds the profile lock throughout. */
export function runStoreCommand([action, directory, id] = []) {
  if (!['backups', 'verify', 'restore'].includes(action) || !directory || (action !== 'backups' && !id)) throw Object.assign(new Error(storeUsage), { code: 'invalid_arguments' });
  const profile = resolve(directory);
  if (!existsSync(profile)) throw Object.assign(new Error('Profile directory not found'), { code: 'not_found' });
  const lock = acquireProfileLock(profile);
  try {
    if (action === 'backups') return { backups: listBackups(profile) };
    if (action === 'verify') return verifyBackup(profile, id);
    const recovered = recoverInterruptedRestore(profile);
    return { ...restoreBackup(profile, id), ...(recovered && { recoveredInterruptedRestore: recovered }) };
  } finally { lock.release(); }
}
