import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEnvelope, generateKeyPair, keyIdOf } from '../src/list-signing.js';
import { diffReleases, entrySchema, evaluateRelease, governanceViolations, verifyRelease } from '../src/list-format.js';
import { addRole, appealDispute, correctEntry, decideAppeal, disputeEntry, listStatus, markStale, publishRelease, removeRole, retireEntry, reviewEntry, rotateKey, submitEntry } from '../src/list-governance.js';
import { T0, acceptEntry, factualDomain, later, newGroup, release } from './fixtures/community-authoring.mjs';

const pinned = group => ({ keyId: group.keys.keyId, publicKey: group.keys.publicKey });
const options = (extra = {}) => ({ mode: 'block', exceptions: [], minReviewers: 1, now: later(1), ...extra });

test('signatures: unsigned, tampered, wrong-key and foreign-publisher lists are rejected', () => {
  const group = newGroup();
  const { data } = release(group, group.state);
  assert.equal(verifyRelease(data, { pinned: pinned(group) }).payload.sequence, 1);
  // A plain data-only list or an envelope without signatures is never a source.
  assert.throws(() => verifyRelease(JSON.stringify({ format: 'weft-site-list', version: 1, rules: [] }), { pinned: pinned(group) }), /LIST_UNSIGNED/);
  const unsigned = JSON.parse(data); unsigned.signatures = [];
  assert.throws(() => verifyRelease(JSON.stringify(unsigned), { pinned: pinned(group) }), /LIST_UNSIGNED/);
  // One changed character in the signed payload invalidates the signature.
  const tampered = JSON.parse(data); tampered.payload = tampered.payload.replace('Group safety list', 'Group safety lisT');
  assert.throws(() => verifyRelease(JSON.stringify(tampered), { pinned: pinned(group) }), /LIST_SIGNATURE/);
  // Signed correctly by someone else (including a self-declared publisher key) is not the pinned publisher.
  const other = generateKeyPair();
  const forged = buildEnvelope(JSON.stringify({ ...JSON.parse(JSON.parse(data).payload), publisher: { keyId: other.keyId } }), [other.privateKeyPem]);
  assert.throws(() => verifyRelease(forged, { pinned: pinned(group) }), /LIST_KEY_UNPINNED/);
  const relabelled = JSON.parse(forged); relabelled.signatures[0].keyId = group.keys.keyId;
  assert.throws(() => verifyRelease(JSON.stringify(relabelled), { pinned: pinned(group) }), /LIST_KEY_UNPINNED|LIST_SIGNATURE/);
  const swapped = JSON.parse(data); swapped.signatures[0].signature = JSON.parse(forged).signatures[0].signature;
  assert.throws(() => verifyRelease(JSON.stringify(swapped), { pinned: pinned(group) }), /LIST_SIGNATURE/);
  assert.throws(() => verifyRelease(data, { pinned: pinned(group), listId: 'other-list' }), /LIST_IDENTITY/);
  assert.throws(() => keyIdOf('AAAA'), /LIST_KEY/);
});

test('a single report never designates: proposals and single approvals enforce nothing, and conflicted approvals do not count', () => {
  const group = newGroup();
  const submitted = submitEntry(group.state, { actor: 'sub1', entry: factualDomain(), now: T0 });
  const id = submitted.entry.id;
  const evaluate = state => evaluateRelease(JSON.parse(JSON.parse(release(group, state).data).payload), options({ minReviewers: 1 }));
  assert.equal(evaluate(submitted.state).entries[0].behavior, 'none');
  // The submitter cannot review their own claim, and unauthorised members cannot review at all.
  assert.throws(() => reviewEntry(submitted.state, { actor: 'sub1', entryId: id, decision: 'approve', now: T0 }), /ROLE_REQUIRED/);
  const selfReviewer = addRole(submitted.state, { actor: 'maint', member: 'sub1', role: 'reviewer', now: T0 });
  assert.throws(() => reviewEntry(selfReviewer, { actor: 'sub1', entryId: id, decision: 'approve', now: T0 }), /CONFLICT_OF_INTEREST/);
  const one = reviewEntry(submitted.state, { actor: 'rev1', entryId: id, decision: 'approve', now: T0 });
  assert.equal(one.entry.status, 'proposed');
  assert.throws(() => reviewEntry(one.state, { actor: 'rev1', entryId: id, decision: 'approve', now: T0 }), /ALREADY_REVIEWED/);
  assert.equal(evaluate(one.state).entries[0].behavior, 'none');
  // A maintainer without the reviewer role cannot supply the second approval.
  const noReviewer = removeRole(one.state, { actor: 'maint', member: 'maint', role: 'reviewer' });
  assert.throws(() => reviewEntry(noReviewer, { actor: 'maint', entryId: id, decision: 'approve', now: T0 }), /ROLE_REQUIRED/);
  const two = reviewEntry(one.state, { actor: 'rev2', entryId: id, decision: 'approve', now: T0 });
  assert.equal(two.entry.status, 'accepted');
  assert.equal(two.transition, 'proposed -> accepted');
  assert.equal(evaluate(two.state).entries[0].behavior, 'block');
  // A list that publishes an "accepted" entry with one approval is not trusted: the subscriber floor wins.
  const forgedOne = structuredClone(two.state);
  forgedOne.entries[0].reviews = forgedOne.entries[0].reviews.slice(0, 1);
  const payload = JSON.parse(JSON.parse(release(group, forgedOne).data).payload);
  const effect = evaluateRelease(payload, options({ minReviewers: 1 })).entries[0];
  assert.equal(effect.behavior, 'none');
  assert.match(effect.effect.reasons[0], /insufficient review/);
  // Rejections by N independent reviewers retire a proposal.
  const rejecting = submitEntry(group.state, { actor: 'sub1', entry: factualDomain('other.example'), now: T0 });
  const rejected = ['rev1', 'rev2'].reduce((state, reviewer) => reviewEntry(state, { actor: reviewer, entryId: rejecting.entry.id, decision: 'reject', now: T0 }).state, rejecting.state);
  assert.equal(rejected.entries[0].status, 'retired');
});

test('entry schema separates facts from opinions and entities from domains', () => {
  const base = { id: 'e1', claim: 'A specific claim about the subject.', category: 'other', status: 'proposed', submitter: 'sub1', lastEditor: 'sub1', createdAt: T0.toISOString(), updatedAt: T0.toISOString(), reviewBy: later(300).toISOString(), revision: 1, round: 1 };
  const domain = { type: 'domain', hostname: 'a.example' };
  assert.throws(() => entrySchema.parse({ ...base, subject: domain, claimType: 'factual', recommended: 'warn' }), /requires at least one source/);
  assert.throws(() => entrySchema.parse({ ...base, subject: domain, claimType: 'opinion', recommended: 'block' }), /Only a sourced factual claim/);
  assert.throws(() => entrySchema.parse({ ...base, subject: { type: 'entity', name: 'Acme', domains: ['a.example'] }, claimType: 'opinion', recommended: 'warn' }), /entity/);
  assert.throws(() => entrySchema.parse({ ...base, subject: domain, claimType: 'opinion', recommended: 'warn', verdict: 'evil' }));
  assert.throws(() => entrySchema.parse({ ...base, subject: { type: 'domain', hostname: 'A.Example' }, claimType: 'opinion', recommended: 'warn' }), /canonical/);
  assert.equal(entrySchema.parse({ ...base, subject: domain, claimType: 'opinion', recommended: 'warn' }).sources.length, 0);

  const group = newGroup();
  let { state } = acceptEntry(group.state, factualDomain('fact.example'));
  ({ state } = acceptEntry(state, { subject: { type: 'domain', hostname: 'opinion.example', includeSubdomains: true, path: '/' }, claim: 'This site is, in our view, low quality.', claimType: 'opinion', category: 'accuracy', recommended: 'warn', sources: [] }));
  ({ state } = acceptEntry(state, { subject: { type: 'entity', name: 'Shady Ltd', entityKind: 'organization', domains: ['shady.example'] }, claim: 'Shady Ltd was cited for repeated billing complaints.', claimType: 'factual', category: 'scam', recommended: 'label', sources: [{ title: 'Registry', url: 'https://registry.example/x', retrievedAt: T0.toISOString() }] }));
  const payload = JSON.parse(JSON.parse(release(group, state).data).payload);
  const behavior = Object.fromEntries(evaluateRelease(payload, options({ now: later(2) })).entries.map(item => [item.entry.subject.hostname || item.entry.subject.name, item.behavior]));
  assert.deepEqual(behavior, { 'fact.example': 'block', 'opinion.example': 'warn', 'Shady Ltd': 'label' });
  // Even an opinion recommended as "block" or an entity entry cannot exceed its ceiling at subscriber mode "block".
  const rules = evaluateRelease(payload, options({ now: later(2) })).rules.map(item => item.rule.hostname);
  assert.deepEqual(rules.sort(), ['fact.example', 'opinion.example']);
  assert.ok(evaluateRelease(payload, options({ mode: 'warn', now: later(2) })).rules.every(item => item.rule.behavior === 'warn'));
});

test('anti-abuse: rate, pending, size and dispute limits hold in tooling and are re-checked from published data', () => {
  const group = newGroup();
  let state = group.state;
  for (let i = 0; i < 5; i++) state = submitEntry(state, { actor: 'sub1', entry: factualDomain(`s${i}.example`), now: new Date(T0.getTime() + i * 1000) }).state;
  assert.throws(() => submitEntry(state, { actor: 'sub1', entry: factualDomain('s6.example'), now: later(0.5) }), /LIMIT_RATE/);
  assert.throws(() => submitEntry(group.state, { actor: 'outsider', entry: factualDomain(), now: T0 }), /ROLE_REQUIRED/);
  assert.throws(() => submitEntry(group.state, { actor: 'sub1', entry: factualDomain('x.example', { claim: 'x'.repeat(501) }), now: T0 }), /LIMIT_SIZE|Too big|too_big/);
  // Tooling refuses to publish entries that violate the list's own limits; a hand-edited file is re-checked by subscribers.
  const cheated = structuredClone(state);
  for (let i = 0; i < 3; i++) cheated.entries.push({ ...structuredClone(cheated.entries[0]), id: `extra-${i}`, subject: { type: 'domain', hostname: `extra${i}.example`, includeSubdomains: true, path: '/' } });
  assert.throws(() => publishRelease(cheated, { privateKeyPem: group.keys.privateKeyPem, now: later(1) }), /GOVERNANCE_VIOLATION.*rate-limit/);
  const strangers = structuredClone(group.state);
  strangers.entries.push({ ...structuredClone(state.entries[0]), id: 'ghost', submitter: 'ghost', lastEditor: 'ghost' });
  assert.throws(() => publishRelease(strangers, { privateKeyPem: group.keys.privateKeyPem, now: later(1) }), /submitter-unknown/);
  const lowered = newGroup();
  const tight = { ...lowered.state, governance: { ...lowered.state.governance, limits: { ...lowered.state.governance.limits, maxPendingPerSubmitter: 1 } } };
  const two = [0, 1].reduce((s, i) => ({ ...s, entries: [...s.entries, { ...structuredClone(state.entries[0]), id: `p${i}`, createdAt: later(i * 2).toISOString() }] }), tight);
  assert.ok(governanceViolations(JSON.parse(JSON.parse(publishAnyway(lowered, two)).payload)).get('p1')?.some(item => item.code === 'pending-cap'));
  // Dispute spam is bounded per member.
  let spam = acceptEntry(group.state, factualDomain('d0.example')).state;
  const id = spam.entries[0].id;
  spam = { ...spam, governance: { ...spam.governance, limits: { ...spam.governance.limits, maxOpenDisputesPerMember: 1 } } };
  spam = disputeEntry(spam, { actor: 'rev3', entryId: id, reason: 'inaccurate', now: later(1) }).state;
  assert.throws(() => disputeEntry(spam, { actor: 'rev3', entryId: id, reason: 'again', now: later(1) }), /LIMIT_DISPUTES/);
});
// Build a signed file without governance publication checks, to exercise the subscriber-side re-check.
function publishAnyway(group, state) {
  const payload = { format: 'weft-community-list', formatVersion: 1, listId: state.listId, name: state.name, description: '', publisher: { keyId: group.keys.keyId }, sequence: 1, issuedAt: T0.toISOString(), governance: state.governance, entries: state.entries };
  return buildEnvelope(JSON.stringify(payload), [group.keys.privateKeyPem]);
}

test('disputes cap enforcement immediately; corrections need fresh review; appeals are decided independently', () => {
  const group = newGroup({ minReviewers: 2 });
  let { state, id } = acceptEntry(group.state, factualDomain('old.example'));
  const effect = (s, at = 2) => evaluateRelease(JSON.parse(JSON.parse(release(group, s).data).payload), options({ now: later(at) })).entries[0];
  assert.equal(effect(state).behavior, 'block');
  // One dispute downgrades to a label at once (it is cheap to reduce harm, expensive to add it).
  state = disputeEntry(state, { actor: 'rev3', entryId: id, reason: 'The page was restored after a hacked-site clean-up.', reporter: 'external:site-owner', now: later(3) }).state;
  assert.equal(state.entries[0].status, 'disputed');
  assert.equal(effect(state, 4).behavior, 'label');
  // Re-review: prior approvals do not carry over; N independent approvals uphold it.
  let upheld = reviewEntry(state, { actor: 'rev1', entryId: id, decision: 'approve', now: later(4) });
  assert.equal(upheld.entry.status, 'disputed');
  upheld = reviewEntry(upheld.state, { actor: 'rev2', entryId: id, decision: 'approve', now: later(4) });
  assert.equal(upheld.entry.status, 'accepted');
  assert.equal(upheld.entry.disputes[0].state, 'upheld');
  assert.equal(effect(upheld.state, 5).behavior, 'block');
  // The disputant appeals; the entry is label-only until a maintainer who was not involved decides.
  const appealed = appealDispute(upheld.state, { actor: 'rev3', entryId: id, disputeId: 'd1', reason: 'Evidence of clean-up attached.', now: later(6) });
  assert.equal(appealed.entry.status, 'disputed');
  assert.equal(effect(appealed.state, 7).behavior, 'label');
  const independent = decideAppeal(appealed.state, { actor: 'maint', entryId: id, disputeId: 'd1', outcome: 'grant', note: 'Clean-up verified', now: later(7) });
  assert.equal(independent.entry.status, 'retired');
  assert.equal(effect(independent.state, 8).behavior, 'none');
  const denied = decideAppeal(appealed.state, { actor: 'maint', entryId: id, disputeId: 'd1', outcome: 'deny', now: later(7) });
  assert.equal(denied.entry.status, 'accepted');
  assert.equal(effect(denied.state, 8).behavior, 'block');
  assert.throws(() => decideAppeal(appealed.state, { actor: 'rev1', entryId: id, disputeId: 'd1', outcome: 'deny', now: later(7) }), /ROLE_REQUIRED/);
  assert.throws(() => appealDispute(appealed.state, { actor: 'rev3', entryId: id, disputeId: 'd1', reason: 'twice', now: later(8) }), /APPEAL_EXISTS/);

  // A correction (here: narrowing to a path) designates nothing until re-reviewed by independent reviewers.
  const corrected = correctEntry(upheld.state, { actor: 'rev3', entryId: id, changes: { subject: { type: 'domain', hostname: 'old.example', includeSubdomains: false, path: '/login' }, recommended: 'warn' }, note: 'Only /login was malicious.', now: later(9) });
  assert.equal(corrected.entry.status, 'corrected');
  assert.equal(corrected.entry.revision, 2);
  assert.equal(effect(corrected.state, 10).behavior, 'none');
  assert.throws(() => reviewEntry(corrected.state, { actor: 'rev3', entryId: id, decision: 'approve', now: later(9) }), /CONFLICT_OF_INTEREST/);
  const reviewed = ['rev1', 'rev2'].reduce((s, who) => reviewEntry(s, { actor: who, entryId: id, decision: 'approve', now: later(10) }).state, corrected.state);
  assert.equal(effect(reviewed, 11).behavior, 'warn');
  assert.deepEqual(reviewed.entries[0].history.map(item => item.action).slice(-3), ['corrected', 'reviewed', 'reviewed']);
  assert.throws(() => correctEntry(upheld.state, { actor: 'rev3', entryId: id, changes: { status: 'accepted' }, note: 'sneaky edit', now: later(9) }), /FIELD_NOT_CORRECTABLE/);
  assert.throws(() => correctEntry(upheld.state, { actor: 'sub1', entryId: id, changes: { claim: 'Changed claim text here.' }, note: '', now: later(9) }), /NOTE_REQUIRED/);

  // Maintainers can retire immediately (reducing harm is easy); retired entries cannot be edited back to life.
  const retired = retireEntry(reviewed, { actor: 'maint', entryId: id, note: 'Domain reassigned', now: later(12) });
  assert.equal(effect(retired.state, 13).behavior, 'none');
  assert.throws(() => correctEntry(retired.state, { actor: 'maint', entryId: id, changes: { claim: 'Changed claim text here.' }, note: 'revive please', now: later(13) }), /ENTRY_RETIRED/);
});

test('stale entries fall back to labels until independently re-reviewed', () => {
  const group = newGroup();
  const { state, id } = acceptEntry(group.state, factualDomain('aging.example'));
  const payload = JSON.parse(JSON.parse(release(group, state).data).payload);
  // Subscribers apply the review date themselves, even before maintainers mark the entry stale.
  assert.equal(evaluateRelease(payload, options({ now: later(30) })).entries[0].behavior, 'block');
  assert.equal(evaluateRelease(payload, options({ now: later(400) })).entries[0].behavior, 'label');
  assert.match(evaluateRelease(payload, options({ now: later(400) })).entries[0].effect.reasons[0], /stale/);
  assert.deepEqual(listStatus(state, later(400)).staleDue, [id]);
  const marked = markStale(state, { actor: 'maint', now: later(400) });
  assert.deepEqual(marked.marked, [id]);
  assert.equal(marked.state.entries[0].status, 'stale');
  let reaffirmed = reviewEntry(marked.state, { actor: 'rev1', entryId: id, decision: 'approve', now: later(401) });
  assert.equal(reaffirmed.entry.status, 'stale');
  reaffirmed = reviewEntry(reaffirmed.state, { actor: 'rev2', entryId: id, decision: 'approve', now: later(401) });
  assert.equal(reaffirmed.entry.status, 'accepted');
  assert.ok(Date.parse(reaffirmed.entry.reviewBy) > later(700).getTime());
  assert.equal(evaluateRelease(JSON.parse(JSON.parse(release(group, reaffirmed.state, later(401)).data).payload), options({ now: later(402) })).entries[0].behavior, 'block');
});

test('key rotation needs both keys; diffs surface changes, newly blocked domains and governance edits', () => {
  const group = newGroup();
  const first = acceptEntry(group.state, factualDomain('one.example'));
  const v1 = release(group, first.state, later(1));
  const second = acceptEntry(v1.state, factualDomain('two.example'), later(2));
  const v2 = release(group, second.state, later(2));
  const before = verifyRelease(v1.data, { pinned: pinned(group) }).payload;
  const after = verifyRelease(v2.data, { pinned: pinned(group) }).payload;
  const diff = diffReleases(before, after, options({ now: later(3) }));
  assert.deepEqual(diff.added.map(item => item.subject), ['*.two.example']);
  assert.deepEqual(diff.newlyBlocked.map(item => item.hostname), ['two.example']);
  assert.equal(diff.removed.length + diff.changed.length, 0);
  const loosened = { ...after, governance: { ...after.governance, minReviewers: 1 } };
  assert.deepEqual(diffReleases(after, loosened, options()).warnings, ['The list lowered its reviewer threshold.']);

  const next = generateKeyPair();
  const rotated = rotateKey(v2.state, { currentPrivateKeyPem: group.keys.privateKeyPem, nextPrivateKeyPem: next.privateKeyPem, statement: 'Annual key rotation, old key retired.', now: later(4) });
  const rotatedRelease = verifyRelease(rotated.envelope, { pinned: pinned(group) });
  assert.equal(rotatedRelease.rotation.toKeyId, next.keyId);
  // Signed by the new key only, by the old key only, or naming the wrong successor: all rejected.
  const only = pem => buildEnvelope(rotated.payload ? JSON.stringify(rotated.payload) : '', [pem]);
  assert.throws(() => verifyRelease(only(group.keys.privateKeyPem), { pinned: pinned(group) }), /LIST_ROTATION/);
  assert.throws(() => verifyRelease(only(next.privateKeyPem), { pinned: pinned(group) }), /LIST_KEY_UNPINNED|LIST_SIGNATURE/);
  const bogus = generateKeyPair();
  const wrongSuccessor = JSON.stringify({ ...rotated.payload, keyRotation: { ...rotated.payload.keyRotation, toPublicKey: bogus.publicKey } });
  assert.throws(() => verifyRelease(buildEnvelope(wrongSuccessor, [group.keys.privateKeyPem, next.privateKeyPem]), { pinned: pinned(group) }), /LIST_ROTATION/);
  assert.throws(() => rotateKey(v2.state, { currentPrivateKeyPem: next.privateKeyPem, nextPrivateKeyPem: group.keys.privateKeyPem, statement: 'wrong direction here', now: later(4) }), /WRONG_KEY/);
  assert.throws(() => rotateKey(v2.state, { currentPrivateKeyPem: group.keys.privateKeyPem, nextPrivateKeyPem: next.privateKeyPem, statement: 'short', now: later(4) }), /NOTE_REQUIRED/);
  // After rotation the publisher signs with the new key only.
  const after2 = publishRelease(rotated.state, { privateKeyPem: next.privateKeyPem, now: later(5) });
  assert.equal(verifyRelease(after2.envelope, { pinned: { keyId: next.keyId, publicKey: next.publicKey } }).payload.sequence, 4);
  assert.throws(() => publishRelease(rotated.state, { privateKeyPem: group.keys.privateKeyPem, now: later(5) }), /WRONG_KEY/);
});

test('maintainer CLI runs the whole workflow on plain files and writes a verifiable signed release', t => {
  const dir = mkdtempSync(join(tmpdir(), 'weft-list-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/community-list.js', import.meta.url));
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args, '--now', '2026-10-02T00:00:00Z'], { encoding: 'utf8' });
    return { status: result.status, out: result.stdout ? JSON.parse(result.stdout) : null, err: result.stderr };
  };
  const keys = cli('keygen', '--out', join(dir, 'keys'));
  assert.equal(keys.status, 0);
  if (process.platform !== 'win32') assert.equal(statSync(keys.out.privateKeyFile).mode & 0o077, 0, 'private key must not be group/world readable');
  const repo = join(dir, 'repo');
  assert.equal(cli('init', '--dir', repo, '--id', 'cli-list', '--name', 'CLI list', '--maintainer', 'maint', '--public-key', keys.out.publicKeyFile).status, 0);
  for (const [member, role] of [['rev1', 'reviewer'], ['rev2', 'reviewer'], ['sub1', 'submitter']]) assert.equal(cli('role-add', '--dir', repo, '--as', 'maint', '--member', member, '--role', role).status, 0);
  const submitted = cli('submit', '--dir', repo, '--as', 'sub1', '--hostname', 'cli-bad.example', '--claim', 'cli-bad.example hosts malware installers, confirmed by two scanners.', '--claim-type', 'factual', '--category', 'malware', '--recommended', 'block', '--source-url', 'https://reports.example.org/1', '--source-title', 'Scan report');
  assert.equal(submitted.status, 0, submitted.err);
  const entry = submitted.out.entryId;
  assert.equal(cli('review', '--dir', repo, '--as', 'rev1', '--entry', entry, '--decision', 'approve').out.status, 'proposed');
  assert.equal(cli('review', '--dir', repo, '--as', 'rev2', '--entry', entry, '--decision', 'approve').out.status, 'accepted');
  const self = cli('review', '--dir', repo, '--as', 'sub1', '--entry', entry, '--decision', 'approve');
  assert.notEqual(self.status, 0);
  assert.match(self.err, /ROLE_REQUIRED|CONFLICT/);
  const published = cli('publish', '--dir', repo, '--key', keys.out.privateKeyFile);
  assert.equal(published.status, 0, published.err);
  assert.equal(published.out.sequence, 1);
  const verified = cli('verify', '--file', published.out.file, '--public-key', keys.out.publicKeyFile, '--list-id', 'cli-list');
  assert.equal(verified.out.valid, true);
  assert.equal(verified.out.payloadSha256, published.out.payloadSha256);
  // Tampering with the hosted file is detected by the same verifier subscribers use.
  const hosted = JSON.parse(readFileSync(published.out.file, 'utf8'));
  hosted.payload = hosted.payload.replace('malware', 'malwarx');
  writeFileSync(join(dir, 'tampered.json'), JSON.stringify(hosted));
  assert.notEqual(cli('verify', '--file', join(dir, 'tampered.json'), '--public-key', keys.out.publicKeyFile).status, 0);
  assert.equal(cli('status', '--dir', repo).out.byStatus.accepted, 1);
  assert.equal(cli('publish', '--dir', repo, '--key', keys.out.privateKeyFile).out.sequence, 2);
});
