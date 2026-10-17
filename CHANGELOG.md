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

- Model replies stream from OpenAI-compatible, Anthropic and Ollama-native
  endpoints (SSE/NDJSON) to the GUI and to API clients (`Accept:
  text/event-stream`), with a defined turn lifecycle: stops keep partial replies
  marked interrupted, length/deadline stops are continuable, runtime and in-band
  provider errors become failed turns, and first-token/idle/total deadlines apply.
- `/v1/events` events have ids and replay from `Last-Event-ID` with bounded
  retention and explicit gaps; `/v1/turns/{turnId}/events` resumes one turn.
  Event types are a registry for other components.
- Chat turns accept typed attachments (passages, tab snapshots, materials,
  context, tasks, exact artifact versions) with item-level review/exclusion,
  per-model context-window planning that omits oldest history visibly, and show
  endpoint locality, provider-reported usage and configured-price estimates.
- Per-model capability records (configured, probed via `models.probe`, or
  default), typed `unsupported_capability` outcomes (CLI exit 5), bounded PNG
  image input per API transport, and explicit acknowledged vision fallback with
  provenance. Image paths are never treated as visual evidence. See ADR-004.
- Verified only against local fake providers; Linux GUI goldens for the Ask
  panel and settings need a reviewed update on the reference platform.

- Added canonical agent guidance, a generated skill reference, and a local MCP
  client plugin manifest/configuration. Guidance is available as `guide.get`
  through the shared catalog.
- Added offline documentation schema checks, three MCP reference task evals
  with baseline deltas, and separate store/search/catalog performance budgets.
- Added canonical contributor instructions, a thin Claude overlay, product
  identity and architecture decisions for encryption, extensions/plugins and
  current local-only collaboration/deployment scope.

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
