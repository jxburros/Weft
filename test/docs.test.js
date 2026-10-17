import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commands } from '../src/commands.js';
import { GUIDANCE, renderGuidance, getGuidance } from '../src/guidance.js';
import { checkExamples, checkRepositoryExamples } from '../scripts/docs-examples.js';
const root = fileURLToPath(new URL('..', import.meta.url));

test('README, docs and skills command examples pass canonical validation', t => {
  const reports = checkRepositoryExamples(root);
  const checked = reports.flatMap(report => report.checked);
  assert.ok(checked.length >= 9, 'the scanner must find the documented commands');
  for (const skipped of reports.flatMap(report => report.skipped)) t.diagnostic(`Skipped ${skipped.source}:${skipped.line}: ${skipped.reason}`);
  t.diagnostic(`Validated ${checked.length} examples without executing commands`);
});

test('documentation validator catches renamed commands, bad options, invalid JSON and empty skip reasons', () => {
  assert.throws(() => checkExamples('```sh\nweft renamed.command\n```'), /Unknown command/);
  assert.throws(() => checkExamples('```bash\nnode bin/weft.js tabs.list \'{"ignored":true}\'\n```'), /tabs.list/);
  assert.throws(() => checkExamples('```json\n{"command":"tabs.close","args":{"tabId":0}}\n```'), /tabs.close/);
  assert.throws(() => checkExamples('```json\n{bad}\n```'), /Invalid JSON/);
  assert.throws(() => checkExamples('<!-- docs-test: skip -->\n```sh\nweft bad\n```'), /reason/);
  assert.equal(checkExamples('<!-- docs-test: skip Demonstrates a deliberate error -->\n```sh\nweft bad\n```').skipped.length, 1);
  assert.equal(checkExamples('```sh\nnpm run cli -- tabs.list\n```').checked.length, 1);
});

test('guidance skill reference is generated from the registry and references real commands', () => {
  assert.equal(readFileSync(new URL('../skills/weft/references/guidance.md', import.meta.url), 'utf8'), renderGuidance());
  for (const [topic, entry] of Object.entries(GUIDANCE)) {
    assert.equal(getGuidance(topic).text, entry.text);
    for (const command of entry.commands) assert.ok(Object.hasOwn(commands, command), `${topic}: unknown ${command}`);
  }
  assert.throws(() => getGuidance('toString'), /Unknown guidance/);
});
