import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientGrants, SIGNING_KEY_FILE, bootstrapToken, MIN_BOOTSTRAP_TOKEN_LENGTH } from '../src/clients.js';
import { createHmac } from 'node:crypto';

const human = { actor: 'human', source: 'gui' };
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-grants-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1000000;
  const options = { directory, masterToken: 'fixture-master', clock: () => time, workspace: { workspace: id => { if (!['ws-a', 'ws-b'].includes(id)) throw new Error('Workspace not found'); } } };
  const grants = new ClientGrants(options);
  return { grants, options, advance: () => { time += 60001; } };
}
test('client credentials bind a live grant and never persist their bearer token', t => {
  const { grants, options, advance } = setup(t);
  const issued = grants.execute('clients.create', { name: 'Reader', scopes: ['read'], workspaceIds: ['ws-a'], ttlSeconds: 60 }, human);
  const context = grants.authenticate(issued.token);
  assert.equal(context.actor, `client:${issued.clientId}`);
  assert.deepEqual(context.workspaceIds, ['ws-a']);
  assert.equal(readFileSync(grants.path, 'utf8').includes(issued.token), false);
  assert.equal(JSON.stringify(grants.execute('clients.list', {}, human)).includes('weft1.'), false);
  const restored = new ClientGrants(options);
  assert.equal(restored.authenticate(issued.token).clientId, issued.clientId);
  // Client tokens are signed with a persisted per-profile key, so a new bootstrap token (restart) keeps them working.
  assert.equal(new ClientGrants({ ...options, masterToken: 'rotated' }).authenticate(issued.token).clientId, issued.clientId);
  if (process.platform !== 'win32') assert.equal(statSync(join(options.directory, SIGNING_KEY_FILE)).mode & 0o077, 0, 'the signing key is private to the user');
  assert.equal(readFileSync(join(options.directory, SIGNING_KEY_FILE), 'utf8').includes('fixture-master'), false);
  const rotated = new ClientGrants({ ...options, masterToken: 'rotated' });
  rotated.rotateSigningKey();
  assert.equal(rotated.authenticate(issued.token), null, 'rotating the signing key invalidates every issued token');
  assert.equal(new ClientGrants(options).authenticate(issued.token), null, 'the rotation is persisted');
  assert.equal(grants.authenticate(issued.token + 'x'), null);
  assert.equal(grants.authenticate('weft1.invalid.fake'), null);
  advance();
  assert.equal(grants.authenticate(issued.token), null);
  assert.throws(() => grants.assertAllowed('materials.get', context, { workspaceId: 'ws-a' }), /expired/);
});
test('tokens signed with the bootstrap token before 1.4 keep working only while that token is unchanged', t => {
  const { grants, options } = setup(t);
  const issued = grants.execute('clients.create', { name: 'Legacy', scopes: ['read'], workspaceIds: ['ws-a'], ttlSeconds: 600 }, human);
  const payload = issued.token.split('.')[1];
  const legacy = `weft1.${payload}.${createHmac('sha256', 'fixture-master').update(payload).digest('base64url')}`;
  assert.equal(grants.authenticate(legacy).clientId, issued.clientId);
  assert.equal(new ClientGrants({ ...options, masterToken: 'changed' }).authenticate(legacy), null);
});
test('client scope admission refuses writes, cross-workspace reads, unclassified commands and revocation', t => {
  const { grants } = setup(t);
  const issued = grants.execute('clients.create', { name: 'Reader', scopes: ['read'], workspaceIds: ['ws-a'] }, human);
  const context = grants.authenticate(issued.token);
  grants.assertAllowed('materials.get', context, { workspaceId: 'ws-a' });
  assert.throws(() => grants.assertAllowed('materials.get', context, { workspaceId: 'ws-b' }), /Workspace/);
  for (const name of ['materials.create', 'tabs.new', 'page.evaluate', 'clients.create', 'browser.close', 'future.write']) assert.throws(() => grants.assertAllowed(name, context, { workspaceId: 'ws-a' }), /scope/);
  grants.execute('clients.revoke', { clientId: issued.clientId }, human);
  assert.equal(grants.authenticate(issued.token), null);
  assert.throws(() => grants.assertAllowed('materials.get', context, { workspaceId: 'ws-a' }), /revoked/);
});
test('only trusted GUI humans mint/revoke grants and requested workspace IDs must exist', t => {
  const { grants } = setup(t);
  for (const context of [{ actor: 'automation' }, { actor: 'human', source: 'api' }, { actor: 'client:x', source: 'gui' }]) assert.throws(() => grants.execute('clients.list', {}, context), /trusted/);
  assert.throws(() => grants.execute('clients.create', { name: 'Invalid', scopes: ['read'], workspaceIds: ['missing'] }, human), /Workspace/);
  assert.equal(grants.grants.length, 0);
});

test('weak WEFT_TOKEN values are refused; a generated token can go to an owner-only file instead of stdout', t => {
  for (const weak of ['short', 'x'.repeat(MIN_BOOTSTRAP_TOKEN_LENGTH - 1), ` ${'y'.repeat(40)}`]) assert.throws(() => bootstrapToken({ WEFT_TOKEN: weak }), /at least 32 characters/);
  const strong = 'z'.repeat(MIN_BOOTSTRAP_TOKEN_LENGTH);
  assert.deepEqual(bootstrapToken({ WEFT_TOKEN: strong }), { token: strong, generated: false, file: null });
  const printed = bootstrapToken({});
  assert.equal(printed.generated, true);
  assert.match(printed.token, /^[0-9a-f]{64}$/);
  assert.equal(printed.file, null);
  const directory = mkdtempSync(join(tmpdir(), 'weft-token-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'nested', 'api-token');
  const written = bootstrapToken({ WEFT_TOKEN_FILE: file });
  assert.equal(written.file, file);
  assert.equal(readFileSync(file, 'utf8').trim(), written.token);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0);
});
