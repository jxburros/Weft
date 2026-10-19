import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Browser smoke tests are mandatory in the separate Linux Chromium job.
const browserTests = new Set(['message-capture.test.js', 'browser.test.js', 'browser-workspace.test.js', 'browser-security.test.js', 'extensions-browser.test.js', 'gui.test.js', 'visual.test.js', 'update-transport.test.js',
  // Headless lifecycle, tab suspension and responsiveness budgets run real Electron in the Linux job.
  'headless.test.js', 'suspension.test.js', 'responsiveness.test.js',
  // The accessibility audit and the community-list/agent-input screens drive the real GUI.
  'accessibility.test.js', 'gui-lists.test.js',
  // Real-Chromium archives, protected logins and checkouts, page observation, recording, the knowledge GUI and encryption settings.
  'archive-browser.test.js', 'credentials-browser.test.js', 'payments-browser.test.js', 'page-observation.test.js', 'workflow-recording.test.js',
  'gui-knowledge.test.js', 'encryption-gui.test.js',
  // Everyday browser chrome: shortcuts, context menu, find bar, zoom, closed tabs, DevTools and page source.
  'browser-chrome.test.js',
  // Site permission prompts, popups, private windows, saved passwords and the extension toolbar (#90, #94, #95, #97, #98).
  'site-permissions-browser.test.js', 'private-window.test.js', 'passwords-browser.test.js', 'gui-site.test.js',
  // Multiple windows, the Everything workspace's external links and four live panes (#99, #100, #101).
  'windows-browser.test.js']);
// Files that launch Electron but skip that test themselves outside the Linux Chromium job; their other tests run everywhere.
const selfScopedElectronTests = new Set(['logo.test.js']);
const all = readdirSync('test').filter(name => name.endsWith('.test.js'));
// Every file that launches the real app must be classified, or it would run (and fail) on runners without Chromium.
const unclassified = all.filter(name => !browserTests.has(name) && !selfScopedElectronTests.has(name) && /\belectronEnv\(/.test(readFileSync(`test/${name}`, 'utf8')));
if (unclassified.length) {
  console.error(`These test files launch Electron; add them to browserTests in scripts/test-unit.mjs: ${unclassified.join(', ')}`);
  process.exit(1);
}
const files = all.filter(name => !browserTests.has(name)).map(name => `test/${name}`);
// Per-file cap: above the largest per-test budget (120 s, e.g. indexing on slow macOS disks) while still catching hangs.
// --test-force-exit ends a file once its tests finish, so a server or child left open by a failed test cannot hang the job.
const result = spawnSync(process.execPath, ['--test', `--test-timeout=${180000 * Math.max(1, Number(process.env.WEFT_TEST_TIME_SCALE) || 1)}`, '--test-force-exit', ...files], { stdio: 'inherit' });
process.exit(result.status === 0 ? 0 : (result.status || 1));
