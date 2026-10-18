import test from 'node:test';
import assert from 'node:assert/strict';
import { runResponsiveness } from '../perf/responsiveness.js';

/*
 * Measured responsiveness budgets (#30) in real Electron: a large seeded workspace, concurrent scoped
 * agents over the API and a person clicking and scrolling the visible page. Ceilings are deliberately
 * generous (well above the reference numbers in perf/README.md) so slow CI machines pass while an
 * order-of-magnitude regression fails.
 */
export const RESPONSIVENESS_BUDGETS = Object.freeze({ guiReadyMs: 15000, navigationP95Ms: 3000, inputP95Ms: 1500, scrollP95Ms: 1500, memoryMb: 3500, mainProcessCpuPercent: 400 });

test('GUI first render, agent navigation, input and scroll stay within budgets with a large workspace and concurrent agents', {
  timeout: 240000, skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires DISPLAY or xvfb-run' : false,
}, async t => {
  const result = await runResponsiveness({ records: 3000, agents: 4, rounds: 5, probes: 12, timeoutMs: 200000 });
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.navigationMs.samples, 20, 'every agent navigation completed');
  assert.equal(result.inputMs.samples, 12);
  assert.equal(result.scrollMs.samples, 12);
  assert.ok(result.guiReadyMs < RESPONSIVENESS_BUDGETS.guiReadyMs, `GUI first render ${result.guiReadyMs} ms`);
  assert.ok(result.navigationMs.p95 < RESPONSIVENESS_BUDGETS.navigationP95Ms, `navigation p95 ${result.navigationMs.p95} ms`);
  assert.ok(result.inputMs.p95 < RESPONSIVENESS_BUDGETS.inputP95Ms, `input p95 ${result.inputMs.p95} ms`);
  assert.ok(result.scrollMs.p95 < RESPONSIVENESS_BUDGETS.scrollP95Ms, `scroll p95 ${result.scrollMs.p95} ms`);
  assert.ok(result.memoryMb < RESPONSIVENESS_BUDGETS.memoryMb, `memory ${result.memoryMb} MB`);
  assert.ok(result.mainProcessCpuPercent < RESPONSIVENESS_BUDGETS.mainProcessCpuPercent, `main-process CPU ${result.mainProcessCpuPercent}%`);
});
