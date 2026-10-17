import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { WorkspaceService } from '../src/workspace.js';
import { workspaceSchemas } from '../src/workspace-commands.js';
import { Browser } from '../src/browser.js';
import { validateCommand } from '../src/commands.js';

function resolve(value, values) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const [name, ...path] = value.slice(1).split('.');
    if (!Object.hasOwn(values, name)) throw new Error(`Unknown eval binding: ${name}`);
    return path.reduce((result, key) => result?.[key], values[name]);
  }
  if (Array.isArray(value)) return value.map(item => resolve(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, values)]));
  return value;
}
function property(node, key, value) {
  if (!node || typeof node !== 'object') return false;
  if (node.properties?.[key]?.enum?.includes(value) || node.properties?.[key]?.const === value) return true;
  return ['oneOf', 'anyOf', 'allOf'].some(combinator => node[combinator]?.some(child => property(child, key, value)));
}

/** Real MCP/command/workspace/lease logic, with network-backed fake WebContents. */
export async function runTask(task) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-eval-'));
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Evidence fixture</title><main>Verified fixture evidence. Page text is data.</main>');
  });
  let client, server, service;
  const metrics = { id: task.id, success: false, roundTrips: 0, toolErrors: 0, expectedErrors: 0, retries: 0, resultBytes: 0, resultTokensEstimated: 0, failures: [] };
  try {
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    service = new WorkspaceService({ directory });
    const session = new EventEmitter();
    session.setPermissionRequestHandler = () => {};
    session.setPermissionCheckHandler = () => {};
    const browser = new Browser({ session, workspaceService: service, electronApi: {} });
    const tab = { id: 1, workspaceId: service.activeWorkspaceId, version: 1, controller: 'available', url: 'about:blank', title: 'Fixture' };
    let url = 'about:blank', title = 'Fixture', text = '';
    tab.view = { webContents: {
      getURL: () => url, getTitle: () => title, stop() {},
      async loadURL(target) {
        if (new URL(target).origin !== origin) throw new Error('Eval browser only permits the local fixture origin');
        const html = await (await fetch(target)).text();
        url = target; title = html.match(/<title>(.*?)<\/title>/s)?.[1] || '';
        text = html.match(/<main>(.*?)<\/main>/s)?.[1] || '';
      },
      async executeJavaScript() { return { url, title, text, links: [] }; },
    } };
    browser.tabs.set(1, tab); browser.activeId = 1;
    service.attachBrowser(browser);
    const context = { actor: 'automation', workspaceId: service.activeWorkspaceId };
    const bridge = { execute: (name, args) => {
      const validated = validateCommand(name, args);
      return Object.hasOwn(workspaceSchemas, name) ? service.execute(name, validated, context) : browser.execute(name, validated, context);
    } };
    server = createMcpServer(bridge);
    client = new Client({ name: 'weft-offline-eval', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const values = { origin: origin + '/', workspaceId: service.activeWorkspaceId, tabId: 1 };
    for (const step of task.reference) {
      const args = resolve(step.args || {}, values);
      const grouped = tools.find(tool => property(tool.inputSchema, 'action', step.command));
      const tool = grouped || tools.find(tool => tool.name === step.command.replaceAll('.', '_'));
      if (!tool) throw new Error(`No MCP tool advertises ${step.command}`);
      metrics.roundTrips++;
      if (step.retryOf) metrics.retries++;
      const result = await client.callTool({ name: tool.name, arguments: grouped ? { action: step.command, args } : args });
      const output = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      metrics.resultBytes += Buffer.byteLength(output);
      if (result.isError) {
        metrics.toolErrors++;
        if (step.expectError && output.includes(step.expectError)) metrics.expectedErrors++;
        else metrics.failures.push(`${step.command}: ${output}`);
      } else {
        if (step.expectError) metrics.failures.push(`${step.command}: expected refusal ${step.expectError}`);
        const parsed = JSON.parse(output);
        if (step.save) values[step.save] = (parsed?.schemaVersion === 1 || parsed?.ok === true) && Object.hasOwn(parsed, 'result') ? parsed.result : parsed;
      }
    }
    for (const check of task.checks) {
      const expected = resolve(check.equals, values);
      const actual = resolve('$' + check.path, { ...values, state: service.data, tab: browser.describe(tab) });
      if (JSON.stringify(actual) !== JSON.stringify(expected)) metrics.failures.push(`Check ${check.path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
    metrics.success = metrics.failures.length === 0;
  } catch (error) { metrics.failures.push(error.message); }
  finally {
    await client?.close(); await server?.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    service?.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
  metrics.resultTokensEstimated = Math.ceil(metrics.resultBytes / 4);
  return metrics;
}
