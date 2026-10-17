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
- Added a Weft plugin system (#61): strict data-only manifests, built-in
  `markdown`, `citations` and `session-stats` plugins, `plugin.<name>.*`
  catalog commands, five named hooks (`capture-format`, `page-extract`,
  `after-command`, `activity-report`, `export-format`) reached only through a
  registry, new `workspaces.exportAs`, `artifacts.render`, `activity.report`
  and `page.extract` commands, and `plugins.list/enable/disable/invoke`.
  Third-party plugins are listed without running code, enabled only by a person
  against manifest/code digests, kept from automation by default and run in a
  permission-model child process. An import-boundary test guards core.
- Added per-workspace unpacked Manifest V3 browser extensions (#34):
  human-only audit/install/enable/disable/remove with exact host grants,
  an audited permission allowlist, hash pinning and restart re-verification.
  Extension-originated requests are limited to granted hosts and every block
  rule. A real Electron fixture run records supported/denied APIs in ADR-004.
  Enabled extensions still run code in granted pages; this residual risk is
  documented. Only Linux/Xvfb was observed.
- Settings gained plugin and extension management dialogs that show scope
  before enablement; workspace export can produce Markdown through the plugin.
- The `unsupported` error code (HTTP 422, CLI exit 1) reports a requested
  format, extractor or extension engine feature that is not available.

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
