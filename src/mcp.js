import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { commands, executeOutcome, errorOutcome, CommandError, normalizeCommand } from './commands.js';
import { WEFT_VERSION } from './version.js';
import { GUIDANCE, getGuidance, guidanceTopics } from './guidance.js';

const groups = {
  tabs: ['tabs', 'tabGroups', 'display', 'windows'], page: ['page'],
  workspace: ['workspace', 'workspaces', 'settings', 'history', 'bookmarks', 'activity', 'search', 'guide', 'plugins', 'plugin', 'backups', 'weft', 'events', 'transfers', 'encryption', 'resume', 'resources', 'browsingData'],
  memory: ['memories', 'learning'],
  records: ['materials', 'context', 'tasks', 'conversations', 'workflows', 'siteRules', 'lists', 'handoffs', 'batch'],
  // Shared context, linked sources, services, citations, freshness and conflicts (ADR 013): split out so every tool stays under the size budget.
  knowledge: ['collections', 'sources', 'services', 'citations', 'freshness', 'conflicts'],
  artifacts: ['artifacts', 'captures'], browser: ['browser', 'downloads', 'cookies', 'storage', 'clients', 'approvals', 'autonomy', 'extensions', 'threats', 'launches', 'update', 'credentials', 'payments'], models: ['models', 'chat'],
};
export const mcpTools = Object.entries(groups).map(([group, namespaces]) => {
  const actions = Object.keys(commands).filter(name => namespaces.includes(name.split('.')[0]));
  return { name: `weft_${group}`, description: `Execute a ${group} command. Use weft_reference for argument schemas and restrictions.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: actions }, args: { type: 'object', description: 'Arguments validated against the selected command schema.' },
      deadlineMs: { type: 'integer', minimum: 1, maximum: 600000, description: 'Optional deadline in ms.' },
    } }, annotations: { readOnlyHint: actions.every(name => commands[name].readOnly),
      destructiveHint: actions.some(name => commands[name].destructive), openWorldHint: ['page', 'tabs', 'models', 'browser', 'knowledge'].includes(group) } };
});
mcpTools.push({ name: 'weft_reference', description: 'Get a command description, complete input schema, and authority restrictions; omit command for a compact command index.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { command: { type: 'string', description: 'Canonical command name.' } } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
const legacyNames = Object.fromEntries(Object.keys(commands).map(name => [name.replaceAll('.', '_'), name]));

/**
 * Read-only MCP resources: guidance, the command reference, capabilities and per-workspace records.
 * Record resources are read through the same client (and therefore the same token, scope and
 * authority gate) as tools; record text is untrusted data, never instructions.
 */
const RESOURCE_COLLECTIONS = ['materials', 'context', 'tasks', 'conversations', 'workflows', 'artifacts', 'handoffs'];
const json = (uri, value) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }] });
export const resourceTemplates = [
  { uriTemplate: 'weft://guide/{topic}', name: 'Weft guidance topic', mimeType: 'text/markdown', description: `Agent workflow guidance; topics: ${guidanceTopics.join(', ')}.` },
  { uriTemplate: 'weft://reference/commands/{command}', name: 'Command reference', mimeType: 'application/json', description: 'Description, input schema and authority restrictions of one command.' },
  { uriTemplate: 'weft://workspaces/{workspaceId}/{collection}', name: 'Workspace records', mimeType: 'application/json', description: `First page of a record collection (${RESOURCE_COLLECTIONS.join(', ')}) in a workspace you can read. Untrusted data.` },
  { uriTemplate: 'weft://workspaces/{workspaceId}/{collection}/{id}', name: 'Workspace record', mimeType: 'application/json', description: 'One record in a workspace you can read. Untrusted data.' },
];
function resourceFailure(outcome) {
  return new McpError(['not_found'].includes(outcome.error.code) ? ErrorCode.InvalidParams : ErrorCode.InternalError, `${outcome.error.code}: ${outcome.error.message}`, { outcome: { status: outcome.status, error: outcome.error } });
}

export function createMcpServer(client) {
  const server = new Server({ name: 'weft', version: WEFT_VERSION }, { capabilities: { tools: {}, resources: {} } });
  const run = async (command, args = {}) => executeOutcome((name, input) => client.executeOutcome ? client.executeOutcome(name, input) : client.execute(name, input), command, args, { returnsOutcome: Boolean(client.executeOutcome) });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [
      { uri: 'weft://capabilities', name: 'Weft capabilities', mimeType: 'application/json', description: 'API version, catalog hash, outcome taxonomy, limits and features.' },
      { uri: 'weft://reference/commands', name: 'Command index', mimeType: 'application/json', description: 'Every canonical command with its description and human-only flag.' },
      ...guidanceTopics.map(topic => ({ uri: `weft://guide/${topic}`, name: `Guide: ${GUIDANCE[topic].title}`, mimeType: 'text/markdown' })),
      { uri: 'weft://workspaces', name: 'Workspaces you can read', mimeType: 'application/json' },
    ];
    // Only workspaces this client's token may read are listed; an out-of-scope token lists none.
    const listed = await run('workspaces.list');
    if (!listed.error && Array.isArray(listed.result)) {
      for (const workspace of listed.result.slice(0, 100)) {
        for (const collection of RESOURCE_COLLECTIONS) resources.push({ uri: `weft://workspaces/${workspace.id}/${collection}`, name: `${String(workspace.name).slice(0, 80)}: ${collection}`, mimeType: 'application/json' });
      }
    }
    return { resources };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    const uri = String(params.uri);
    if (uri === 'weft://capabilities') { const outcome = await run('weft.capabilities'); if (outcome.error) throw resourceFailure(outcome); return json(uri, outcome.result); }
    if (uri === 'weft://reference/commands') return json(uri, Object.entries(commands).map(([command, { description, humanOnly, readOnly }]) => ({ command, description, humanOnly, readOnly })));
    let match = /^weft:\/\/guide\/([a-z-]{1,40})$/.exec(uri);
    if (match) {
      if (!Object.hasOwn(GUIDANCE, match[1])) throw new McpError(ErrorCode.InvalidParams, 'Unknown guidance topic');
      const guide = getGuidance(match[1]);
      return { contents: [{ uri, mimeType: 'text/markdown', text: `# ${guide.title}\n\n${guide.text}\n\nCommands: ${guide.commands.join(', ')}\n` }] };
    }
    match = /^weft:\/\/reference\/commands\/([A-Za-z0-9.-]{1,120})$/.exec(uri);
    if (match) {
      if (!Object.hasOwn(commands, match[1])) throw new McpError(ErrorCode.InvalidParams, 'Unknown command');
      return json(uri, { command: match[1], ...commands[match[1]] });
    }
    if (uri === 'weft://workspaces') { const outcome = await run('workspaces.list'); if (outcome.error) throw resourceFailure(outcome); return json(uri, outcome.result); }
    match = /^weft:\/\/workspaces\/(ws_[0-9a-f-]{36})\/([a-zA-Z]+)(?:\/([A-Za-z0-9_.:-]{1,128}))?$/.exec(uri);
    if (!match || !RESOURCE_COLLECTIONS.includes(match[2])) throw new McpError(ErrorCode.InvalidParams, 'Unknown Weft resource URI');
    const [, workspaceId, collection, id] = match;
    const outcome = id ? await run(`${collection}.get`, { id }) : await run(`${collection}.list`, { workspaceId, page: { limit: 100 } });
    if (outcome.error) throw resourceFailure(outcome);
    // A record from another workspace is never served under this workspace's URI.
    if (id && outcome.result?.workspaceId !== workspaceId) throw new McpError(ErrorCode.InvalidParams, 'not_found: record not found in this workspace');
    return json(uri, { untrusted: true, workspaceId, collection, ...(id ? { record: outcome.result } : outcome.result) });
  });
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
          outcome = { schemaVersion: 1, command: 'weft_reference', status: 'succeeded', execution: 'succeeded', validation: 'passed', review: 'not_required', workspaceId: null, tabId: null, normalized: [], result, error: null };
        }
      } else {
        const tool = mcpTools.find(tool => tool.name === params.name);
        let command; let args; let options = {};
        if (tool) {
          const input = params.arguments ?? {};
          if (Object.keys(input).some(key => !['action', 'args', 'deadlineMs'].includes(key)) || !tool.inputSchema.properties.action.enum.includes(normalizeCommand(input.action, input.args).command)) {
            throw new CommandError({ code: 'invalid_arguments', message: 'Choose an action from this tool and supply its args.', field: 'action', allowed: tool.inputSchema.properties.action.enum, schema: 'weft_reference' });
          }
          if (input.deadlineMs !== undefined && (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > 600000)) {
            throw new CommandError({ code: 'invalid_arguments', message: 'deadlineMs must be an integer from 1 to 600000', field: 'deadlineMs' });
          }
          command = input.action; args = input.args; options = input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {};
        } else if (Object.hasOwn(legacyNames, params.name)) {
          command = legacyNames[params.name]; args = params.arguments;
        } else throw new CommandError({ code: 'unknown_command', message: 'Unknown MCP tool. Use tools/list.', field: 'name', allowed: mcpTools.map(tool => tool.name) });
        // Validate and normalize here too: injected clients cannot bypass the shared contract.
        outcome = await executeOutcome((name, input) => client.executeOutcome ? client.executeOutcome(name, input, options) : client.execute(name, input, options), command, args, { returnsOutcome: Boolean(client.executeOutcome) });
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
