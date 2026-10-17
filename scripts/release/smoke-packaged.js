#!/usr/bin/env node
// Launches a packaged Weft with a throwaway profile and the update kill switch, checks the
// authenticated loopback API, version and update state, then closes it through the API.
// Usage: node scripts/release/smoke-packaged.js <path-to-executable> [expected-install-kind]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [executable, expectedKind] = process.argv.slice(2);
if (!executable) { console.error('Usage: smoke-packaged.js <executable> [expected-install-kind]'); process.exit(2); }
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const profile = mkdtempSync(join(tmpdir(), 'weft-smoke-'));
const port = await new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const token = randomBytes(24).toString('hex');
const args = [`--user-data-dir=${profile}`];
// CI Linux runners lack the setuid sandbox helper and FUSE; production launches never pass these flags
// (APPIMAGE_EXTRACT_AND_RUN only affects AppImages).
if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu');
const child = spawn(executable, args, { env: { ...process.env, WEFT_PORT: String(port), WEFT_TOKEN: token, WEFT_DISABLE_UPDATES: '1', ELECTRON_RUN_AS_NODE: '', APPIMAGE_EXTRACT_AND_RUN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
const fail = async message => {
  console.error(`::error::Packaged smoke test failed: ${message}\n${output.slice(-4000)}`);
  child.kill('SIGKILL');
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exit(1);
};
const call = async (command, body = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, args: body }), signal: AbortSignal.timeout(15000) });
  return response.json();
};

const deadline = Date.now() + 90000;
while (!output.includes(`Weft API: http://127.0.0.1:${port}`)) {
  if (Date.now() > deadline) await fail('API did not start within 90 seconds');
  if (child.exitCode !== null) await fail(`process exited early with ${child.exitCode}`);
  await new Promise(resolve => setTimeout(resolve, 250));
}
const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/commands`).then(response => response.status);
if (unauthorized !== 401) await fail(`unauthenticated API request returned ${unauthorized}`);
const status = await call('update.status');
if (status.error) await fail(`update.status: ${status.error.message}`);
if (status.result.currentVersion !== version) await fail(`packaged version ${status.result.currentVersion} differs from ${version}`);
if (!status.result.killSwitch.active) await fail('kill switch was not honored');
if (expectedKind && status.result.install.kind !== expectedKind) await fail(`install kind ${status.result.install.kind}, expected ${expectedKind}`);
const check = await call('update.check');
// Human-only administration is refused by the shared authority gate before anything runs (ADR-005).
const refusal = check.error?.code === 'permission_required' && check.error.details?.authority?.reason === 'human_only';
if (!refusal || check.execution !== 'not_started') await fail(`automation update.check was not refused as human-only: ${JSON.stringify(check.error ?? check.result)}`);
const info = await call('browser.info');
if (info.error) await fail(`browser.info: ${info.error.message}`);
await call('browser.close');
const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 20000))]);
if (code === 'timeout') await fail('app did not exit after browser.close');
rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`Packaged smoke test passed: Weft ${version} (${status.result.install.kind}, Electron ${info.result?.electron ?? info.result?.versions?.electron ?? 'unknown'})`);
