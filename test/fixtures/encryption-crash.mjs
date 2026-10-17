// Child process for crash tests: run one encryption operation and SIGKILL this
// process at the named step, leaving the profile exactly as a power loss or
// forced quit would (stale lock file included).
import { writeSync } from 'node:fs';
import { WorkspaceService } from '../../src/workspace.js';
import { createKeyProtector } from '../../src/encryption.js';
import { fakeSafeStorage, kdfParams } from '../encryption-helpers.js';

const [directory, operation, step, unlockMode = 'os'] = process.argv.slice(2);
// node --test also loads files under test/: without arguments this module does nothing.
if (directory) await run();

async function run() {
  // The marker is written synchronously first: on Windows the kill is TerminateProcess (exit code 1, no signal),
  // so the parent needs it to tell this kill from an ordinary failure exit.
  const crash = name => { if (name === step) { writeSync(2, `WEFT_CRASH_AT ${name}\n`); process.kill(process.pid, 'SIGKILL'); } };
  const service = new WorkspaceService({ directory, onWarning() {}, keyProtector: createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' }), encryption: { kdf: kdfParams } });
  const human = { actor: 'human', source: 'gui', onStep: crash };
  if (service.locked) await service.executeEncryption('encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' }, human);
  if (operation === 'enable') await service.executeEncryption('encryption.enable', { acknowledgeKeyLoss: true, unlockMode, passphrase: 'correct horse battery staple' }, human);
  else if (operation === 'disable') await service.executeEncryption('encryption.disable', { acknowledgePlaintext: true }, human);
  else if (operation === 'rotate') {
    // The rotation job's own loop, in small batches, killed after `step` batches.
    await service.exclusive(() => service.encryption.beginDataKeyRotation());
    for (let batch = 1; ; batch++) {
      const result = await service.exclusive(() => service.storage.reencryptStep({ limit: 5 }));
      crash(`batch-${batch}`);
      if (result.complete) break;
    }
  }
  console.log('COMPLETED_WITHOUT_CRASH');
  service.close();
}
