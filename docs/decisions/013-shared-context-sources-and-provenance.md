# ADR 013: shared context, linked sources, context review and provenance

Status: accepted and implemented for issues #21, #22, #23 and #66 (bounded
scope; see "Remaining limits"). Last reviewed: 2026-10-17. A shared browser
session container between workspaces is deliberately **not** implemented
(decision below).

## Context

Workspaces were isolated islands: records could not be shared with another
workspace, linked-file and service materials were descriptive text, context
categories had revision checks but no proposal/promotion flow, no source-change
detection and no conflict handling, and records did not say who or what
produced them. Citations were free-form identifiers. The authority layer
(ADR-005) already gives every non-human caller one gate, client grants scoped to
workspaces and a browser-owned approval queue. Storage (ADR-011) persists any
new record collection generically.

## Decision

### Shared context collections (#21)

- A collection (`sharedCollections`) belongs to an **owner workspace** and lists
  **items** (context, materials or artifacts in that workspace). Participating
  workspaces are **members** with a `read` or `write` role, the person who
  granted them and when; revocation sets `revokedAt` and keeps the membership as
  history. Every change is a numbered history entry (provenance).
- Creating, renaming, deleting, granting, revoking and adding/removing items are
  `administration` commands: only a person in the trusted GUI decides what is
  shared and with whom. Agents with access read (`collections.list/get/read`)
  and, with a write role, create or update (`collections.write`). A shared
  update requires `expectedRevision`; a concurrent change fails with
  `stale_state` and nothing is merged silently. Trusted categories remain
  human-only through collections. Records created through a collection live in
  the owner workspace with `origin.via` naming the writing workspace.
- **One boundary for every caller.** `WorkspaceService.record()` admits a record
  from another workspace only for reads and only through an active membership,
  so a person's agents, the internal model (chat attachments run as
  `model-reader`; the read-only search tool runs through the dispatcher) and
  external clients meet the same rule. `search.query` includes shared records,
  labelled with `shared.collectionId`. External clients reach shared records
  only through `collections.*` with their own workspace as target; ordinary
  `context.get` of another workspace's record still fails with
  `outside_workspace_grant`. Revocation applies to the next command because
  membership is read on every call.
- Exports include owned collections and items but never members (authority is
  not data); the import report lists them as lossy.

**Session sharing is separate and not built.** Collections carry
`sessionSharing: "separate"` and every surface states that sharing context never
shares sign-ins, cookies or site storage. Sharing a Chromium session container
between workspaces would merge two workspaces' site-storage modes, temporary
storage journals, extensions, download policy and site rules, which are bound to
one partition per workspace in `src/browser.js` and ADR-008. That is a separate
security decision with its own threat model; no command enables it, so the
default is off by construction. A real Chromium test verifies cookies and
localStorage stay isolated with a write-shared collection in place, and a
client scoped to a participant still cannot move a tab out of the owner
workspace without an explicit cross-workspace grant.

### Linked files, folders and service references (#22)

- `sources.link` is human-only and takes a path chosen in a native dialog (the
  trusted GUI's `weft:pickPath` IPC) or typed by the person. Weft resolves the
  real path, refuses links that are symbolic links, and records size, mtime,
  device/inode and SHA-256 (folders: a manifest hash over a bounded,
  non-following walk). `mode: "copy"` instead stores a managed copy (files up
  to 10 MiB) with `copiedFrom` metadata; changes to the original are not
  tracked.
- `sources.check` reports `available`, `changed`, `moved` (same inode or same
  SHA-256 found in the old folder's parent tree, bounded walk), `missing` or
  `inaccessible` (permission denied, replaced by a symbolic link, wrong kind)
  and accepts nothing. `sources.refresh` accepts the current content as a new
  source version; `sources.relink` (human) points at the detected or a new
  location. Agents never receive the absolute path (only the name).
- Agents read linked content only with `sources.read`: a folder listing or a
  relative path inside the linked root, at most 1 MiB per call. `..`, absolute
  paths and paths whose real path leaves the root (symlink escapes) are
  refused. No command accepts an arbitrary path from automation. Weft's own
  profile (database, credential files, Chromium session data) can never be
  linked, and reads through a linked parent folder refuse anything inside it.
- **Service references** use an adapter contract (`describe()`, `fetch()` with
  outcomes `updated`, `not_modified`, `unauthorized`, `redirected`, `failed`).
  The built-in `http` adapter fetches a person-supplied HTTPS URL (plain HTTP
  only for loopback) with an optional `Authorization` or `X-API-Key` header,
  conditional requests, a 2 MiB cap, a 15 s timeout and no redirects. Records
  carry explicit `access` (`none`, `unknown`, `authorized`, `unauthorized`,
  `revoked`), `lastRefreshAt`, `lastError` and immutable cached source versions
  (SHA-256, ETag/Last-Modified; content retained for the newest five).
  `services.read` always reports cached-versus-live. When the service refuses
  access or a person revokes it, cached content is withheld from agents and
  models; `services.revoke` can purge it. Creating, refreshing and credential
  changes are human-only; refresh is never automatic unless the person enabled
  `autoRefresh` and scheduled checks for that workspace.
- Credentials are stored only through Electron `safeStorage` in
  `service-credentials.json` (the same OS-protection rule as provider keys;
  plain-text fallback is refused). They are never written to project data,
  activity, exports or backups, and the value is never returned.
- Exports omit linked content, local paths, cached service content and
  credentials, list them in `linkedContentOmitted`, and imported links start
  `unlinked`. Duplicating a workspace in the same profile keeps local links.
- **Optional integrations evaluated, not built:** ByAuthorX (per-span
  provenance and quote matching, which informed #66), Vixl, AI Server Studio and
  QAI-ality could become adapters implementing the same contract. Ordinary files
  and documented HTTP APIs do not depend on them. Against the core-versus-plugin
  checklist (ADR-003, `docs/PLUGINS.md`), service adapters fail question 3
  (they need egress and credentials) and the linked-source boundary fails
  question 4 (it enforces filesystem scope), so both stay in core; a future
  adapter would be added as a reviewed core adapter, not a sandboxed plugin.

### Proposals, promotion, freshness and conflicts (#23)

- `context.propose` records an attributed finding with `proposal` metadata
  (requested trusted category, rationale, proposer). `context.promote` belongs
  to a new action class, **`trusted_context`**: a person promotes directly; an
  agent needs the class in its client grant **and** an approval from the
  browser-owned queue each time, or a standing approval (task-bound when the
  client grant is bound to a task, ending when the task closes). Autonomy
  levels never admit it, and record, page or source text can never supply the
  approval. Promotion creates a new trusted record with `promotedFrom` and the
  approval in its origin; the finding keeps its text and evidence.
- `citations.check` and `freshness.check` re-anchor citations against the newest
  capture version, record revision or linked/service source version. Status is
  `verified`, `reanchored` (quote found in a newer version), `stale` (quote
  removed or source changed) or `unverified`. A transition to `stale` opens a
  `source_changed` conflict once. Freshness checks are local (no network);
  scheduled checks are opt-in per workspace (`freshness.configure`, human) and
  run every 15 minutes in the app process when due; they refresh services only
  where the person allowed it.
- `conflicts.create` records contradictions or a conflicting edit
  (`proposed`), preserving it instead of overwriting. `conflicts.resolve` is
  attributable (`resolution.origin`) and never rewrites originals: `choose`
  marks the others `superseded` (or applies the preserved edit as a new
  revision with history), `merge` creates a new record with `derivedFrom`,
  `keep_both`/`dismiss` close it. Conflicts involving confirmed context,
  instructions or decisions are resolved by a person.

### Provenance and quote selectors (#66)

- `origin` on context, materials, every revision (`history[].origin`,
  `lastOrigin`) and capture versions: `{actor, kind, clientId?, model?,
  provider?, toolCall?, conversationId?, captureId?, authoring, at}`. Actor and
  kind come from the authenticated context (`human`, `agent`, `model`,
  `system`, `import`); callers may add only descriptive fields. Strict schemas
  reject `actor`/`kind`, and automation or model callers cannot claim
  `human_written` or `pasted` authorship.
- Capture citations store `{captureId, versionId, version, exact, prefix,
  suffix}` (W3C TextQuoteSelector) and an anchor with original offsets.
  Matching normalizes Unicode NFKC (folding ﬀ/ﬁ/ﬂ and full-width forms), further
  ligatures (æ, œ), typographic quotes and dashes, invisible characters and
  whitespace runs, then case; prefix/suffix choose among repeated occurrences.
  An unknown cite target or missing quote is stored as `unverified`; the record
  is never rejected for it.
- Import keeps exported provenance only as `origin.claimed` under an `import`
  origin, remaps every cited ID (capture, version, record), and recomputes
  citation statuses against the imported versions; unresolved citations stay
  `unverified` with `not_in_export`.

## Verification

- `test/knowledge.test.js`: read-only consumers, write roles with revision
  conflicts, immediate revocation for REST clients, internal model reads and
  search, tab moves and separate partitions; linked file/folder detection
  (changed, moved by inode, symlink replacement, missing, permission denied when
  not root), refresh/relink, traversal and symlink escapes, bounded reads,
  managed copies and export omission; service references against a loopback
  server (credential header, conditional refresh, versions, 401 withholding,
  revoke/purge, redirect not followed, credential absent from every profile file
  except the encrypted store); proposals with single, standing and task-scoped
  approvals; freshness, re-anchoring, conflicts and resolution; export/import
  round trip and tampered imports.
- `test/provenance.test.js`: quote normalization and re-anchoring (moved text,
  ligatures, deleted quote, repeated quotes) and origin spoofing over REST.
- `test/gui-knowledge.test.js` (real Electron): proposal promotion, citation
  status, source check and conflict resolution, linked-source cards and shared
  collection grant/revoke dialogs.
- `test/browser-workspace.test.js` (real Chromium): cookie and localStorage
  isolation with a write-shared collection between the workspaces.
- `evals/tasks/propose-cited-finding.json`: an MCP agent proposes a cited finding
  and is refused promotion.

## Remaining limits

- No shared browser session container (decided above); no multi-user or
  multi-profile collaboration (ADR-002).
- Collections share records of their owner workspace; a participant cannot add
  its own records to another workspace's collection (it creates them there
  through a write role instead).
- No filesystem watcher: status is detected on `sources.check`, `freshness.check`
  or scheduled checks. Moved detection searches a bounded nearby tree only.
  Linked content is not snapshotted, so the previous bytes of a changed linked
  file are not preserved (only their hashes); captures and cached service
  versions are preserved.
- Only the generic HTTP(S) adapter exists; no OAuth flow. Windows and macOS
  `safeStorage` behavior for service credentials is unverified here (Linux
  tests use a fake keyring).
- Conflict detection is evidence-based (source changes, recorded edits and
  contradictions); Weft does not detect semantic contradictions itself.
- Per-span (sub-record) provenance and C2PA export from ByAuthorX were not
  adopted; provenance is per record and per revision.
