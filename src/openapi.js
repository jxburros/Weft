import { z } from 'zod';
import { commands } from './commands.js';
import { turnFrameSchema } from './turn-relay.js';

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
  const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 415, 422, 503, 504].map(status => [status, {
    description: ({ 400: 'Invalid command or arguments', 401: 'Missing or invalid bearer token', 403: 'Browser-origin access denied', 413: 'Request exceeds 1 MiB', 415: 'JSON content type required', 422: 'Command failed', 404: 'Target not found', 409: 'Stale state, lease conflict, or cancellation', 503: 'Unavailable', 504: 'Timeout' })[status],
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  }]));
  return {
    openapi: '3.1.0',
    info: { title: 'Weft local browser API', version: '1.0.0', description: 'Authenticated loopback control plane. The token grants broad local automation access; human-only operations remain unavailable. Browser-origin requests are rejected. No remote TLS service or per-client scopes are provided.' },
    servers: [{ url: 'http://127.0.0.1:9222', description: 'Default; WEFT_PORT may change the port' }],
    security: [{ localBearer: [] }],
    paths: {
      '/v1/commands': { get: { operationId: 'listCommands', summary: 'Discover validated commands', responses: { 200: { description: 'Command names, descriptions and JSON input schemas' }, 401: errors[401], 403: errors[403] } } },
      '/v1/execute': { post: { operationId: 'executeCommand', summary: 'Execute a canonical command', requestBody: { required: true, content: { 'application/json': { schema: { oneOf: variants } } } }, description: 'Send Accept: text/event-stream to receive turn.* progress frames (ids <turnId>:<seq>) followed by one `outcome` event carrying the CommandOutcome. Disconnecting the originating request before the outcome cancels the command; a cancelled model turn keeps its partial reply marked interrupted.', responses: { 200: { description: 'Command result', content: { 'application/json': { schema: { $ref: '#/components/schemas/CommandOutcome' } }, 'text/event-stream': { schema: { type: 'string' }, description: 'turn.start/request/phase/delta/end frames, then event: outcome' } } }, ...errors } } },
      '/v1/openapi.json': { get: { operationId: 'getOpenApi', summary: 'Read this generated API contract', responses: { 200: { description: 'OpenAPI 3.1 document' }, 401: errors[401], 403: errors[403] } } },
      '/v1/events': { get: { operationId: 'subscribeEvents', summary: 'Subscribe to sanitized live metadata', description: 'Server-sent events with type/command/status/actor/workspace/target/record-id/version metadata only. No arguments, results, page text, URL, titles, error messages, model text or secrets. Each event has an id <boot>-<seq>; reconnect with Last-Event-ID to replay retained later events (bounded in-memory retention: 1000 events, 1 MiB, 15 minutes). When requested events are no longer retained, the process restarted, or the id is unknown, an `event: gap` frame precedes the replay; re-read current state. Send the bearer token as a header; browser EventSource access is intentionally denied. Maximum 16 subscribers; slow consumers are disconnected.', responses: { 200: { description: 'Connected comment followed by weft events and heartbeat comments', content: { 'text/event-stream': { schema: { type: 'string' } } } }, 401: errors[401], 403: errors[403], 503: { description: 'Subscriber limit reached' } } } },
      '/v1/turns/{turnId}/events': { get: { operationId: 'followTurn', summary: 'Follow or resume one model turn stream',
        description: 'Replays retained turn frames after Last-Event-ID (<turnId>:<seq>) then streams live frames until turn.end. Frames include model reply text and require the read scope and access to the turn workspace. Retention is bounded (10000 frames / 4 MiB per turn, 60 s after the turn ends); dropped frames produce `event: gap`. Disconnecting a follower never stops the turn.',
        parameters: [{ name: 'turnId', in: 'path', required: true, schema: { type: 'string', pattern: '^turn_[0-9a-f-]{36}$' } }, { name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string' } }],
        responses: { 200: { description: 'turn.* frames', content: { 'text/event-stream': { schema: { type: 'string' }, description: 'Each data payload is a TurnFrame' } } }, 401: errors[401], 403: errors[403], 404: errors[404], 503: { description: 'Subscriber limit reached' } } } },
    },
    components: {
      securitySchemes: { localBearer: { type: 'http', scheme: 'bearer', description: 'WEFT_TOKEN configured at startup or the generated local token' } },
      schemas: { ...schemas,
        CommandError: { type: 'object', required: ['code', 'message'], properties: {
          code: { type: 'string', description: 'Stable machine-readable error code; see docs/COMMANDS.md.' },
          message: { type: 'string' }, field: { type: ['string', 'null'] },
          allowed: { type: 'array', items: {} }, suggestions: { type: 'array', items: { type: 'string' } },
          schema: { type: 'string' }, details: { type: 'object', description: 'Allowlisted state diagnostics such as visible target candidates or emergency stop time.' }, issues: { type: 'array', items: { type: 'object' } }, httpStatus: { type: 'integer' },
        } },
        CommandOutcome: { type: 'object', required: ['schemaVersion', 'command', 'execution', 'validation', 'review', 'workspaceId', 'tabId', 'normalized', 'result', 'error'], properties: {
          schemaVersion: { const: 1 }, command: { type: ['string', 'null'] },
          execution: { enum: ['succeeded', 'failed', 'cancelled', 'not_started'] },
          validation: { enum: ['passed', 'failed', 'not_run'] }, review: { enum: ['not_required', 'required'] },
          workspaceId: { type: ['string', 'null'] }, tabId: { type: ['integer', 'null'] },
          normalized: { type: 'array', items: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } },
          result: {}, error: { anyOf: [{ type: 'null' }, { $ref: '#/components/schemas/CommandError' }] },
        } },
        ApiError: { $ref: '#/components/schemas/CommandOutcome' },
        TurnFrame: (({ $schema, ...schema }) => schema)(z.toJSONSchema(turnFrameSchema)),
      },
    },
  };
}
