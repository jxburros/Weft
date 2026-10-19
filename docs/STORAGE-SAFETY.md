# Local storage, backup and export safety

Verified against code: 2026-10-19. Design and rationale: [ADR 011](decisions/011-transactional-storage-search-and-recovery.md);
workspace encryption: [ADR 014](decisions/014-workspace-encryption-and-key-management.md).

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
| `encryption-keyring.json` | Present only when workspace encryption is on: wrapped keys, never an unwrapped key |

Without workspace encryption all of these contain plaintext project content
(including the search index). The search index is derived data: when its
format version changes it is rebuilt in bounded background batches after the
store opens, the rebuild position is saved with each batch (`store_info`
`searchIndexRebuild`) so a restart resumes it, and searches report partial
coverage until it finishes. Files and folders are created owner-only where
the OS supports it. See [Encryption at rest](#encryption-at-rest) for what
changes when a person turns encryption on.

The database holds every workspace collection, including handoff and takeover
records, shared context collections, evidence conflicts, freshness schedules,
record provenance and citations, linked-source metadata and cached service
versions (cached bytes are components), site-rule provenance (creator, revision history, review state),
storage modes (`storagePolicies`), community list subscriptions (`siteLists`),
conversation turn manifests, manual and learned memories (`memories` records),
background-learning configuration and processed-source fingerprints (the
`learning` entry in `state_meta`), embedding settings, vectors and
queue (`vector_*` tables) and the in-store activity entries. Modules that
share it (handoffs, community lists, site storage, extensions) commit through
the same transaction and, on failure, return to the last committed state, so a
change and its activity entries roll back together.

Other services keep their own small files in the same folder, outside the
database:

| File | Owner | Write method |
| --- | --- | --- |
| `activity-log.jsonl`, `activity-head.json`, `activity-config.json` | Hash-chained activity log | Append with fsync; head/config verified replacement |
| `approvals.json`, `authority-policy.json`, `client-grants.json` | Authority gate, approvals, agent grants | Stamped verified replacement (`writeVerifiedJson`) |
| `model-connections.json` | Model connections (encrypted key blobs) | Verified replacement |
| `service-credentials.json` | Service-reference credentials (OS-encrypted blobs via `safeStorage`; refused without OS protection) | Stamped verified replacement |
| `extensions/` (`extensions.json` and installed copies) | Per-workspace browser extensions | Stamped verified replacement |
| `plugin-grants.json` | Plugin enablement grants | Stamped verified replacement |
| `temporary-storage-journal.json`, `threat-intel.json`, `download-safety.json`, `quarantine/` | Browser security state | Durable temporary-file replacement (`src/atomic-json.js`) |

Updater state lives in the separate `updates/` folder of the user-data
directory. Stamped writes (`writeVerifiedJson`) refuse to overwrite a file that
changed since it was read; browser-owned journals use exclusive temporary files,
fsync and rename, and remove the temporary file if the write fails.

## Encryption at rest

Off by default; a person turns it on in Settings > Encryption
(`encryption.enable`, human-only) after acknowledging that losing the recovery
key, the passphrase and the OS key means the data is gone. Then:

| Store | Treatment |
| --- | --- |
| `records.doc`, `state_meta` values (except `schemaVersion`), retained request results | AES-256-GCM envelopes `wfe1.<keyVersion>.<revision>.…` bound to collection, id, revision and key version |
| Request fingerprints | Keyed HMAC, so guessable arguments cannot be confirmed |
| `components/` | Sealed files named by a keyed locator (no plaintext digests on disk); content SHA-256 re-verified after decryption |
| Search index | Not on disk: an in-memory FTS5 database rebuilt in bounded background batches after unlock; searches report partial coverage until it finishes |
| Embedding vectors (`vector_chunks`) | On disk, each chunk's text digest and vector sealed with an index-derived key (AAD: workspace, record, version, chunk, model, dimensions); the digest column is a keyed HMAC. Unlock only decrypts; nothing is re-embedded |
| Payment records (`<profile>/payments/payments.json`, outside `workspace-data`) | One envelope sealed with the current data key (format 2); unreadable while locked; re-sealed on data-key rotation and restore; a plaintext file left by an interrupted enable/disable is sealed at the next unlock |
| Backups | Sealed snapshot, sealed components and a copy of the keyring (manifest format 2) |
| `recovery/` copies made afterwards | Copies of the sealed database |
| Plaintext left from before | Listed by `encryption.status {inventory: true}` and when enabling; older backups and recovery copies can be overwritten and removed on request; export packages are only listed |

Still plaintext: record/workspace identifiers, collection names, record counts,
component sizes, timestamps of files, the activity log and other small policy
files listed above, Chromium partitions and anything exported with explicit
acknowledgement. The keyring wraps a random profile key with the OS key store
(Electron `safeStorage`; `basic_text` on Linux is refused), a recovery key and
an optional scrypt passphrase.

Locking (`encryption.lock`) closes the database, drops decrypted state and keys
and closes tabs; every command except `encryption.status`, `encryption.unlock`,
`encryption.checkRecoveryKey` and `guide.get` then returns `locked` (HTTP 423,
CLI exit 9). Profiles in manual unlock mode start locked. Only a person in the
Weft window unlocks.

Enabling, disabling and data-key rotation are crash-safe: one SQLite
transaction switches every value, a `pending` marker in the keyring lets the
next start roll back or complete the migration without any key, and every
sealed value names its key version so an interrupted rotation resumes. Plaintext
component files and freed database pages are overwritten (`secure_delete`,
`VACUUM`), but SSDs, copy-on-write filesystems, snapshots and the freed tail of
a truncated WAL can keep earlier blocks: overwriting is never called secure
erasure.

One exception keeps opening fast: when the full-text index format changes, the
old index is dropped while opening with `secure_delete=FAST`, which frees its
pages without rewriting them. A durable `searchIndexNeedsScrub` marker is
written in the same transaction; the freed pages are scrubbed with `VACUUM` in
the background after the rebuild, or immediately when content is restricted or
purged, and the marker is removed only after the scrub succeeds (an interrupted
scrub runs again after the next open, never during it).

Exports (`workspaces.export`, `workspaces.exportPackage`, `workspaces.exportAs`)
from an encrypted profile require `acknowledgePlaintext: true` and say they are
plaintext. Restoring an encrypted backup needs the recovery key or passphrase
that was valid when it was made unless the session's key still fits; restoring
a plaintext backup makes the profile plaintext again (the replaced keyring is
kept in `recovery/pre-restore-*`).

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
list (`storeMigrations` in `src/store.js`; the current version is 1, because new
collections such as `memories` are stored as ordinary record rows, and the
embedding tables are versioned separately by `vectorIndexVersion` in
`store_info` and recreated when that version changes); a consistent copy is saved in `recovery/` before an existing database is
migrated. A database from a newer Weft fails with `STORE_UNSUPPORTED`. One that
fails `quick_check` or cannot be opened fails with `STORE_CORRUPT` and is left
byte-for-byte unchanged; restore a backup (below).

## Backups and restore

`backups.create` (and the GUI's Back up now) writes a `VACUUM INTO` snapshot and
copies of every referenced component to a temporary folder, writes a manifest of
SHA-256 digests, renames it into place and verifies it (digests,
`integrity_check`, component completeness; for an encrypted profile also the
keyring and the encryption marker). The application also makes an
automatic backup at startup and every 24 hours when due, keeping the latest
five; failures appear as storage warnings and in `backups.list`. Manual backups
are not pruned. `backups.verify` recomputes everything and never modifies a
backup; manifest paths other than `workspace.sqlite`,
`components/<aa>/<name>` and, for encrypted backups, `encryption-keyring.json`
are rejected. Encrypted backups stay encrypted (see Encryption at rest).

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

### What a backup contains

A backup is the workspace database and the components it references: every
project record and revision, conversations and turn manifests, captures, files,
handoff history, site rules with their provenance, storage modes, community
list subscriptions, request identities and the in-store activity entries.
Restoring rewinds all of these together, including request identities: a
`requestId` first used after the backup is no longer remembered.

These are deliberately **not** in a backup and a restore leaves them as they are:

| Excluded | Reason |
| --- | --- |
| Hash-chained activity log | Append-only evidence. Rewinding it would break or hide the chain; a restore is appended to it as a `backups.restore` entry with the backup ID, and `activity.verify` stays intact. |
| Approvals, autonomy policy, agent connection grants | Authority must never be widened by old data: a restore could revive revoked grants, used approvals or higher autonomy. Current authority applies to restored workspaces. |
| Model connections and keys | Credentials; never copied into backups. |
| Credential vault, wrapped key, task grants (`<profile>/credentials`) | Saved sign-ins live outside `workspace-data` (ADR-017), so backups, exports and packages never contain them; restoring cannot revive a revoked sign-in. |
| Service-reference credentials | Credentials; never copied into backups or exports. Restored service references keep their state but need a person to store a credential again if the file is gone. |
| Linked file and folder contents | They stay at their own location; the database holds only the path, hashes and status. A restore does not bring back the bytes of a changed or deleted linked file. |
| Temporary-storage journal, threat intelligence, download scanner settings, quarantine | Current browser security state. Rewinding could restore stale threat lists or forget origins that still need erasing. |
| Plugin grants, extension installs | Enablement is a human decision bound to code digests; a restore must not re-enable revoked code. |
| Updater state | Tracks installed and staged application versions, not project data. |
| Chromium partitions (cookies, site storage) | Browser session data; not project data. |

A restore never changes these files, so after one a workspace can reference an
approval, grant or autonomy ceiling for a workspace that no longer exists (it
is simply unused) or lack one it had when the backup was made.

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
manifests, exact artifact versions with component hashes and annotations,
task/workflow/evidence/attachment links, site-rule provenance (creator, revision
history, review state), handoff/takeover history and the workspace's memories
(an import makes shared memories workspace-scoped). Background-learning
configuration is not exported, and an import never enables learning. They exclude browser
sessions, cookies, credentials, provider keys, model settings, global site rules,
activity, browsing history, the search index, request identities, backups,
storage modes and community list subscriptions (both browser policy for this
profile; subscribe again to verify signed lists), approvals, autonomy ceilings
and grants; each exclusion is listed in the export's `excluded` field; URL
metadata drops credentials, fragments and secret-named query parameters.
Captured text and file bytes are never rewritten by export cleaning.

Imports (formats 1 and 2) never write a path from their input, create new IDs,
remap structured references (which must resolve inside the export), rewrite
exported IDs cited in free-form text, verify recorded component hashes
(`COMPONENT_INTEGRITY` on mismatch), store HTML/script text inertly, sanitize
URLs and leave imported site rules and workflows disabled. Imported site rules
keep their creator and revision history with an added "Imported inactive for
review" revision. Imported handoffs get new IDs and remapped evidence; a handoff
that was still open or accepted becomes cancelled history (`importedStatus`
keeps the original) because its tabs belong to the exporting session. The result's
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
exercised on this Linux runner. Encryption is covered by `test/encryption*.test.js`
(including real `SIGKILL` crash tests at every migration and rotation step);
real macOS Keychain, Windows DPAPI and Linux secret-service backends have not been
exercised.
