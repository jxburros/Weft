# ADR 016: durable task runtime, uncertain outcomes and parameterized workflows

Status: implemented for issues #8, #58 and #10 with fixture, process-kill,
real-Chromium recording and GUI tests. Real external accounts, payment
providers and long-running production use are not validated. Last reviewed:
2026-10-17.

## Context

Tasks were durable records and workflows were editable checklists that the GUI
turned into queued human tasks. Nothing executed a plan, and an interruption
left only an `attempted` activity entry: there was no way to tell, on restart,
whether a click, a submitted form or a model request had taken effect, and
nothing prevented a later retry from repeating it. Prior art (#58: ByAuthorX
`jobs.py`, AI-Server-Studio `runTruth.ts` and `sweepInterruptedRuns()`) uses a
small transition table, logs every transition with a reason, sweeps
interrupted runs at boot and refuses to resubmit uncertain remote work without
an explicit duplicate-risk acceptance.

## Decision

### One phase vocabulary

`src/task-phases.js` defines the phases `queued`, `running`,
`waiting_on_human`, `paused`, `completed`, `failed`, `cancelled` and
`uncertain`, and a `TRANSITIONS` table. Task records, workflow runs (which are
tasks) and model turns (`turnPhase()` maps turn-manifest statuses) use it.
`uncertain` leaves only for `paused`/`running` (after a recorded determination
or a confirmed retry), `failed` or `cancelled`; it never becomes `completed`
directly. The older `waiting` state is normalized to `waiting_on_human` when a
store opens and on import (no schema bump).

Every transition is validated and appended to the task's `timeline` with
`from`, `to`, actor, reason code, note and step, in the same SQLite
transaction as the change; after commit it is mirrored into the hash-chained
activity log as a `task` entry and published as a metadata-only `task` event.
Tasks run by the runtime change phase only through the runtime commands;
`tasks.transition`/`tasks.update` refuse them, and no caller can set or clear
`uncertain` by hand.

### Execution through the shared dispatcher

`src/task-runtime.js` drives a task's `plan` (steps of kind `command`,
`model`, `review` or `handoff`) after `tasks.start`. Each step re-enters the
shared dispatcher as the task's **bound identity**: the built-in runner
(`task:<taskId>` with a person-chosen autonomy level), an agent connection
grant (`client:<id>`) or the bootstrap automation identity. The authority gate,
client grants (scopes, destinations, data classes, task binding, expiry),
approvals and the emergency-stop latch therefore apply to every step exactly as
to a direct command. Agents may start or run workflows only as themselves (an
existing grant); a person chooses any other identity and alone rebinds it
(`tasks.reassign`). Human-only commands, administration and the runtime's own
controls cannot be plan steps.

Outcomes map to phases: approval required → `waiting_on_human` (resumed when
the approval is decided); expired/revoked grants and usage limits → `paused`
with a `grant` blocker; other refusals before any effect → `paused`; missing
selectors, stale refs and changed URL assumptions → `paused` as an invalidated
step; local failures → `failed`; external work that started and failed
ambiguously → `uncertain`. Review steps and `reviewRequired` steps wait for
`tasks.review` (approve, reject or edit the remaining steps). Handoff steps
create a `handoffs.create` record and wait until it is completed. Model steps
send `chat.send` with the task's model (switchable with `tasks.redirect`) and
the provider's disclosure rules: a cloud destination waits until a person
acknowledges it through `tasks.continue { disclosureAck }`.

### Operation records before every step

Before dispatching a step the runtime commits an operation record on the task
(`attempted`, with command, identity, action class, minimized argument summary
and whether the effect is external). Record writes carry a deterministic store
request ID (`task.<taskId>.<stepId>.<args digest>`) so a repeat replays the
committed result instead of applying twice. After the outcome the record
becomes `completed` (external results are "accepted, not verified"),
`not_started`, `failed`, `interrupted` or `uncertain`, with links to created
records and evidence. Unresolved uncertain operations are never pruned.

### Interruption and recovery

- **Startup sweep** (`init()`, before the API listens): running tasks whose
  in-flight step was local are paused with reason `server_restart` (a repeated
  record write replays); attempted external steps with no outcome become
  `uncertain` (`server_restart_uncertain`). Model turns are first checked
  against the conversation's turn manifest (a recorded lookup).
- **Emergency stop** pauses runtime tasks before anything else, schedules no
  new step and returns the already-submitted steps separately; when such a step
  returns ambiguously the task becomes `uncertain`.
- **Reconciliation**: `tasks.reconcile` (human only) records `completed`,
  `not_completed` or runs a registered recorded lookup
  (`registerReconciler(kind, lookup)`); the determination, its source and
  evidence are stored on the operation and logged. A lookup that cannot tell
  keeps the work uncertain.
- **No blind retries**: `tasks.continue` refuses uncertain work
  (`duplicate_risk`); `tasks.retryStep` repeats uncertain external work only
  with `confirmDuplicateRisk: true` from a person, recorded as
  `duplicate_risk_accepted`.
- **Staleness**: `tasks.get`/`tasks.list` report `staleness` when the material
  revisions, workflow revision, model or plan that produced the latest step
  results have changed.

### Payments and other consequential steps

Payment work (#7) plugs in without changing the runtime: a payment command is
classified `payment` (once-only approval per use, `external` effect), so it is
recorded `attempted` before dispatch and becomes `uncertain` on interruption; a
payment module registers a reconciler for its command or operation kind that
queries the provider's transaction status by the operation id it stored. The
credential broker (#6, ADR 017) is wired the same way: `credentials.fill` is a
plan step dispatched as the task identity, needs an exact approval or a human
`credentials.grantTask` for that task, and is treated as external work.

### Workflows (#10)

Workflow records gain typed parameters (`string`, `number`, `boolean`, `url`,
`enum`, `credential`; legacy strings become required strings), `{{name}}`
substitution at execution time, required materials, allowed sites (enforced
before and after each step in addition to grants), opaque credential
references validated through the credential broker interface (credential
values never; credential parameters only as the id of `credentials.fill`),
review checkpoints and expected outputs (a person confirms them before the run
completes). Parameters marked `sensitive` stay in process memory only; after a
restart the run pauses for re-entry, and approval previews withhold them.
`workflows.run` creates a runtime task; `workflows.validate` reports errors
without running.

Saving or importing never authorizes a workflow: imported workflows stay
inactive (format 2 `enabled: false`), workflows written by automation are
created inactive, and a non-human change to steps, parameters, sites,
materials or credential references disables an enabled workflow until a person
reviews it. Runs always use the executor's current grants.

Recording (`workflows.recordStart/recordStop`, human only) turns a person's
navigation, Weft commands and trusted in-page clicks and field changes into
steps. An isolated-world script reports selectors, labels and sensitivity
hints only, never values; page scripts cannot forge reports (nonce, trusted
events only). Typed values become parameters; password fields become
`credentials.fill` steps; other sensitive fields become person-performed
instructions; secret-named URL parameters are stripped. Recorded workflows are
saved inactive for review.

### Delegation from chat

The optional read-tool set of a chat turn includes `propose_task`, which only
records an untrusted proposal in the conversation. The GUI shows it as a card;
nothing is created until a person saves it, and nothing runs until a task is
started.

## Consequences and limits

- Weft cannot know external outcomes it did not observe; uncertainty is
  surfaced, not resolved by guessing. No reconciler exists for page clicks,
  fills or sign-ins: a person checks the destination.
- One runtime per process; tasks do not migrate between machines and imported
  tasks never resume on their own (their bindings are not imported).
- Recording does not capture keyboard shortcuts, drag and drop, typed
  characters (only committed field changes), cross-origin frames or closed
  shadow roots; ref-based actions are recorded as steps that need re-targeting.
- Approval previews withhold sensitive run parameters, but a page.fill of a
  sensitive value still delivers it to the page; prefer credential references.
- Not validated with real external accounts, payment providers or very long
  runs; the 30-second approval-expiry poll is the only scheduler.
