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
| Encrypted: enable encryption in place (11k records, 1k captures, first backup) | 30 s |
| Encrypted: update one record in a 10k-record store | 5 s |
| Encrypted: first search (builds the in-memory index) / repeated search | 5 s / 2 s |
| Encrypted: export (acknowledged plaintext) | 5 s |
| Encrypted: reopen and unlock with the OS key | 5 s |
| Encrypted: data-key rotation of 11k records and 1k components | 60 s |
| 100 catalog serializations | 2 s |
| 100 OpenAPI generations and serializations | 3 s |

Reference run (Linux container, Node 22, 2026-10-17): 10k-record update
~50-230 ms (JSON store: ~270 ms), 1k-capture search ~10-50 ms, import ~2.6-3.1 s
(JSON store: ~2.3 s), 500-capture initial write ~1.6-2.3 s, note update
~55-100 ms, annotation ~15-30 ms, ranked search ~25-40 ms, reopen ~150-300 ms.
Encrypted profile (injected OS key store, production recovery-key KDF): enable
~4.7 s, update ~40 ms, first search ~0.8 s, repeated search ~13 ms, export
~160 ms, reopen ~370 ms, data-key rotation ~2.3 s.

## Responsiveness in real Electron (#30)

`xvfb-run -a npm run perf:responsiveness` (`perf/responsiveness.js`) seeds a
profile with 5,000 notes, 500 tasks and three workspaces, launches the shipped
main process, and measures while concurrent scoped agents work over the
authenticated API (each: inspect, navigate, snapshot, record a finding) and a
person clicks and scrolls the visible page with native input events. Environment
variables `WEFT_BENCH_RECORDS`, `WEFT_BENCH_AGENTS` and `WEFT_BENCH_ROUNDS` change
the fixture. `test/responsiveness.test.js` runs a 3,000-record variant in the
Linux Chromium CI job and enforces the targets below.

| Measure | Target (CI budget) | 5k records, 4 agents | 10k records, 8 agents |
| --- | ---: | ---: | ---: |
| GUI first render (process start to populated overview) | < 15 s | 1.0 s | 1.5 s |
| Agent navigation p50 / p95 | p95 < 3 s | 76 / 88 ms | 125 / 195 ms |
| Native click to page handler p50 / p95 | p95 < 1.5 s | 14 / 82 ms | 17 / 130 ms |
| Wheel scroll to scroll event p50 / p95 | p95 < 1.5 s | 4 / 30 ms | 4 / 39 ms |
| Total memory (all Chromium processes) | < 3.5 GB | 1.28 GB (9 processes) | 1.93 GB (13 processes) |
| Main-process CPU during the workload | < 400% | ~105% | ~109% |

Reference run: Linux container, Xvfb, `--disable-gpu` software rendering,
Electron 44.9.0, 2026-10-17. Before this change the same 5k-record run measured
navigation p50/p95 353/513 ms and click p95 287 ms: every browser command copied
the entire workspace state to check a workspace id, and every tab title update
rewrote all records. The main process stays busy (~1 core) under four agents;
the remaining per-command cost is record commits that plan over every record and
the GUI's 1.5 s state poll. These numbers are not real-hardware or
GPU-accelerated measurements, and Chromium CPU is sampled once over the workload.

Timings print in TAP diagnostics. A failure should be investigated on the same
fixture before raising a budget; do not automatically tune ceilings to the
current run. These are regression ceilings, not user-facing latency promises or
benchmarks of maximum supported scale. They do not measure GUI first paint,
Chromium memory consumption, multi-process database contention, cold disks,
slow/network filesystems or encrypted volumes. GUI first render, input, scroll and
memory are measured separately in real Electron (above), on a virtual display only.
