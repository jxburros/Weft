# Local storage, backup and export safety

Verified against code: 2026-10-17. Design and rationale: [ADR 004](decisions/004-transactional-storage-search-and-recovery.md).

## Layout

`workspace-data/` beneath the Electron profile contains:

| Path | Contents |
| --- | --- |
| `.workspace.lock` | Cross-process ownership lock |
| `workspace.sqlite` (+ `-wal`, `-shm`) | Transactional metadata, search index, request identities |
| `components/<aa>/<sha256>` | Immutable capture text, PNG and stored-file bytes |
| `backups/<id>/` | Verified backups (database snapshot, component copies, manifest) |
| `recovery/` | Preserved originals: migrated JSON stores, pre-migration and pre-restore data |
| `transfers/<name>/` | Large-project packages written or read by export/import |
| `restore-journal.json` | Present only while a restore is in progress |

All of these contain project content (including the search index) and are not
encrypted. Files and folders are created owner-only where the OS supports it.

## Writers and conflicts

Weft holds `.workspace.lock` in the canonical profile directory. Exclusive file
creation prevents a second process from opening the profile; services in the
same process share ownership but keep separate database connections. Normal
exit or `WorkspaceService.close()` releases only the owned lock. Abrupt
termination can leave a lock: close all processes using the profile and remove
`.workspace.lock` only after checking that no writer remains. Weft never guesses
that a PID or remote host is dead. Network filesystems and live cloud
synchronization are unsupported.

Every mutation is one SQLite `BEGIN IMMEDIATE` transaction covering changed
record rows, their search documents, component references and any request
identity. Before writing, Weft checks `PRAGMA data_version` (any commit by
another connection, including a lock-ignoring tool) and the database file's
device/inode (replacement or removal). Either causes `STORE_CONFLICT`: the command
rolls back its in-memory changes, the external change is preserved, and further
writes refuse until restart. A lost lock causes `STORE_LOCKED`.

Component files are written to an exclusive temporary name, fsynced, reread and
digest-checked, renamed and the directory fsynced, before the transaction that
references them commits. Reads re-verify the SHA-256 (`COMPONENT_INTEGRITY`,
`COMPONENT_MISSING`). Startup deletes temporary files and components no
committed record references (left by an interrupted write); deleting the last
record that references a component deletes its file.

## Migration and damaged stores

Opening a profile that still has `workspace-state.json` validates it with the
append-only `src/migrations.js` runner (unknown fields retained; structure, IDs,
active workspace and ownership checked), copies its exact bytes to
`recovery/workspace-state.<sha256>.json` (fsynced, verified), builds a complete
database under a temporary name, reloads and compares it with the source, renames
it into place and only then removes the JSON. Interrupted migrations are
discarded and repeated; a finished one completes. If a database and a different
JSON file both exist (for example an older Weft wrote a new JSON store), opening
stops with `STORE_CONFLICT` and both are preserved for human review. Unreadable,
unsupported, newer or invalid JSON stops without writing anything.

Database schema changes use `PRAGMA user_version` and an append-only migration
list; a consistent copy is saved in `recovery/` before an existing database is
migrated. A database from a newer Weft fails with `STORE_UNSUPPORTED`. One that
fails `quick_check` or cannot be opened fails with `STORE_CORRUPT` and is left
byte-for-byte unchanged; restore a backup (below).

## Backups and restore

`backups.create` (and the GUI's Back up now) writes a `VACUUM INTO` snapshot and
copies of every referenced component to a temporary folder, writes a manifest of
SHA-256 digests, renames it into place and verifies it (digests,
`integrity_check`, component completeness). The application also makes an
automatic backup at startup and every 24 hours when due, keeping the latest
five; failures appear as storage warnings and in `backups.list`. Manual backups
are not pruned. `backups.verify` recomputes everything and never modifies a
backup; manifest paths other than `workspace.sqlite` and
`components/<aa>/<sha256>` are rejected.

`backups.restore` (human-only; `dryRun` previews record counts) refuses an
unverified backup, writes `restore-journal.json`, moves the current database and
components to `recovery/pre-restore-*`, stages and re-verifies the backup, then
swaps it in. Each step resumes on the next start after interruption. With Weft
closed — including when the database is too damaged to open — run:

<!-- docs-test: skip Offline maintenance subcommand, not a catalog command -->
```sh
weft store backups /path/to/profile/workspace-data
weft store restore /path/to/profile/workspace-data <backup id>
```

Backups share the profile's disk: they cover logical damage, mistakes and
interrupted operations, not disk loss or theft. Copy backup folders elsewhere for
that. Restoring a backup does not change Chromium session storage.

## Secrets and export review

Secret-named keys (including nested ignored import fields), workflow parameter
names such as `api_key`, and direct attempts to save secret-bearing structured
data are rejected with `SECRET_FIELD`, without echoing values. This does not
detect secrets written into ordinary prose. Existing data containing such keys
is preserved and opening fails explicitly.

`workspaces.export` and `workspaces.exportPackage` optionally accept
`sensitiveTerms` (at most 100 nonempty strings of up to 200 characters) and
return `residueScan`: `found` (an exact, case-sensitive term occurs), `clean`
(absent from supported inspected data) or `unverifiable` (an image, unsupported
binary or undecodable text component remains). Only SHA-256 hashes of terms are
reported. It does not perform OCR, unpack archives, redact content, or certify
the absence of other secrets/PII.

## Export, import and transfer

Exports (format 2) keep revisions and revision histories, conversations and turn
manifests, exact artifact versions with component hashes and annotations, and
task/workflow/evidence/attachment links. They exclude browser sessions, cookies,
credentials, provider keys, model settings, global site rules, activity,
browsing history, the search index, request identities and backups; URL
metadata drops credentials, fragments and secret-named query parameters.
Captured text and file bytes are never rewritten by export cleaning.

Imports (formats 1 and 2) never write a path from their input, create new IDs,
remap structured references (which must resolve inside the export), rewrite
exported IDs cited in free-form text, verify recorded component hashes
(`COMPONENT_INTEGRITY` on mismatch), store HTML/script text inertly, sanitize
URLs and leave imported site rules and workflows disabled. The result's
`importReport` lists record counts, every lossy mapping (dropped unknown fields,
disabled policies, unresolved citations, initialized fields from older formats),
linked sources whose live content is not included, the inactive policies and
workflows, and exclusions. `dryRun: true` returns the same report without
committing; the GUI always previews first.

JSON exports are limited to 100 MiB and REST bodies to 1 MiB. Larger projects use
human-only `workspaces.exportPackage`/`workspaces.importPackage`: a folder in
`workspace-data/transfers/` with `workspace.json` (records with component
references), component files and a manifest of digests. Package names cannot
contain paths. Import rejects links and non-regular files, malformed or
duplicate manifest paths, unlisted or missing components and any digest
mismatch, all before any change is committed. Existing packages are never
overwritten.

## Sync-folder warnings

Startup and snapshots report known Dropbox, OneDrive, Google Drive and iCloud
paths, environment-configured sync roots, conflicted copies of the JSON or
SQLite store and placeholder files. Warnings reach the startup log and
`snapshot.storageWarnings` for the trusted GUI; workspace-scoped automation does
not receive filenames. Copies are never merged, renamed or deleted. If only
conflicted copies/placeholders exist, opening stops rather than creating a
misleading empty project. Detection uses path/name heuristics.

## Validation

`node --test test/store.test.js test/storage-safety.test.js test/search.test.js test/idempotency.test.js test/backups.test.js test/portability.test.js test/workspace.test.js`
covers locks, external writers and replaced files, verified component writes,
lossless version-1 migration (records, relationships, capture versions, browser
containers), interrupted/conflicting migrations, damaged databases and
components, orphan recovery, schema-runner upgrades and refusal of newer
databases, permissions, backups/verification/restore with interruption at each
step and offline CLI restore, automatic backup retention, lossless round trips,
import previews, corrupted components, malformed packages and links, and older
formats. `npm run test:perf` measures capture-heavy stores and asserts that
metadata changes leave component files untouched. Windows directory-fsync
behavior, macOS/Windows crash behavior and real sync-client races have not been
exercised on this Linux runner.
