import { z } from 'zod';

const secret = z.string().min(1).max(1024);
const unlockMode = z.enum(['os', 'manual']).describe('os: the OS key store (Keychain, DPAPI, libsecret/KWallet) unlocks at startup; manual: a person enters the passphrase or recovery key at every start.');
/** Workspace encryption (ADR 014). Everything except status is human-only administration from the Weft window. */
export const encryptionCommandDefinitions = {
  'encryption.status': ['Report whether workspace encryption is on or locked, how it unlocks, OS key-store backend and what it covers', {
    inventory: z.boolean().optional().describe('Human only: also list plaintext copies (older backups, recovery copies, export packages) left in the profile.') }],
  'encryption.enable': ['Human turns on workspace encryption in place; returns the recovery key once', {
    acknowledgeKeyLoss: z.literal(true).describe('The person confirmed that data is unrecoverable if the recovery key, passphrase and OS key are all lost.'),
    unlockMode: unlockMode.default('os'), passphrase: secret.optional().describe('Optional passphrase (at least 12 characters) as a second way to unlock.'),
    removePlaintextCopies: z.boolean().default(false).describe('Overwrite and remove plaintext backups and recovery copies after encrypting (export packages are kept).') }],
  'encryption.lock': ['Human locks encrypted workspace data: keys leave memory and every surface returns locked until a person unlocks', {}],
  'encryption.unlock': ['Human unlocks encrypted workspace data with the OS key, passphrase or recovery key (Weft window only)', {
    method: z.enum(['os', 'passphrase', 'recovery']), secret: secret.optional().describe('Passphrase or recovery key; omit for the OS key.') }],
  'encryption.configure': ['Human changes how encrypted data unlocks (OS key at startup or manual) and sets, changes or removes the passphrase', {
    unlockMode: unlockMode.optional(), passphrase: secret.nullable().optional().describe('New passphrase, or null to remove it.') }],
  'encryption.rotate': ['Human rotates keys: wrapping (new profile and recovery key) or dataKey (new data key with resumable re-encryption)', {
    target: z.enum(['wrapping', 'dataKey']), passphrase: secret.optional().describe('wrapping only: passphrase to keep under the new profile key; omitted removes the passphrase.') }],
  'encryption.checkRecoveryKey': ['Human checks that a recovery key opens this profile, without unlocking or changing anything', { recoveryKey: secret }],
  'encryption.disable': ['Human turns off encryption and rewrites workspace data as plaintext on this disk', {
    acknowledgePlaintext: z.literal(true).describe('The person confirmed that project data will be stored unencrypted.') }],
};
export const encryptionSchemas = Object.fromEntries(Object.entries(encryptionCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
/** Commands that run while the profile is locked; every other command returns `locked`. */
// Display status and attach (ADR 015) also work while locked, so a person can attach to a headless session and unlock it.
export const LOCK_EXEMPT = Object.freeze(new Set(['encryption.status', 'encryption.unlock', 'encryption.checkRecoveryKey', 'guide.get', 'display.status', 'display.show']));
