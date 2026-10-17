import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { commands, executeOutcome, errorOutcome, CommandError, normalizeCommand } from './commands.js';

const groups = {
  tabs: ['tabs'], page: ['page'],
  workspace: ['workspace', 'workspaces', 'settings', 'history', 'bookmarks', 'activity', 'search', 'guide', 'plugins', 'plugin'],
  records: ['materials', 'context', 'tasks', 'conversations', 'workflows', 'siteRules', 'lists', 'handoffs'],
  artifacts: ['artifacts'], browser: ['browser', 'downloads', 'cookies', 'storage', 'clients', 'approvals', 'autonomy', 'extensions'], models: ['models', 'chat'],
};
export const mcpTools = Object.entries(groups).map(([group, namespaces]) => {
  const actions = Object.keys(commands).filter(name => namespaces.includes(name.split('.')[0]));
  return { name: `weft_${group}`, description: `Execute a ${group} command. Use weft_reference for argument schemas and restrictions.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: actions }, args: { type: 'object', description: 'Arguments validated against the selected command schema.' },
    } }, annotations: { readOnlyHint: actions.every(name => commands[name].readOnly),
      destructiveHint: actions.some(name => commands[name].destructive), openWorldHint: ['page', 'tabs', 'models', 'browser'].includes(group) } };
});
mcpTools.push({ name: 'weft_reference', description: 'Get a command description, complete input schema, and authority restrictions; omit command for a compact command index.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { command: { type: 'string', description: 'Canonical command name.' } } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
const legacyNames = Object.fromEntries(Object.keys(commands).map(name => [name.replaceAll('.', '_'), name]));

export function createMcpServer(client) {
  const server = new Server({ name: 'weft', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    let outcome;
    try {
      if (params.name === 'weft_reference') {
        const args = params.arguments ?? {};
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'command') || (args.command !== undefined && typeof args.command !== 'string')) {
          throw new CommandError({ code: 'invalid_arguments', message: 'Supply only an optional command string.', field: 'command' });
        }
        if (args.command && !Object.hasOwn(commands, args.command)) {
          outcome = await executeOutcome(() => {}, args.command, {});
        } else {
          const result = args.command ? { command: args.command, ...commands[args.command] } : Object.entries(commands).map(([command, { description, humanOnly }]) => ({ command, description, humanOnly }));
          outcome = { schemaVersion: 1, command: 'weft_reference', execution: 'succeeded', validation: 'passed', review: 'not_required', workspaceId: null, tabId: null, normalized: [], result, error: null };
        }
      } else {
        const tool = mcpTools.find(tool => tool.name === params.name);
        let command; let args;
        if (tool) {
          const input = params.arguments ?? {};
          if (Object.keys(input).some(key => !['action', 'args'].includes(key)) || !tool.inputSchema.properties.action.enum.includes(normalizeCommand(input.action, input.args).command)) {
            throw new CommandError({ code: 'invalid_arguments', message: 'Choose an action from this tool and supply its args.', field: 'action', allowed: tool.inputSchema.properties.action.enum, schema: 'weft_reference' });
          }
          command = input.action; args = input.args;
        } else if (Object.hasOwn(legacyNames, params.name)) {
          command = legacyNames[params.name]; args = params.arguments;
        } else throw new CommandError({ code: 'unknown_command', message: 'Unknown MCP tool. Use tools/list.', field: 'name', allowed: mcpTools.map(tool => tool.name) });
        // Validate and normalize here too: injected clients cannot bypass the shared contract.
        outcome = await executeOutcome((name, input) => client.executeOutcome ? client.executeOutcome(name, input) : client.execute(name, input), command, args, { returnsOutcome: Boolean(client.executeOutcome) });
      }
    } catch (error) { outcome = errorOutcome(error, null, {}, [], 'failed'); }
    const content = [{ type: 'text', text: JSON.stringify(outcome) }];
    if (!outcome.error && outcome.command === 'page.screenshot' && outcome.result?.data) {
      content.push({ type: 'image', data: outcome.result.data, mimeType: outcome.result.mimeType });
    }
    return { content, structuredContent: outcome, ...(outcome.error && { isError: true }) };
  });
  return server;
}

export async function startMcp(client) {
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
  return server;
}
