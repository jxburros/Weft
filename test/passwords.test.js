import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { commands } from '../src/commands.js';
import { closeAfter, closeQuietly, tempDirectory } from './temp-profile.js';
import { PasswordService, generatePassword, importRows, parseCsv } from '../src/passwords.js';

const human = { actor: 'human', source: 'gui' };
const protector = { status: () => ({ available: true, backend: 'test', protected: true }), wrap: text => Buffer.from(`wrapped:${text}`), unwrap: bytes => Buffer.from(bytes).toString().slice(8) };

function fixture(t, options = {}) {
  const directory = tempDirectory(t, 'weft-passwords-');
  const workspace = closeAfter(t, new WorkspaceService({ directory: join(directory, 'records') }), closeQuietly);
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const browser = new Browser({ session, workspaceService: workspace, admission: new AutomationAdmission(), electronApi: {} });
  const audits = [];
  const passwords = new PasswordService({ directory: join(directory, 'passwords'), protector, browser, workspace, audit: entry => audits.push(entry), confirmReveal: async () => true, ...options });
  browser.tabs.set(1, { id: 1, workspaceId: workspace.activeWorkspaceId, version: 1, controller: 'available',
    view: { webContents: { getURL: () => 'https://example.com/', getTitle: () => 'Fixture', stop: () => {}, isDestroyed: () => false, close: () => {} } } });
  browser.activeId = 1;
  const dispatch = createDispatcher({ workspace, browser, admission: browser.admission });
  return { directory, workspace, browser, passwords, dispatch, audits };
}

test('every saved-password command is human-only administration; agents and model tools are refused', async t => {
  const { dispatch, passwords, workspace } = fixture(t);
  for (const name of Object.keys(commands).filter(item => item.startsWith('passwords.'))) {
    assert.equal(commands[name].humanOnly, true, name);
    assert.equal(commands[name].actionClass, name === 'passwords.list' ? 'local_read' : 'administration', name);
  }
  const saved = await dispatch('passwords.save', { origin: 'https://example.com', username: 'alice', password: 'correct horse' }, human);
  assert.equal(saved.error, null);
  for (const context of [{ actor: 'automation', source: 'api' }, { actor: 'model-reader', source: 'model', workspaceIds: [workspace.activeWorkspaceId] }]) {
    for (const [name, args] of [['passwords.list', {}], ['passwords.reveal', { id: saved.result.entry.id }], ['passwords.fill', { id: saved.result.entry.id, tabId: 1 }]]) {
      const outcome = await dispatch(name, args, context);
      assert.ok(outcome.error, `${name} refused for ${context.actor}`);
      assert.ok(['permission_required', 'human_required'].includes(outcome.error.code), outcome.error.code);
      assert.doesNotMatch(JSON.stringify(outcome), /correct horse/);
    }
  }
  await assert.rejects(passwords.execute('passwords.list', {}, { actor: 'automation' }), /only to the person/);
});

test('the vault seals entries under an OS-protected key and refuses to save without one', async t => {
  const { passwords, directory, workspace } = fixture(t);
  const workspaceId = workspace.activeWorkspaceId;
  await passwords.execute('passwords.save', { origin: 'https://example.com', username: 'alice', password: 'hunter2-secret' }, human);
  const raw = readFileSync(join(directory, 'passwords', 'vault.json'), 'utf8');
  assert.doesNotMatch(raw, /hunter2-secret|alice/);
  const listed = await passwords.execute('passwords.list', {}, human);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].username, 'alice');
  assert.doesNotMatch(JSON.stringify(listed), /hunter2/);
  const revealed = await passwords.execute('passwords.reveal', { id: listed.entries[0].id }, human);
  assert.equal(revealed.password, 'hunter2-secret');
  // Reopening with the same OS key decrypts; a tampered entry fails authentication.
  const reopened = new PasswordService({ directory: join(directory, 'passwords'), protector });
  assert.equal((await reopened.execute('passwords.list', { workspaceId }, human)).entries[0].username, 'alice');
  reopened.vault.entries[0].origin = 'https://evil.example';
  assert.throws(() => reopened.open(reopened.vault.entries[0]));
  const unprotected = new PasswordService({ directory: join(directory, 'other'), protector: { status: () => ({ protected: false, backend: 'basic_text' }) } });
  await assert.rejects(unprotected.execute('passwords.save', { origin: 'https://example.com', username: 'a', password: 'b' }, human), error => error.code === 'unavailable');
  const declined = new PasswordService({ directory: join(directory, 'passwords'), protector, confirmReveal: async () => false });
  await assert.rejects(declined.execute('passwords.reveal', { id: listed.entries[0].id }, human), error => error.code === 'cancelled');
});

test('save offers follow a submitted sign-in: save, update when the password changed, never for a site', async t => {
  const { passwords, browser, workspace, audits } = fixture(t);
  const prompts = [];
  browser.onSitePrompt = notice => prompts.push(notice);
  const tab = { id: 7, workspaceId: workspace.activeWorkspaceId, url: 'https://login.example/signin', view: { webContents: { getURL: () => 'https://login.example/signin' } } };
  const offer = await passwords.offer(tab, { origin: 'https://login.example', username: 'bob', password: 'first-pass' });
  assert.equal(offer.kind, 'save');
  assert.deepEqual(Object.keys(passwords.offerFor(7)).sort(), ['expiresAt', 'id', 'kind', 'origin', 'username']);
  assert.equal(prompts.length, 1);
  await passwords.execute('passwords.respondOffer', { offerId: offer.id, action: 'save' }, human);
  assert.equal(await passwords.offer(tab, { origin: 'https://login.example', username: 'bob', password: 'first-pass' }), null, 'unchanged sign-in is not offered again');
  const update = await passwords.offer(tab, { origin: 'https://login.example', username: 'bob', password: 'second-pass' });
  assert.equal(update.kind, 'update');
  await passwords.execute('passwords.respondOffer', { offerId: update.id, action: 'save' }, human);
  const [entry] = (await passwords.execute('passwords.list', {}, human)).entries;
  assert.equal((await passwords.execute('passwords.reveal', { id: entry.id }, human)).password, 'second-pass');
  // A candidate from another origin than the tab's page is ignored.
  assert.equal(await passwords.offer(tab, { origin: 'https://other.example', username: 'x', password: 'y' }), null);
  const never = await passwords.offer({ ...tab, id: 8, url: 'https://nosave.example/', view: { webContents: { getURL: () => 'https://nosave.example/' } } }, { origin: 'https://nosave.example', username: 'c', password: 'd' });
  await passwords.execute('passwords.respondOffer', { offerId: never.id, action: 'never' }, human);
  assert.equal(await passwords.offer({ ...tab, id: 8, url: 'https://nosave.example/', view: { webContents: { getURL: () => 'https://nosave.example/' } } }, { origin: 'https://nosave.example', username: 'c', password: 'e' }), null);
  assert.ok(audits.length && audits.every(item => !/first-pass|second-pass|bob/.test(JSON.stringify(item))), 'activity holds origins and actions only');
});

test('entries are per workspace unless explicitly shared', async t => {
  const { passwords, workspace } = fixture(t);
  const first = workspace.activeWorkspaceId;
  const other = await workspace.execute('workspaces.create', { name: 'Other' }, human);
  const { entry } = await passwords.execute('passwords.save', { workspaceId: first, origin: 'https://example.com', username: 'alice', password: 'p' }, human);
  assert.equal((await passwords.execute('passwords.list', { workspaceId: other.id }, human)).entries.length, 0);
  await passwords.execute('passwords.update', { id: entry.id, changes: { sharedWith: [other.id] } }, human);
  const shared = (await passwords.execute('passwords.list', { workspaceId: other.id }, human)).entries;
  assert.equal(shared.length, 1);
  assert.equal(shared[0].shared, true);
});

test('CSV import reads Chrome, Firefox and Safari exports, can delete the source, and export writes a private file', async t => {
  const { passwords, directory } = fixture(t);
  assert.deepEqual(parseCsv('a,"b,""c"""\r\nd,e\n'), [['a', 'b,"c"'], ['d', 'e']]);
  assert.equal(importRows('name,url,username,password,note\nEx,https://ex.com/login,al,pw1,\n').entries[0].origin, 'https://ex.com');
  assert.equal(importRows('"url","username","password","httpRealm"\n"https://fx.example:8443/a","u","pw2",""\n').entries[0].origin, 'https://fx.example:8443');
  assert.equal(importRows('Title,URL,Username,Password,Notes,OTPAuth\nS,https://safari.example/,s,pw3,,\n').entries[0].username, 's');
  assert.equal(importRows('url,username,password\nftp://x/,a,b\n').skipped, 1);
  assert.throws(() => importRows('a,b\n1,2\n'), /url and password/);
  const source = join(directory, 'export.csv');
  writeFileSync(source, 'name,url,username,password,note\nA,https://a.example/,ann,pa,\nB,https://b.example/,ben,pb,\n');
  const result = await passwords.execute('passwords.import', { path: source, deleteSource: true }, human);
  assert.deepEqual([result.imported, result.updated, result.skipped, existsSync(source)], [2, 0, 0, false]);
  const out = join(directory, 'out.csv');
  await assert.rejects(passwords.execute('passwords.export', { path: out }, human));
  await passwords.execute('passwords.export', { path: out, acknowledgePlaintext: true }, human);
  assert.match(readFileSync(out, 'utf8'), /https:\/\/a\.example,ann,pa/);
  await assert.rejects(passwords.execute('passwords.export', { path: out, acknowledgePlaintext: true }, human), /EEXIST/, 'never overwrites');
});

test('generated passwords are long and mix character classes', () => {
  for (let i = 0; i < 20; i++) {
    const value = generatePassword(20);
    assert.equal(value.length, 20);
    assert.match(value, /[A-Z]/); assert.match(value, /[a-z]/); assert.match(value, /[2-9]/); assert.match(value, /[-_.!@#%]/);
  }
});
