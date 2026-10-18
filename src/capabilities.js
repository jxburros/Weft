import { createHash } from 'node:crypto';
import { WEFT_VERSION } from './version.js';
import { MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, PAGEABLE } from './pagination.js';
import { TRANSFER_LIMITS } from './transfers.js';
import { MAX_VECTORS_PER_WORKSPACE } from './vector-index.js';

/** Capability and version discovery (ADR 018): what this Weft build supports, for agents and integrations. */
export const capabilityCommandDefinitions = {
  'weft.capabilities': ['Discover API version, command catalog hash, outcome taxonomy, limits and supported integration features', {}],
};
export const MAX_DEADLINE_MS = 600000;
export const DEADLINE_GRACE_MS = 1000;
export const MCP_RESOURCES = Object.freeze(['weft://capabilities', 'weft://guide/{topic}', 'weft://reference/commands', 'weft://reference/commands/{command}',
  'weft://workspaces', 'weft://workspaces/{workspaceId}/{collection}', 'weft://workspaces/{workspaceId}/{collection}/{id}']);

let catalogHash = null;
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);

export function describeCapabilities({ commands, outcomeStatuses, errorHttpStatus, errorStatus, exitCodes, apiVersion, eventTypes = [], eventRetention = null, context = {}, embeddings = true }) {
  catalogHash ??= createHash('sha256').update(canonical(commands)).digest('hex');
  return {
    apiVersion, weftVersion: WEFT_VERSION, outcomeSchemaVersion: 1,
    catalog: { commands: Object.keys(commands).length, sha256: catalogHash, discovery: ['GET /v1/commands', 'GET /v1/openapi.json', 'weft_reference (MCP)', 'weft commands (CLI)'] },
    outcomes: { statuses: [...outcomeStatuses], field: 'status',
      errors: Object.fromEntries(Object.keys(errorHttpStatus).sort().map(code => [code, { status: errorStatus[code], httpStatus: errorHttpStatus[code], exitCode: exitCodes[code] ?? 1 }])) },
    caller: { actor: typeof context.actor === 'string' ? context.actor : null, clientId: context.clientId ?? null, workspaceIds: context.workspaceIds ? [...context.workspaceIds] : null,
      taskId: context.taskId ?? null, scopes: context.scopes ? [...context.scopes] : null },
    limits: { restRequestBytes: 1024 * 1024, batchCommands: 100, batchCommandsNeedingApproval: 20, pageLimit: MAX_PAGE_LIMIT, deadlineMs: MAX_DEADLINE_MS },
    features: {
      streaming: { rest: { accept: 'text/event-stream', commands: ['chat.send'], turnReplay: '/v1/turns/{turnId}/events' }, cli: false, mcp: false },
      batch: { command: 'batch.execute', atomic: true, placeholders: '$N.id' },
      idempotency: { argument: 'requestId', resultRetentionDays: 7, fingerprintRetentionDays: 30, maxRetainedResultBytes: 1024 * 1024 },
      dryRun: { argument: 'dryRun' },
      expectedState: { tabs: 'expectedVersion', records: 'expectedRevision', staleCode: 'stale_state' },
      deadlines: { rest: ['Weft-Deadline-Ms header', 'deadlineMs body field'], cli: '--deadline-ms <ms>', mcp: 'deadlineMs tool argument', maxMs: MAX_DEADLINE_MS, graceMs: DEADLINE_GRACE_MS,
        code: 'deadline_exceeded', effects: ['not_started', 'rolled_back', 'stopped', 'uncertain'] },
      pagination: { argument: 'page', result: '{items, nextCursor, total}', defaultLimit: DEFAULT_PAGE_LIMIT, maxLimit: MAX_PAGE_LIMIT, commands: [...PAGEABLE].filter(name => Object.hasOwn(commands, name)).sort(), alsoPaged: ['activity.list', 'events.list'] },
      eventReplay: { sse: '/v1/events', command: 'events.list', cursor: 'Last-Event-ID / after', types: [...eventTypes].sort(), ...(eventRetention && { retention: eventRetention }), persisted: false },
      transfers: { commands: ['transfers.begin', 'transfers.append', 'transfers.commit', 'transfers.abort', 'transfers.list', 'transfers.read'], download: 'GET /v1/download', ...TRANSFER_LIMITS },
      search: { lexical: 'fts5-bm25', hybrid: embeddings ? 'opt-in per workspace (search.configureEmbeddings, human-only)' : false, fusion: 'reciprocal-rank', k: 60, maxVectorsPerWorkspace: MAX_VECTORS_PER_WORKSPACE, verifiedAbsence: 'search.query with page' },
      mcp: { tools: 'grouped weft_* tools plus weft_reference', resources: [...MCP_RESOURCES] },
    },
  };
}
