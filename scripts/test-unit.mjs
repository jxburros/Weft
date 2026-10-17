import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Browser smoke tests are mandatory in the separate Linux Chromium job.
const browserTests = new Set(['browser.test.js', 'browser-workspace.test.js', 'browser-security.test.js', 'extensions-browser.test.js', 'gui.test.js', 'visual.test.js']);
const files = readdirSync('test').filter(name => name.endsWith('.test.js') && !browserTests.has(name)).map(name => `test/${name}`);
const result = spawnSync(process.execPath, ['--test', '--test-timeout=60000', ...files], { stdio: 'inherit' });
process.exit(result.status === 0 ? 0 : (result.status || 1));
