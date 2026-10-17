#!/usr/bin/env node
// Release gate: the tag, package.json, package-lock.json, plugin manifest and CHANGELOG must agree.
// Usage: node scripts/release/metadata.js [v1.2.3 [notes-output.md]]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stable = /^\d+\.\d+\.\d+$/;
/** Returns the section body for `## v1.2.3 — date` (also accepts `## 1.2.3` and `## [1.2.3]`). */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const escaped = version.replaceAll('.', '\\.');
  const start = lines.findIndex(line => new RegExp(`^## \\[?v?${escaped}\\]?(?:\\s|$)`).test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim() || null;
}

export function releaseMetadata(root, tag = null) {
  const read = path => readFileSync(join(root, path), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  const version = pkg.version;
  const problems = [];
  if (!stable.test(version)) problems.push(`package.json version ${version} is not a stable x.y.z version`);
  if (lock.version !== version || lock.packages?.['']?.version !== version) problems.push(`package-lock.json version ${lock.version}/${lock.packages?.['']?.version} does not match ${version}; run npm install --package-lock-only`);
  if (plugin.version !== version) problems.push(`.claude-plugin/plugin.json version ${plugin.version} does not match ${version}`);
  let notes = null;
  if (tag !== null) {
    if (tag !== `v${version}`) problems.push(`Tag ${tag} does not match package.json version v${version}`);
    notes = changelogSection(read('CHANGELOG.md'), version);
    if (!notes) problems.push(`CHANGELOG.md has no "## v${version} — YYYY-MM-DD" section with release notes`);
  }
  return { version, notes, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [tag, notesPath] = process.argv.slice(2);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const { version, notes, problems } = releaseMetadata(root, tag ?? null);
  if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  if (notesPath) writeFileSync(notesPath, `${notes}\n`);
  console.log(`Release metadata consistent for ${version}${tag ? ` (${tag})` : ''}`);
}
