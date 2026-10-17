import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { runEvaluations } from '../evals/run.js';

test('offline MCP reference tasks succeed without baseline regressions', async t => {
  const results = await runEvaluations();
  assert.equal(results.length, readdirSync(new URL('../evals/tasks/', import.meta.url)).filter(name => name.endsWith('.json')).length, 'every task file runs');
  for (const result of results) {
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.success, true, JSON.stringify(result.failures));
    assert.equal(result.toolErrors, result.expectedErrors);
    assert.ok(Object.values(result.delta).every(value => value <= 0), `${result.id}: baseline regression`);
  }
});
