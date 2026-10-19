# Validation and supported test coverage

`npm ci` installs the locked dependencies. Run `node node_modules/electron/install.js`
once before parallel tests to install Electron 44 without lazy-installer races. `npm run check` syntax-checks JavaScript,
fails on exports nothing in the repository uses (`scripts/unused-exports.mjs`) and runs ESLint with
the small rule set in `eslint.config.js` (`npm run lint` runs ESLint alone): unused variables, empty
blocks without a comment, unreachable code, `==` other than against `null`, and `let` that is never
reassigned. `no-shadow` is deliberately not enabled (see the comment in the config).
`npm run test:unit` runs non-GUI tests with a three-minute per-file cap (multiplied, like
every explicit per-test timeout, by `WEFT_TEST_TIME_SCALE`; CI sets 4 on Windows, whose synced
disk writes are several times slower) and
`--test-force-exit`, so a server or child left open by a failing test cannot hang
the job. GitHub CI runs these on Node 22/24 and Linux/macOS/Windows; a successful
matrix is evidence for that commit, not a claim about every operating-system
configuration. Every test file that launches the real Electron app must be listed
in `browserTests` in `scripts/test-unit.mjs` (the runner refuses unlisted files
that call `electronEnv`), and launches it through `scripts/electron-env.js`, which
removes `ELECTRON_RUN_AS_NODE`: Windows treats an empty value as set and would
start Electron as plain Node.

Windows cannot delete or rename over a file that is still open. Tests that open
stores, logs, servers or children in a temporary profile register them with
`test/temp-profile.js` (`tempDirectory`, `removeAfter`, `closeAfter`,
`beforeRemoval`), which closes everything before removing the directory; on Linux
that removal fails the test when this process still has a file in it open, so a
leaked handle shows up before Windows CI. Crash tests accept Windows termination
(exit code 1, no signal, after the child's crash marker) where POSIX reports
`SIGKILL`; AppImage replacement tests run only off Windows, and the open-database
replacement scenario asserts that Windows refuses the replacement instead.

`npm test` runs exactly the files matching `test/**/*.test.js`; helpers and
fixtures under `test/` and `scripts/test-unit.mjs` are never collected as tests
(#122), so a new helper with top-level side effects cannot run by accident.

The separate Linux Chromium job runs **all** tests under `xvfb-run -a npm test`,
including native browser isolation and GUI workflows, then compares the GUI
goldens (`WEFT_VISUAL=1`; `test/visual.test.js` skips without it; see
`test/visual/README.md`). It archives the test log
under an artifact named with the tested commit SHA. Electron subprocesses in tests
use `--no-sandbox` because hosted runners lack a configured setuid helper. Normal
Weft startup retains Chromium sandboxing. Fixture tokens are disposable local-only
values; CI has read-only repository permissions and uses no production secrets.

`npm run test:docs`, `npm run evals`, and `npm run test:perf` exercise published
examples, scripted MCP tasks, and local performance budgets respectively. CI runs
`test:perf` on the Linux unit job and an `npm audit --omit=dev --audit-level=high` job
on every pull request; workflow actions are pinned by commit SHA.
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

Headless-session, tab-suspension and responsiveness tests (`test/headless.test.js`,
`test/suspension.test.js`, `test/responsiveness.test.js`) launch real Electron and
run only in the Linux Chromium job under Xvfb with software rendering. Their
evidence is Linux-only; the responsiveness budgets are deliberately generous
regression ceilings, and `perf/README.md` records the reference numbers.

Everyday browser chrome (`test/browser-chrome.test.js`) runs real Electron in the
Linux Chromium job: shortcuts pressed inside a page (including a page that claims
Ctrl+F), the context-menu template and a site-blocked link, find counts, zoom
memory, recently closed tabs, tab order, DevTools refusals and page source. The
native context menu and the system print dialog are not opened under test (the
menu is captured before it is shown; printing is stubbed). The print dialog on
Windows, macOS and Linux desktops and macOS Cmd shortcuts have not been checked
by hand yet.

Tests do not substitute for real screen-reader, signing/notarization, recovery-key,
malware-feed, payment-provider, model-provider account, signed-in webmail,
email-forwarding relay or multi-user deployment validation. Model discovery,
learning, embeddings and webmail capture are exercised only against local fake
endpoints and fixture pages. Those items
remain open until their issue-specific acceptance criteria have evidence.
