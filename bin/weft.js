#!/usr/bin/env node
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
        : await client.execute(command, JSON.parse(json));
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(`weft: ${error.message}`);
    process.exitCode = 1;
  }
}
