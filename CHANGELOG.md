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
- Added packaging with electron-builder 26.15.3 (build-time dev dependency):
  Windows assisted per-user NSIS installer with generated brand bitmaps and Weft
  text, data-preserving upgrades and opt-in confirmed data removal on uninstall;
  macOS dmg/zip; Linux AppImage/deb. Packaged builds keep the `weft` profile folder.
- Added a stable-only verified updater (`update.status`, human-only `update.check`,
  `update.install`, `update.rollback`, `update.configure`) and a Settings > Updates
  center: fixed GitHub source, size/SHA-512 verification, prerelease/downgrade
  refusal, opt-in daily staging-only checks, health check with rollback and the
  `WEFT_DISABLE_UPDATES` kill switch. No update traffic occurs unless a person
  checks or opts in.
- Added a tag-gated release workflow (version/changelog gate, signing when secrets
  exist, packaged smoke tests, SHA256SUMS, draft-then-publish), a CI Linux package
  smoke job, Dependabot, ADR-010 and `docs/RELEASING.md` (platforms, support policy,
  Electron/Chromium cadence, trust roots, security gates). Releases need a
  `## vX.Y.Z — date` changelog section.
- Update commands run under the shared authority gate: `update.status` is a
  classified read (no network); check/install/rollback/configure are human-only
  administration (automation gets the typed `human_only` denial). Update
  requests and check outcomes are recorded in durable activity; emergency stop,
  plugin and stream shutdown and site-data cleanup coexist with the updater's
  background-check stop on quit. ADR renumbered to 010.

- Added signed, governed community site lists (#28): Ed25519 publisher key
  pinning with rotation and anti-rollback, private-group/public subscriptions
  with label/warn/block modes, digest-confirmed update previews, rollback,
  unsubscribe, visible exceptions, opt-in verified source checks, a strict
  claim/source/entity/opinion schema, file-based governance with
  `scripts/community-list.js`, `lists.matches` precedence/provenance and ADR-004.
  Fixture-validated; no hosted service, management screen or member authentication.
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
  default), typed `unsupported_capability` outcomes (CLI exit 8), bounded PNG
  image input per API transport, and explicit acknowledged vision fallback with
  provenance. Image paths are never treated as visual evidence. See ADR-006.
- Streaming model turns run under the shared authority gate: `chat.send` is
  `cloud_spend`, `models.probe` is human-only administration, and destination
  decisions, primary/vision-fallback requests and turn outcomes are recorded in
  durable activity without content. `unsupported_capability` uses CLI exit 8
  so it stays distinct from `approval_required` (exit 5).
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
- Enforced one authority gate in the shared dispatcher for every non-human
  caller, including internal model read tools: human-only floors, autonomy
  levels with workspace ceilings, and purpose-bound client grants with
  cross-workspace, data-class, destination, usage-limit and task-binding scopes
  that a human can edit or revoke live (#5, #43; ADR-005).
- Added one durable approval queue bound to exact command/argument/actor/target
  fingerprints with approve-once, standing and reject decisions in the GUI.
  Denials are typed (`error.details.authority`); approval requests return
  `approval_required` (HTTP 403, CLI exit 5). Unclassified commands need an
  exact approval for every use.
- Added a hash-chained, append-only activity log with attempted/completed/
  partial/externally-uncertain outcome labels, model destination decisions,
  blocks and overrides, secret exclusion and URL minimization, configurable
  age/count retention independent of artifacts, `activity.list` cursor
  pagination, `activity.verify` and GUI filters (#29). Bootstrap token defaults
  to standing autonomy for compatibility; `activity.list` now returns
  `{items, nextCursor}` instead of an array.
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
  rule. A real Electron fixture run records supported/denied APIs in ADR-007.
  Enabled extensions still run code in granted pages; this residual risk is
  documented. Only Linux/Xvfb was observed.
- Plugin and extension commands run under the shared authority gate: built-in
  plugin commands are classified from their manifests (permissions raise the
  class and set data classes), `plugins.invoke` is raised to the invoked
  operation's class, nested hook/capability reads are re-dispatched with the
  caller's identity (gated, approval-aware and recorded in activity), plugin
  and extension administration and `workspaces.exportAs` are human-only
  administration, and emergency stop also terminates plugin processes.
  `activity.report` now renders the durable activity log.
- Settings gained plugin and extension management dialogs that show scope
  before enablement; workspace export can produce Markdown through the plugin.
- The `unsupported` error code (HTTP 422, CLI exit 1) reports a requested
  format, extractor or extension engine feature that is not available.
- Added `page.snapshot` semantic snapshots with frame-scoped stable element
  refs, coverage reporting (cross-origin frames, redacted fields, lazy, busy,
  virtualized, opaque and truncated content) and an isolated-world observer;
  `page.click`/`page.fill` accept refs bound to the actor's latest snapshot and
  an element fingerprint (#15, #41).
- `page.screenshot` adds element/region capture, crop and resolution limits,
  capture geometry metadata and sensitive-field masking; added permission-gated
  `page.clickAt`/`page.press` with viewport geometry validation (#15, #41).
- Automation input now requires a current-state inspection by the same actor;
  per-tab input is serialized with a configurable queue and optional exclusive
  mode; newly blocked navigations fail as `site_blocked` (#9, #41).
- Added explicit tab control modes (`tabs.setControlMode`: you drive, assist,
  agent drives), takeover boundaries that report uncancellable in-flight
  actions, and persisted structured handoffs (`handoffs.*`) shown in the GUI (#9).
- Readable/HTML extraction runs in an isolated world and strips `srcdoc`;
  page-sourced titles drop control and bidi-override characters (#41).
- Observation, raw input, control-mode and handoff commands are classified for
  the shared authority gate (`page.snapshot` external read with page content;
  `page.clickAt`/`page.press` external writes with form/message/account
  categories; `handoffs.*` local records; `tabs.setControlMode` human-only
  administration). The gate decides first; version, inspection and queue checks
  follow, so an approval never substitutes for fresh inspection. Takeover
  boundaries are recorded in durable activity and published as `handoff`
  events; handoff record changes also publish `handoff` events.
- Added browser-owned site storage modes (block, session-only, remember, clear)
  with revocable workspace exceptions and defaults, an opaque-origin sandbox
  for blocked sites, cross-site `SameSite=None` cookie blocking by default, a
  crash-safe temporary-data journal and a published coverage matrix (#18).
- Added site-rule evidence links, creator, revision history, review dates and
  `siteRules.review`; `siteRules.explain` and a GUI explanation of every matching
  rule, exception and security finding in precedence order; structured
  `site_blocked` outcomes (HTTP 403, CLI exit 4); cancellation of speculative
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
- `site_blocked` is one code across navigation, input and engine-abort paths:
  HTTP 403, CLI exit 4 (a policy refusal; exit 5 stays `approval_required`) and
  the same `error.details.blocked` structure. Site-storage, threat, launch and
  scanner setters are human-only administration; `storage.policy`,
  `siteRules.explain`, `threats.status` and `launches.list` are classified reads.
  Site-rule and security blocks, unsolicited downloads, pending/refused external
  launches, popups without input and quarantined downloads are recorded in
  durable activity. Extension-originated requests are also subject to security
  intelligence. ADRs renumbered to 008 (storage modes) and 009 (destination
  intelligence and downloads).

### Not completed

- See [all 67 issue dispositions](docs/ISSUE-STATUS.md) for the 26 completed
  scopes and 41 broader/partial items left open.

- Workspace encryption, key lifecycle/recovery, extension compatibility testing,
  native plugin isolation/permissions and plugin loading remain unimplemented.
- Hosted sync, concurrent collaboration and remote deployment are deferred.
- Activity integrity is tamper evidence only; a process that can rewrite the
  profile can rewrite the log. The changed agent-connections dialog needs a
  reviewed golden update in the Linux visual CI job (local fonts differ).
- Live-model evals, actual plugin installation in a Claude client and GUI
  first-render performance measurements have not been verified.
- Installers are unsigned (no signing/notarization credentials). The Windows
  installer was compiled but not built runnable or run; macOS packages, the
  release workflow on GitHub and real updates between published versions have not
  been exercised. Automatic rollback is AppImage-only.

### Notes

Validation: Linux Chromium/GUI/golden checks, transport/security regressions and
syntax checks passed locally; CI additionally verifies Node 22/24 on Windows,
macOS and Linux. Offline MCP reference scenarios passed (3/3); performance budgets
passed for 10k materials and 1k captures. Integrated documentation, grouped MCP eval and performance checks passed
(6 tests, no skips; 11 documented command examples). These checks do not
establish cross-platform hardware/account support.
