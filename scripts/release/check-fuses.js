#!/usr/bin/env node
// Reads the fuse wire of a packaged Electron binary and fails unless every fuse in
// scripts/release/fuses.cjs has the configured state (#117).
// Usage: node scripts/release/check-fuses.js <path-to-packaged-executable>
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// @electron/fuses comes with electron-builder (a locked dev dependency).
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
// Fuse wire bytes: ASCII '1' is enabled, '0' disabled (@electron/fuses FuseState).
const FuseState = { ENABLE: 49, DISABLE: 48 };
const expected = require('./fuses.cjs');
const names = {
  runAsNode: FuseV1Options.RunAsNode,
  enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
  enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
};

const [executable] = process.argv.slice(2);
if (!executable) { console.error('Usage: check-fuses.js <packaged-executable>'); process.exit(2); }
const wire = await getCurrentFuseWire(executable);
const problems = [];
for (const [key, enabled] of Object.entries(expected)) {
  const actual = wire[names[key]];
  const want = enabled ? FuseState.ENABLE : FuseState.DISABLE;
  if (actual !== want) problems.push(`${key}: expected ${enabled ? 'enabled' : 'disabled'}, found ${actual === FuseState.ENABLE ? 'enabled' : actual === FuseState.DISABLE ? 'disabled' : 'missing or unknown'}`);
}
if (problems.length) {
  console.error(`::error::Electron fuses in ${executable} differ from scripts/release/fuses.cjs:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`Electron fuses verified for ${executable}: ${Object.entries(expected).map(([key, value]) => `${key}=${value}`).join(', ')}`);
