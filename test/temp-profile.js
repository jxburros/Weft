// Temporary profile directories for tests that open stores, logs, brokers or children inside them.
//
// Windows refuses to delete a file that is still open (EBUSY), so a directory may be removed only after
// everything opened in it is closed. node:test runs a test's after hooks in registration order, which would
// remove a directory created before the store opened in it. Every temporary directory and closable resource
// a test registers here shares one after hook: resources close first (newest first), then the directories go.
//
// On Linux the removal also checks /proc/self/fd and fails the test when a file under the directory is still
// open, so a handle a test or the product forgets to close fails here before it reaches Windows CI.
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const registries = new WeakMap();

function registry(t) {
  let entry = registries.get(t);
  if (entry) return entry;
  entry = { closers: [], directories: [] };
  registries.set(t, entry);
  t.after(async () => {
    let failure = null;
    for (const close of entry.closers.splice(0).reverse()) {
      try { await close(); } catch (error) { failure ??= error; }
    }
    for (const directory of entry.directories.splice(0).reverse()) {
      try { removeDirectory(directory); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  });
  return entry;
}

/** A new directory under the OS temp folder, removed after the test once everything registered with closeAfter is closed. */
export function tempDirectory(t, prefix = 'weft-test-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registry(t).directories.push(directory);
  return directory;
}

/** Remove an existing directory with the test's other temporary directories, after its resources close. */
export function removeAfter(t, directory) {
  registry(t).directories.push(directory);
  return directory;
}

/** Close a resource after the test and before its temporary directories are removed. Returns the resource. */
export function closeAfter(t, resource, close = item => item.close()) {
  registry(t).closers.push(() => close(resource));
  return resource;
}

/** Files under a directory that this process still has open (Linux only; empty elsewhere). */
export function openFilesUnder(directory) {
  if (process.platform !== 'linux') return [];
  const root = resolve(directory);
  const open = [];
  let descriptors;
  try { descriptors = readdirSync('/proc/self/fd'); } catch { return []; }
  for (const descriptor of descriptors) {
    let target;
    try { target = readlinkSync(`/proc/self/fd/${descriptor}`); } catch { continue; }
    if (target === root || target.startsWith(root + sep)) open.push(target);
  }
  return open;
}

/** Remove a directory tree, failing when this process still holds a file in it open (Windows could not delete it). */
export function removeDirectory(directory) {
  const open = openFilesUnder(directory);
  // Retries cover transient Windows locks such as a just-exited child's handles or an antivirus scan.
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  if (open.length) throw new Error(`Files were still open when ${directory} was removed; Windows cannot delete open files (EBUSY): ${[...new Set(open)].join(', ')}`);
}

/** Run a cleanup step (stop a server, close several objects) after the test and before its directories are removed. */
export function beforeRemoval(t, cleanup) {
  registry(t).closers.push(cleanup);
}

/** For closeAfter: close a resource a test may already have closed itself. */
export function closeQuietly(resource) {
  try { resource.close(); } catch { /* already closed */ }
}
