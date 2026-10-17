# Validation and supported test coverage

`npm ci` installs the locked dependencies. Run `node node_modules/electron/install.js`
once before parallel tests to install Electron 44 without lazy-installer races. `npm run check` syntax-checks JavaScript.
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
Import filenames are reduced to basenames and their bytes are stored only as
content-addressed component files named by digest: imports never write a
caller-supplied path. Package imports reject links, malformed manifest paths and
digest mismatches. This does not claim arbitrary archive extraction support. Loopback URL tests deliberately reject DNS names even
if they might currently resolve to loopback; control-plane authorization never
relies on mutable DNS answers.

Extension compatibility evidence (`test/extensions-browser.test.js`, summarized
in ADR-007) comes from Electron 44.9.0 / Chromium 152 on Linux under Xvfb. Run
it again after any Electron upgrade before changing the allowed extension
permission set; macOS and Windows behaviour has not been observed. Plugin
sandbox tests rely on Node's permission model as shipped with the running Node
or Electron version.

Tests do not substitute for real screen-reader, signing/notarization, recovery-key,
malware-feed, payment-provider, or multi-user deployment validation. Those items
remain open until their issue-specific acceptance criteria have evidence.
