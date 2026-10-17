# Changelog

Entries describe implemented changes and verification limits. Product direction
alone is not a shipped capability.

## 2026-10-17 — Agent

### Changed

- Hardened JSON storage with ownership locks, verified writes, migrations,
  secret guards, export residue review and sync-conflict warnings.
- Unified outcomes/errors and compact MCP tools; added scoped client credentials,
  shared emergency stop, pinned targets and serialized browser input.
- Added provider disclosure/manifests, untrusted-content framing and error-key
  redaction; offline pinned community lists with verified rollback.
- Centralized design tokens, improved keyboard/dialog behavior, added reviewed
  light/dark GUI goldens and real Chromium/cross-platform Node CI.

- Added canonical agent guidance, a generated skill reference, and a local MCP
  client plugin manifest/configuration. Guidance is available as `guide.get`
  through the shared catalog.
- Added offline documentation schema checks, three MCP reference task evals
  with baseline deltas, and separate store/search/catalog performance budgets.
- Added canonical contributor instructions, a thin Claude overlay, product
  identity and architecture decisions for encryption, extensions/plugins and
  current local-only collaboration/deployment scope.
- Replaced the whole-file JSON store with transactional SQLite metadata
  (built-in `node:sqlite`, WAL, append-only schema migrations, external-writer
  detection) and verified content-addressed component files for captures and
  stored files; metadata edits no longer rewrite capture bytes (#25, ADR 004).
  Existing JSON stores migrate losslessly on first start with the original kept
  under `recovery/`; interrupted migrations recover and damaged or newer stores
  are preserved unchanged. The minimum Node.js version is now 22.13.
- Added a local FTS5 index with BM25 ranking for materials, context, task,
  workflow and capture text, scoped to the workspace in SQL, injection-safe
  query compilation and results that cite record revisions and exact capture
  versions (#67). Embedding/hybrid retrieval remains deferred.
- Added optional `requestId` idempotency to record mutations (replay or
  `idempotency_conflict`, bounded retention), atomic `batch.execute` with
  `$N.id` placeholders, and `dryRun` previews for deletions, imports, restores
  and batches across GUI/REST/CLI/MCP (#39).
- Added verified automatic and manual backups, journaled restore with preserved
  originals, offline `weft store` recovery, lossless format-2 export/import with
  lossy-mapping reports and GUI previews, and verified package folders for
  projects beyond the REST/JSON limits (#27).

### Not completed

- See [all 67 issue dispositions](docs/ISSUE-STATUS.md) for the 26 completed
  scopes and 41 broader/partial items left open.

- Workspace encryption, key lifecycle/recovery, extension compatibility testing,
  native plugin isolation/permissions and plugin loading remain unimplemented.
- Hosted sync, concurrent collaboration and remote deployment are deferred.
- Live-model evals, actual plugin installation in a Claude client and GUI
  first-render performance measurements have not been verified.

### Notes

Validation: Linux Chromium/GUI/golden checks, transport/security regressions and
syntax checks passed locally; CI additionally verifies Node 22/24 on Windows,
macOS and Linux. Offline MCP reference scenarios passed (3/3); performance budgets
passed for 10k materials and 1k captures. Integrated documentation, grouped MCP eval and performance checks passed
(6 tests, no skips; 11 documented command examples). These checks do not
establish cross-platform hardware/account support.
