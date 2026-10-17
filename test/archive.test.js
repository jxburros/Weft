import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { buildArchive, diffResources, diffText, parseMhtml } from '../src/archive.js';
import { componentPath } from '../src/components.js';
import { encodePng } from '../src/png.js';

const ORIGIN = 'http://127.0.0.1:4100';
const qp = text => Buffer.from(text, 'utf8').toString('latin1').replace(/[=\u0080-ÿ]/g, char => `=${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).replace(/(.{70})/g, '$1=\r\n');
/** A Chromium-style MHTML file: quoted-printable HTML parts, base64 binary parts, a frame referenced by cid:. */
function mhtml({ heading = 'Prices today', price = '42', image = Buffer.from('fake-image-bytes'), large = null } = {}) {
  const boundary = '----MultipartBoundary--fixture----';
  const part = (headers, body) => `--${boundary}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n${body}\r\n`;
  const html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>Shop é</title><link rel="stylesheet" href="${ORIGIN}/style.css"></head><body><h1>${heading}</h1><p>Price ${price}</p><img src="${ORIGIN}/logo.png"><img src="${ORIGIN}/missing.png"><input type="password" name="pw" value="pw-secret-1"><input type="hidden" name="csrf" value="csrf-token-2"><input name="q" value="visible query"><textarea autocomplete="one-time-code">otp-secret-3</textarea><iframe src="cid:frame-1@mhtml.blink"></iframe></body></html>`;
  return Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${ORIGIN}/\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related;\r\n\ttype="text/html";\r\n\tboundary="${boundary}"\r\n\r\n\r\n`
    + part({ 'Content-Type': 'text/html', 'Content-ID': '<frame-0@mhtml.blink>', 'Content-Transfer-Encoding': 'quoted-printable', 'Content-Location': `${ORIGIN}/` }, qp(html))
    + part({ 'Content-Type': 'image/png', 'Content-Transfer-Encoding': 'base64', 'Content-Location': `${ORIGIN}/logo.png` }, image.toString('base64').replace(/(.{76})/g, '$1\r\n'))
    + part({ 'Content-Type': 'text/css', 'Content-Transfer-Encoding': 'quoted-printable', 'Content-Location': `${ORIGIN}/style.css` }, 'h1 { color: red; }')
    + (large ? part({ 'Content-Type': 'video/mp4', 'Content-Transfer-Encoding': 'base64', 'Content-Location': `${ORIGIN}/movie.mp4` }, large.toString('base64')) : '')
    + part({ 'Content-Type': 'text/html', 'Content-ID': '<frame-1@mhtml.blink>', 'Content-Transfer-Encoding': 'quoted-printable', 'Content-Location': `${ORIGIN}/frame` }, '<html><body><p>Frame text</p></body></html>')
    + `--${boundary}--\r\n`, 'latin1');
}
const references = [{ url: `${ORIGIN}/logo.png`, kind: 'image' }, { url: `${ORIGIN}/missing.png`, kind: 'image' }, { url: `${ORIGIN}/app.js`, kind: 'script' }, { url: `${ORIGIN}/never.png`, kind: 'image' }];
const resourceLog = [{ url: `${ORIGIN}/missing.png`, statusCode: 404, resourceType: 'image' }];

test('MHTML parts become a manifest with explicit missing, failed, script and oversized entries', () => {
  const parsed = parseMhtml(mhtml());
  assert.equal(parsed.parts.length, 4);
  assert.match(parsed.parts[0].bytes.toString('utf8'), /Shop é/);
  const archive = buildArchive({ mhtml: mhtml({ large: Buffer.alloc(5000, 1) }), references, resourceLog, limits: { maxResourceBytes: 4096 } });
  assert.equal(archive.resources[0].role, 'document');
  const html = Buffer.from(archive.resources[0].bodyBase64, 'base64').toString('utf8');
  for (const secret of ['pw-secret-1', 'csrf-token-2', 'otp-secret-3']) assert.equal(html.includes(secret), false, secret);
  assert.ok(html.includes('visible query'), 'ordinary field values are kept');
  assert.ok(html.includes('https://cid.weft-archive.invalid/frame-1%40mhtml.blink'), 'frame references point inside the archive');
  const byUrl = Object.fromEntries(archive.resources.map(item => [item.url, item]));
  assert.equal(byUrl[`${ORIGIN}/missing.png`].status, 'failed');
  assert.equal(byUrl[`${ORIGIN}/missing.png`].httpStatus, 404);
  assert.equal(byUrl[`${ORIGIN}/never.png`].status, 'missing');
  assert.equal(byUrl[`${ORIGIN}/app.js`].status, 'not-archived-script');
  assert.equal(byUrl[`${ORIGIN}/movie.mp4`].status, 'omitted-size');
  assert.equal(byUrl[`${ORIGIN}/movie.mp4`].bodyBase64, undefined);
  assert.equal(byUrl[`${ORIGIN}/frame`].role, 'frame');
  assert.equal(archive.complete, false);
  assert.deepEqual(archive.counts, { stored: 4, 'omitted-size': 1, failed: 1, 'not-archived-script': 1, missing: 1 });
});

test('text and resource diffs report additions, removals and changed bytes', () => {
  const diff = diffText('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual([diff.added, diff.removed], [2, 1]);
  assert.deepEqual(diff.hunks[0].lines.filter(line => line.op !== 'context').map(line => `${line.op}:${line.text}`), ['removed:b', 'added:B', 'added:e']);
  assert.equal(diffText('same', 'same').identical, true);
  const resources = diffResources([{ url: 'a', sha256: '1', status: 'stored' }, { url: 'b', sha256: '2', status: 'stored' }], [{ url: 'a', sha256: '9', status: 'stored' }, { url: 'c', status: 'missing' }]);
  assert.deepEqual(resources.totals, { added: 1, removed: 1, changed: 1, statusChanged: 0 });
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-archive-'));
  let page = { heading: 'Prices today', price: '42' };
  const previews = [];
  const white = encodePng({ width: 4, height: 4, data: Buffer.alloc(64, 255) });
  const browser = {
    // Stands in for Browser.captureArchive: the real Chromium path is covered by test/archive-browser.test.js.
    captureArtifact: async () => ({ url: `${ORIGIN}/`, title: 'Shop', text: `${page.heading}\nPrice ${page.price}`, pngBase64: (page.png ?? white).toString('base64'), navigationVersion: 3,
      archive: buildArchive({ mhtml: mhtml(page), references, resourceLog }), capture: { startedAt: new Date().toISOString(), durationMs: 12, readiness: { state: 'ready' }, originalUrl: `${ORIGIN}/`, finalUrl: `${ORIGIN}/`, stateChanges: [], complete: false, incomplete: ['resources-not-stored'] } }),
    openArchivePreview: async payload => { previews.push(payload); return { open: true }; },
    closeArchivePreview: () => ({ closed: true }),
  };
  const workspace = new WorkspaceService({ directory, browser });
  t.after(() => { workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, previews, setPage: next => { page = { ...page, ...next }; } };
}

test('archive versions are immutable, verifiable, comparable, previewable and portable', async t => {
  const f = fixture(t);
  const { workspace } = f;
  const first = await workspace.execute('artifacts.capture', { kind: 'archive', title: 'Shop' });
  const v1 = workspace.data.artifacts[0].versions[0];
  const got = await workspace.execute('artifacts.get', { id: first.id, versionId: v1.id });
  assert.equal(got.archive.resources.some(item => 'bodyBase64' in item), false, 'reads return the manifest, never inlined resource bodies');
  assert.ok(got.components.some(item => item.type === 'application/x-weft-archive-manifest'));
  assert.equal(got.capture.complete, false);
  assert.equal((await workspace.execute('artifacts.verify', { id: first.id })).status, 'verified');

  // Recapture after the page changed: a new immutable version; comparison shows text, resource and pixel changes.
  const black = encodePng({ width: 4, height: 4, data: Buffer.from(Array.from({ length: 16 }, (_, index) => index < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]).flat()) });
  f.setPage({ price: '45', image: Buffer.from('new-image-bytes'), png: black });
  await workspace.execute('artifacts.capture', { kind: 'archive', artifactId: first.id });
  const [a, b] = workspace.data.artifacts[0].versions;
  assert.equal(a.id, v1.id, 'the earlier version is unchanged');
  const comparison = await workspace.execute('artifacts.compare', { id: first.id, fromVersionId: a.id, toVersionId: b.id, diffImage: true });
  assert.equal(comparison.identical, false);
  assert.deepEqual(comparison.text.hunks.flatMap(hunk => hunk.lines).filter(line => line.op !== 'context').map(line => line.text), ['Price 42', 'Price 45']);
  assert.ok(comparison.resources.changed.some(item => item.url === `${ORIGIN}/logo.png`));
  assert.ok(comparison.resources.changed.some(item => item.url === `${ORIGIN}/`), 'the document itself changed');
  assert.equal(comparison.pixels.changedPixels, 4);
  assert.ok(comparison.pixels.diffPngBase64);

  // Inline export and import carry the archive with verified resource hashes; a damaged component makes the export fail instead of shipping it.
  const exported = await workspace.execute('workspaces.export', { id: workspace.activeWorkspaceId });
  assert.ok(exported.artifacts[0].versions[0].archive.resources[1].bodyBase64);
  const imported = await workspace.execute('workspaces.import', { data: exported });
  const copy = workspace.data.artifacts.find(item => item.workspaceId === imported.id);
  assert.equal((await workspace.execute('artifacts.verify', { id: copy.id })).status, 'verified');
  const tampered = structuredClone(exported);
  tampered.artifacts[0].versions[0].archive.resources[1].bodyBase64 = Buffer.from('other').toString('base64');
  await assert.rejects(workspace.execute('workspaces.import', { data: tampered }), /COMPONENT_INTEGRITY/);
  await workspace.execute('workspaces.switch', { id: exported.workspace.id });

  // Offline preview receives verified bytes only; a corrupted subresource is withheld and reported.
  const logo = b.archive.resources.find(item => item.url === `${ORIGIN}/logo.png`);
  writeFileSync(componentPath(join(f.directory, 'components'), logo.sha256), 'tampered');
  const verify = await workspace.execute('artifacts.verify', { id: first.id, versionId: b.id });
  assert.equal(verify.status, 'damaged');
  assert.deepEqual(verify.versions[0].components.filter(item => item.status !== 'verified').map(item => [item.component, item.status]), [[`${ORIGIN}/logo.png`, 'corrupt']]);
  assert.match(verify.scope, /do not prove/);
  const preview = await workspace.execute('artifacts.preview', { id: first.id, versionId: b.id });
  assert.deepEqual(preview.unavailable, [{ url: `${ORIGIN}/logo.png`, status: 'corrupt' }]);
  assert.equal(f.previews.at(-1).resources.some(item => item.url === `${ORIGIN}/logo.png`), false);
  assert.ok(f.previews.at(-1).resources.every(item => Buffer.isBuffer(item.bytes)));
  assert.equal(preview.notStored, 3, 'failed, missing and script entries are listed, not served');
  await assert.rejects(workspace.execute('artifacts.preview', { id: first.id, versionId: b.id }, { actor: 'automation' }), /PERMISSION_REQUIRED/);
  const documentHash = b.archive.resources[0].sha256;
  writeFileSync(componentPath(join(f.directory, 'components'), documentHash), 'tampered');
  await assert.rejects(workspace.execute('artifacts.preview', { id: first.id, versionId: b.id }), /COMPONENT_INTEGRITY/);
  await assert.rejects(workspace.execute('workspaces.export', { id: workspace.activeWorkspaceId }), /COMPONENT_INTEGRITY/);
});
