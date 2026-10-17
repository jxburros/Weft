# ADR 018: integration contracts and optional hybrid retrieval

Status: accepted and implemented for issues #14 (remaining scope) and #67
(embeddings and hybrid retrieval). Last reviewed: 2026-10-17.

## Context

The shared command catalog already had typed outcomes, stable error/exit codes,
request-ID idempotency, batches, approvals, `Last-Event-ID` replay on
`/v1/events` and cursor pagination for `activity.list` (ADR 005, 006, 011).
Missing were: one outcome taxonomy that every surface classifies identically,
request deadlines, pagination for the other large collections, replayable
events for task/navigation/policy/artifact/workspace/approval changes and for
callers without SSE (CLI, MCP), capability discovery, MCP resources, a transfer
path beyond the 1 MiB REST request cap, and the embeddings half of local
retrieval that ADR 011 deferred.

## Decision

### Outcome taxonomy

Every outcome gains `status`, one of `succeeded`, `partial`, `blocked`,
`approval_required`, `stale_state`, `conflict`, `unsupported`, `invalid`,
`cancelled`, `timed_out`, `failed`. Failures derive it from the error code
through one table (`ERROR_STATUS` in `src/commands.js`) next to the HTTP status
and CLI exit code tables; a completed command is `partial` only when its result
says so explicitly (`status: "partial"`, `partial: true` or `complete: false`).
The field is additive: `execution`, `review` and `error.code` keep their
meaning. A contract test drives every code through GUI IPC, REST, CLI and MCP
and requires the same status, execution, HTTP status and exit code. The GUI
labels failures with the same status. `/v1/events` command events carry the
status as `outcome`.

### Request envelope

The dispatcher echoes `request: {apiVersion, requestId, actor, clientId,
taskId, deadlineMs}` from the authenticated context, never from caller
arguments. Expected state uses existing fields: tab `expectedVersion` and record
`expectedRevision`, now also accepted by record deletions, `tasks.transition`,
`artifacts.annotate` and `artifacts.delete` (typed `stale_state` with reason
`revision_changed`, applied nothing).

### Deadlines

A caller deadline (REST `Weft-Deadline-Ms` header or `deadlineMs` body field,
CLI `--deadline-ms`, MCP grouped-tool `deadlineMs`; 1–600000 ms) bounds the whole
command. Every start point (the dispatcher for direct commands, the workspace
write queue on dequeue, search, handoffs) checks the deadline signal and marks
the command started in the same synchronous step, so an expired deadline before
start guarantees the command never runs (`deadline_exceeded`,
`details.started: false`, `execution: not_started`). After start, the signal is
aborted: record transactions roll back before commit (`effect: rolled_back`),
model turns stop and keep their partial reply (`effect: stopped`, with the turn
ID; the manifest deadline is `request`), and anything still running after a 1 s
grace is reported as `effect: uncertain` with the new `execution: uncertain`.
A command that completes inside the grace returns its real result with
`deadline: {exceeded: true}`. Deadlines never retry or fall back.

### Pagination

Additive rather than versioned: pageable collection commands accept
`page: {limit, cursor}` and then return `{items, nextCursor, total}`; without
`page` the established unpaged result is unchanged. This avoids repeating the
`activity.list` breaking change while giving every large collection the same
shape (records, artifacts, artifact versions, history, bookmarks, downloads,
conversation messages, handoffs, approvals, workspaces, search results and
uploads). Order is documented and stable (creation order; history, approvals
and downloads newest first; messages and versions in append order). Cursors are
opaque keyset positions bound to command, workspace and filters, so inserts and
deletions between pages neither duplicate nor skip earlier items; a cursor from
another query is `invalid_arguments` on `page.cursor`. A legacy `limit` cannot
be combined with `page`. Generic paging happens in the dispatcher over the
module's full list; search, messages, versions and uploads page natively.

### Events and replay

Task, artifact, policy, workspace and approval changes are derived from final
outcomes as metadata-only events (IDs, revision, version, status token);
navigation commits, in-page navigations and blocked navigations come from the
browser. All pass the existing allowlist (approval IDs are now admitted), so
arguments, URLs, titles, reasons and text never appear. One shared, sanitized
in-memory `EventLog` feeds both `/v1/events` and the new `events.list` command,
so CLI and MCP callers resume from the same `<boot>-<seq>` cursor and see the
same gap reasons. Retention is unchanged (1,000 events, 1 MiB, 15 minutes, not
persisted); `events.list` polling is not itself published.

### Discovery and MCP resources

`weft.capabilities` (and `GET /v1/capabilities`) reports the API version, the
SHA-256 of the canonical catalog, the outcome table, limits and feature flags
(streaming, batch, idempotency, dry run, expected state, deadlines, pagination,
event replay, transfers, search, MCP resources). The MCP server adds
`resources/list`, `resources/templates/list` and `resources/read` for
capabilities, guidance topics, the command reference and read-only
per-workspace record lists/records. Record resources are read through the same
REST client and token, so the authority gate and scope apply; records are
marked untrusted data.

### Large transfers

Uploads are sessions (`transfers.begin/append/commit/abort/list`): the caller
declares size and SHA-256, appends base64 chunks of at most 512 KiB at explicit
offsets (each request stays under 1 MiB; an identical retried chunk is accepted,
a conflicting one is `stale_state`), and commit verifies size and digest before
creating a material (10 MiB), an artifact text/PNG version (20 MiB PNG, 2 million
characters) or a package file. Commits run the same apply/transact path as the
record commands, including `requestId`. Sessions are private to the caller,
expire after an hour idle, at most four per caller and 1 GiB in flight, and do
not survive a restart. Package uploads stage the files of a
`workspaces.exportPackage` folder under `transfers/.incoming-<name>/`; the
folder is published only when the manifest arrives and every listed file
verifies, and importing stays the human-only `workspaces.importPackage`.
Downloads use `transfers.read` (bounded chunks with whole-file and chunk
SHA-256) and `GET /v1/download`, which streams by calling `transfers.read` per
chunk so every chunk passes the gate. Reading package folders is raised to
human administration because a package can contain any workspace's records.

### Optional embeddings and hybrid retrieval (#67)

ADR 011 deferred embeddings until a pinned model and download flow existed.
This decision avoids downloads entirely: a person enables embeddings per
workspace (`search.configureEmbeddings`, human-only) by choosing an existing
model connection and an embedding model name already available at it. Only
that endpoint is contacted, through Ollama `/api/embed` or OpenAI-compatible
`/embeddings`; Weft never pulls, downloads or installs a model, and a fixed probe
string (no workspace data) verifies the model and learns its dimension. The
on-device default needs nothing else; an endpoint that is not on this device
requires `acknowledgeEgress`, recorded in activity, and local-only records are
then never sent. A connection later pointed elsewhere stops embedding until a
person reconfigures it.

Vectors are unit-normalized float32 BLOBs in the workspace database
(`vector_chunks`, keyed by record, capture version and chunk; derived data,
never exported; included in backups). Text is chunked (1,200 characters, 200
overlap, at most 32 chunks per document; the title is prefixed to each chunk).
The record commit transaction enqueues changed records for workspaces with
embeddings enabled; a single-flight background pass embeds them in batches of
16, reusing unchanged chunks by digest. Deleted records lose their vectors in
the same transaction. A different model or dimension drops the workspace's
vectors and re-embeds everything. Search is exact cosine over at most 20,000
vectors per workspace (a cached matrix; about 61 MB at 768 dimensions, at most
four workspaces cached); beyond that, indexing stops and coverage reports
`capacity`. An approximate index (for example `sqlite-vec`) is the documented
next step if that limit proves too small; it is not bundled.

`search.query` gains `mode` (`auto` default, `lexical`, `hybrid`). With
embeddings enabled, BM25 and vector results (each a fixed 200-candidate window
so pages of one query never reorder) are fused by reciprocal rank with k=60;
both sides filter by workspace in SQL. Results keep the record/capture citation
and add `ranking` (lexical/vector rank, similarity). Paged results add
`coverage` (indexed documents; embedded, pending and unembedded documents with
reasons `pending`, `local_only`, `capacity`, `error`, `empty`) and `absence`:
an empty result is `verified` only when every indexed document was searched by
every enabled index; otherwise the reason names the unembedded documents. An
unreachable endpoint in `auto` mode degrades to lexical and marks the page
`partial`; `hybrid` mode fails instead. The model read tool uses paged search,
so it receives the absence signal before claiming something is not found.

Retrieved context sent to a model (search results from the read tool or the new
`search` chat attachment) is capped at 0.4 of the window remaining after the
reserved reply, across the turn; lower-ranked results are omitted whole and the
omission is reported in the tool result, manifest and disclosure.

### Core versus plugin

Embeddings are optional (question 1 of the [checklist](../PLUGINS.md#is-a-new-feature-a-plugin)),
but they fail questions 2–4: they write derived data into the transactional
store inside the record commit, send record text to a model endpoint (egress
governed by the provider locality and disclosure rules), are configured by a
human-only policy command and change the ranking of a core read. They therefore
stay in core. Disabling them removes only derived vectors (question 6); records,
lexical search and evidence are unchanged. Transfers, events, pagination and
discovery are part of the command contract itself and are core by definition.

## Consequences and limits

- `status`, `request` and `deadline` are additive outcome fields;
  `execution: uncertain` is a new value that only appears after a deadline.
- Pagination totals for hybrid search count fused candidates (at most 200 per
  index); lexical totals are exact.
- Event retention is in memory; a restart produces a `restarted` gap.
- Upload sessions are lost on restart; partial files are removed at startup.
- Embedding quality depends entirely on the person's chosen local model; the
  golden-query evaluation uses a deterministic fake endpoint and measures the
  contract (synonym recall improves over lexical), not any real model.
- Vector search cost grows linearly with vectors; the per-workspace cap and the
  perf budget (`perf/budgets.js`) bound it.
- Not validated against a real Ollama or OpenAI-compatible embedding server or
  external MCP clients' resource UIs.
