# Connecting from the CLI, MCP and REST

Weft's GUI, CLI, MCP bridge and REST API share one validated command catalog.
This page covers how to reach it from outside the app and how agent authority is
enforced. For guidance on writing an integration, see
[agent integration](AGENT-INTEGRATION.md); for every command, see the
[command reference](COMMANDS.md).

## CLI and MCP

Keep the browser running and give the CLI the same token:

```sh
node bin/weft.js commands
node bin/weft.js workspaces.list
node bin/weft.js tabs.new '{"url":"https://example.com"}'
node bin/weft.js page.readable
node bin/weft.js materials.create '{"title":"Research note","content":"Questions to explore","kind":"note"}'
node bin/weft.js tasks.create '{"title":"Review the source","objective":"Check the evidence"}'
node bin/weft.js artifacts.capture '{"kind":"bundle","title":"Source reference"}'
```

`npm run cli -- <command> '<JSON arguments>'` is equivalent. `npm link` optionally
installs the `weft` command. Command outcomes, including command failures, are
JSON on stdout; process/protocol diagnostics use stderr. See
[the command contract](COMMANDS.md) for stable error and exit codes. Screenshots require a visible tab. Hidden-tab bundles retain readable text
and report an unavailable image rather than inventing one.

For MCP, configure your client:

```json
{
  "mcpServers": {
    "weft": {
      "command": "node",
      "args": ["/absolute/path/to/Weft/bin/weft.js", "mcp"],
      "env": {
        "WEFT_TOKEN": "<same token as the running browser>",
        "WEFT_API_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

MCP advertises ten grouped tools, including `weft_reference` for command
discovery. Execution tools accept a canonical command as `action` and its `args`;
legacy underscore names such as `page_readable` remain accepted but unadvertised.
Schemas and structured outcomes are shared. Screenshots retain MCP image content.
The bridge writes only protocol messages to stdout. `WEFT_API_URL` accepts loopback HTTP origins only and clients
do not follow redirects.

## REST and authority

Requests require `Authorization: Bearer <token>`:

- `GET /v1/commands` returns descriptions and input schemas.
- `GET /v1/openapi.json` returns the generated OpenAPI 3.1 contract.
- `GET /v1/events` streams authenticated command metadata through SSE, without
  arguments, page content, model messages, credentials, or results. Reconnect
  with `Last-Event-ID` to replay recently retained events.
- `GET /v1/turns/{turnId}/events` follows or resumes one model turn; send
  `Accept: text/event-stream` to `POST /v1/execute` to stream a turn you start.
  See [agent integration](AGENT-INTEGRATION.md).
- `POST /v1/execute` accepts `{ "command": "...", "args": {} }` (optionally a
  `deadlineMs` field or `Weft-Deadline-Ms` header) and returns a versioned outcome
  with `schemaVersion`, `command`, `status`, `execution`, `validation`, `review`,
  `workspaceId`, `tabId`, `normalized`, `request`, `result` and `error`.
  See [the command contract](COMMANDS.md) for status and error meanings.
- `GET /v1/capabilities` reports the API version, catalog hash, outcome table,
  limits and features; `GET /v1/download` streams stored bytes.

Discovery is the authoritative list of available commands and arguments. Unknown
fields are rejected. API request bodies are capped at 1 MiB, so large projects
move as package folders (`workspaces.exportPackage`/`workspaces.importPackage`,
human-only) or through the GUI, and single large files move through verified
chunked uploads (`transfers.begin`, `transfers.append`, `transfers.commit`). Large
collections accept `page: {limit, cursor}`. REST rejects browser-origin requests and does not enable CORS.

Mutating record commands accept an optional `requestId`: retrying the same command
and arguments returns the original result (`idempotency.replayed: true`) instead of
applying twice. `batch.execute` applies up to 100 record commands all-or-nothing, and
destructive record commands, imports and batches accept `dryRun` to preview the exact
changes. See [ADR 011](decisions/011-transactional-storage-search-and-recovery.md).

Human-only policy, configuration, storage-administration, override, and takeover
commands appear in discovery but reject automation callers. Every other agent
command passes one authority gate (ADR-005): reads run, local work runs at the
default level, and external actions such as clicks, form fills, scripts and model
sends wait in the Agent requests queue until you approve them once or for a
period, unless you granted standing autonomy. The bootstrap token defaults to
standing autonomy; lower it in Settings → Agent connections. There, issue a
separate token for each client with a purpose, workspace restrictions (several
workspaces need an explicit cross-workspace grant), read/record-write/tab-control
scopes, allowed sites, readable data classes, an autonomy level, an optional
command limit and a finite lifetime. Changes and revocation take effect on every
subsequent command and event; idle event streams close at their next heartbeat.
Tokens are displayed once and never stored in the project. Scoped clients cannot
execute page scripts or send to models unless granted, configure providers,
change site policy, approve requests, or mint other tokens. Activity records
decisions, approvals and outcomes with hash-chain tamper evidence and
configurable retention; it is not proof that an external action succeeded. This remains a
local single-user application, not a remote multi-user service. Takeovers revoke leases and state versions, but cannot undo
an external action or arbitrary page script that already executed.
