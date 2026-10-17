# Changelog

Entries describe implemented changes and verification limits. Product direction
alone is not a shipped capability.

## 2026-10-17 — Agent

### Changed

- Added canonical agent guidance, a generated skill reference, and a local MCP
  client plugin manifest/configuration. Guidance is available as `guide.get`
  through the shared catalog.
- Added offline documentation schema checks, three MCP reference task evals
  with baseline deltas, and separate store/search/catalog performance budgets.
- Added canonical contributor instructions, a thin Claude overlay, product
  identity and architecture decisions for encryption, extensions/plugins and
  current local-only collaboration/deployment scope.

### Not completed

- Workspace encryption, key lifecycle/recovery, extension compatibility testing,
  native plugin isolation/permissions and plugin loading remain unimplemented.
- Hosted sync, concurrent collaboration and remote deployment are deferred.
- Live-model evals, actual plugin installation in a Claude client and GUI
  first-render performance measurements have not been verified.

### Notes

Validation: offline MCP reference scenarios passed (3/3); performance budgets
passed for 10k materials and 1k captures. Documentation validation and shared
interface integration are checked by the final integrated test run; these
checks do not establish cross-platform hardware/account support.
