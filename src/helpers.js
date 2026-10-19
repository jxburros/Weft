import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/**
 * Small shared helpers (#120): size-capped file and HTTP body readers, a typed
 * error factory and a serial work queue. Files and bodies from untrusted sources
 * go through these readers so link handling and size limits cannot drift between
 * copies.
 */

/** An error carrying a stable `code` (and optional `details`) for typed outcomes. */
export function typedError(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details != null && { details }) });
}

const basename = path => String(path).split(/[\\/]/).pop();

/**
 * Read a regular file of at most `limit` bytes. Links and directories are refused
 * before opening (and the open itself does not follow a link where the platform
 * supports O_NOFOLLOW), so a link swapped in cannot point the read elsewhere.
 * `fail(message)` builds the error thrown for a refused or oversized file.
 */
export function readBoundedFile(path, limit, { fail = message => new Error(message) } = {}) {
  if (!lstatSync(path).isFile()) throw fail(`${basename(path)} must be a regular file, not a link or directory`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw fail(`${basename(path)} must be a regular file, not a link or directory`);
    if (stat.size > limit) throw fail(`${basename(path)} exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    // Read until end of file, one byte past the cap at most, in case the file grew after fstat.
    for (;;) { const read = readSync(fd, buffer, length, buffer.length - length, length); if (!read) break; length += read; if (length >= buffer.length) break; }
    if (length > limit) throw fail(`${basename(path)} exceeds ${limit} bytes`);
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

/**
 * Read a fetch Response body up to `limit` bytes. With `truncate`, a longer body is
 * cut at the limit (for error details); otherwise `fail(message)` is thrown. The
 * body is always cancelled afterwards, so an oversized reply stops downloading.
 */
export async function readCappedBody(response, limit, { truncate = false, fail = message => new Error(message), label = 'Response' } = {}) {
  if (!response?.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > limit) {
        if (!truncate) throw fail(`${label} exceeded the ${formatBytes(limit)} limit`);
        chunks.push(Buffer.from(value).subarray(0, limit - bytes));
        bytes = limit;
        break;
      }
      chunks.push(Buffer.from(value));
      bytes += value.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

function formatBytes(bytes) {
  if (bytes % (1024 * 1024) === 0) return `${bytes / 1024 / 1024} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

/**
 * Serialize async work on an owner: each call runs after the previous one settles,
 * and a failure does not block later work. Returns the call's own promise.
 */
export function serialize(owner, work, key = 'queue') {
  const run = (owner[key] ?? Promise.resolve()).then(work);
  owner[key] = run.catch(() => {});
  return run;
}
