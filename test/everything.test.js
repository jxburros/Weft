import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { EVERYTHING_ID, ensureEverything } from '../src/everything.js';
import { ExternalOpener, externalItemsFromArgv, refusalFor } from '../src/external-open.js';
import { resolveCommandTargets } from '../src/admission.js';
import { commands } from '../src/commands.js';

function service(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-everything-'));
  const workspace = new WorkspaceService({ directory });
  t.after(() => { workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace };
}

test('Everything is built in and cannot be deleted, archived or renamed (#99)', async t => {
  const { workspace } = service(t);
  assert.notEqual(workspace.snapshot().workspaces[0].id, EVERYTHING_ID, 'callers that take the first listed workspace still reach a project');
  const everything = workspace.snapshot().workspaces.find(item => item.id === EVERYTHING_ID);
  assert.equal(everything.id, EVERYTHING_ID);
  assert.equal(everything.builtin, 'everything');
  assert.notEqual(workspace.activeWorkspaceId, EVERYTHING_ID, 'a new profile still opens on its own project workspace');
  await assert.rejects(workspace.execute('workspaces.delete', { id: EVERYTHING_ID }), /cannot be deleted/);
  await assert.rejects(workspace.execute('workspaces.archive', { id: EVERYTHING_ID }), /cannot be archived/);
  await assert.rejects(workspace.execute('workspaces.update', { id: EVERYTHING_ID, changes: { name: 'Inbox' } }), /cannot be renamed/);
  // Other details may change; the built-in identity stays.
  await workspace.execute('workspaces.update', { id: EVERYTHING_ID, changes: { description: 'Unfiled pages' } });
  assert.equal(workspace.workspace(EVERYTHING_ID).builtin, 'everything');
  // It is a normal workspace for records.
  const note = await workspace.execute('materials.create', { workspaceId: EVERYTHING_ID, title: 'Unfiled' });
  assert.equal(note.workspaceId, EVERYTHING_ID);
  // An exported copy of Everything imports as an ordinary project workspace.
  const exported = await workspace.execute('workspaces.export', { id: EVERYTHING_ID }, { actor: 'human' });
  const imported = await workspace.execute('workspaces.import', { data: exported.data ?? exported }, { actor: 'human' });
  assert.notEqual(imported.id, EVERYTHING_ID);
  assert.equal(imported.builtin, undefined);
});

test('stores created before Everything gain it once, with contents kept', () => {
  const data = { workspaces: [{ id: 'ws_a', name: 'Project' }] };
  assert.equal(ensureEverything(data, '2026-10-19T00:00:00.000Z'), true);
  assert.deepEqual(data.workspaces.map(item => item.id), ['ws_a', EVERYTHING_ID]);
  assert.equal(ensureEverything(data), false);
  // A hand-edited store gets its built-in identity back and Everything is not listed first.
  data.workspaces.reverse(); data.workspaces[0].archived = true; data.workspaces[0].name = 'Renamed';
  assert.equal(ensureEverything(data), true);
  assert.deepEqual(data.workspaces.map(item => item.id), ['ws_a', EVERYTHING_ID]);
  assert.equal(data.workspaces[1].archived, false);
  assert.equal(data.workspaces[1].name, 'Everything');
});

test('deleting a workspace can reopen its pages in Everything; moving materials and captures in and out of it', async t => {
  const { workspace } = service(t);
  const project = await workspace.execute('workspaces.create', { name: 'Trip' });
  const opened = [];
  const tabs = new Map([[7, { id: 7, workspaceId: project.id }], [8, { id: 8, workspaceId: project.id }]]);
  workspace.attachBrowser({ tabs, describe: tab => ({ url: tab.id === 7 ? 'https://example.com/plan' : 'about:blank', pinned: false, blocked: null }),
    newTab: async (url, workspaceId) => { opened.push([url, workspaceId]); return { id: 9 }; }, closeWorkspace() {}, switchWorkspace: async () => null });
  const material = await workspace.execute('materials.create', { workspaceId: EVERYTHING_ID, title: 'Hotel ideas' });
  const moved = await workspace.execute('workspaces.moveRecord', { collection: 'materials', id: material.id, workspaceId: project.id }, { actor: 'human' });
  assert.equal(moved.workspaceId, project.id);
  await assert.rejects(workspace.execute('workspaces.moveRecord', { collection: 'materials', id: material.id, workspaceId: project.id }, { actor: 'human' }), /already in that workspace/);
  // Agents cannot move records between workspaces.
  await assert.rejects(workspace.execute('workspaces.moveRecord', { collection: 'materials', id: material.id, workspaceId: EVERYTHING_ID }, { actor: 'automation' }), /human/i);
  const result = await workspace.execute('workspaces.delete', { id: project.id, moveTabsToEverything: true }, { actor: 'human' });
  assert.equal(result.movedTabsToEverything, 1, 'blank tabs are not reopened');
  assert.deepEqual(opened, [['https://example.com/plan', EVERYTHING_ID]]);
});

test('agents never target Everything implicitly; naming it is explicit (#99)', async t => {
  const { workspace } = service(t);
  const project = workspace.activeWorkspaceId;
  const browser = { tabs: new Map([[1, { id: 1, workspaceId: EVERYTHING_ID }]]), activeId: 1, tab(id) { return this.tabs.get(id); } };
  const agent = { actor: 'automation' };
  // Everything does not make a one-project profile ambiguous: an agent omitting workspaceId reaches the project.
  await workspace.execute('workspaces.switch', { id: EVERYTHING_ID }, { actor: 'human' });
  const resolved = resolveCommandTargets('materials.list', {}, agent, { workspace, browser, commands });
  assert.equal(resolved.args.workspaceId, project);
  // The current tab in Everything is not an implicit page target for an agent.
  assert.throws(() => resolveCommandTargets('page.inspect', {}, agent, { workspace, browser, commands }), /Everything/);
  // Naming it works, for callers whose grant includes it.
  assert.equal(resolveCommandTargets('page.inspect', { tabId: 1 }, agent, { workspace, browser, commands }).target.workspaceId, EVERYTHING_ID);
  assert.equal(resolveCommandTargets('materials.list', {}, { actor: 'human' }, { workspace, browser, commands }).args.workspaceId, EVERYTHING_ID);
});

test('links and files from other applications are validated, queued until ready and unlocked, and opened as data (#99)', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'weft-external-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'page.html'), '<p>Saved</p>');
  writeFileSync(join(folder, 'notes.txt'), 'x');
  mkdirSync(join(folder, 'dir.html'));
  symlinkSync(join(folder, 'page.html'), join(folder, 'alias.html'));
  assert.deepEqual(externalItemsFromArgv(['--flag', 'https://example.com/a', 'page.html', 'notes.txt', '/app/main.js', '.'], { cwd: folder }).map(item => item.kind), ['url', 'file']);
  assert.match(refusalFor({ kind: 'url', url: 'javascript:alert(1)' }), /not opened/);
  assert.match(refusalFor({ kind: 'url', url: 'file:///etc/passwd' }), /not opened/);
  assert.match(refusalFor({ kind: 'url', url: 'https://user:pw@example.com/' }), /credentials/);
  assert.match(refusalFor({ kind: 'file', path: join(folder, 'dir.html') }), /regular file/);
  assert.equal(refusalFor({ kind: 'url', url: 'https://example.com/' }), null);

  let locked = true, destination = 'everything';
  const opened = [], imported = [], audits = [], notices = [];
  const opener = new ExternalOpener({ locked: () => locked, destination: () => destination, lastUsed: () => 'ws_project', workspaceOpen: id => ['ws_project', EVERYTHING_ID].includes(id),
    openUrl: async (url, workspaceId) => { opened.push([url, workspaceId]); return { id: opened.length }; },
    importFile: async (file, workspaceId) => { imported.push([file.filename, file.mimeType, file.bytes.length, workspaceId]); return { id: 'mat_1' }; },
    audit: entry => audits.push(entry), notify: event => notices.push(event) });
  const refused = opener.receive([{ kind: 'url', url: 'https://example.com/one' }, { kind: 'url', url: 'javascript:void(0)' }, { kind: 'file', path: join(folder, 'alias.html') }], 'launch');
  assert.equal(refused.length, 1);
  await opener.setReady(true);
  assert.equal(opened.length, 0, 'nothing opens while the profile is locked');
  locked = false;
  await opener.flush();
  assert.deepEqual(opened, [['https://example.com/one', EVERYTHING_ID]]);
  assert.deepEqual(imported, [['page.html', 'text/html', 12, EVERYTHING_ID]], 'a symlinked file opens as its real file, copied as a material');
  assert.ok(audits.some(entry => entry.reason === 'external_open' && entry.actor === 'external-app' && /no agent action/.test(entry.detail)));
  assert.ok(audits.some(entry => entry.reason === 'external_open_refused'));
  destination = 'last-used';
  opener.receive([{ kind: 'url', url: 'https://example.com/two' }]);
  await opener.flush();
  assert.deepEqual(opened.at(-1), ['https://example.com/two', 'ws_project']);
  destination = 'ask';
  opener.receive([{ kind: 'url', url: 'https://example.com/three' }]);
  await opener.flush();
  const [waiting] = opener.list();
  assert.equal(waiting.label, 'https://example.com/three');
  assert.ok(notices.some(event => event.type === 'choose'));
  await assert.rejects(opener.choose(waiting.id, 'ws_unknown'), /open workspace/);
  await opener.choose(waiting.id, 'ws_project');
  assert.deepEqual(opened.at(-1), ['https://example.com/three', 'ws_project']);
  await assert.rejects(opener.choose(waiting.id, 'ws_project'), /no longer waiting/);
});
