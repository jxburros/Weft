import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Browser smoke tests are mandatory in the separate Linux Chromium job.
const browserTests = new Set(['browser.test.js', 'browser-workspace.test.js', 'browser-security.test.js', 'extensions-browser.test.js', 'gui.test.js', 'visual.test.js', 'update-transport.test.js',
  // Headless lifecycle, tab suspension and responsiveness budgets run real Electron in the Linux job.
  'headless.test.js', 'suspension.test.js', 'responsiveness.test.js',
  // The accessibility audit and the community-list/agent-input screens drive the real GUI.
  'accessibility.test.js', 'gui-lists.test.js']);
const files = readdirSync('test').filter(name => name.endsWith('.test.js') && !browserTests.has(name)).map(name => `test/${name}`);
// Per-file cap: above the largest per-test budget (120 s, e.g. indexing on slow macOS disks) while still catching hangs.
const result = spawnSync(process.execPath, ['--test', '--test-timeout=180000', ...files], { stdio: 'inherit' });
process.exit(result.status === 0 ? 0 : (result.status || 1));
