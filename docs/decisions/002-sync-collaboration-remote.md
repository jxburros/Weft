# ADR 002: sync, collaboration and remote deployment scope

Status: local-only scope selected for the current product. Future implementations
require a separate accepted design. Last code review: 2026-10-17. Related: #35.

## Decisions

| Capability | Current decision | Ownership and privacy |
| --- | --- | --- |
| Optional cross-device sync | Deferred; use explicit workspace exports/backups | User owns local data and chooses any transfer destination |
| Concurrent shared-workspace editing | Deferred; one local process is authoritative | No hosted workspace owner/member model or implied sharing |
| Remote browser control/deployment | Unsupported; preserve authenticated loopback binding | Local bearer access is not a remote identity or workspace ACL |
| Hosting | No Weft-hosted synchronization service in current scope | No account, billing or hosted availability dependency |

These decisions keep local work independent of hosted services and do not remove
export/backup responsibilities. Shared project context does not authorize sharing
authenticated browser sessions, cookies, provider keys or active credentials.
An export is a transfer operation, not continuous sync or necessarily a verified
backup; follow the backup feature's documented verification/restore procedure.

## Conditions for revisiting

A sync proposal must define per-record revision/conflict semantics (including
delete tombstones, offline edits, artifact immutability and visible manual
resolution); authenticated encrypted transport; per-client revocable identities;
workspace roles/ACLs; server operator access; encryption and key recovery;
retention/deletion/export; migration and ownership transfer. Last-writer-wins
must never silently overwrite findings or policy. Sessions and provider keys
stay excluded by default and require their own distinct consent/design.

Remote deployment, if selected later, must be an explicit mode with TLS,
authenticated revocable clients and least-privilege workspace grants. Do not
make the existing loopback API public or expose raw Chromium debugging ports.
Document host/operator responsibilities and patch ownership before release.

## Acceptance tests required before implementation ships

- Existing local workflows succeed with no network or hosted account.
- Concurrent/offline edits and delete/update conflicts preserve both versions
  until an explicit resolution; retries do not duplicate operations.
- A revoked client cannot read, write, subscribe or resume a session; cross-
  workspace and cross-owner requests fail before content is returned.
- Transport downgrade, invalid TLS identity, expired credentials and replay
  fail; browser-origin and debugger access remain denied.
- Encrypted backup recovery succeeds on another device; loss-of-key behavior
  is explicit; migration is restart-safe and export remains available.
- No credentials, cookie partitions or authenticated sessions enter a sync
  payload unless a separately implemented, explicitly authorized mechanism
  covers them.

These are future gates, not claims of passing tests. The current loopback and
workspace boundary regressions remain applicable. No remote/sync feature is
implemented or enabled by this decision.
