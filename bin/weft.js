#!/usr/bin/env node
import { errorOutcome, resultExitCode } from '../src/commands.js';
import { createClient } from '../src/client.js';

// --deadline-ms <ms> (or --deadline-ms=<ms>) may appear anywhere; it bounds the whole command.
const argv = process.argv.slice(2);
let deadlineMs;
let deadlineError = null;
for (let index = 0; index < argv.length; index++) {
  const match = /^--deadline-ms(?:=(.*))?$/.exec(argv[index]);
  if (!match) continue;
  const value = match[1] ?? argv[index + 1];
  argv.splice(index, match[1] === undefined ? 2 : 1);
  index--;
  if (!/^\d{1,7}$/.test(value ?? '') || Number(value) < 1 || Number(value) > 600000) deadlineError = 'Use --deadline-ms with an integer from 1 to 600000';
  else deadlineMs = Number(value);
}
const [command, json = '{}', ...extra] = argv;
if (!command || ['help', '--help', '-h'].includes(command)) {
  console.log(`Usage: weft commands | <command> [JSON arguments] | mcp

Connects to the running Weft browser using WEFT_TOKEN.
WEFT_API_URL defaults to http://127.0.0.1:9222.
Options: --deadline-ms <ms> stops waiting after ms; the outcome says whether the command started.
Discovery: weft weft.capabilities
Examples:
  weft tabs.new '{"url":"https://example.com"}'
  weft page.screenshot '{"tabId":1}'

Offline backup maintenance (Weft closed): weft store backups|verify|restore <directory> [backup id]`);
} else if (command === 'store') {
  // Local maintenance does not use the API: a damaged database cannot serve one.
  try {
    const { runStoreCommand } = await import('../src/store-cli.js');
    const result = runStoreCommand(process.argv.slice(3));
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'failed') process.exitCode = 1;
  } catch (error) {
    console.error(error.code === 'invalid_arguments' ? error.message : `${error.code || 'store_error'}: ${error.message}`);
    process.exitCode = error.code === 'invalid_arguments' ? 2 : error.code === 'STORE_LOCKED' ? 4 : 1;
  }
} else {
  try {
    if (extra.length) throw Object.assign(new Error('Pass command arguments as one JSON object'), { code: 'invalid_arguments' });
    if (deadlineError) throw Object.assign(new Error(deadlineError), { code: 'invalid_arguments' });
    let client;
    try { client = createClient(); }
    catch (error) { error.code = 'invalid_arguments'; throw error; }
    if (command === 'mcp') {
      const { startMcp } = await import('../src/mcp.js');
      await startMcp(client);
    } else {
      const result = command === 'commands'
        ? await client.listCommands()
        : await client.executeOutcome(command, JSON.parse(json), deadlineMs !== undefined ? { deadlineMs } : {});
      console.log(JSON.stringify(result, null, 2));
      if (command !== 'commands') process.exitCode = resultExitCode(result);
    }
  } catch (error) {
    if (error instanceof SyntaxError) error.message = 'Invalid JSON arguments. Supply one JSON object.';
    const outcome = errorOutcome(Object.assign(error, { code: error instanceof SyntaxError ? 'invalid_json' : error.code || 'transport_error' }), command, {}, [], error instanceof SyntaxError || error.code === 'invalid_arguments' ? 'failed' : 'not_run');
    const write = command === 'mcp' ? console.error : console.log;
    write(JSON.stringify(outcome, null, 2));
    process.exitCode = resultExitCode(outcome);
  }
}
