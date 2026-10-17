import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runTask } from './harness.js';

export async function runEvaluations() {
  const directory = new URL('./tasks/', import.meta.url);
  const results = [];
  for (const name of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    results.push(await runTask(JSON.parse(readFileSync(new URL(name, directory), 'utf8'))));
  }
  const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url), 'utf8'));
  return results.map(result => ({ ...result, delta: Object.fromEntries(['roundTrips', 'toolErrors', 'retries'].map(key => [key, result[key] - baseline[result.id][key]])) }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('Usage: node evals/run.js (offline reference agent only; live model evaluation is not implemented)');
    process.exitCode = 2;
  } else {
    const results = await runEvaluations();
    console.log(JSON.stringify({ agent: 'reference', results }, null, 2));
    if (results.some(result => !result.success || Object.values(result.delta).some(value => value > 0))) process.exitCode = 1;
  }
}
