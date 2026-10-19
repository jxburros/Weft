// Fails when a module exports a name that no file in the repository uses, not even its own module (#124).
// Usage beyond the defining module is not required: a helper exported only for tests still counts as used.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'bin', 'scripts', 'test', 'evals', 'perf'];
function files(directory) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('_') ? [] : files(path);
    return /\.(?:[cm]?js)$/.test(entry.name) ? [path] : [];
  });
}
const sources = new Map(roots.flatMap(files).map(path => [path, readFileSync(path, 'utf8')]));
const declaration = /^export\s+(?:async\s+)?(?:const|let|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
const problems = [];
for (const [path, source] of sources) {
  if (!path.startsWith('src')) continue;
  for (const match of source.matchAll(declaration)) {
    const name = match[1];
    const escaped = name.replace(/\$/g, '\\$');
    const pattern = `(?<![\\w$])${escaped}(?![\\w$])`;
    const own = (source.match(new RegExp(pattern, 'g')) || []).length;
    const word = new RegExp(pattern);
    const elsewhere = [...sources].some(([other, text]) => other !== path && word.test(text));
    if (own <= 1 && !elsewhere) problems.push(`${path}: export ${name} is not used anywhere`);
  }
}
if (problems.length) {
  console.error(`${problems.join('\n')}\nRemove the export, or use it.`);
  process.exit(1);
}
