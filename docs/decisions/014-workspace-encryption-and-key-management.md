# ADR 014: workspace encryption, key management and recovery

Status: accepted and implemented for issue #26 (2026-10-17). This record makes
the decisions that [ADR 001](001-workspace-encryption.md) left open; ADR 001
remains the requirements and threat-model statement it was measured against.
Storage layout and recovery context: [ADR 011](011-transactional-storage-search-and-recovery.md).

## Threat model

Encryption at rest protects workspace data from:

- someone who obtains the disk while Weft is not running or is locked (lost or
  stolen device, powered-off disk, disposed drive);
- other local OS accounts and anyone holding a copy of the profile folder or of
  a backup made while encryption was on, without this account's OS key store,
  passphrase or recovery key.

It does **not** protect against malware or any other program running as the
same user, a compromised operating system or administrator, debuggers/memory
dumps, or anyone using the computer while Weft is unlocked. While unlocked,
keys and decrypted records are in Weft's memory by design. OS swap,
hibernation files and crash dumps can contain unlocked data; OS full-disk
encryption remains the recommended complement.

## Decision summary

- **Opt-in, per profile**, turned on by a person in Settings > Encryption with
  explicit acknowledgement that losing every key loses the data.
- **Application-layer AES-256-GCM** (Node `node:crypto`) for record documents,
  settings, retained request results and component files. `node:sqlite` has no
  SQLCipher, and adding a native crypto build was rejected (supply chain,
  packaging on three platforms, and ADR 003's dependency checklist).
- **One random data key per profile**, not per workspace: one SQLite database
  holds every workspace, component deduplication spans workspaces, and locking
  is a property of the person's session, not of one project. Workspace and
  record identity is still bound into every ciphertext.
- **Key hierarchy**: a random 256-bit *profile key* is wrapped by (a) the OS key
  store through Electron `safeStorage` (Keychain, DPAPI, libsecret/KWallet),
  (b) a recovery key shown once, and optionally (c) a passphrase. The profile
  key wraps versioned random *data keys* and a random *index key*. Nothing
  derives keys from names, tokens or provider credentials.
- **Search**: the FTS5 index is **never written to disk** for an encrypted
  profile. It lives in an attached `:memory:` database (with `temp_store =
  MEMORY`), is rebuilt from the decrypted documents in bounded background
  batches after unlock (ADR 015; searches meanwhile report partial lexical
  coverage) and is discarded on lock. An encrypted on-disk shadow index was
  rejected: an encrypted FTS index cannot be queried, and a per-token blind
  index leaks term frequencies.
- **Locked state** is a typed `locked` outcome on every surface; only a person
  in the Weft window can unlock.

## Formats

| Item | On disk |
| --- | --- |
| Record document (`records.doc`) | `wfe1.<keyVersion>.<revision>.<base64(nonce‖ciphertext‖tag)>`; AAD = domain, collection, record id, profile id, key version and the declared revision; the decrypted record must carry that id and revision |
| Settings (`state_meta.value`) | Same envelope, AAD bound to the key; `schemaVersion` stays plaintext for offline tools |
| Retained request results | Same envelope, AAD bound to scope and request id |
| Request fingerprints | HMAC-SHA-256 under a key derived (HKDF) from the index key, over the argument digest |
| Component file | Name = HMAC-SHA-256 locator of the content digest (index-key derived); bytes = `WFC1` ‖ key version ‖ GCM sealed content with AAD bound to profile id, version and locator; the content SHA-256 is re-verified after decryption |
| Keyring `encryption-keyring.json` | Wrapped keys only: OS blob, scrypt-wrapped recovery and passphrase entries, profile-key-wrapped data and index keys, current version, pending rotation or migration marker |
| Database marker | `store_info.encryption = {profileId}` |

Nonces are 96-bit random per message. A plaintext row inside an encrypted
store, a ciphertext moved to another row, a changed revision or key version, a
flipped byte and a keyring for another profile are all rejected with
`component_integrity` and nothing is changed. Per-record authenticity does not
detect rollback of a whole profile or of one record to an older ciphertext of
the same record: the envelope declares its revision and the authenticated data
binds that declared revision, so an older sealed copy decrypts as the older
revision (no trusted counter exists). Someone with write access to the profile
can therefore swap in an earlier sealed value; that is outside the
confidentiality threat model and is documented in
[storage safety](../STORAGE-SAFETY.md#encryption-at-rest).

Human secrets: passphrases (minimum 12 characters) use scrypt N=2^17, r=8,
p=1; recovery keys carry 184 random bits plus a 16-bit checksum (ten base32
groups of four) and use scrypt N=2^15. KDF parameters are authenticated as
wrap AAD, so lowering them fails instead of weakening the key.

## Key lifecycle

- **OS key store.** `createKeyProtector` reports platform/backend. On Linux,
  `safeStorage.getSelectedStorageBackend()` of `basic_text` (no secret service:
  Chromium would use a hard-coded key), `unknown`, or an unavailable store is
  refused as protection; the person chooses manual unlock instead. On real
  Electron under xvfb in CI the backend is `basic_text`, and Weft reports it as
  not protective.
- **Unlock modes.** `os`: the OS key store unlocks at startup (protects the
  powered-off disk and other accounts; anyone who can sign in as the user can
  open Weft). `manual`: Weft starts locked and asks for the passphrase or
  recovery key every time. The profile key is never stored unwrapped.
- **Lock.** `encryption.lock` stops model turns and plugin processes, saves and
  closes every tab (no workspace page stays loaded; site requests are refused
  while locked), closes the database, drops decrypted state and the in-memory
  index, and zeroes key buffers. Every command except `encryption.status`,
  `encryption.unlock`, `encryption.checkRecoveryKey` and `guide.get` returns
  `locked` (HTTP 423, CLI exit 9, MCP `isError` with the same outcome), before
  any target lookup reads workspace data.
- **Idle auto-lock** (amended in 1.4.0). Off by default. A person sets it in
  Settings → Encryption → Unlock options (`encryption.configure`
  `autoLockMinutes` 1–1440 or null, `lockOnScreenLock`); agents cannot change
  it. The main process polls OS idle time (`powerMonitor.getSystemIdleTime`)
  every 30 s and, past the limit, locks through the same lock path with lock
  reason `idle`; with `lockOnScreenLock` the OS `lock-screen` and `suspend`
  events lock with reason `screen_locked`. Idle means no human keyboard or mouse
  use of the computer: agent commands never keep the profile unlocked, and
  running agent work stops at lock as with a manual lock. The setting lives in
  `<profile>/auto-lock.json` (not secret; a person with write access to the
  profile can turn it off, which is outside the at-rest threat model).
- **Unlock** is human-only administration from the trusted GUI (agents get
  `permission_required`). A wrong secret is `key_invalid`; an OS key that
  cannot unwrap (moved profile, other account, denied keychain) is
  `unavailable`, and the profile stays locked with reason `os_key_unavailable`
  — never a plaintext fallback.
- **Wrapping rotation** (`encryption.rotate {target: "wrapping"}`): new profile
  key and recovery key; data and index keys are re-wrapped atomically (one
  keyring replacement). The previous recovery key and passphrase stop working
  for this keyring; older backups keep their own keyring and earlier keys.
- **Data-key rotation** (`{target: "dataKey"}`): a new data key becomes current
  for new writes; a job re-seals records, settings, request results and
  components in queued batches (other commands interleave), then removes the old
  key and compacts the database. Every sealed value names its key version, so a
  crash or lock resumes from what remains; both keys stay in the keyring until
  nothing references the old one. Locators and fingerprints use the index key
  and do not change.
- **Recovery and loss.** The recovery key is shown once at enable (and after a
  wrapping rotation); `encryption.checkRecoveryKey` tests one without
  unlocking. If the OS key, passphrase and recovery key are all lost, the data
  cannot be recovered by anyone; enabling requires that acknowledgement.
  `encryption.configure` re-enrols the OS key on a new machine after a recovery
  unlock, switches unlock mode and sets/removes the passphrase.

## Migration

Enabling is in place and crash-safe:

1. Write the keyring with `pending: enable`.
2. Seal every referenced component under its locator (orphans until commit).
3. One SQLite transaction seals every record, setting and request result,
   rewrites component references and request fingerprints, drops the on-disk
   FTS tables and writes the database marker.
4. Checkpoint and `VACUUM` (with `secure_delete = ON`), clear `pending`, then
   overwrite with zeros and delete the plaintext component files.

At startup, without any key: a pending enable whose database has no marker is
rolled back (keyring removed, sealed orphans deleted); one whose database is
encrypted is completed (vacuum, keyring activated, unreferenced plaintext files
overwritten and removed) before the profile is unlocked or offered for unlock.
Disabling (`encryption.disable`, explicit plaintext acknowledgement) is the
mirror image; request identities that cannot be re-fingerprinted become
`already_committed` instead of re-applying. Real `SIGKILL` tests cover every
step of enable, disable and data-key rotation.

Overwriting is best effort and never called secure erasure: SSD wear
levelling, copy-on-write filesystems (APFS, Btrfs), snapshots, the freed tail
of a truncated database or WAL, and external backups can retain earlier blocks.
Enabling lists remaining plaintext copies (older backups, `recovery/` copies,
transfer packages); a person can choose to overwrite and remove the backups
and recovery copies. Export packages are the person's explicit exports and are
only listed. A verified encrypted backup is made right after enabling.

## Backups, restore and exports

- Backups of an encrypted profile copy the sealed database and component files
  and the keyring (manifest format 2 with the profile id and key versions).
  They are restorable on another machine with the recovery key or passphrase
  that was valid when the backup was made.
- Restore swaps the keyring with the data. If the session's profile key opens
  the restored keyring the profile stays unlocked; otherwise it locks and asks
  for that backup's secret. Restoring a plaintext backup produces a plaintext
  profile and the preview and result say so; the replaced keyring is kept in
  `recovery/pre-restore-*`.
- `workspaces.export`, `workspaces.exportPackage` and `workspaces.exportAs`
  from an encrypted profile refuse to run without `acknowledgePlaintext: true`,
  which the GUI sets only after a visible warning and checkbox; exports carry a
  plaintext limitation/warning. Duplication within the profile stays encrypted.

## Coverage of features merged after this decision

Reconciled when merging with archives/redaction (ADR 012), shared context and
linked sources (ADR 013), the credential broker (ADR 017) and integration
contracts with embeddings (ADR 018):

| Data | Encrypted profile |
| --- | --- |
| Resource archive manifests (URLs, statuses) and archived bodies (#16) | Manifests are part of the sealed artifact record; bodies (`bodyBase64`) are sealed components under keyed names. The offline preview decrypts into memory only (an in-memory, network-less partition) and closes on lock. Chromium's transient MHTML serialization during capture is overwritten with zeros before removal (best effort, like every overwrite). |
| Sanitized derivatives, restricted originals and purge (#17) | Versions and redaction metadata are sealed records. `artifacts.purgeContent` releases the sealed components; FTS rows of a purged or restricted version live only in the in-memory index. Overwrite is best effort, not secure erasure. |
| Embedding vectors and their queue (#67) | Amended: sealed at rest. Each chunk's text digest and float32 vector are one AES-256-GCM envelope under a key derived (HKDF) from the index key (stable across data-key rotation); the AAD binds profile, workspace, collection, record, version, chunk, model key and dimensions, and the on-disk digest column is an HMAC under a second index-derived key, so a guessed chunk text cannot be confirmed. Enabling encryption seals existing vectors inside the migration transaction and disabling opens them, so neither, nor lock/unlock, re-embeds anything: unlock only decrypts, and unchanged chunks are never sent to an endpoint again. A chunk that fails authentication is refused for search (`component_integrity`) and replaced, by re-embedding that chunk, on `search.reindex`. A profile encrypted before this change (vectors were memory-only) queues its embedded workspaces once at the first unlock. The queue (record identifiers, attempt counts, error text) and the per-workspace embedding setting (connection id, endpoint, model name, locality) stay on disk unsealed, like other identifiers and model connection settings. The queue does not run while locked. |
| Linked-source paths and fingerprints, cached service content (#22), shared collections and grants (#21), citations and quote selectors (#23), origin records (#66), conflicts | Inside sealed records and settings; cached service bodies are sealed components. Service credentials stay in their own OS-protected file, as before. |
| Chunked upload parts (#14) | Material and artifact upload parts are held in memory (never in `transfers/uploads/`), zeroed when committed, aborted, expired or the profile locks. Package uploads and export packages are plaintext by nature: exports need `acknowledgePlaintext`, and package folders are listed in the plaintext-copy inventory. |
| Events (#14) | Metadata-only and in memory; locking drops the retained log, and a replay from before the lock reports the gap reason `locked`. `events.list`, MCP resources and every other command answer `locked`. |
| Credential vault (#6) | Separate vault and key (ADR 017), outside `workspace-data`; it is not part of workspace encryption or backups. `credentials.*` commands, like every command, answer `locked` while the workspace data is locked. |
| Task runtime (#8, #10) | Plans, timelines, operation records and workflow run state are sealed task-record fields; sensitive run parameters are memory-only. Locking pauses runtime tasks (`profile_locked`) and stops scheduling; the startup sweep runs at unlock and only a person continues (ADR 016). |
| Resume records and tab groups (#24) | Sealed records like other workspace data, included in backups; excluded from exports (they describe this profile's tabs, listed in `excluded`). Browser-session and history writes commit only their own rows, still sealed. A headless session (#11) of a manual-unlock profile starts locked: `display.status` and stdout say a person must attach (`weft attach`) and unlock; `display.status`/`display.show` work while locked, everything else answers `locked`. |
| Payment records (#7, ADR 019) | Amended: sealed. `<profile>/payments/payments.json` sits outside `workspace-data` (it is not in workspace backups) but, with encryption on, is one AES-256-GCM envelope under the current data key (format 2, same envelope and AAD convention as sealed settings, domain `payments/records`). It is unreadable while locked (every `payments.*` command and the service itself answer `locked`); enabling seals it and overwrites the plaintext copy (best effort), disabling writes plaintext first, data-key rotation re-seals it before the old key is dropped, and a restore re-seals it under the restored keyring. A plaintext file inside an encrypted profile is treated as an interrupted migration and sealed at the next unlock (not rejected). The interrupted-click sweep runs at unlock for a locked profile. Card details stay in the separately encrypted credential vault; the optional issuer key stays wrapped by OS-protected storage. Settings lists payment records under "encrypted". |
| Scheduled work | Freshness checks, community-list checks, the embedding queue and automatic backups wait while locked; plugin processes and model turns stop at lock. |

## Not covered (documented, not claimed)

- Identifiers, collection names, workspace ids, record counts and order,
  component sizes, file timestamps, command names and request ids. The activity
  log keeps identifier-shaped values only in id fields (names of plugins,
  packages, formats, extractors and files become character counts), page URL
  origins and paths, and only the origin of service, endpoint, list, provider
  and update URLs (amended after integration).
- Chromium partitions: cookies, caches, site storage, service workers,
  downloads. Chromium encrypts cookies with the OS key store on some platforms;
  Weft does not rely on or claim it.
- The durable activity log (`activity-log.jsonl`): command names, actors, ids,
  page URL origins and paths, service URL origins, character counts —
  minimized, never record content or names (identifier-shaped free text and
  names are reduced to a character count).
  Approval previews (`approvals.json`, bounded and expiring), client grants,
  autonomy policy, model connection settings (keys are separately OS-encrypted),
  plugin/extension state, threat-intelligence and download-safety files.
- Process memory, swap, hibernation and crash dumps while unlocked; plaintext
  exports a person confirmed.

## Core, not a plugin

Checked against the core-versus-plugin checklist (ADR 003, `docs/PLUGINS.md`):
encryption changes persistence integrity and the authority boundary (locked
state on every surface, human-only unlock), needs the store's transaction and
component internals and the OS key store, and adds no external integration or
dependency. It therefore belongs in core; no plugin hook was widened for it.

## Alternatives considered

- **SQLCipher / encrypted VFS:** best coverage of SQLite pages but unavailable in
  `node:sqlite`; a native module would be a new supply-chain and packaging
  dependency. Revisit if Node ships an encrypted VFS.
- **Per-workspace keys:** stronger separation between projects, but no
  separation exists at the OS-account level that the threat model addresses,
  and it would split the database and component deduplication.
- **Passphrase-only:** rejected as the default; the OS key store gives at-rest
  protection without typing on every launch where it is real (not `basic_text`).
- **Rely on full-disk encryption only:** does not cover backups copied
  elsewhere or other local accounts with disk access.

## Verification

`test/encryption-integration.test.js` (sealed vectors and payment records, see the
coverage table), `test/encryption.test.js` (protector backends incl. `basic_text`, foreign
account and unavailable store; recovery-key checksum; keyring unwrap per
method, wrong/tampered secrets and KDF downgrade; AAD binding and tamper
detection; rewrap and rotations), `test/encryption-store.test.js` (no plaintext
anywhere in the profile after enabling, sealed rows, in-memory search, manual
and OS unlock, locked in-process paths, OS key unavailable then recovery and
re-enrolment, tampered/transplanted/injected rows, idempotency across
enable/disable, plaintext export acknowledgement, encrypted backups and locked
restore with the old recovery key, plaintext-copy inventory/removal,
rotations, disable), `test/encryption-crash.test.js` (SIGKILL at every enable,
disable and rotation step, including inside the commit transaction),
`test/encryption-surfaces.test.js` (REST 423, CLI exit 9, MCP and in-process
`locked`; agents denied unlock; secrets absent from activity) and
`test/encryption-gui.test.js` (real Electron `safeStorage` backend report,
Settings enable flow, one-time recovery key, lock screen, wrong passphrase,
restart unlock with the recovery key). `npm run test:perf` measures enabling,
writes, first/repeated search, export, reopen and rotation for an encrypted
11k-record profile.

Not verified: real macOS Keychain, Windows DPAPI and a Linux session with
libsecret/KWallet (the protector is exercised through an injected backend and
real Electron reports `basic_text` under xvfb); secure deletion on any physical
medium; behaviour under memory forensics.
