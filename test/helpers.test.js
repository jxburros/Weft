import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBoundedFile, readCappedBody, serialize, typedError } from '../src/helpers.js';

const body = chunks => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close(); } }));

test('readBoundedFile reads regular files within the cap and refuses links, directories and oversized files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-helpers-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'plain.txt');
  writeFileSync(file, 'hello');
  assert.equal(readBoundedFile(file, 5).toString(), 'hello');
  assert.throws(() => readBoundedFile(file, 4), /exceeds 4 bytes/);
  mkdirSync(join(directory, 'folder'));
  assert.throws(() => readBoundedFile(join(directory, 'folder'), 100), /regular file/);
  try { symlinkSync(file, join(directory, 'link.txt')); }
  catch (error) { if (process.platform === 'win32') return t.skip(`symlinks unavailable: ${error.code}`); throw error; }
  assert.throws(() => readBoundedFile(join(directory, 'link.txt'), 100), /regular file, not a link/);
  assert.throws(() => readBoundedFile(join(directory, 'link.txt'), 100, { fail: message => typedError('invalid_arguments', message) }), error => error.code === 'invalid_arguments');
});

test('readCappedBody stops at the limit: truncating for error details, failing otherwise', async () => {
  assert.equal((await readCappedBody(body(['abc', 'def']), 10)).toString(), 'abcdef');
  assert.equal((await readCappedBody(body(['abc', 'def']), 4, { truncate: true })).toString(), 'abcd');
  await assert.rejects(readCappedBody(body(['abc', 'def']), 4), /exceeded the 4 bytes limit/);
  await assert.rejects(readCappedBody(body(['x'.repeat(2048)]), 1024, { label: 'Reply' }), /Reply exceeded the 1 KiB limit/);
  await assert.rejects(readCappedBody(body(['abcdef']), 4, { fail: () => typedError('too_large', 'nope') }), error => error.code === 'too_large');
  assert.equal((await readCappedBody(new Response(null), 4)).length, 0);
});

test('serialize runs work one at a time and a failure does not block later work', async () => {
  const owner = {};
  const order = [];
  const slow = serialize(owner, async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('slow'); return 1; });
  const failing = serialize(owner, async () => { order.push('failing'); throw new Error('boom'); });
  const fast = serialize(owner, () => { order.push('fast'); return 3; });
  assert.equal(await slow, 1);
  await assert.rejects(failing, /boom/);
  assert.equal(await fast, 3);
  assert.deepEqual(order, ['slow', 'failing', 'fast']);
});

test('typedError carries a code and details only when given', () => {
  const plain = typedError('not_found', 'missing');
  assert.equal(plain.message, 'missing');
  assert.equal(plain.code, 'not_found');
  assert.equal(Object.hasOwn(plain, 'details'), false);
  assert.deepEqual(typedError('invalid_arguments', 'bad', { field: 'x' }).details, { field: 'x' });
});
