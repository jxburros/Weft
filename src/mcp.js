import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { commands, validateCommand } from './commands.js';

export function createMcpServer(client) {
  const server = new Server({ name: 'weft', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(commands).map(([name, definition]) => ({
      name: name.replaceAll('.', '_'),
      ...definition,
    })),
  }));
  const names = Object.fromEntries(Object.keys(commands).map(name => [name.replaceAll('.', '_'), name]));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      if (!Object.hasOwn(names, params.name)) throw new Error(`Unknown tool: ${params.name}`);
      const name = names[params.name];
      const result = await client.execute(name, validateCommand(name, params.arguments));
      if (name === 'page.screenshot') {
        return { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  return server;
}

export async function startMcp(client) {
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
  return server;
}
