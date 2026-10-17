# ADR 011: transactional storage, local search and recovery

Status: accepted and implemented for issues #25, #67, #39 and #27. Last reviewed:
2026-10-17. Embeddings/hybrid retrieval were deferred here and are decided in ADR 018.

## Context

Version 1/2 stored every record and every capture byte in one JSON file that was
rewritten atomically on each change, capped at 100 MiB. Search was substring
matching in memory. There were no request identities, batches, automatic
backups or lossless exports. Weft must stay local-first, dependency-light and
usable without hosted services.

## Decision

**Metadata.** Use `node:sqlite` (`DatabaseSync`, built into Node 22.13+ and
Electron's Node; no native dependency) for `workspace-data/workspace.sqlite`.
WAL journaling, `synchronous=FULL`, `secure_delete=ON`, `trusted_schema=OFF`, a
`PRAGMA quick_check` on open and `PRAGMA user_version` with an append-only
migration list (`src/store.js`). Records are JSON documents keyed by
`(collection, id)` with a workspace column and an order column, so new
collections and fields from other features persist without schema changes.
Non-record top-level state (settings, browser session, unknown future keys) is
stored as JSON values.

**Components.** Capture text, PNGs and file bytes (`*Base64` fields and artifact
version `text`) are written to `workspace-data/components/<aa>/<sha256>` as
immutable content-addressed files: exclusive temporary file, fsync, reread and
digest check, rename, directory fsync. Rows hold `{ "$component": {sha256, size,
encoding} }` markers; reads re-verify the digest and fail with
`COMPONENT_INTEGRITY`/`COMPONENT_MISSING`. A reference table drives garbage
collection when the last referencing record is deleted, and startup removes
components left by interrupted transactions. Limits: 32 MiB per component (PNG
captures 20 MiB, stored files 10 MiB, text 2 million characters) and 64 MiB per
record document.

**API compatibility.** `WorkspaceService` keeps its in-memory `data` object and
public methods. A commit diffs each record document against what was last
committed and writes only changed rows, their search documents and new
components in one `BEGIN IMMEDIATE` transaction. Component-backed fields are
non-enumerable lazy getters, so ordinary clones stay small and the established
`structuredClone(data)`/reassign rollback pattern keeps those fields. A failed
command reverts memory to the last committed documents.

**Coordination.** The existing cross-process profile lock remains. Changes made
by any other connection are detected through `PRAGMA data_version`, and a
replaced/removed database file through its device/inode; both refuse to write
(`STORE_CONFLICT`) until restart, as the JSON store did.

**Migration.** A JSON store is validated with the existing migration runner,
its exact bytes are preserved in `recovery/workspace-state.<sha256>.json`, and a
complete database is built under a temporary name, reloaded and compared with the
source before it is renamed into place; only then is the JSON removed. An
abandoned temporary database is discarded and the migration repeated; a
canonical database beside an identical JSON finishes the move; a different JSON
beside the database is a `STORE_CONFLICT` and both are preserved. Corrupt or
newer databases are reported and never modified. Downgrading to a JSON-only
release is unsupported: it would not see the database (and a newly created JSON
store is later reported as a conflict, never merged).

**Search (#67).** An FTS5 index (`unicode61`, diacritics folded, 2/3-character
prefix indexes, no stemming because stemmed prefixes miss partially typed words)
lives in the same database. One document per record and one per immutable
artifact version, updated in the commit transaction. Queries are compiled from
letter/number tokens into quoted phrases with a final-token prefix, so FTS
operators and column filters in user text are inert. BM25 weights title 6:1
body; documents containing every term rank before partial matches. The
workspace filter is part of the SQL query. Results cite record id, revision and
exact capture version. Conversation messages are not indexed because one
record can mix local-only and shareable messages.

**Request identities and batches (#39).** Mutations accept `requestId`. The
fingerprint (command, validated arguments, workspace scope) and the result are
committed in the same transaction as the change, scoped to the calling actor.
An identical retry returns the stored result with `idempotency.replayed: true`;
a different payload fails with `idempotency_conflict`. Results are retained 7
days (1 MiB maximum), fingerprints 30 days, at most 50,000 entries; after the
result expires a retry fails with `already_committed` instead of reapplying.
`batch.execute` validates and authorizes every contained command (including
client grants) before applying record commands in one transaction; `$N.id`
placeholders reference earlier results. Page, browser, capture, import, backup
and workspace-lifecycle commands are rejected in batches because they cannot be
rolled back. `dryRun` runs destructive record commands, imports, restores and
batches, reports the exact created/updated/deleted records, then rolls back
without browser effects.

**Backups and portability (#27).** Backups are `VACUUM INTO` snapshots plus
copies of every referenced component and a SHA-256 manifest, written under a
temporary name and verified (digests, `integrity_check`, component
completeness) before being reported. The app makes an automatic backup at
startup and every 24 hours when due, keeping five; manual backups are never
pruned. Restore verifies first, records a journal, moves current data to
`recovery/pre-restore-*` (never deleting it), stages and re-verifies the backup,
then swaps; every step resumes after interruption. `weft store` restores
offline when the database is too damaged to open. Export format 2 keeps
revisions, revision histories, conversations and turn manifests, exact
artifact versions with component hashes, annotations and structured/free-form
citations (remapped to new IDs); the importer verifies hashes, reports every
lossy mapping, linked sources not included and inactive policies, and supports
`dryRun` previews. Large projects move as package folders (records file,
component files, manifest) under `workspace-data/transfers/`, avoiding the
1 MiB REST and 100 MiB JSON limits.

## Integration with authority, handoffs and browser state

Integrated after ADRs 004–010 (numbered 011 for that reason):

- **Shared store.** Handoff and takeover records, site-rule provenance,
  storage modes (`storagePolicies`), community subscriptions (`siteLists`),
  turn manifests and in-store activity are collections in this database.
  Modules that change them outside `WorkspaceService.execute` (handoffs,
  community lists, site storage, extensions, activity retention) commit with
  the same transaction and, on failure, call `rollback()`, which returns
  *every* collection to the last committed state instead of restoring a
  partial copy. Handoffs are indexed for search (index version 2).
- **Export format 2** carries site-rule provenance and handoff history.
  Imported handoffs that were open or accepted become cancelled history,
  because their tab IDs belong to the exporting session and must never steer
  input. Storage modes and community subscriptions are named exclusions
  (browser policy; signed lists are re-verified by subscribing again), as are
  approvals, autonomy ceilings and grants.
- **Batches and the authority gate.** The dispatcher authorizes every command
  in `batch.execute` with the caller's identity before the transaction starts.
  When any of them needs approval, the batch needs one exact one-time approval
  bound to the fingerprint of the whole normalized batch. Per-command or
  standing approvals were rejected as unsafe: they would admit combinations and
  placeholder targets the human never saw. Batches needing approval are limited
  to 20 commands so the approval preview lists each one. Client usage and rate
  limits count every contained command; an agent batch stays in one workspace.
- **Request identities** are scoped to actor and client, so one client never
  receives another's stored result. A replay is re-authorized by the gate
  before the stored result is returned. Activity records batches, each applied
  command, replays and dry runs (replays and dry runs as `recorded`, not as new
  changes).
- **Backups** contain only this database and its components. The hash-chained
  activity log, approvals, autonomy policy, grants, model connections, browser
  security state, plugin/extension state and updater state are excluded so a
  restore can neither rewind evidence nor revive authority; the restore itself
  is appended to the activity chain (see `docs/STORAGE-SAFETY.md`).

## Embeddings and hybrid retrieval (decided in ADR 018)

Originally deferred here. [ADR 018](018-integration-contracts-and-hybrid-retrieval.md)
implements them without any model download: a person enables embeddings per
workspace using an embedding model already available at an existing model
connection (on-device by default; other endpoints need an explicit egress
acknowledgement and never receive local-only records). Vectors live in this
database (never exported), are scoped by workspace in SQL, and are fused with
BM25 by reciprocal rank (k=60) with golden-query evaluation. Without that
opt-in, search remains lexical only.

## Consequences and limits

- The database, WAL, components, backups and the search index contain project
  content and are **not encrypted at rest** (ADR 001). Files are created with
  owner-only permissions where the OS supports them; deleted rows are zeroed in
  the database file, but copies may persist in backups, recovery folders,
  WAL pages until checkpoint and filesystem/SSD remnants.
- Backups live on the same disk as the profile; they protect against logical
  damage and interrupted operations, not disk loss. Copy backups or packages
  elsewhere for that.
- Directory fsync is unavailable on Windows; Windows/macOS crash behavior,
  network filesystems and sync clients have not been exercised here.
- In-memory state still holds all metadata (not capture bytes); very large
  activity logs increase per-commit diff time. Budgets in `perf/` measure the
  current fixtures, not a maximum supported size.
