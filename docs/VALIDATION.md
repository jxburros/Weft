# Validation and supported test coverage

`npm ci` installs the locked dependencies. `npm run check` syntax-checks JavaScript.
`npm run test:unit` runs non-GUI tests with a one-minute per-test timeout. GitHub CI
runs these on Node 22/24 and Linux/macOS/Windows; a successful matrix is evidence
for that commit, not a claim about every operating-system configuration.

The separate Linux Chromium job runs **all** tests under `xvfb-run -a npm test`,
including native browser isolation and GUI workflows. It archives the test log
under an artifact named with the tested commit SHA. Electron subprocesses in tests
use `--no-sandbox` because hosted runners lack a configured setuid helper. Normal
Weft startup retains Chromium sandboxing. Fixture tokens are disposable local-only
values; CI has read-only repository permissions and uses no production secrets.

`npm run test:docs`, `npm run evals`, and `npm run test:perf` exercise published
examples, scripted MCP tasks, and generous local performance budgets respectively.
Performance budgets are regression thresholds, not a throughput guarantee.

Hostile-input tests use fixed random seeds, compare record operations against a
shadow model, and verify invalid imports leave both memory and disk unchanged.
Import filenames are reduced to basenames and their bytes stay inside the JSON
store: imports never write a caller-supplied path. This does not claim arbitrary
archive extraction support. Loopback URL tests deliberately reject DNS names even
if they might currently resolve to loopback; control-plane authorization never
relies on mutable DNS answers.

Tests do not substitute for real screen-reader, signing/notarization, recovery-key,
malware-feed, payment-provider, or multi-user deployment validation. Those items
remain open until their issue-specific acceptance criteria have evidence.
