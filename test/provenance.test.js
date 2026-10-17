import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorQuote, buildCitation, normalizeText, originFor, reanchorCitation } from '../src/provenance.js';
import { WorkspaceService } from '../src/workspace.js';
import { ClientGrants } from '../src/clients.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { createApiServer } from '../src/server.js';
import { budget } from './time-budget.js';

const human = { actor: 'human', source: 'gui' };

test('quote selectors re-anchor across ligatures, typography, whitespace and moved text', () => {
  const original = 'Results. The effect of heavy rain was severe. Later the river rose.';
  const moved = 'Later the river rose.\n\nIn the field notes:   the eﬀect of heavy\nrain was “severe”. Results.';
  const anchor = anchorQuote(moved, { exact: 'The effect of heavy rain was "severe"', prefix: 'Results. ', suffix: '. Later' });
  assert.ok(anchor, 'ligature ﬀ, curly quotes, line breaks and case are normalized before matching');
  assert.equal(anchor.method, 'case-insensitive');
  assert.equal(moved.slice(anchor.start, anchor.end), 'the eﬀect of heavy\nrain was “severe”', 'offsets point at the original text, not the normalized copy');
  assert.equal(normalizeText('Ｆｕｌｌ width​ text­'), 'Full width text', 'NFKC folds full-width forms; invisible characters are dropped');
  assert.equal(anchorQuote(original, { exact: 'effect of heavy snow' }), null, 'a changed quote does not match');
  const twice = 'alpha beta gamma. alpha beta delta.';
  const second = anchorQuote(twice, { exact: 'alpha beta', prefix: 'gamma. ', suffix: ' delta' });
  assert.equal(second.start, 18, 'prefix/suffix choose among repeated occurrences');
  assert.equal(second.occurrences, 2);
  assert.equal(anchorQuote(twice, { exact: 'alpha beta' }).ambiguous, true, 'an unqualified repeated quote is flagged ambiguous');
  assert.equal(anchorQuote('Encyclopædia', { exact: 'Encyclopaedia' }).method, 'normalized', 'æ folds to ae');
});

test('citations become verified, reanchored, stale or unverified without rejecting the record', () => {
  const v1 = 'Intro. Rainfall rose 12% in 2024. Outro.';
  const versions = { v1, v2: 'Changed intro.\nRainfall  rose 12% in 2024.', v3: 'Rainfall data was withdrawn.' };
  const resolve = input => input.versionId in versions ? { pin: { captureId: 'a', versionId: input.versionId }, text: versions[input.versionId], anchorKey: { versionId: input.versionId } } : null;
  const citation = buildCitation({ type: 'capture', captureId: 'a', versionId: 'v1', exact: 'Rainfall rose 12% in 2024' }, resolve);
  assert.equal(citation.status, 'verified');
  assert.equal(citation.prefix, 'Intro. ', 'missing prefix/suffix context is captured for later re-anchoring');
  assert.deepEqual([citation.anchor.start, citation.anchor.end], [7, 32]);
  const unknown = buildCitation({ type: 'capture', captureId: 'missing', exact: 'x' }, () => null);
  assert.deepEqual([unknown.status, unknown.reason], ['unverified', 'unknown_target']);
  assert.equal(buildCitation({ type: 'capture', captureId: 'a', versionId: 'v1', exact: 'not present' }, resolve).reason, 'quote_not_found');
  const latest = id => () => ({ key: { versionId: id }, changed: id !== 'v1', text: versions[id] });
  const reanchored = reanchorCitation(citation, latest('v2'));
  assert.equal(reanchored.status, 'reanchored');
  assert.equal(reanchored.versionId, 'v1', 'the original pinned version is never rewritten');
  assert.equal(versions.v2.slice(reanchored.current.start, reanchored.current.end), 'Rainfall  rose 12% in 2024');
  const stale = reanchorCitation(citation, latest('v3'));
  assert.deepEqual([stale.status, stale.reason], ['stale', 'quote_removed']);
  assert.equal(reanchorCitation(citation, () => null).status, 'unverified');
  assert.equal(reanchorCitation(citation, latest('v1')).status, 'verified');
});

test('origin is derived from the authenticated caller; automation cannot claim human or pasted authorship', () => {
  assert.deepEqual([originFor({ actor: 'human' }).kind, originFor({ actor: 'human' }).authoring], ['human', 'human_written']);
  const agent = originFor({ actor: 'client:abc', clientId: 'abc' }, { model: 'm1', provider: 'local', toolCall: 'call_7' });
  assert.deepEqual([agent.kind, agent.actor, agent.model, agent.toolCall, agent.authoring], ['agent', 'client:abc', 'm1', 'call_7', 'ai_generated']);
  assert.equal(originFor({ actor: 'model-reader', source: 'model' }).kind, 'model');
  for (const authoring of ['human_written', 'pasted']) {
    assert.throws(() => originFor({ actor: 'automation' }, { authoring }), { code: 'permission_required' });
    assert.throws(() => originFor({ actor: 'model-reader' }, { authoring }), { code: 'permission_required' });
  }
  assert.equal(originFor({ actor: 'human' }, { authoring: 'pasted' }).authoring, 'pasted', 'a person may record pasted content');
});

test('every transport stores the authenticated origin and refuses spoofed human provenance', { timeout: budget(20000) }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-provenance-'));
  const workspace = new WorkspaceService({ directory });
  const browser = { tabs: new Map(), activeId: null, tab: () => null, downloads: new Map() };
  const clients = new ClientGrants({ directory, masterToken: 'provenance-master-token', workspace });
  const dispatch = createDispatcher({ workspace, browser, clients, providers: { close() {} }, admission: new AutomationAdmission() });
  const server = createApiServer({ execute: dispatch, token: 'provenance-master-token', authenticate: value => clients.authenticate(value), executeReturnsOutcome: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  const rest = async (command, args, bearer) => (await fetch(`http://127.0.0.1:${server.address().port}/v1/execute`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) })).json();
  const grant = (await dispatch('clients.create', { name: 'Writer', scopes: ['read', 'records.write'], workspaceIds: [workspace.activeWorkspaceId] }, human)).result;
  const workspaceId = workspace.activeWorkspaceId;

  const spoofActor = await rest('context.create', { workspaceId, title: 'Claim', content: 'Written by a person', origin: { actor: 'human' } }, grant.token);
  assert.equal(spoofActor.error.code, 'invalid_arguments', 'actor is never an accepted origin field');
  const spoofKind = await rest('materials.create', { workspaceId, title: 'Note', origin: { kind: 'human' } }, grant.token);
  assert.equal(spoofKind.error.code, 'invalid_arguments');
  const spoofAuthoring = await rest('context.create', { workspaceId, title: 'Claim', origin: { authoring: 'human_written' } }, grant.token);
  assert.equal(spoofAuthoring.error.code, 'permission_required');
  const bootstrap = await rest('materials.create', { workspaceId, title: 'Paste', origin: { authoring: 'pasted' } }, 'provenance-master-token');
  assert.equal(bootstrap.error.code, 'permission_required', 'the bootstrap token is automation too');

  const created = await rest('context.create', { workspaceId, title: 'Finding', content: 'Observed text', origin: { model: 'local-llm', provider: 'ollama', toolCall: 'call_1', conversationId: 'conv_x' } }, grant.token);
  assert.equal(created.error, null, JSON.stringify(created.error));
  assert.deepEqual([created.result.origin.kind, created.result.origin.actor, created.result.origin.model, created.result.origin.authoring], ['agent', `client:${grant.clientId}`, 'local-llm', 'ai_generated']);
  assert.equal(created.result.history[0].origin.actor, `client:${grant.clientId}`, 'each revision records who produced it');
  const edited = await dispatch('context.update', { id: created.result.id, changes: { content: 'Edited by a person' }, expectedRevision: 1 }, human);
  assert.equal(edited.result.history.at(-1).origin.kind, 'human');
  assert.equal(edited.result.origin.kind, 'agent', 'the original origin is kept; edits are attributed per revision');
  const model = await workspace.execute('materials.create', { workspaceId, title: 'Model note' }, { actor: 'model-reader', source: 'model', workspaceId });
  assert.equal(model.origin.kind, 'model');
});
