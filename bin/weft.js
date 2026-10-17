#!/usr/bin/env node
import { errorOutcome, resultExitCode } from '../src/commands.js';
import { createClient } from '../src/client.js';

const [command, json = '{}', ...extra] = process.argv.slice(2);
if (!command || ['help', '--help', '-h'].includes(command)) {
  console.log(`Usage: weft commands | <command> [JSON arguments] | mcp

Connects to the running Weft browser using WEFT_TOKEN.
WEFT_API_URL defaults to http://127.0.0.1:9222.
Examples:
  weft tabs.new '{"url":"https://example.com"}'
  weft page.screenshot '{"tabId":1}'`);
} else {
  try {
    if (extra.length) throw new Error('Pass command arguments as one JSON object');
    const client = createClient();
    if (command === 'mcp') {
      const { startMcp } = await import('../src/mcp.js');
      await startMcp(client);
    } else {
      const result = command === 'commands'
        ? await client.listCommands()
        : await client.executeOutcome(command, JSON.parse(json));
      console.log(JSON.stringify(result, null, 2));
      if (command !== 'commands') process.exitCode = resultExitCode(result);
    }
  } catch (error) {
    if (error instanceof SyntaxError) error.message = 'Invalid JSON arguments. Supply one JSON object.';
    const outcome = errorOutcome(Object.assign(error, { code: error instanceof SyntaxError ? 'invalid_json' : 'invalid_arguments' }), command, {}, [], 'failed');
    console.log(JSON.stringify(outcome, null, 2));
    process.exitCode = resultExitCode(outcome);
  }
}
