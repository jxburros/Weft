import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Small durable JSON files owned by the browser (journals, security configuration). */
export function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${path} is unreadable; preserve it and review before retrying`); }
}

export function writeJsonDurable(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
  try { const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } } catch { /* Directory fsync is unsupported on some platforms. */ }
}
