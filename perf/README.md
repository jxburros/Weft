# Performance regression budgets

Run `npm run test:perf` (or `node --test perf/budgets.js`). This file deliberately
does not use the `.test.js` suffix and lives outside `test/`, so ordinary
`node --test` runs do not include it. No external service or Chromium is needed.

The fixture has 10,000 material records and 1,000 captures with roughly 2.5 KB of
text each. Fixture setup is excluded from timing. The suite asserts result
correctness as well as these deliberately generous ceilings:

| Operation | Budget |
| --- | ---: |
| Update one record in a 10k-record store | 5 s |
| Search text across 1k captures | 2 s |
| Export the workspace | 5 s |
| Import its 11k records | 10 s |
| 100 catalog serializations | 2 s |
| 100 OpenAPI generations and serializations | 3 s |

Timings print in TAP diagnostics. A failure should be investigated on the same
fixture before raising a budget; do not automatically tune ceilings to the
current run. These are regression ceilings, not user-facing latency promises or
benchmarks of maximum supported scale. They do not measure GUI first paint,
Chromium memory consumption, database contention, cold disks or encrypted
volumes. GUI first render with many tabs still needs a real display/hardware
benchmark and is not claimed here.
