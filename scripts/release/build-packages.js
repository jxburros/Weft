#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function packagingEnvironment(env) {
  const result = { ...env };
  // Actions supplies missing secrets as ''. electron-builder checks for null,
  // so an empty certificate link otherwise resolves to the working directory.
  // Keep passwords intact: an empty password can be valid for a certificate.
  for (const key of ['CSC_LINK', 'WIN_CSC_LINK']) {
    if (result[key] === '') delete result[key];
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [
    require.resolve('electron-builder/cli.js'),
    '--config', 'electron-builder.config.cjs', ...process.argv.slice(2), '--publish', 'never',
  ], { env: packagingEnvironment(process.env), stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
