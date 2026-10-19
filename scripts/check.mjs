import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const directories = ['src', 'bin', 'scripts', 'test', 'evals', 'perf'];
function check(directory) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) check(path);
    else if (/\.(?:[cm]?js)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
directories.forEach(check);
// Then exports nothing uses (#124) and the small lint rule set in eslint.config.js (#118).
for (const args of [['scripts/unused-exports.mjs'], ['node_modules/eslint/bin/eslint.js', '.']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
