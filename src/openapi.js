import { commands } from './commands.js';

/** Generated from the same JSON schemas used by GUI, CLI, REST and MCP. */
export function createOpenApiDocument(catalog = commands) {
  const schemas = {};
  const variants = Object.entries(catalog).map(([command, definition]) => {
    const { $schema, ...schema } = definition.inputSchema;
    schemas[command] = schema;
    return {
      type: 'object', additionalProperties: false,
      required: ['command', ...(schema.required?.length ? ['args'] : [])],
      properties: { command: { type: 'string', const: command }, args: { $ref: `#/components/schemas/${command}` } },
      description: definition.description,
    };
  });
  const errors = Object.fromEntries([400, 401, 403, 413, 415, 422].map(status => [status, {
    description: ({ 400: 'Invalid command or arguments', 401: 'Missing or invalid bearer token', 403: 'Browser-origin access denied', 413: 'Request exceeds 1 MiB', 415: 'JSON content type required', 422: 'Command failed or policy denied' })[status],
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  }]));
  return {
    openapi: '3.1.0',
    info: { title: 'Weft local browser API', version: '1.0.0', description: 'Authenticated loopback control plane. The token grants broad local automation access; human-only operations remain unavailable. Browser-origin requests are rejected. No remote TLS service or per-client scopes are provided.' },
    servers: [{ url: 'http://127.0.0.1:9222', description: 'Default; WEFT_PORT may change the port' }],
    security: [{ localBearer: [] }],
    paths: {
      '/v1/commands': { get: { operationId: 'listCommands', summary: 'Discover validated commands', responses: { 200: { description: 'Command names, descriptions and JSON input schemas' }, 401: errors[401], 403: errors[403] } } },
      '/v1/execute': { post: { operationId: 'executeCommand', summary: 'Execute a canonical command', requestBody: { required: true, content: { 'application/json': { schema: { oneOf: variants } } } }, responses: { 200: { description: 'Command result', content: { 'application/json': { schema: { type: 'object', required: ['result'], properties: { result: {} } } } } }, ...errors } } },
      '/v1/openapi.json': { get: { operationId: 'getOpenApi', summary: 'Read this generated API contract', responses: { 200: { description: 'OpenAPI 3.1 document' }, 401: errors[401], 403: errors[403] } } },
      '/v1/events': { get: { operationId: 'subscribeEvents', summary: 'Subscribe to sanitized live metadata', description: 'Server-sent events with command/status/actor/workspace/target/version metadata only. No arguments, results, page text, URL, titles, error messages or secrets. Live-only: no replay or Last-Event-ID recovery. Send the bearer token as a header; browser EventSource access is intentionally denied. Maximum 16 subscribers; slow consumers are disconnected.', responses: { 200: { description: 'Connected comment followed by weft events and heartbeat comments', content: { 'text/event-stream': { schema: { type: 'string' } } } }, 401: errors[401], 403: errors[403], 503: { description: 'Subscriber limit reached' } } } },
    },
    components: {
      securitySchemes: { localBearer: { type: 'http', scheme: 'bearer', description: 'WEFT_TOKEN configured at startup or the generated local token' } },
      schemas: { ...schemas, ApiError: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } } } } },
    },
  };
}
