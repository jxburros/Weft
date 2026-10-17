import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { CommunityLists } from '../src/community-lists.js';
import { commands } from '../src/commands.js';
import { buildEnvelope, generateKeyPair } from '../src/list-signing.js';
import { correctEntry, disputeEntry, publishRelease, reviewEntry, rotateKey } from '../src/list-governance.js';
import { T0, acceptEntry, factualDomain, later, newGroup, release } from './fixtures/community-authoring.mjs';

const human = { actor: 'human' };
function fixture(t, { fetcher, now = later(2) } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-signed-lists-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = new WorkspaceService({ directory }); t.after(() => workspace.close());
  const clock = { now: now.getTime() };
  const calls = [];
  const lists = new CommunityLists({ workspace, clock: () => clock.now, fetcher: fetcher ? (...args) => { calls.push(args); return fetcher(...args); } : (...args) => { calls.push(args); throw new Error('network must not be used'); } });
  return { directory, workspace, lists, clock, calls };
}
const preview = (lists, group, data, extra = {}) => lists.execute('lists.preview', { id: 'grp', publicKey: group.keys.publicKey, data, ...extra }, human);
async function subscribe(lists, group, data, extra = {}) {
  const reviewed = await preview(lists, group, data, extra.mode ? { mode: extra.mode } : {});
  return lists.execute('lists.subscribe', { id: 'grp', groupType: 'private-group', publicKey: group.keys.publicKey, mode: 'label', data, payloadSha256: reviewed.to.payloadSha256, ...extra }, human);
}
const update = async (lists, data, extra = {}) => {
  const reviewed = await lists.execute('lists.preview', { id: 'grp', data, ...extra }, human);
  return lists.execute('lists.update', { id: 'grp', data, payloadSha256: reviewed.to.payloadSha256, ...extra }, human);
};
const catalog = () => commands;

test('subscription commands are human-only administration in the shared catalog', async t => {
  for (const name of ['lists.subscribe', 'lists.preview', 'lists.update', 'lists.configure', 'lists.exception', 'lists.unsubscribe', 'lists.check', 'lists.matches']) {
    assert.equal(catalog()[name].humanOnly, true, name);
    assert.equal(catalog()[name].actionClass, 'administration', name);
  }
  const { lists } = fixture(t);
  const group = newGroup();
  const { data } = release(group, acceptEntry(group.state, factualDomain()).state);
  await assert.rejects(lists.execute('lists.preview', { id: 'grp', publicKey: group.keys.publicKey, data }, { actor: 'automation' }), /PERMISSION_REQUIRED/);
  await assert.rejects(lists.execute('lists.check', { id: 'grp' }, { actor: 'automation' }), /PERMISSION_REQUIRED/);
  await assert.rejects(lists.execute('lists.subscribe', { id: 'grp', groupType: 'public', publicKey: group.keys.publicKey, data, payloadSha256: '0'.repeat(64) }, human), /LIST_UNCONFIRMED/);
  await assert.rejects(lists.execute('lists.subscribe', { id: 'grp', groupType: 'public', publicKey: group.keys.publicKey, data, payloadSha256: '0'.repeat(64), extra: true }, human));
});

test('subscribing pins the key, needs the previewed digest, defaults to label and never touches the network', async t => {
  const { lists, workspace, calls } = fixture(t);
  const group = newGroup();
  const { data } = release(group, acceptEntry(group.state, factualDomain('bad.example')).state);
  const before = workspace.storage.contentDigest();
  const reviewed = await preview(lists, group, data);
  assert.equal(reviewed.isNew, true);
  assert.equal(reviewed.added.length, 1);
  assert.equal(reviewed.publisher.keyId, group.keys.keyId);
  assert.equal(workspace.storage.contentDigest(), before, 'preview must not change stored state');
  // The wrong key cannot be pinned: the release is not signed by it.
  const stranger = generateKeyPair();
  await assert.rejects(preview(lists, { keys: stranger }, data), /LIST_KEY_UNPINNED/);
  const subscribed = await subscribe(lists, group, data);
  assert.equal(subscribed.mode, 'label');
  assert.equal(subscribed.groupType, 'private-group');
  assert.equal(subscribed.publisher.keyId, group.keys.keyId);
  assert.equal(subscribed.integrity, 'verified');
  assert.equal(subscribed.ruleCount, 0, 'label mode creates no enforcing rules');
  assert.equal(workspace.matchSiteRule('https://bad.example/'), null);
  await assert.rejects(subscribe(lists, group, data), /Already subscribed/);
  assert.equal(calls.length, 0, 'no network fetch without an explicit check');
  // Labels are visible with provenance even though nothing is blocked.
  const matches = lists.matchesForUrl('https://www.bad.example/x');
  assert.equal(matches[0].effectiveBehavior, 'label');
  assert.equal(matches[0].claimKind, 'Factual claim');
  assert.equal(matches[0].provenance.approvals.length, 2);
  assert.equal(matches[0].provenance.submitter, 'sub1');
  assert.equal(matches[0].provenance.sources[0].url, 'https://reports.example.org/incidents/42');
  // Mode is a ceiling chosen by the subscriber; changing it re-materialises enforcement.
  await lists.execute('lists.configure', { id: 'grp', mode: 'warn' }, human);
  assert.equal(workspace.matchSiteRule('https://bad.example/').behavior, 'warn');
  await lists.execute('lists.configure', { id: 'grp', mode: 'block' }, human);
  const rule = workspace.matchSiteRule('https://bad.example/');
  assert.equal(rule.behavior, 'block');
  assert.equal(rule.provenance.signed, true);
  assert.equal(rule.provenance.claimKind, 'Factual claim');
  assert.equal(rule.provenance.publisherKeyId, group.keys.keyId);
  // A public-group floor of two independent reviewers applies even if the list says one.
  const lax = newGroup({ minReviewers: 1 });
  const single = acceptEntry(lax.state, factualDomain('lax.example'), T0, ['rev1']);
  const laxRelease = release(lax, single.state).data;
  const { lists: other } = fixture(t);
  const sub = await other.execute('lists.subscribe', { id: 'grp', groupType: 'public', publicKey: lax.keys.publicKey, mode: 'block', data: laxRelease, payloadSha256: (await other.execute('lists.preview', { id: 'grp', publicKey: lax.keys.publicKey, data: laxRelease }, human)).to.payloadSha256 }, human);
  assert.equal(sub.minReviewers, 2);
  assert.equal(sub.ruleCount, 0);
  assert.equal(sub.counts.active, 0);
});

test('unsigned, tampered, replayed, equivocating and expired updates are refused; explicit older releases are flagged', async t => {
  const { lists, workspace } = fixture(t);
  const group = newGroup();
  const first = acceptEntry(group.state, factualDomain('one.example'), T0);
  const v1 = release(group, first.state, later(1));
  await subscribe(lists, group, v1.data, { mode: 'block' });
  const second = acceptEntry(v1.state, factualDomain('two.example'), later(2));
  const v2 = release(group, second.state, later(2));
  const store = () => workspace.storage.contentDigest();
  const stored = store();
  const confirm = async data => (await lists.execute('lists.preview', { id: 'grp', data }, human)).to.payloadSha256;
  const tampered = JSON.parse(v2.data); tampered.payload = tampered.payload.replace('two.example', 'evil.example');
  await assert.rejects(lists.execute('lists.update', { id: 'grp', data: JSON.stringify(tampered), payloadSha256: '0'.repeat(64) }, human), /LIST_SIGNATURE/);
  await assert.rejects(lists.execute('lists.update', { id: 'grp', data: JSON.stringify({ format: 'weft-site-list', version: 1, rules: [] }), payloadSha256: '0'.repeat(64) }, human), /LIST_UNSIGNED/);
  const foreign = generateKeyPair();
  const foreignRelease = buildEnvelope(JSON.stringify({ ...JSON.parse(JSON.parse(v2.data).payload), publisher: { keyId: foreign.keyId } }), [foreign.privateKeyPem]);
  await assert.rejects(lists.execute('lists.update', { id: 'grp', data: foreignRelease, payloadSha256: '0'.repeat(64) }, human), /LIST_KEY_UNPINNED/);
  // The previewed digest must be confirmed: applying anything else is refused.
  await assert.rejects(lists.execute('lists.update', { id: 'grp', data: v2.data, payloadSha256: 'f'.repeat(64) }, human), /LIST_UNCONFIRMED/);
  assert.equal(store(), stored);
  await update(lists, v2.data);
  assert.equal(workspace.matchSiteRule('https://two.example/').behavior, 'block');
  // Replay of the older release: refused unless a human explicitly allows an older release.
  await assert.rejects(lists.execute('lists.preview', { id: 'grp', data: v1.data }, human), /LIST_ROLLBACK/);
  await assert.rejects(lists.execute('lists.update', { id: 'grp', data: v1.data, payloadSha256: await confirm(v2.data) }, human), /LIST_ROLLBACK/);
  const older = await lists.execute('lists.preview', { id: 'grp', data: v1.data, allowOlder: true }, human);
  assert.equal(older.rollback, true);
  assert.match(older.warnings[0], /ROLLBACK/);
  assert.deepEqual(older.noLongerBlocked.map(item => item.hostname), ['two.example']);
  // Same sequence, different bytes: equivocation.
  const equal = publishRelease(acceptEntry(v1.state, factualDomain('three.example'), later(2)).state, { privateKeyPem: group.keys.privateKeyPem, now: later(2) });
  assert.equal(equal.payload.sequence, 2);
  await assert.rejects(lists.execute('lists.preview', { id: 'grp', data: equal.envelope }, human), /LIST_EQUIVOCATION/);
  // An already-current release is a no-op.
  assert.equal((await lists.execute('lists.update', { id: 'grp', data: v2.data, payloadSha256: v2.payloadSha256 }, human)).unchanged, true);
  // Expiry.
  const expiring = publishRelease(v2.state, { privateKeyPem: group.keys.privateKeyPem, now: later(3), expiresInDays: 1 });
  assert.equal((await lists.execute('lists.preview', { id: 'grp', data: expiring.envelope }, human)).to.expiresAt, later(4).toISOString());
  lists.clock = () => later(10).getTime();
  await assert.rejects(lists.execute('lists.preview', { id: 'grp', data: expiring.envelope }, human), /LIST_EXPIRED/);
});

test('key rotation is previewed, pins the successor, and the retired key can no longer sign updates', async t => {
  const { lists, workspace } = fixture(t);
  const group = newGroup();
  const v1 = release(group, acceptEntry(group.state, factualDomain('one.example')).state, later(1));
  await subscribe(lists, group, v1.data, { mode: 'block' });
  const successor = generateKeyPair();
  const rotated = rotateKey(v1.state, { currentPrivateKeyPem: group.keys.privateKeyPem, nextPrivateKeyPem: successor.privateKeyPem, statement: 'Moving the signing key to a hardware token.', now: later(2) });
  const reviewed = await lists.execute('lists.preview', { id: 'grp', data: rotated.envelope }, human);
  assert.match(reviewed.warnings[0], /KEY ROTATION/);
  assert.equal(reviewed.publisher.rotation.toKeyId, successor.keyId);
  const applied = await update(lists, rotated.envelope);
  assert.equal(applied.publisher.keyId, successor.keyId);
  assert.equal(applied.publisher.rotations[0].keyId, group.keys.keyId);
  assert.equal(applied.publisher.rotations[0].statement, 'Moving the signing key to a hardware token.');
  const next = acceptEntry(rotated.state, factualDomain('two.example'), later(3));
  const withNewKey = publishRelease(next.state, { privateKeyPem: successor.privateKeyPem, now: later(3) });
  assert.equal((await update(lists, withNewKey.envelope)).current.sequence, 3);
  assert.equal(workspace.matchSiteRule('https://two.example/').behavior, 'block');
  // A compromised/old key can no longer publish for this subscription.
  const oldKeyRelease = buildEnvelope(JSON.stringify({ ...withNewKey.payload, sequence: 9, publisher: { keyId: group.keys.keyId } }), [group.keys.privateKeyPem]);
  await assert.rejects(lists.execute('lists.preview', { id: 'grp', data: oldKeyRelease }, human), /LIST_KEY_UNPINNED/);
  // Rolling back across the rotation restores content but keeps the newer pinned key.
  const back = await lists.execute('lists.rollback', { id: 'grp' }, human);
  assert.equal(back.current.sequence, 2);
  assert.equal(back.publisher.keyId, successor.keyId);
  assert.equal(back.highWater, 3);
  assert.equal((await lists.execute('lists.preview', { id: 'grp', data: withNewKey.envelope }, human)).rollback, false, 'rolling forward to the highest accepted release is allowed');
  await assert.rejects(lists.execute('lists.preview', { id: 'grp', data: v1.data }, human), /LIST_(ROLLBACK|KEY_UNPINNED)/);
});

test('exceptions are visible and per-site; unsubscribe removes everything; other rules are untouched', async t => {
  const { lists, workspace } = fixture(t);
  const group = newGroup();
  let state = acceptEntry(group.state, factualDomain('bad.example')).state;
  state = acceptEntry(state, factualDomain('worse.example')).state;
  const { data } = release(group, state);
  await workspace.execute('siteRules.create', { hostname: 'personal.test' }, human);
  await subscribe(lists, group, data, { mode: 'block' });
  assert.equal(workspace.matchSiteRule('https://bad.example/').behavior, 'block');
  const excepted = await lists.execute('lists.exception', { id: 'grp', action: 'add', hostname: 'Bad.Example', reason: 'Our own staging mirror' }, human);
  assert.deepEqual(excepted.exceptions.map(item => [item.hostname, item.reason]), [['bad.example', 'Our own staging mirror']]);
  assert.equal(workspace.matchSiteRule('https://bad.example/'), null);
  assert.equal(workspace.matchSiteRule('https://worse.example/').behavior, 'block');
  const match = lists.matchesForUrl('https://bad.example/')[0];
  assert.equal(match.excepted, true);
  assert.equal(match.active, false);
  assert.match(match.reasons[0], /exception/);
  assert.equal(excepted.counts.excepted, 1);
  await lists.execute('lists.exception', { id: 'grp', action: 'remove', hostname: 'bad.example' }, human);
  assert.equal(workspace.matchSiteRule('https://bad.example/').behavior, 'block');
  await assert.rejects(lists.execute('lists.exception', { id: 'grp', action: 'remove', hostname: 'bad.example' }, human), /No such exception/);
  const removed = await lists.execute('lists.unsubscribe', { id: 'grp' }, human);
  assert.equal(removed.removedRules, 2);
  assert.equal(workspace.matchSiteRule('https://bad.example/'), null);
  assert.ok(workspace.matchSiteRule('https://personal.test/'));
  assert.deepEqual(await lists.execute('lists.status', {}, human), []);
  assert.ok(workspace.data.activity.some(item => item.action === 'lists.unsubscribe' && /nothing was uploaded/.test(item.detail)));
});

test('explicit and scheduled source checks fetch only configured https URLs and never apply an update', async t => {
  const group = newGroup();
  const v1 = release(group, acceptEntry(group.state, factualDomain('one.example')).state, later(1));
  const v2 = release(group, acceptEntry(v1.state, factualDomain('two.example'), later(2)).state, later(2));
  let served = v2.data;
  const { lists, workspace, calls, clock } = fixture(t, { fetcher: async () => { if (served instanceof Error) throw served; return served; } });
  await subscribe(lists, group, v1.data, { mode: 'block', sourceUrl: 'https://lists.example.org/group/latest.signed.json' });
  await assert.rejects(lists.execute('lists.configure', { id: 'grp', sourceUrl: 'http://plain.example/list.json' }, human));
  await assert.rejects(lists.execute('lists.configure', { id: 'grp', sourceUrl: 'https://user:pw@lists.example.org/x' }, human));
  // Scheduled checks are off until a human enables them.
  assert.deepEqual(await lists.runScheduledChecks(clock.now + 10 * 86_400_000), []);
  assert.equal(calls.length, 0);
  const checked = await lists.execute('lists.check', { id: 'grp' }, human);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['https://lists.example.org/group/latest.signed.json', { maxBytes: 1_000_000 }]);
  assert.equal(checked.checked, 'update-available');
  assert.equal(checked.pendingUpdate.sequence, 2);
  assert.equal(workspace.matchSiteRule('https://two.example/'), null, 'a fetched release is never applied automatically');
  const reviewed = await lists.execute('lists.preview', { id: 'grp' }, human);
  assert.deepEqual(reviewed.newlyBlocked.map(item => item.hostname), ['two.example']);
  const applied = await lists.execute('lists.update', { id: 'grp', payloadSha256: reviewed.to.payloadSha256 }, human);
  assert.equal(applied.pendingUpdate, null);
  assert.equal(workspace.matchSiteRule('https://two.example/').behavior, 'block');
  // Bad fetches are rejected and recorded, not applied.
  const tampered = JSON.parse(v2.data); tampered.payload = tampered.payload.replace('Group safety list', 'Hacked list');
  served = JSON.stringify(tampered);
  assert.equal((await lists.execute('lists.check', { id: 'grp' }, human)).lastCheck.outcome, 'rejected');
  served = v1.data;
  const rollback = await lists.execute('lists.check', { id: 'grp' }, human);
  assert.equal(rollback.lastCheck.outcome, 'rejected');
  assert.match(rollback.lastCheck.detail, /LIST_ROLLBACK/);
  served = new Error('offline');
  assert.equal((await lists.execute('lists.check', { id: 'grp' }, human)).lastCheck.outcome, 'error');
  assert.equal(workspace.data.siteLists[0].pending, null);
  // Opt-in schedule: respects the interval and records the trigger.
  await lists.execute('lists.configure', { id: 'grp', scheduledCheck: { enabled: true, intervalHours: 6 } }, human);
  const before = calls.length;
  served = v2.data;
  assert.deepEqual(await lists.runScheduledChecks(clock.now + 3_600_000), []);
  clock.now += 7 * 3_600_000;
  const ran = await lists.runScheduledChecks(clock.now);
  assert.equal(ran.length, 1);
  assert.equal(calls.length, before + 1);
  assert.equal(workspace.data.siteLists[0].lastCheck.trigger, 'scheduled');
  assert.ok(workspace.data.activity.some(item => item.action === 'lists.check' && item.actor === 'scheduler' && /no workspace data sent/.test(item.detail)));
  await assert.rejects(lists.execute('lists.configure', { id: 'grp', sourceUrl: null, scheduledCheck: { enabled: true, intervalHours: 1 } }, human), /sourceUrl/);
});

test('lists.matches shows every rule, precedence and community provenance; its winner equals the browser matcher', async t => {
  const { lists, workspace } = fixture(t);
  const group = newGroup();
  let state = acceptEntry(group.state, factualDomain('mix.example')).state;
  state = acceptEntry(state, { subject: { type: 'domain', hostname: 'mix.example', includeSubdomains: true, path: '/shop' }, claim: 'Our reviewers found the shop pages misleading about prices.', claimType: 'opinion', category: 'accuracy', recommended: 'warn', sources: [] }).state;
  state = acceptEntry(state, { subject: { type: 'entity', name: 'Mix Holdings', entityKind: 'organization', domains: ['mix.example'] }, claim: 'Mix Holdings operates mix.example and is the subject of a regulator notice.', claimType: 'factual', category: 'other', recommended: 'label', sources: [{ title: 'Notice', url: 'https://regulator.example/n/1', retrievedAt: T0.toISOString() }] }).state;
  await workspace.execute('siteRules.create', { hostname: 'mix.example', behavior: 'warn', reason: 'Personal note' }, human);
  await workspace.execute('siteRules.create', { hostname: 'mix.example', behavior: 'block', mode: 'connection', path: '/api', reason: 'Personal connection block' }, human);
  await subscribe(lists, group, release(group, state).data, { mode: 'block' });
  for (const url of ['https://mix.example/', 'https://www.mix.example/shop/item', 'https://mix.example/api/v1', 'https://other.example/']) {
    const explained = await lists.execute('lists.matches', { url }, human);
    const winner = workspace.matchSiteRule(url);
    assert.equal(explained.winner?.id ?? null, winner?.id ?? null, url);
    assert.ok(explained.precedence.length >= 3);
    if (winner) assert.equal(explained.rules[0].id, winner.id);
  }
  const root = await lists.execute('lists.matches', { url: 'https://mix.example/' }, human);
  assert.deepEqual(root.rules.map(rule => [rule.source, rule.behavior, rule.precedenceTier]).sort(), [['community-list', 'block', 2], ['personal', 'warn', 3]]);
  assert.deepEqual(root.communityMatches.map(match => [match.subjectType, match.effectiveBehavior]).sort(), [['domain', 'block'], ['entity', 'label']]);
  const shop = await lists.execute('lists.matches', { url: 'https://mix.example/shop/a' }, human);
  const opinion = shop.communityMatches.find(match => match.claimType === 'opinion');
  assert.equal(opinion.claimKind, 'Opinion');
  assert.equal(opinion.effectiveBehavior, 'warn');
  assert.equal(shop.communityMatches.find(match => match.subjectType === 'entity').enforcedByRuleId, null);
  assert.equal(opinion.enforcedByRuleId, shop.rules.find(rule => rule.provenance?.entryId === opinion.entryId).id);
  const api = await lists.execute('lists.matches', { url: 'https://mix.example/api/v1' }, human);
  assert.equal(api.rules[0].mode, 'connection');
  assert.equal(api.rules[0].winner, true);
});

test('end to end: a corrected entry propagates through a signed update and changes subscriber behavior with inspectable provenance', async t => {
  const { lists, workspace } = fixture(t, { now: later(5) });
  const group = newGroup({ minReviewers: 2 });
  // v1: two reviewers accept a factual entry that blocks the whole domain.
  const accepted = acceptEntry(group.state, factualDomain('shop.example'), T0);
  const v1 = release(group, accepted.state, later(1));
  const subscribed = await subscribe(lists, group, v1.data, { mode: 'block', groupType: 'public' });
  assert.equal(subscribed.minReviewers, 2);
  assert.equal(workspace.matchSiteRule('https://shop.example/checkout').behavior, 'block');
  assert.equal(workspace.matchSiteRule('https://shop.example/blog/post').behavior, 'block');
  const original = lists.matchesForUrl('https://shop.example/blog/post')[0];
  assert.equal(original.revision, 1);

  // The group is told the block is too broad: a member disputes it, a reviewer corrects the scope and
  // downgrades the recommendation, and two independent reviewers confirm the correction.
  let state = disputeEntry(v1.state, { actor: 'rev3', entryId: accepted.id, reason: 'Only the checkout path was spoofed; the blog is fine.', reporter: 'external:site-owner', now: later(2) }).state;
  const v2dispute = release(group, state, later(2));
  state = v2dispute.state;
  state = correctEntry(state, { actor: 'rev3', entryId: accepted.id, note: 'Narrowed to /checkout and downgraded to warn after the owner removed the spoofed form.', now: later(3),
    changes: { subject: { type: 'domain', hostname: 'shop.example', includeSubdomains: false, path: '/checkout' }, recommended: 'warn' } }).state;
  const underReview = release(group, state, later(3));
  state = underReview.state;
  state = ['rev1', 'rev2'].reduce((s, reviewer) => reviewEntry(s, { actor: reviewer, entryId: accepted.id, decision: 'approve', now: later(4) }).state, state);
  const v4 = release(group, state, later(4));
  assert.deepEqual([v2dispute.payload.sequence, underReview.payload.sequence, v4.payload.sequence], [2, 3, 4]);

  // The subscriber checks the preview first: the correction is visible as a change, not a silent swap.
  const reviewed = await lists.execute('lists.preview', { id: 'grp', data: v4.data }, human);
  assert.equal(reviewed.changed.length, 1);
  assert.deepEqual(reviewed.changed[0].fields.sort(), ['behavior', 'revision', 'status', 'subject', 'recommended', 'reviewBy'].sort());
  assert.equal(reviewed.changed[0].before.behavior, 'block');
  assert.equal(reviewed.changed[0].after.behavior, 'warn');
  assert.equal(reviewed.changed[0].after.status, 'corrected');
  assert.match(reviewed.changed[0].correctionNote, /Narrowed to \/checkout/);
  assert.equal(reviewed.newlyBlocked.length, 0);
  assert.deepEqual(reviewed.noLongerBlocked.map(item => [item.hostname, item.path]), [['shop.example', '/']]);
  assert.equal(workspace.matchSiteRule('https://shop.example/blog/post').behavior, 'block', 'preview alone changes nothing');

  // An intermediate release where the correction is not yet reviewed designates nothing at all.
  const interim = await lists.execute('lists.preview', { id: 'grp', data: underReview.data }, human);
  assert.equal(interim.changed[0].after.behavior, 'none');

  const applied = await lists.execute('lists.update', { id: 'grp', data: v4.data, payloadSha256: reviewed.to.payloadSha256 }, human);
  assert.equal(applied.current.sequence, 4);
  assert.equal(applied.rollbackAvailable, true);
  assert.equal(workspace.matchSiteRule('https://shop.example/blog/post'), null);
  const checkout = workspace.matchSiteRule('https://shop.example/checkout/pay');
  assert.equal(checkout.behavior, 'warn');
  assert.equal(workspace.matchSiteRule('https://www.shop.example/checkout'), null, 'correction also dropped subdomain coverage');

  // Provenance is inspectable from the rule, from the match list and from the stored activity.
  assert.deepEqual([checkout.provenance.entryId, checkout.provenance.entryRevision, checkout.provenance.entryStatus, checkout.provenance.sequence], [accepted.id, 2, 'corrected', 4]);
  const explained = await lists.execute('lists.matches', { url: 'https://shop.example/checkout/pay' }, human);
  const match = explained.communityMatches[0];
  assert.equal(match.status, 'corrected');
  assert.equal(match.revision, 2);
  assert.equal(match.provenance.correctionNote.startsWith('Narrowed'), true);
  assert.deepEqual(match.provenance.approvals.sort(), ['rev1', 'rev2']);
  assert.equal(match.provenance.submitter, 'sub1');
  assert.equal(match.provenance.disputes[0].state, 'corrected');
  assert.deepEqual(match.provenance.history.map(item => item.action).filter(action => ['submitted', 'disputed', 'corrected'].includes(action)), ['submitted', 'disputed', 'corrected']);
  assert.equal(match.provenance.sources[0].title, 'Incident write-up');
  assert.equal(match.payloadSha256, reviewed.to.payloadSha256);
  assert.equal(match.publisherKeyId, group.keys.keyId);
  assert.ok(workspace.data.activity.some(item => item.action === 'lists.update' && /seq 4/.test(item.detail) && /\+0 -0 ~1/.test(item.detail)));

  // Rollback is explicit and verified; it restores the broad block, and the newer sequence stays the floor.
  const rolled = await lists.execute('lists.rollback', { id: 'grp' }, human);
  assert.equal(rolled.current.sequence, 1);
  assert.equal(workspace.matchSiteRule('https://shop.example/blog/post').behavior, 'block');
  await assert.rejects(lists.execute('lists.preview', { id: 'grp', data: v2dispute.data }, human), /LIST_ROLLBACK/);
  await lists.execute('lists.update', { id: 'grp', data: v4.data, payloadSha256: reviewed.to.payloadSha256 }, human);
  assert.equal(workspace.matchSiteRule('https://shop.example/blog/post'), null);
});

test('subscriptions survive restart, stay scoped to their workspace and detect tampered stored bytes', async t => {
  const { lists, workspace, directory } = fixture(t);
  const group = newGroup();
  const { data } = release(group, acceptEntry(group.state, factualDomain('bad.example')).state);
  await subscribe(lists, group, data, { mode: 'block' });
  const original = workspace.activeWorkspaceId;
  const other = await workspace.execute('workspaces.create', { name: 'Other' });
  assert.deepEqual(await lists.execute('lists.status', {}, human).then(list => list.filter(item => item.workspaceId === other.id)), []);
  await assert.rejects(lists.execute('lists.update', { id: 'grp', workspaceId: original, data, payloadSha256: '0'.repeat(64) }, { actor: 'human', workspaceId: other.id }), /PERMISSION_REQUIRED/);
  const reopened = new WorkspaceService({ directory }); t.after(() => reopened.close());
  const again = new CommunityLists({ workspace: reopened, clock: () => later(2).getTime() });
  assert.equal(reopened.matchSiteRule('https://bad.example/', original).behavior, 'block');
  const status = (await again.execute('lists.status', { id: 'grp', workspaceId: original }, human))[0];
  assert.equal(status.kind, 'signed');
  assert.equal(status.integrity, 'verified');
  assert.equal(status.envelope, undefined);
  // Editing the stored copy (e.g. to weaken the list) is detected instead of trusted.
  reopened.data.siteLists[0].current.envelope = reopened.data.siteLists[0].current.envelope.replace('Group safety list', 'Group safety lisT');
  assert.equal(again.summary(reopened.data.siteLists[0]).integrity, 'mismatch');
  assert.deepEqual(again.matchesForUrl('https://bad.example/', original), []);
  // Legacy unsigned pins keep working and cannot clobber a signed id.
  const legacy = { id: 'grp', workspaceId: original, sourceRepo: 'a/b', commit: 'a'.repeat(40), path: 'x.json', sha256: '0'.repeat(64), bytes: 1, data: 'x' };
  await assert.rejects(again.execute('lists.install', legacy, human), /LIST_KIND/);
});
