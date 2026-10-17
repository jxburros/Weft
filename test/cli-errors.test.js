import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createApiServer } from '../src/server.js';

const cli = fileURLToPath(new URL('../bin/weft.js', import.meta.url));
async function run(args, env) {
  try { return await promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, ...env } }); }
  catch (error) { return error; }
}
test('CLI discovery preserves authorization error and mapped exit status', { timeout: 5000 }, async t => {
  const server = createApiServer({ token: 'expected', execute: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await run(['commands'], { WEFT_TOKEN: 'wrong', WEFT_API_URL: `http://127.0.0.1:${server.address().port}` });
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stdout).error.code, 'unauthorized');
  assert.equal(result.stderr, '');
});
test('CLI discovery classifies connection failures as transport failures', { timeout: 5000 }, async () => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const result = await run(['commands'], { WEFT_TOKEN: 'test', WEFT_API_URL: `http://127.0.0.1:${port}` });
  assert.equal(result.code, 7);
  assert.equal(JSON.parse(result.stdout).error.code, 'transport_error');
});
test('MCP startup failures keep stdout free of non-protocol JSON', { timeout: 5000 }, async () => {
  const result = await run(['mcp'], { WEFT_TOKEN: '', WEFT_API_URL: 'http://127.0.0.1:9222' });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'invalid_arguments');
});
test('malformed CLI JSON remains a private structured input error', { timeout: 5000 }, async () => {
  const result = await run(['tabs.new', '{"private-value":SECRET}'], { WEFT_TOKEN: 'test', WEFT_API_URL: 'http://127.0.0.1:9222' });
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).error.code, 'invalid_json');
  assert.doesNotMatch(result.stdout, /private-value|SECRET/);
});
