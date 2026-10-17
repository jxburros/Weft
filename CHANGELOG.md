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
- Added browser-owned site storage modes (block, session-only, remember, clear)
  with revocable workspace exceptions and defaults, an opaque-origin sandbox
  for blocked sites, cross-site `SameSite=None` cookie blocking by default, a
  crash-safe temporary-data journal and a published coverage matrix (#18).
- Added site-rule evidence links, creator, revision history, review dates and
  `siteRules.review`; `siteRules.explain` and a GUI explanation of every matching
  rule, exception and security finding in precedence order; structured
  `site_blocked` outcomes (CLI exit 5); cancellation of speculative
  prefetch/prerender requests, which Electron's feature switches did not stop;
  and real Chromium before-contact tests with positive controls (#19, #41).
- Page-initiated popups now need input in their tab; gesture grants end when
  the tab commits another document (#41).
- Added hash-pinned offline threat lists with staleness, an optional
  off-by-default Safe Browsing v4-compatible hash-prefix provider, security
  findings that need an explicit risk acknowledgement, pending human approval
  for external application launches, collapsed repeat/burst downloads with
  source and file type, OS origin metadata, quarantine and an optional local
  scanner with honest statuses (#20). Live provider, real scanner and
  Windows/macOS metadata were not verified.

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
