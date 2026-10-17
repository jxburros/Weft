import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientGrants } from '../src/clients.js';

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
  assert.equal(new ClientGrants({ ...options, masterToken: 'rotated' }).authenticate(issued.token), null);
  assert.equal(grants.authenticate(issued.token + 'x'), null);
  assert.equal(grants.authenticate('weft1.invalid.fake'), null);
  advance();
  assert.equal(grants.authenticate(issued.token), null);
  assert.throws(() => grants.assertAllowed('materials.get', context, { workspaceId: 'ws-a' }), /expired/);
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
