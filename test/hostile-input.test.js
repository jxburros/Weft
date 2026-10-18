import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceService } from '../src/workspace.js';
import { createClient } from '../src/client.js';
import { budget } from './time-budget.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-hostile-'));
  const service = new WorkspaceService({ directory });
  t.after(() => { service.close?.(); rmSync(directory, { recursive: true, force: true }); });
  return { service, directory };
}
function random(seed) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

test('seeded record mutations agree with a shadow model and rejected revisions preserve disk', { timeout: budget(15000) }, async t => {
  const { service } = fixture(t);
  const next = random(0x57ef7);
  const records = new Map();
  for (let step = 0; step < 180; step++) {
    const pick = next();
    const ids = [...records.keys()];
    const id = ids[Math.floor(next() * ids.length)];
    if (!id || pick < 0.4) {
      const content = `seeded content ${step}`;
      const value = await service.execute('materials.create', { title: `Record ${step}`, content });
      records.set(value.id, { content, revision: 1 });
    } else if (pick < 0.7) {
      const old = records.get(id);
      const content = `updated ${step}`;
      const value = await service.execute('materials.update', { id, expectedRevision: old.revision, changes: { content } });
      assert.equal(value.revision, old.revision + 1);
      records.set(id, { content, revision: old.revision + 1 });
    } else if (pick < 0.85) {
      await service.execute('materials.delete', { id });
      records.delete(id);
    } else {
      const before = service.storage.contentDigest();
      await assert.rejects(service.execute('materials.update', { id, expectedRevision: 99999, changes: { content: 'must not commit' } }));
      assert.equal(service.storage.contentDigest(), before);
    }
    const actual = await service.execute('materials.list');
    assert.equal(actual.length, records.size);
    for (const record of actual) assert.deepEqual({ content: record.content, revision: record.revision }, records.get(record.id));
  }
});

test('malformed and seeded hostile imports fail atomically without changing project bytes', { timeout: budget(15000) }, async t => {
  const { service } = fixture(t);
  await service.execute('materials.create', { title: 'Keep me', content: 'Original' });
  const valid = await service.execute('workspaces.export', { id: service.activeWorkspaceId });
  const bad = [null, [], {}, '{', '"text"', { ...valid, schemaVersion: 999999 }, { ...valid, materials: {} }];
  const next = random(0x1bad);
  for (let i = 0; i < 50; i++) {
    const copy = structuredClone(valid);
    const choice = Math.floor(next() * 5);
    if (choice === 0) copy.materials[0].id = i;
    if (choice === 1) copy.materials.push(structuredClone(copy.materials[0]));
    if (choice === 2) copy.materials[0].title = 'x'.repeat(241 + i);
    if (choice === 3) copy.materials[0].fileBase64 = `!invalid-${i}`;
    if (choice === 4) copy.materials = Array.from({ length: 10001 }, () => copy.materials[0]);
    bad.push(copy);
  }
  for (const data of bad) {
    const before = service.storage.contentDigest();
    const snapshot = service.snapshot();
    await assert.rejects(service.execute('workspaces.import', { data }));
    assert.deepEqual(service.snapshot(), snapshot);
    assert.equal(service.storage.contentDigest(), before);
  }
});

test('imported filenames are inert basenames and HTML remains stored data', { timeout: budget(5000) }, async t => {
  const { service, directory } = fixture(t);
  const bundle = await service.execute('workspaces.export', { id: service.activeWorkspaceId });
  bundle.materials = [{ id: 'hostile-file', title: 'Untrusted', kind: 'file', filename: '../../outside.txt', fileBase64: Buffer.from('<script>throw new Error("untrusted")</script>').toString('base64') }];
  const imported = await service.execute('workspaces.import', { data: bundle });
  const [file] = await service.execute('materials.list', { workspaceId: imported.id });
  assert.equal(file.filename, 'outside.txt');
  assert.equal(existsSync(join(directory, 'outside.txt')), false);
  const stored = await service.execute('materials.get', { id: file.id });
  assert.match(Buffer.from(stored.fileBase64, 'base64').toString(), /<script>/);
});

test('control-plane origins use a narrow syntactic loopback allowlist without DNS trust', { timeout: budget(5000) }, () => {
  for (const url of ['http://127.0.0.1:9222', 'http://localhost:9222', 'http://[::1]:9222', 'http://2130706433:9222']) {
    assert.doesNotThrow(() => createClient({ url, token: 'fixture' }), url);
  }
  for (const url of ['https://localhost', 'http://localhost.', 'http://localhost.evil.test', 'http://127.0.0.1.nip.io', 'http://[::ffff:127.0.0.1]', 'http://0.0.0.0', 'http://127.0.0.2', 'http://example.com', 'file:///tmp', 'http://user:pass@localhost', 'http://localhost/path', 'http://localhost?token=fixture', 'http://localhost#fragment']) {
    assert.throws(() => createClient({ url, token: 'fixture' }), /loopback/, url);
  }
});
