import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { restoreBackup, verifyBackup, listBackups } from '../src/backups.js';
import { closeAfter, removeAfter } from './temp-profile.js';

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('image body')]).toString('base64');
function profile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-backups-'));
  removeAfter(t, directory);
  return directory;
}
function open(t, directory, options = {}) {
  const service = new WorkspaceService({ directory, onWarning() {}, ...options });
  closeAfter(t, service);
  return service;
}
async function seeded(t) {
  const directory = profile(t);
  const service = open(t, directory);
  const capture = await service.execute('artifacts.create', { title: 'Evidence', text: 'backed up capture text', pngBase64: PNG });
  const note = await service.execute('materials.create', { title: 'Before backup', content: 'v1' });
  const backup = await service.execute('backups.create', { note: 'before risky work' });
  return { directory, service, capture, note, backup };
}

test('manual backups are verified snapshots with a digest manifest; administration only', async t => {
  const { directory, service, backup } = await seeded(t);
  assert.equal(backup.status, 'verified');
  assert.equal(backup.kind, 'manual');
  assert.equal(backup.counts.artifacts, 1);
  const manifest = JSON.parse(readFileSync(join(directory, 'backups', backup.id, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map(file => file.path.split('/')[0]).sort(), ['components', 'components', 'workspace.sqlite']);
  assert.ok(manifest.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)));
  const listed = await service.execute('backups.list');
  assert.deepEqual(listed.backups.map(item => item.id), [backup.id]);
  for (const name of ['backups.create', 'backups.list', 'backups.restore', 'backups.verify']) {
    await assert.rejects(service.execute(name, name.endsWith('restore') || name.endsWith('verify') ? { id: backup.id } : {}, { actor: 'automation' }), /PERMISSION_REQUIRED/);
  }
});

test('verification detects damaged databases, components, missing files and malformed manifest paths', async t => {
  const { directory, backup } = await seeded(t);
  const folder = join(directory, 'backups', backup.id);
  const manifestPath = join(folder, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const component = manifest.files.find(file => file.path.startsWith('components/'));
  const original = readFileSync(join(folder, ...component.path.split('/')));
  writeFileSync(join(folder, ...component.path.split('/')), 'tampered');
  assert.deepEqual(verifyBackup(directory, backup.id).problems, [{ path: component.path, problem: 'digest mismatch' }]);
  rmSync(join(folder, ...component.path.split('/')));
  assert.equal(verifyBackup(directory, backup.id).problems[0].problem, 'missing');
  writeFileSync(join(folder, ...component.path.split('/')), original);
  assert.equal(verifyBackup(directory, backup.id).status, 'verified');
  for (const path of ['../../outside', '/etc/passwd', 'components/zz/abc', 'components/00/' + '1'.repeat(64)]) {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: [...manifest.files, { path, size: 1, sha256: '1'.repeat(64) }] }));
    assert.equal(verifyBackup(directory, backup.id).status, 'failed', path);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const database = join(folder, 'workspace.sqlite');
  const bytes = readFileSync(database);
  bytes.fill(0, 4096, 8192);
  writeFileSync(database, bytes);
  const failed = verifyBackup(directory, backup.id);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.problems.some(item => item.path === 'workspace.sqlite'));
  assert.throws(() => verifyBackup(directory, '../escape'), /BACKUP_INVALID/);
});

test('restore replaces current data with the verified backup and preserves the originals', async t => {
  const { directory, service, capture, note, backup } = await seeded(t);
  await service.execute('materials.update', { id: note.id, changes: { content: 'after backup' } });
  const later = await service.execute('artifacts.create', { title: 'Later capture', text: 'created after the backup' });
  const preview = await service.execute('backups.restore', { id: backup.id, dryRun: true });
  assert.equal(preview.applied, false);
  assert.equal(preview.changes.restored.artifacts, 1);
  assert.equal((await service.execute('artifacts.list')).length, 2);
  const restored = await service.execute('backups.restore', { id: backup.id });
  assert.equal(restored.restored, backup.id);
  assert.equal((await service.execute('materials.get', { id: note.id })).content, 'v1');
  assert.equal((await service.execute('artifacts.get', { id: capture.id })).versions[0].pngBase64, PNG);
  await assert.rejects(service.execute('artifacts.get', { id: later.id }), /not found/);
  assert.equal((await service.execute('search.query', { query: 'created after' })).length, 0);
  // Originals, including later capture bytes, are preserved rather than deleted.
  const preserved = join(directory, ...restored.preservedOriginal.split('/'));
  assert.ok(existsSync(join(preserved, 'workspace.sqlite')));
  assert.ok(readdirSync(join(preserved, 'components')).length >= 1);
  await service.execute('materials.create', { title: 'Writable after restore' });
  service.close();
  const reopened = open(t, directory);
  assert.equal((await reopened.execute('materials.list')).length, 2);
});

for (const step of ['preserved', 'staged', 'swapped']) {
  test(`restore interrupted after "${step}" completes on next start`, async t => {
    const { directory, service, note, backup } = await seeded(t);
    await service.execute('materials.update', { id: note.id, changes: { content: 'after backup' } });
    service.close();
    assert.throws(() => restoreBackup(directory, backup.id, { onStep: current => { if (current === step) throw new Error('simulated crash'); } }), /simulated crash/);
    assert.ok(existsSync(join(directory, 'restore-journal.json')));
    const reopened = open(t, directory);
    assert.equal(existsSync(join(directory, 'restore-journal.json')), false);
    assert.equal((await reopened.execute('materials.get', { id: note.id })).content, 'v1');
    assert.ok(readdirSync(join(directory, 'recovery')).some(name => name.startsWith('pre-restore-')));
  });
}

test('a damaged live database can be restored offline with the store CLI', { timeout: 15000 }, async t => {
  const { directory, service, note, backup } = await seeded(t);
  service.close();
  writeFileSync(join(directory, 'workspace.sqlite'), 'damaged beyond repair');
  rmSync(join(directory, 'workspace.sqlite-wal'), { force: true });
  assert.throws(() => new WorkspaceService({ directory, onWarning() {} }), /STORE_CORRUPT/);
  const cli = fileURLToPath(new URL('../bin/weft.js', import.meta.url));
  const listed = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'store', 'backups', directory])).stdout);
  assert.deepEqual(listed.backups.map(item => item.id), [backup.id]);
  const result = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'store', 'restore', directory, backup.id])).stdout);
  assert.equal(result.verification.status, 'verified');
  assert.equal(readFileSync(join(directory, ...result.preservedOriginal.split('/'), 'workspace.sqlite'), 'utf8'), 'damaged beyond repair');
  const reopened = open(t, directory);
  assert.equal((await reopened.execute('materials.get', { id: note.id })).content, 'v1');
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'store', 'restore', directory, backup.id]), error => /STORE_LOCKED/.test(error.stderr) && error.code === 4);
});

test('automatic backups run when due, are verified and keep a bounded number', async t => {
  const directory = profile(t);
  let now = Date.parse('2026-10-01T00:00:00Z');
  const service = open(t, directory, { clock: () => now, backups: { automatic: true, intervalHours: 24, keep: 2 } });
  await service.runAutomaticBackup();
  await service.runAutomaticBackup();
  assert.equal(listBackups(directory).filter(item => item.kind === 'automatic').length, 1, 'not due again within the interval');
  for (let day = 1; day <= 3; day++) { now += 24 * 3600 * 1000; await service.execute('materials.create', { title: `Day ${day}` }); await service.runAutomaticBackup(); }
  const automatic = listBackups(directory).filter(item => item.kind === 'automatic');
  assert.equal(automatic.length, 2);
  assert.ok(automatic.every(item => verifyBackup(directory, item.id).status === 'verified'));
  assert.equal((await service.execute('backups.list')).policy.lastError, null);
  // Manual backups are never pruned automatically.
  await service.execute('backups.create', {});
  now += 24 * 3600 * 1000;
  await service.runAutomaticBackup();
  assert.equal(listBackups(directory).filter(item => item.kind === 'manual').length, 1);
});

test('partially written backups are discarded at startup', async t => {
  const { directory, service } = await seeded(t);
  service.close();
  const partial = join(directory, 'backups', '.tmp-00000000-0000-4000-8000-000000000000');
  writeFileSync(join(directory, 'backups', 'not-a-backup'), 'ignored');
  rmSync(partial, { recursive: true, force: true });
  await import('node:fs').then(fs => { fs.mkdirSync(partial); fs.writeFileSync(join(partial, 'workspace.sqlite'), 'partial'); });
  open(t, directory);
  assert.equal(existsSync(partial), false);
  assert.equal(listBackups(directory).length, 1);
});
