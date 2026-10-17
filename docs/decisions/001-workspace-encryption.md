# ADR 001: workspace encryption and recovery

Status: architecture direction recorded; implementation deferred. Issue #26
remains open. Last code review: 2026-10-17.

## Decision and threat model

Do not describe Weft's workspace as encrypted. Provider-key OS safe storage is
not workspace encryption. Local project records, captured text/images, exports,
indexes and artifacts require a coordinated storage design before an encryption
claim is made. OS full-disk encryption is the current host-level mitigation;
it does not protect data from another process running as the unlocked user.

Select envelope encryption for a future workspace-encryption feature using a
maintained, audited AEAD library and OS-protected wrapping keys. Each workspace
gets a randomly generated data key; do not derive keys from workspace names,
API tokens or provider credentials. Authenticate workspace ID, record ID,
schema and key version as associated data. Never reuse a nonce under a key.
The crypto implementation/library choice remains a reviewed implementation
prerequisite, not a custom algorithm to add opportunistically.

## Coverage and lifecycle requirements

| Surface | Required treatment before an encrypted-workspace claim |
| --- | --- |
| Records, captures and files | Encrypt payloads and sensitive metadata; authenticate before parse |
| Search indexes and previews | Encrypted persistence or memory-only indexes rebuilt after unlock |
| Temp files and crash journals | No plaintext spill; crash cleanup and authenticated recovery |
| Backups and exports | Encrypted by default for encrypted workspaces; explicit visible plaintext export |
| Chromium cookies/caches/sessions | Separate threat domain; OS/session controls do not imply workspace encryption |
| Downloaded files, logs and OS swap | Explicitly outside coverage until separately designed; minimize content logging |

Lock must flush/stop writes and clear accessible keys/content caches, stop provider
and automation operations for the workspace, and reject reads through every
surface. Unlock uses the OS credential store or a user recovery secret. Key
unavailability must fail closed without a plaintext fallback. Wrapping-key
rotation rewraps keys; data-key rotation rewrites content atomically and keeps
old keys only while recovery needs them. Recovery uses an independently stored
user-controlled recovery key; the app must explain that losing all usable keys
means permanent loss. A running compromised host can read unlocked data and is
outside this protection boundary.

## Migration and acceptance gates

Migrate to a new encrypted store with a verified backup, authenticated manifests,
versioned records and an atomic cutover marker. Preserve the original until the
new store is verified, disclose existing plaintext copies, and never promise
secure deletion on SSDs. Imports into an encrypted workspace must not leave
plaintext staging copies. Cross-platform backup recovery must not depend solely
on one machine's OS key store.

Before shipping: exercise interrupted migration/rotation and restart; every
locked read/write/provider path; missing/corrupt/wrong keys; authenticated
corruption and rollback; recovery on a second OS account/machine; encrypted
backup verification and explicit plaintext export. No such encryption lifecycle
or cross-platform tests are implemented by this ADR. Storage migration, key UX
and recovery implementation are outstanding; issue #26 is not resolved.
