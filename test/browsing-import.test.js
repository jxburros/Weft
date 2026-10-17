import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { createDispatcher } from '../src/dispatch.js';
import { AutomationAdmission } from '../src/admission.js';
import { discoverSources, readSource, NEVER_IMPORTED } from '../src/browsing-import.js';
import { chromiumProfile, firefoxProfile, netscapeFile } from './fixtures/browsing-data.mjs';

const human = { actor: 'human', source: 'gui' };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'weft-browsing-home-'));
  const directory = mkdtempSync(join(tmpdir(), 'weft-browsing-store-'));
  const workspace = new WorkspaceService({ directory });
  const browser = { tabs: new Map(), downloads: new Map(), activeId: null, tab() { throw new Error('Tab not found'); }, execute() { throw new Error('unexpected'); } };
  const dispatch = createDispatcher({ workspace, browser, admission: new AutomationAdmission(), providers: { close() {} } });
  t.after(() => { workspace.close(); rmSync(home, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); });
  return { home, directory, workspace, dispatch };
}

test('discovery lists Chromium-family and Firefox profiles with what can be imported, without reading them', t => {
  const { home } = setup(t);
  chromiumProfile(home);
  chromiumProfile(home, { browserRoot: '.config/BraveSoftware/Brave-Browser', profile: 'Profile 2', name: 'Brave personal' });
  firefoxProfile(home);
  const found = discoverSources({ home, platform: 'linux', env: {} });
  assert.deepEqual(found.sources.map(source => [source.kind, source.browser, source.profile]).sort(), [
    ['chromium', 'Brave', 'Brave personal'], ['chromium', 'Google Chrome', 'Work person'], ['firefox', 'Firefox', 'default-release']]);
  assert.deepEqual(found.sources.find(source => source.kind === 'firefox').data, { bookmarks: true, history: true, containers: true });
  assert.deepEqual(found.neverImported, NEVER_IMPORTED);
  assert.ok(NEVER_IMPORTED.some(item => /Passwords/.test(item)) && NEVER_IMPORTED.some(item => /Cookies/.test(item)) && NEVER_IMPORTED.some(item => /sessions/i.test(item)) && NEVER_IMPORTED.some(item => /Autofill/.test(item)));
});

test('Chromium preview reports folders, duplicates, unsupported fields and skipped secret-bearing URLs, then imports exactly what was previewed', async t => {
  const { home, workspace, dispatch } = setup(t);
  const path = chromiumProfile(home);
  const historyBefore = hash(join(path, 'History'));
  const mtime = statSync(join(path, 'History')).mtimeMs;
  await dispatch('bookmarks.create', { title: 'Already here', url: 'https://existing.example.com/' }, human);
  const previewOutcome = await dispatch('browsingData.preview', { kind: 'chromium', path }, human);
  assert.equal(previewOutcome.error, null, JSON.stringify(previewOutcome.error));
  const preview = previewOutcome.result;
  assert.equal(preview.source.profile, 'Work person');
  assert.equal(preview.bookmarks.found, 4);
  assert.equal(preview.bookmarks.new, 2);
  assert.equal(preview.bookmarks.duplicates, 2, 'one repeated in the source, one already in the workspace');
  assert.ok(preview.bookmarks.folders.includes('Bookmarks bar / Research'));
  const paper = preview.bookmarks.sample.find(item => item.title === 'Paper');
  assert.equal(paper.url, 'https://papers.example.org/1?page=2', 'sensitive URL parameters are removed');
  assert.deepEqual(preview.skipped.map(item => item.reason).sort(), ['URL contains credentials (never imported)', 'unsupported scheme file:', 'unsupported scheme javascript:']);
  assert.ok(preview.unsupported.some(item => item.field === 'bookmark.meta_info'));
  assert.ok(preview.unsupported.some(item => item.field === 'url.sensitiveParametersRemoved'));
  assert.equal(preview.history.found, 2, 'hidden and non-web entries are excluded');
  assert.deepEqual(preview.source.filesRead, ['Bookmarks', 'History', 'History-wal', '../Local State']);
  assert.match(preview.disclosure, /sign in again/);
  assert.equal(hash(join(path, 'History')), historyBefore, 'the browser database is copied, never modified');
  assert.equal(statSync(join(path, 'History')).mtimeMs, mtime);
  // A changed source after preview is refused.
  const stale = await dispatch('browsingData.import', { kind: 'chromium', path, previewDigest: '0'.repeat(64) }, human);
  assert.equal(stale.error.code, 'stale_state');
  const result = (await dispatch('browsingData.import', { kind: 'chromium', path, previewDigest: preview.previewDigest }, human)).result;
  assert.deepEqual(result.imported, { bookmarks: 2, history: 2 });
  assert.equal(result.skipped.duplicateBookmarks, 2);
  const bookmarks = (await dispatch('bookmarks.list', {}, human)).result;
  assert.equal(bookmarks.length, 3);
  const docs = bookmarks.find(item => item.url === 'https://docs.example.com/guide');
  assert.match(docs.note, /Folder: Bookmarks bar/);
  assert.deepEqual(docs.tags, ['imported-bookmark']);
  const visits = (await dispatch('history.list', {}, human)).result;
  assert.ok(visits.some(visit => visit.url === 'https://news.example.com/today' && visit.visitedAt === '2026-03-02T10:00:00.000Z'));
  // Nothing secret-like reached the workspace.
  assert.doesNotMatch(JSON.stringify(workspace.data), /SECRET-SENTINEL|secret-value|user:pass/);
  // Importing the same source again finds only duplicates.
  const again = (await dispatch('browsingData.preview', { kind: 'chromium', path }, human)).result;
  assert.equal(again.bookmarks.new, 0);
  assert.equal(again.history.new, 0);
});

test('Firefox preview lists containers and excludes tags and keywords; bookmark HTML keeps folders', async t => {
  const { home, directory, dispatch } = setup(t);
  const path = firefoxProfile(home);
  const preview = (await dispatch('browsingData.preview', { kind: 'firefox', path }, human)).result;
  assert.deepEqual(preview.containers.map(item => item.name), ['userContextPersonal.label', 'Work']);
  assert.ok(preview.notes.some(note => /cannot be separated by container/.test(note)));
  assert.deepEqual(preview.bookmarks.sample.map(item => [item.title, item.folder.join(' / ')]).sort(), [['Cart', 'menu'], ['Reference docs', 'toolbar / Reading']]);
  assert.deepEqual(preview.unsupported.map(item => item.field).sort(), ['firefox.keywords', 'firefox.tags']);
  assert.equal(preview.history.found, 2);
  const html = netscapeFile(directory);
  const file = (await dispatch('browsingData.preview', { kind: 'netscape-html', path: html }, human)).result;
  assert.equal(file.bookmarks.found, 3);
  assert.equal(file.bookmarks.duplicates, 1);
  assert.deepEqual(file.bookmarks.sample[0], { title: 'Blog <post>', url: 'https://blog.example.com/post?a=1&b=2', folder: ['Toolbar & more'], addedAt: '2023-11-14T22:15:00.000Z', duplicate: null });
  assert.deepEqual(file.unsupported.map(item => item.field).sort(), ['html.icon', 'html.shortcuturl', 'html.tags']);
  assert.ok(file.skipped.some(item => item.reason === 'unsupported scheme place:'));
  assert.ok(file.notes.some(note => /no browsing history/.test(note)));
  const imported = (await dispatch('browsingData.import', { kind: 'netscape-html', path: html, previewDigest: file.previewDigest, skipDuplicates: false }, human)).result;
  assert.equal(imported.imported.bookmarks, 3, 'duplicates may be kept when the person chooses');
});

test('browsing-data import is human-only and refuses links, wrong file types and non-export HTML', async t => {
  const { home, directory, dispatch } = setup(t);
  const path = chromiumProfile(home);
  for (const command of ['browsingData.sources', 'browsingData.preview']) {
    const outcome = await dispatch(command, command === 'browsingData.sources' ? {} : { kind: 'chromium', path });
    assert.equal(outcome.error.code, 'permission_required', command);
    assert.equal(outcome.error.details.authority.reason, 'human_only');
  }
  const text = join(directory, 'notes.txt');
  writeFileSync(text, 'hello');
  assert.equal((await dispatch('browsingData.preview', { kind: 'netscape-html', path: text }, human)).error.code, 'invalid_arguments');
  const fake = join(directory, 'fake.html');
  writeFileSync(fake, '<html><a href="https://x.example">x</a></html>');
  assert.match((await dispatch('browsingData.preview', { kind: 'netscape-html', path: fake }, human)).error.message, /Netscape/);
  assert.equal((await dispatch('browsingData.preview', { kind: 'firefox', path: join(home, 'missing') }, human)).error.code, 'not_found');
  // Only allowlisted files are read: a profile with nothing but secret files yields nothing.
  const empty = mkdtempSync(join(tmpdir(), 'weft-secret-only-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  for (const file of ['Login Data', 'Cookies', 'Web Data']) writeFileSync(join(empty, file), 'SECRET-SENTINEL');
  const nothing = readSource({ kind: 'chromium', path: empty, include: ['bookmarks', 'history'] });
  assert.deepEqual([nothing.bookmarks.length, nothing.history.length], [0, 0]);
});
