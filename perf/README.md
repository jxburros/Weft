# Performance regression budgets

Run `npm run test:perf` (or `node --test perf/budgets.js`). This file deliberately
does not use the `.test.js` suffix and lives outside `test/`, so ordinary
`node --test` runs do not include it. No external service or Chromium is needed.

The first fixture has 10,000 material records and 1,000 captures with roughly
2.5 KB of text each. The second is capture-heavy: 500 captures each with a unique
96 KiB PNG and 24 KiB of text (about 60 MiB of component files) plus 2,000 notes;
it asserts that note edits and capture annotations leave every component file's
inode, modification time and size unchanged. Fixture setup is excluded from
timing except where named. The suite asserts result correctness as well as these
deliberately generous ceilings:

| Operation | Budget |
| --- | ---: |
| Update one record in a 10k-record store | 5 s |
| Search text across 1k captures | 2 s |
| Export the workspace | 5 s |
| Import its 11k records | 10 s |
| Initial write of 500 captures (components and index) | 30 s |
| Note update / capture annotation with 500 captures | 1 s each |
| Ranked search over 500 captures | 1 s |
| Reopen the capture-heavy store | 5 s |
| 100 catalog serializations | 2 s |
| 100 OpenAPI generations and serializations | 3 s |

Reference run (Linux container, Node 22, 2026-10-17): 10k-record update
~50-230 ms (JSON store: ~270 ms), 1k-capture search ~10-50 ms, import ~2.6-3.1 s
(JSON store: ~2.3 s), 500-capture initial write ~1.6-2.3 s, note update
~55-100 ms, annotation ~15-30 ms, ranked search ~25-40 ms, reopen ~150-300 ms.

Timings print in TAP diagnostics. A failure should be investigated on the same
fixture before raising a budget; do not automatically tune ceilings to the
current run. These are regression ceilings, not user-facing latency promises or
benchmarks of maximum supported scale. They do not measure GUI first paint,
Chromium memory consumption, multi-process database contention, cold disks,
slow/network filesystems or encrypted volumes. GUI first render with many tabs still needs a real display/hardware
benchmark and is not claimed here.
