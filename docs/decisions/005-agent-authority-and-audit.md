# ADR 005: agent authority, approvals and durable activity

Status: implemented for issues #5, #43 and #29 (bounded scope below). Last
reviewed: 2026-10-17.

## Decision

Weft has one authorization layer. `createDispatcher` (`src/dispatch.js`) resolves
the target, then calls `Authority.authorize` (`src/authority.js`) before any
handler runs, for every non-human caller: the bootstrap token, scoped client
tokens, CLI and MCP (which reach the REST API), in-process callers and the
internal model read tools (`main.js` routes `page_readable`/`workspace_search`
through the dispatcher as an observe-level identity limited to one workspace).
A dispatcher created without an `Authority` builds one, so the gate cannot be
omitted by wiring. Only the trusted GUI human (`actor: human`, `source: gui`)
bypasses the gate, and only that identity can resolve approvals, change grants,
autonomy or retention.

Order of evaluation:

1. Emergency-stop latch (`src/admission.js`).
2. Hard floor: human-only commands (the catalog's human-only set and every
   `administration`-class command; a test requires administration commands to be
   marked human-only) are denied to every non-human.
3. Client grant (`src/clients.js`): live/unexpired, every touched workspace in
   the grant (a tab's source workspace counts; more than one workspace requires an
   explicit `crossWorkspace` grant; creating workspaces is refused), resource
   write scope (`records.write` or `tabs.control`, derived from the command
   namespace), extra action classes (`code_exec`, `cloud_spend`, `bulk_export`,
   `credential_use`, `payment` must be granted explicitly), data classes for
   reads, destination origin patterns for URLs and tab pages, usage/rate limits
   and, for task-bound grants, an open task.
4. Autonomy gate (`src/autonomy.js`, pure): the effective level is the lower of
   the identity level and an optional workspace ceiling.
5. Approval evidence from the single approval queue (`src/approvals.js`).

All checks are driven by command metadata (`actionClass`, `resource`,
`dataClasses`, `effect`, `sensitiveCategories`, `humanOnly`), so commands added
later are covered without editing the gate. A command with no registered class is
`unclassified`: the most restrictive non-denied class, needing an exact one-time
approval for every use (bootstrap/internal callers) and refused to client tokens.

## Levels and classes

| Class | observe | assist | scoped | autonomous |
| --- | --- | --- | --- | --- |
| local_read, external_read | auto | auto | auto | auto |
| local_write | deny | approval | auto | auto |
| external_write, code_exec, cloud_spend | deny | approval | approval | auto_preapproved |
| bulk_export, credential_use, payment, unclassified | deny | exact approval | exact approval | exact approval |
| administration (human only) | deny | deny | deny | deny |

`auto_preapproved` means a human granted standing authority (the autonomous level
or a standing approval). Standing approvals never apply to the once-only row.
Sensitive outbound categories map onto these classes: form submissions, messages
and account changes are `external_write` (page click/fill) or `code_exec`;
sensitive outbound data to a model is `cloud_spend` (in addition to the existing
per-destination disclosure acknowledgement); bulk export, credential use and
payment are once-only classes. Workspace export itself remains human-only.

Defaults: client tokens are `scoped` (local work runs, external actions wait for
approval); the bootstrap token printed at startup is `autonomous` for
compatibility with the existing operator workflow and can be lowered in the
Agent connections dialog; the internal model reader is `observe`; other internal
actors default to `assist`.

## Approvals

An `approval_required` outcome creates (or reuses) one pending request bound to a
SHA-256 fingerprint of the command, validated arguments (after defaults and
target resolution, including `expectedVersion`), actor, workspace, tab and
destination. Pending requests expire after 15 minutes; at most 25 per actor.
The human chooses:

- approve once: the identical retry by the same actor consumes it (valid 15
  minutes); any difference creates a new request;
- approve for a period (standing, 5 minutes to 24 hours): the same actor, command,
  workspace and destination origin; bound to the client's task when the grant is
  task-bound and ended when that task closes; refused for once-only classes;
- reject.

Requests are durable (`approvals.json`). Agents may list their own requests (no
preview); the GUI shows a bounded preview of the agent-supplied arguments labelled
as data. Approval cannot be expressed as a command argument (strict schemas reject
unknown fields), and no page, artifact or tool text is interpreted by the gate.

## Denials

Gate refusals are `permission_required` (or `human_required`), HTTP 403, CLI exit
4, `execution: not_started`, with `error.details.authority` (`decision`, `reason`,
`actionClass`, `level`). Approval requests are `approval_required`, HTTP 403, CLI
exit 5, with `approvalId`, `fingerprint` and `expiresAt`. The same shape is
returned over REST, CLI, MCP, in-process dispatch and the model tools.

## Activity and audit integrity

`src/activity-log.js` keeps an append-only JSON-lines log (`activity-log.jsonl`)
for commands (non-human reads and all writes; human GUI polling reads are not
logged), gate decisions, approval requests and decisions, grant and policy
changes, model destination decisions (destination origin, locality, sizes; no
content), site-rule and download blocks, overrides and artifact creation. Each
entry carries an outcome label: `attempted` (written before an external-effect
command runs), `completed`, `failed`, `denied`, `pending_approval`, `partial`,
`externally_uncertain` (an external action the browser or provider accepted, or
one interrupted after it may have started) or `cancelled`, plus `irreversible`
and `external` flags. History is never presented as proof of an external result.

Minimization: entries store only IDs, numbers, booleans, short enum-like values,
URLs reduced to origin and path (credentials, query and fragment removed) and
character counts for free text. Secret-named fields and binary payloads are
dropped. Records and artifacts keep their own content; the log does not copy it.

Retention: by age (default 90 days) and count (default 20,000 entries),
configurable by the human (`activity.configure`). The same policy prunes the
workspace store's ordinary activity entries. Records and artifacts are never
removed by activity retention.

Integrity: each entry includes the previous entry's SHA-256 hash. Pruning keeps an
anchor (sequence and hash of the last removed entry), and a separate head marker
records the latest sequence. `activity.verify` reports edits, deletions,
reordering, unreadable lines and tail truncation within the retained window; a
failed check found at startup is appended to the chain so later pruning cannot
silently erase it.

Threat model: this is tamper evidence against accidental corruption, partial
writes and casual edits of the profile. It is **not** tamper-proof: a process or
person with write access to the profile directory can rewrite the whole log,
anchor and head consistently. Defending against host compromise would require an
external witness or signing key outside the profile (not implemented). Lines are
appended without a per-entry fsync; the most recent entries can be lost in a
power failure, and a torn final line is discarded and recorded.

## Privacy and crash reporting

Weft has no telemetry and no crash reporting. Any future crash reporting must be
opt-in, separate from workspace content and activity, and must apply the same
redaction and minimization before anything leaves the device.

## Limits

- Destination grants are checked before each command (requested URL or current
  tab page). A redirect during an allowed navigation is not blocked mid-flight;
  later commands on the redirected page are refused.
- Click/fill cannot distinguish a harmless click from a submission; all are
  treated as external changes.
- There is no credential broker or payment flow; their classes exist so future
  commands inherit once-only approval, but no such command ships.
- The bootstrap token's default is `autonomous`; operators who want approvals for
  it must lower it.
