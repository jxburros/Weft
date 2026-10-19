import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { decodePng, encodePng } from '../src/png.js';
import { detectSensitive, redactText } from '../src/redaction.js';
import { componentPath } from '../src/components.js';
import { fakeEndpoint, modelFixture } from './model-test-helpers.js';

const SECRET = 'zebracodeword';
const human = { actor: 'human', source: 'gui' };

/** 8x6 RGBA screenshot: white, with a red "secret" block at (2,1)-(5,3), plus a tEXt chunk carrying the secret. */
function screenshot() {
  const width = 8, height = 6, data = Buffer.alloc(width * height * 4, 255);
  for (let y = 1; y < 4; y++) for (let x = 2; x < 6; x++) data.set([220, 0, 0, 255], (y * width + x) * 4);
  const encoded = encodePng({ width, height, data });
  const body = Buffer.concat([Buffer.from('Comment\0'), Buffer.from(`card ${SECRET}`)]);
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write('tEXt', 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0);
  // Insert the ancillary chunk right after IHDR (8 + 25 bytes).
  return Buffer.concat([encoded.subarray(0, 33), head, body, crc, encoded.subarray(33)]);
}
const pageText = `Order for alice@example.com. Card 4111 1111 1111 1111 charged. Internal code ${SECRET} approved. Call +1 415 555 0134.`;

function profileBytes(directory) {
  return Buffer.concat(readdirSync(directory).filter(name => name.startsWith('workspace.sqlite')).map(name => readFileSync(join(directory, name))));
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-redaction-'));
  const workspace = new WorkspaceService({ directory });
  const browser = { tabs: new Map(), execute: async () => { throw new Error('No browser in this fixture'); } };
  const dispatch = createDispatcher({ workspace, browser, providers: { close() {}, execute() { throw new Error('unexpected'); } }, admission: new AutomationAdmission() });
  t.after(() => { workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  const created = await workspace.execute('artifacts.create', { title: 'Checkout receipt', text: pageText, pngBase64: screenshot().toString('base64'),
    url: 'https://shop.example/users/alice@example.com/orders?order=991&session=abc&email=alice%40example.com' });
  const original = workspace.data.artifacts[0].versions[0];
  return { directory, workspace, dispatch, artifactId: created.id, originalId: original.id };
}

test('detection assistance finds common formats, masks previews and never claims completeness', () => {
  const found = detectSensitive(pageText);
  assert.deepEqual(found.map(item => item.kind), ['email', 'payment-card', 'phone']);
  assert.equal(JSON.stringify(found).includes('alice@example.com'), false, 'previews are masked');
  assert.equal(detectSensitive('Card 4111 1111 1111 1112').some(item => item.kind === 'payment-card'), false, 'numbers failing the Luhn check are not cards');
  const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'a'.repeat(20)}`;
  assert.deepEqual(detectSensitive(`token ${jwt} key sk-live-${'x'.repeat(24)}`).map(item => item.kind), ['jwt', 'api-key']);
  const { text, redactions, unmatched } = redactText(pageText, [{ literal: SECRET, label: 'codeword' }, { pattern: 'ali\\w+@', flags: 'i' }, { literal: 'not present' }]);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes('alice@'), false);
  assert.deepEqual(unmatched, [2]);
  assert.equal(JSON.stringify(redactions).includes(SECRET), false, 'redaction metadata never contains removed text or selectors');
  assert.throws(() => redactText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', [{ pattern: '(a+)+$' }]), /too long|failed/, 'pathological patterns are bounded');
});

test('case-insensitive literal redaction keeps offsets when case mapping changes length', () => {
  const cases = [
    // İ lowercases to two code units; spans after it must not shift.
    ['İİİ token SECRET123 end', 'secret123', 'İİİ token [REDACTED] end'],
    // ẞ and ß fold to "ss" on both sides of the match.
    ['ẞtraße and STRASSE end', 'strasse', '[REDACTED] and [REDACTED] end'],
    // A ligature inside the secret is covered whole.
    ['ﬁle-key FILE-KEY end', 'file-key', '[REDACTED] [REDACTED] end'],
    // A length-changing character inside the match is removed, not partly kept.
    ['x İstanbul y', 'i̇stanbul', 'x [REDACTED] y']
  ];
  for (const [text, literal, expected] of cases) {
    const result = redactText(text, [{ literal, caseSensitive: false }]);
    assert.equal(result.text, expected, text);
    assert.deepEqual(result.unmatched, []);
  }
  // Case-sensitive matching is unchanged.
  assert.equal(redactText('Secret secret', [{ literal: 'secret' }]).text, 'Secret [REDACTED]');
});

test('PNG redaction replaces pixels and drops ancillary chunks', () => {
  const source = screenshot();
  assert.ok(source.includes(Buffer.from(SECRET)));
  const image = decodePng(source);
  assert.equal(image.width, 8);
  assert.deepEqual([...image.data.subarray((1 * 8 + 2) * 4, (1 * 8 + 2) * 4 + 4)], [220, 0, 0, 255]);
  const again = decodePng(encodePng(image));
  assert.deepEqual(again.data, image.data, 'round trip is lossless');
  assert.equal(encodePng(image).includes(Buffer.from(SECRET)), false, 'text chunks are not re-encoded');
});

test('a sanitized derivative removes text, pixels and metadata; restricted originals are withheld from agents, search and exports', async t => {
  const f = await fixture(t);
  const { workspace, dispatch, artifactId, originalId } = f;
  // Review: URL path/query metadata and masked detection-assistance matches.
  const review = await workspace.execute('artifacts.review', { id: artifactId, versionId: originalId });
  assert.ok(review.findings.some(item => item.kind === 'url-path' && item.severity === 'high'));
  assert.ok(review.findings.some(item => item.kind === 'url-query' && item.parameter === 'email'));
  assert.deepEqual(review.textFindings.map(item => item.kind), ['email', 'payment-card', 'phone']);
  assert.equal(JSON.stringify(review).includes('alice@example.com'), false);
  assert.match(review.scope, /assistance only/);
  assert.match(review.image, /not inspected/);

  const selection = { id: artifactId, versionId: originalId, text: [{ literal: SECRET, label: 'codeword' }, { detector: 'email' }, { detector: 'payment-card' }, { detector: 'phone' }],
    regions: [{ x: 2, y: 1, width: 4, height: 3, label: 'card image' }] };
  const preview = await workspace.execute('artifacts.redact', { ...selection, preview: true });
  assert.equal(preview.saved, false);
  assert.equal(workspace.data.artifacts[0].versions.length, 1, 'preview saves nothing');
  assert.equal(preview.text.includes(SECRET), false);

  const result = await workspace.execute('artifacts.redact', selection);
  const derivativeId = result.derivative.versionId;
  assert.equal(result.derivative.redactions, 5);
  const derivative = await workspace.execute('artifacts.get', { id: artifactId, versionId: derivativeId });
  for (const value of [SECRET, 'alice@example.com', '4111', '555 0134']) assert.equal(derivative.text.includes(value), false, value);
  // origin-path drops the query by default; the email selector also matched the path, so only the origin is kept.
  assert.equal(derivative.url, 'https://shop.example');
  assert.equal(derivative.derivedFrom, originalId);
  assert.equal(derivative.redactionStatus, 'redacted');
  const pixels = decodePng(Buffer.from(derivative.pngBase64, 'base64'));
  for (let y = 1; y < 4; y++) for (let x = 2; x < 6; x++) assert.deepEqual([...pixels.data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)], [0, 0, 0, 255]);
  assert.deepEqual([...pixels.data.subarray(0, 4)], [255, 255, 255, 255], 'pixels outside regions are unchanged');
  assert.equal(Buffer.from(derivative.pngBase64, 'base64').includes(Buffer.from(SECRET)), false, 'no hidden PNG text chunk');
  const metadata = JSON.stringify({ ...derivative, text: undefined, pngBase64: undefined });
  assert.equal(metadata.includes(SECRET) || metadata.includes('alice@example.com'.replace('alice', 'x')) || metadata.includes('4111'), false, 'redaction metadata holds labels and positions only');
  assert.deepEqual(derivative.redactions.filter(item => item.type === 'region').map(({ x, y, width, height }) => [x, y, width, height]), [[2, 1, 4, 3]]);

  // Before restriction the original is still an ordinary version (separate access decision).
  assert.ok((await workspace.execute('search.query', { query: SECRET })).some(hit => hit.versionId === originalId));
  assert.equal((await dispatch('artifacts.get', { id: artifactId, versionId: originalId })).result.text, pageText);
  assert.ok(profileBytes(f.directory).includes(Buffer.from(SECRET)), 'the search index held the original text before restriction');
  // Restricting the original is human administration.
  assert.equal((await dispatch('artifacts.setAccess', { id: artifactId, versionId: originalId, access: 'restricted' })).error.code, 'permission_required');
  assert.equal((await dispatch('artifacts.setAccess', { id: artifactId, versionId: originalId, access: 'restricted' }, human)).error, null);

  // Search index and on-disk database no longer hold the removed text.
  assert.deepEqual(await workspace.execute('search.query', { query: SECRET }), []);
  assert.equal(profileBytes(f.directory).includes(Buffer.from(SECRET)), false, 'secure delete leaves no index residue in the database or WAL');

  // Agents (REST/CLI/MCP all use this dispatcher) see a withheld stub everywhere.
  const agentGet = await dispatch('artifacts.get', { id: artifactId, versionId: originalId });
  assert.equal(agentGet.result.withheld, 'restricted_original');
  assert.deepEqual(agentGet.result.derivatives, [derivativeId]);
  for (const command of ['artifacts.list', 'workspace.snapshot']) {
    const outcome = await dispatch(command, {});
    const serialized = JSON.stringify(outcome.result);
    assert.equal(serialized.includes(SECRET) || serialized.includes('alice%40example.com') || serialized.includes('session=abc'), false, command);
  }
  const whole = JSON.stringify((await dispatch('artifacts.get', { id: artifactId })).result);
  assert.equal(whole.includes(SECRET), false);
  assert.ok(whole.includes('[REDACTED]'), 'the derivative stays readable');
  for (const command of ['artifacts.review', 'artifacts.compare']) {
    const args = command === 'artifacts.review' ? { id: artifactId, versionId: originalId } : { id: artifactId, fromVersionId: originalId, toVersionId: derivativeId };
    assert.equal((await dispatch(command, args)).error.details.authority.reason, 'restricted_original', command);
  }
  assert.equal((await dispatch('artifacts.redact', { id: artifactId, versionId: originalId, text: [] })).error.code, 'permission_required');

  // Raw original access: an exact one-time human approval per read; never standing; model readers never.
  const first = await dispatch('artifacts.readOriginal', { id: artifactId, versionId: originalId });
  assert.equal(first.error.code, 'approval_required');
  const approvalId = first.error.details.authority.approvalId;
  assert.equal((await dispatch('approvals.approve', { id: approvalId, mode: 'standing' }, human)).error.code, 'permission_required');
  assert.equal((await dispatch('approvals.approve', { id: approvalId, mode: 'once' }, human)).error, null);
  const approved = await dispatch('artifacts.readOriginal', { id: artifactId, versionId: originalId });
  assert.equal(approved.result.text, pageText);
  assert.equal((await dispatch('artifacts.readOriginal', { id: artifactId, versionId: originalId })).error.code, 'approval_required', 'one approval covers one read');
  await assert.rejects(workspace.execute('artifacts.readOriginal', { id: artifactId, versionId: originalId }, { actor: 'model-reader' }), /PERMISSION_REQUIRED/);
  assert.equal((await workspace.execute('artifacts.get', { id: artifactId, versionId: originalId }, { actor: 'model-reader' })).text, undefined);
  const modelOutcome = await dispatch('artifacts.readOriginal', { id: artifactId, versionId: originalId }, { actor: 'model-reader', source: 'model', workspaceIds: [workspace.activeWorkspaceId] });
  assert.equal(modelOutcome.error.details.authority.reason, 'observe_only');

  // Exports: restricted originals excluded by default and explained; derivatives-only; 'all' is an explicit human choice.
  const exported = await workspace.execute('workspaces.export', { id: workspace.activeWorkspaceId, sensitiveTerms: [SECRET], reviewMetadata: true });
  const serialized = JSON.stringify(exported);
  assert.equal(serialized.includes(SECRET), false);
  assert.deepEqual(exported.excludedContent, [{ collection: 'artifacts', id: artifactId, versionId: originalId, number: 1, reason: 'restricted original' }]);
  assert.equal(exported.artifacts[0].versions.length, 1);
  assert.notEqual(exported.residueScan.status, 'found');
  assert.ok(exported.linkedSourcesNotIncluded.items.some(item => item.kind === 'live page'));
  assert.match(exported.metadataReview.scope, /assistance only/);
  const everything = await workspace.execute('workspaces.export', { id: workspace.activeWorkspaceId, captures: 'all', sensitiveTerms: [SECRET] });
  assert.equal(everything.residueScan.status, 'found');
  await workspace.execute('artifacts.create', { title: 'Unreviewed', text: 'plain capture' });
  const derivativesOnly = await workspace.execute('workspaces.export', { id: workspace.activeWorkspaceId, captures: 'derivatives-only' });
  assert.deepEqual(derivativesOnly.artifacts.map(item => item.versions.map(version => version.id)), [[derivativeId]]);
  assert.ok(derivativesOnly.excludedContent.some(item => item.reason === 'no exportable versions under this capture policy'));
  // The excluded original's derivative imports with its redaction metadata; the missing source is reported.
  const imported = await workspace.execute('workspaces.import', { data: exported });
  assert.ok(imported.importReport.lossy.some(item => item.field === 'versions.derivedFrom'));

  // Retention: purging the original removes its stored content; metadata and hashes remain.
  const textHash = workspace.data.artifacts.find(item => item.id === artifactId).versions[0].components.find(item => item.type === 'text/plain').sha256;
  assert.ok(existsSync(componentPath(join(f.directory, 'components'), textHash)));
  assert.equal((await dispatch('artifacts.purgeContent', { id: artifactId, versionId: originalId })).error.code, 'permission_required');
  const purged = (await dispatch('artifacts.purgeContent', { id: artifactId, versionId: originalId }, human)).result;
  assert.equal(purged.purged, true);
  assert.ok(purged.componentsDeleted >= 1);
  assert.equal(existsSync(componentPath(join(f.directory, 'components'), textHash)), false);
  const after = await workspace.execute('artifacts.readOriginal', { id: artifactId, versionId: originalId });
  assert.equal(after.text, undefined);
  assert.ok(after.purged);
  assert.equal((await workspace.execute('artifacts.verify', { id: artifactId })).status, 'verified');
});

test('model attachments send the sanitized derivative in place of a restricted original', async t => {
  const endpoint = await fakeEndpoint(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })); });
  const fixture = await modelFixture(t);
  const model = await fixture.save({ endpoint: `${endpoint.base}/v1`, capabilities: { images: true } });
  const created = await fixture.workspace.execute('artifacts.create', { title: 'Receipt', text: pageText, pngBase64: screenshot().toString('base64') });
  const originalId = fixture.workspace.data.artifacts.find(item => item.id === created.id).versions[0].id;
  const attachments = [{ kind: 'artifact', id: created.id, versionId: originalId }];
  await fixture.workspace.execute('artifacts.setAccess', { id: created.id, versionId: originalId, access: 'restricted' });
  const blocked = await fixture.preview(model.id, { attachments });
  const withheld = blocked.items.filter(item => item.kind === 'artifact');
  assert.deepEqual(withheld.map(item => item.delivery), ['unavailable'], 'no derivative yet: nothing from the capture is sent');
  assert.match(withheld[0].reason, /restricted original/);
  const { derivative } = await fixture.workspace.execute('artifacts.redact', { id: created.id, versionId: originalId, text: [{ literal: SECRET }], regions: [{ x: 2, y: 1, width: 4, height: 3 }] });
  const disclosure = await fixture.preview(model.id, { attachments });
  const image = disclosure.items.find(item => item.key.endsWith(':image'));
  assert.equal(image.regions.redacted, 1);
  await fixture.send(model.id, { attachments, disclosureAck: true });
  const body = JSON.stringify(endpoint.requests.at(-1).body);
  assert.equal(body.includes(SECRET), false, 'the original text never reaches the model');
  assert.ok(body.includes(derivative.versionId), 'provenance names the derivative that was sent');
  assert.ok(body.includes('substitutedFor'));
  const sent = decodePng(Buffer.from(/data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(body)[1], 'base64'));
  assert.deepEqual([...sent.data.subarray((1 * 8 + 2) * 4, (1 * 8 + 2) * 4 + 4)], [0, 0, 0, 255], 'redacted pixels are what the model receives');
});
