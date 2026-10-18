# Changelog

Entries describe implemented changes and verification limits. Product direction
alone is not a shipped capability.

## Unreleased

Documentation only; no behavior changed.

- Rewrote the README around the project promise, a concrete scenario, how human
  control works, and a single "Status and limits" section. Moved the detailed
  CLI/MCP/REST, authority, keyboard, model, persistence and protection material
  into [docs/CONNECTING.md](docs/CONNECTING.md) and
  [docs/USING-WEFT.md](docs/USING-WEFT.md).
- Added a [documentation index](docs/README.md) that separates guides from
  contributor records, and moved the issue disposition to
  `docs/maintainers/ISSUE-STATUS.md`.
- Restructured `docs/IMPLEMENTATION.md` into an at-a-glance summary, a short
  status table and per-section detail. Verification dates remain only on documents
  that make verification claims.
- Verified: `npm run test:docs` passes and every relative Markdown link resolves.
  Not verified: the full test suite, which this change does not touch.

## 2026-10-18 — Windows installer in CI and releases

### Added

- CI builds the unsigned Windows NSIS installer on `windows-latest` for every PR
  and push to `main`, verifies its `latest.yml`, and runs
  `scripts/release/windows-install-check.ps1`: silent per-user install, the
  uninstall registry entry, Start menu and desktop shortcuts, a packaged smoke
  test of the installed app, a reinstall over the existing copy (the upgrade
  path) and a silent uninstall. Workspace data in `%APPDATA%\weft` must survive
  both the reinstall and the uninstall, and the update cache must be removed by
  the uninstall. The installer is kept as a 14-day workflow artifact.
- The release workflow runs the same check before publishing, and unsigned
  Windows release notes explain how to verify the installer against
  `SHA256SUMS.txt` and get past SmartScreen.

Verified on GitHub's `windows-latest` runner (Weft 1.1.0, Electron 44.9.0).
Not verified: a desktop Windows 10/11 machine, an upgrade between two real
releases (the reinstall uses the same version), and the interactive installer
and uninstaller pages, which a silent run does not show; installers remain
unsigned.

## 2026-10-18 — Agent

### Fixed

- Cross-site cookie blocking no longer fails open when Electron cannot resolve
  the requesting frame (it then omits both `frame` and `webContents`, which
  made the request look same-site). A request is now cross-site when its
  requesting document (`initiatorOrigin`) or its top page is on another site,
  so a cross-site frame also no longer receives the top site's cookies; top-level
  navigations stay first-party. The intermittent `cross-site cookie header
  removed` failure was the commit race fixed in 1.1.0, not a test artifact: with
  the earlier logic the real-Chromium test reproduced the leak
  (`cookie: 'firstparty=1'`), and the Cookie header was visible to the hook in
  every probe. The real-Chromium test now repeats the tracker-to-embedding-site
  transition on several fresh sites. `test/site-security.test.js` covers stale
  and unresolved frames without timing. Engine findings, including why Chromium's
  process-wide third-party cookie switch is not used, are in ADR-008.

## v1.1.0 — 2026-10-18

Minor release. Version strings (`package.json`, `package-lock.json`,
`.claude-plugin/plugin.json`) are aligned at 1.1.0 and `npm run release:check`
passes. The user-visible changes since 1.0.0 are the entries below, including
bounded background search indexing, OS memory-pressure tab suspension, sealed
payment records and embedding vectors, the GUI accessibility audit, the finished
design system, the community-lists and agent-input screens, and the CI/Windows
test-stability fixes. Electron 44.9.0. Documentation was re-verified against the
code on this date (`npm run test:docs` and guidance generation are clean).
Installing, upgrading across real versions and rollback on each operating system
remain unverified on real machines (`docs/RELEASING.md`).

### Fixed

- Cross-site cookie blocking no longer races page commits: a new top
  document's subresource requests can reach the main process before its commit,
  while the frame still reports the previous page's URL, so a tracker the person
  had just visited could receive its first-party cookie when embedded by the next
  site. Top-frame requests are now judged by their initiating document's origin
  (embedded frames still by their top document); regression covered in
  `test/site-security.test.js`.

## 2026-10-17 — Agent

### Changed

- Search-index rebuilds are a bounded background job (#30, ADR-015 amended): a
  search-index version change or an encrypted profile's in-memory index after
  unlock no longer rebuilds while opening the workspace or on the first search.
  Opening runs at most one short batch; the rest runs in ~10 ms batches between
  commands, a plaintext rebuild resumes from its saved position after a restart,
  and writes are indexed immediately. Searches meanwhile return partial results:
  page mode sets `partial: true` with `coverage.lexical` (`complete`,
  `unindexedRecords`, progress) and never verifies an absence; unpaged
  `search.query` outcomes have status `partial` and an outcome-level `coverage`.
  `search.status` reports progress, human-only `search.indexing` pauses or
  resumes the rebuild, and metadata-only `indexing` events report it.
- Tab suspension also follows the operating system's memory pressure (#30):
  Linux pressure-stall information and available memory, Windows available
  memory, and a conservative macOS free-page heuristic (Electron system memory
  as a fallback), combined with the existing renderer budget and every
  suspension blocker; human setting `resources.systemMemoryPressure` (default
  on). Unsaved-input, media and fullscreen checks now cover every subframe,
  including cross-origin frames; a frame that cannot be inspected keeps its tab
  loaded (`frame_not_inspected`). Verified on Linux only; the macOS and Windows
  sources are exercised through injected values.
- A command whose deadline expires keeps its concurrency slot until its work
  actually settles (it still answers `deadline_exceeded` promptly), so
  timed-out-but-running commands count against global, client and task limits;
  `resources.status` reports them as `agentCommands.afterDeadline`.
- Payment records are sealed with the workspace encryption keys (ADR-014 and
  ADR-019 amended): one AES-256-GCM envelope under the current data key,
  unreadable while locked, sealed on enable (plaintext copy overwritten best
  effort), written as plaintext before disable, re-sealed on data-key rotation
  and restore; the interrupted-submission sweep runs at unlock for a locked
  profile. Settings lists payment records as encrypted.
- Encrypted profiles keep embedding vectors on disk sealed per chunk (an
  index-key-derived AES-256-GCM key, keyed digest column) instead of in memory
  only: enabling, disabling, locking and unlocking re-embed nothing, so unchanged
  text is never sent to an embedding endpoint again. A vector that fails
  authentication is refused and replaced on `search.reindex`. Profiles encrypted
  earlier queue their embedded workspaces once at the first unlock.
- Activity summaries keep identifier-shaped values only in id fields (plugin,
  package, format, extractor and file names become character counts) and keep
  only the origin of service, endpoint, model, list, provider and update URLs.
- Approval cards say why a void approval is void (checkout changed, another
  approval used first, task closed, cancelled, not saved, not clicked) instead
  of a bare "invalidated"; a regression test pins that a click refused with
  `inspection_required` leaves its one-time approval usable after inspecting.
- Audited GUI accessibility (#31) in real Electron: `test/accessibility.test.js`
  runs axe-core 4.13.0 (new pinned dev dependency) and rendered checks over
  every view, dialog, stop page, split view, agent panel and lock screen in both
  themes (state and focus contrast, 24 px targets, 11 px text floor, Tab
  reachability, focus restoration, 200% zoom/text at the minimum window,
  reduced motion, quiet polling). Fixes: F6/Shift+F6, Ctrl+L and Ctrl+K now
  leave a website for Weft's chrome (the page never sees them and leaving is
  not a takeover); polling no longer replaces the focused control; one status
  and one alert announcer replace noisy live regions (status bar, streamed
  tokens, approval/activity lists); landmarks, headings and names; muted and
  disabled contrast; keyboard entry for redaction areas; the app is inert
  behind the lock screen; outcome codes now survive the preload bridge, so a
  lock made outside the window shows the lock screen. Real screen readers,
  magnifiers and Windows/macOS were not run; see `docs/ACCESSIBILITY.md`.
- Finalized the implemented design system (#36): spacing, radius and type
  scales consolidated (11 px floor), disabled/focus/trusted-surface tokens, a
  persistent ownership badge and page frame with a reduced-motion-safe handoff
  pulse, state badges with distinct marker shapes, split-view pane headers and
  focused-pane frame, and one "Weft browser control" band for browser-owned
  decisions (including the credential entry window, which now bundles Source
  Sans 3). `npm run logo:validate` measures every logo variant at 16–256 px;
  the supplied mark loses its crossing at 16–32 px, so a generated optical
  variant now supplies the 16/24/32 px favicon images
  (`artifacts/logo-contact-sheet.png`). Final brand approval remains a human
  decision (`docs/DESIGN-SYSTEM.md`).
- Added a Community site lists screen (#28) under Settings and Privacy:
  subscribe with the publisher key fingerprint and full change preview,
  digest-confirmed updates, mode/reviewer/source/scheduled-check changes,
  exceptions, matches for an address, rollback and unsubscribe. Added Agent
  input settings (#9) for shared/exclusive input and the per-tab queue limit
  and wait.
- Visual goldens now pin fontconfig rendering (slight hinting, greyscale,
  DejaVu fallback), so machine-local font settings no longer fail them on
  unchanged code; all twelve were regenerated and reviewed.
- Split view pairs the active page with another live page (not a blank or
  blocked tab).

- Added resource archives (#16, ADR-012): `artifacts.capture` with
  `kind: "archive"` stores Chromium's MHTML serialization as content-addressed
  resource components with a manifest (URL, MIME, size, SHA-256, status) that
  lists failed, missing, script, oversized and over-budget resources explicitly,
  removes sensitive form values, bounds readiness and duration, and records
  original/final URL, timing, viewport, state changes, request failures,
  coverage and incomplete reasons. Added `artifacts.compare` (text, resource
  and pixel diffs), `artifacts.verify`, and a human-only offline preview
  (`artifacts.preview`/`artifacts.closePreview`) with JavaScript disabled,
  archive-only responses and blocked navigation, forms, popups and downloads.
- Added capture redaction and controlled derivatives (#17, ADR-012):
  `artifacts.redact` saves sanitized derivative versions (text spans, titles,
  URLs and re-encoded PNG regions; `preview: true` first) with
  `derivedFrom`/`redactions`/`inaccessibleRegions` metadata; human-only
  `artifacts.setAccess` restricts originals (withheld from agents, model
  attachments, search and default exports) and `artifacts.purgeContent`
  removes stored content; `artifacts.readOriginal` needs the new
  `restricted_original` data class and an exact one-time approval per read.
  `artifacts.review` and export `reviewMetadata` add URL/query/path review and
  labelled pattern-detection assistance; exports take a `captures` policy and
  report `excludedContent` and `linkedSourcesNotIncluded`. The search index uses
  FTS5 secure-delete. GUI: archive coverage, offline preview banner, version
  comparison, redaction editor and export capture policy. Limits: no archived
  HTML redaction, OCR, note/annotation rewriting or erasure of earlier backups.
- Integrated payment authorization (#7, ADR 019) with restricted originals,
  trusted context, integration contracts, scheduling and encryption:
  `terms_changed`/`merchant_changed` join the outcome tables; a submit past its
  deadline never clicks; payment events are metadata-only; checkout tabs with a
  pending or submitting payment are never suspended; payment records are
  documented as outside workspace encryption.
- Integrated headless sessions, resume state, tab groups, browsing-data import
  and resource scheduling (#11, #24, #30, ADR 015) with the credential broker,
  archives, task runtime, encryption and integration contracts: tabs are never
  suspended under a protected login, during a capture or workflow recording,
  or while a runtime task step targets them; task steps take scheduler slots
  and count against budgets; a locked headless profile reports the lock in
  `display.status` and on stdout; resume records and tab groups are sealed;
  `resource_busy` (exit 3) and `budget_exhausted` (exit 4) join the outcome
  tables as documented exit-code categories.
- Integrated the durable task runtime, phase vocabulary and workflows (#8,
  #58, #10, ADR 016) with archives/redaction, shared context, encryption and
  integration contracts: task identities keep restricted originals withheld and
  need human approval for trusted-context promotion; locking pauses runtime
  tasks and the unlock sweep records in-flight work honestly; command steps
  accept `deadlineMs`; `duplicate_risk` joins the outcome tables; phase changes
  are published once. MCP gains a ninth tool, `weft_knowledge`, for shared
  collections, linked sources, services, citations, freshness and conflicts, so
  every tool stays under the size budget.
- Integrated workspace encryption (#26, ADR 014) with archives, redaction,
  shared context, linked sources, the credential broker, embeddings and
  transfers: embedding vectors and their queue are memory-only in encrypted
  profiles (dropped from disk on enable, rebuilt after unlock); archive bodies,
  cached service content, collections, citations and origins are sealed; upload
  parts stay in memory; locking closes the archive preview, discards uploads and
  the retained event log, and pauses freshness, list and embedding work. New
  `locked` (HTTP 423, exit 9) and `key_invalid` (422) codes are in the outcome
  tables. Real Keychain/DPAPI/libsecret backends remain unverified.
- Integrated integration contracts and hybrid retrieval (#14, #67, ADR 018)
  with archives, redaction, knowledge and credentials: restricted and purged
  capture versions are never embedded and lose their vectors in the restricting
  commit; `transfers.read`, downloads and MCP resources withhold restricted
  originals; search keeps shared-collection records (lexical, labelled);
  `collections.list`, `conflicts.list` and `credentials.list` page; new
  metadata-only `collection`, `conflict` and `credential` events; service
  refreshes, credential fills and archive captures honor request deadlines.
  MCP `sources.*`/`services.*` moved to `weft_workspace` to keep each tool under
  the 2,000-character budget.
- Integrated restricted originals with shared collections, citations and
  protected login: shared-collection reads withhold restricted versions,
  citations never anchor against a restricted original (re-anchoring uses its
  sanitized derivative or reports `restricted_original`), and automation archive
  capture is refused on a tab in, or entering, a protected operation.
- Completed integration contracts (#14, ADR 018): every outcome carries a stable
  `status` (succeeded, partial, blocked, approval_required, stale_state, conflict,
  unsupported, invalid, cancelled, timed_out, failed) and the authenticated
  `request` linkage, contract-tested for every error code across GUI IPC, REST,
  CLI and MCP; caller deadlines (`Weft-Deadline-Ms`/`deadlineMs`, CLI
  `--deadline-ms`, MCP `deadlineMs`) return `deadline_exceeded` stating whether the
  command started and whether it rolled back, stopped or is uncertain (new
  `execution: "uncertain"`); `expectedRevision` on deletions, task transitions and
  artifact annotations; additive `page: {limit, cursor}` pagination returning
  `{items, nextCursor, total}` for every large collection plus new
  `conversations.messages` and `artifacts.versions`; task, artifact, navigation,
  policy, workspace and approval events with `events.list` replay for CLI/MCP;
  `weft.capabilities` and `GET /v1/capabilities`; MCP resources for guidance,
  the command reference and scoped workspace records; verified chunked uploads
  (`transfers.*`) and streamed downloads (`transfers.read`, `GET /v1/download`)
  beyond the 1 MiB request cap, including staging package folders whose import
  stays human-only.
- Added optional hybrid retrieval (#67, ADR 018): a person enables embeddings per
  workspace (Settings > Semantic search, human-only `search.configureEmbeddings`)
  with an embedding model already available at an existing connection (Ollama
  `/api/embed` or OpenAI-compatible `/embeddings`; nothing is downloaded; non-device
  endpoints need an egress acknowledgement and never receive local-only records).
  Vectors are float32 BLOBs with exact cosine search (up to 20,000 per workspace),
  indexed incrementally and re-embedded on model change; `search.query` fuses BM25
  and vector results by reciprocal rank (k=60) with citations, `mode`, coverage and
  a verified-absence signal; `search.status` and `search.reindex`; retrieved
  context sent to models (read tool and new `search` attachment) is capped at 0.4
  of the window after the reserved reply. Evaluated with a deterministic fake
  local embedding endpoint only.

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
- Replaced the whole-file JSON store with transactional SQLite metadata
  (built-in `node:sqlite`, WAL, append-only schema migrations, external-writer
  detection) and verified content-addressed component files for captures and
  stored files; metadata edits no longer rewrite capture bytes (#25, ADR 011).
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
- Storage integration: handoff and takeover records, site-rule provenance,
  storage modes, community subscriptions, turn manifests and activity retention
  now commit through the SQLite store; a failed change in any of them rolls back
  every collection it touched, including its activity entries. Format-2 exports
  carry site-rule provenance (creator, revision history, review state) and
  handoff history; imported handoffs that were still open become cancelled
  history because their tabs belong to the exporting session. Storage modes and
  community subscriptions are listed as excluded. Handoffs are searchable (index
  version 2 rebuilds on open). ADR renumbered to 011.
- `batch.execute` passes the authority gate for every contained command with the
  caller's identity; a batch that needs approval needs one exact one-time
  approval of the whole batch (standing approvals never cover a batch; at most
  20 commands), client usage/rate limits count every contained command, and an
  agent batch stays in one workspace. Request IDs are scoped per client, replays
  are re-authorized, and activity records batches, each applied command, replays
  and dry runs.
- Fixed: a one-time approval was spent when the gate admitted a command even
  if the browser then refused it before any input (`inspection_required` or
  other stale-state checks). Such pre-execution refusals now give the approval
  back for the identical retry (recorded as `approval_restored`); a command
  that starts keeps it consumed.
- Fixed: the chat disclosure review could end as cancelled when a "close"
  event queued by the previous dialog (the attachment picker) arrived after the
  review opened, so the reviewed message was silently not sent (seen as a
  flaky GUI test under load). The review now ends only when it is closed or
  replaced. The GUI test waits for the durable reply rather than the streaming
  bubble, checks the message was sent once, and waits for the dark wordmark
  image to load instead of sampling it once.
- Added a credential broker and protected login operation (#6, ADR-017): saved
  sign-ins are purpose-bound references (label, purpose, exact origins, optional
  embedded-frame origins, expiry, revocation, masked account) created only in
  Settings > Saved sign-ins, with the secret typed into a separate browser-owned
  window. A separate broker process (empty environment, Node permission model
  limited to its vault directory) seals entries with AES-256-GCM under a
  `safeStorage`-wrapped key and authenticates their authorization metadata;
  Linux `basic_text` is refused. Optional 1Password CLI (`op read`) adapter,
  tested only with a fake CLI. New commands `credentials.status/list/get`,
  `credentials.fill` (`credential_use`: exact one-time approval bound to the
  destination, or a human task grant) and human-only `credentials.create/update/
  revoke/delete/grantTask/revokeGrant/configureProvider`; MCP `weft_browser`
  grows accordingly (reviewed baseline update) and a `credentials` guidance
  topic was added.
- `credentials.fill` verifies top-level and target-frame origins in the browser
  process and the broker, fills in the top frame's isolated world, and returns
  sanitized status only. During it and a cooldown every other automation command
  on the tab except `page.inspect` is refused (titles withheld); afterwards filled
  fields stay redacted in snapshots and captures, `page.evaluate` is refused on
  the filled document, and observation is refused if the page reveals or copies
  the secret. Refusals carry a fixed `error.details.credential` word.
- Backups contain the workspace database and its components only; approvals,
  grants, autonomy policy, the activity log, browser security state, plugin and
  extension state and updater state are deliberately not restored (see
  `docs/STORAGE-SAFETY.md`). A restore appends to the activity hash chain and
  never rewinds it.
- Added shared context collections (#21, ADR-013): an owner workspace shares
  chosen context, materials and captures with other workspaces as read or
  write members; creating, sharing, granting and revoking are human-only and
  recorded as history. People, internal models (attachments and the search
  tool) and scoped agents meet one record boundary (`collections.list/get/read`,
  `collections.write` with required `expectedRevision`); revocation applies to
  the next command. Sharing context never shares browser sessions: no shared
  session container is offered (decision recorded), and the real Chromium test
  keeps cookies/localStorage isolated with a collection shared.
- Linked files, folders and service references (#22): a person links a file or
  folder from a native picker (`sources.link`) or stores a managed copy; Weft
  records path, size, mtime, inode and SHA-256/manifest hash and reports
  available, changed, moved, missing or inaccessible (`sources.check`),
  accepting changes only on `sources.refresh` and moves only on a human
  `sources.relink`. Agents read linked content only through `sources.read`
  (bounded, inside the linked root, traversal and symlink escapes refused, no
  local paths disclosed). Service references (`services.*`) use an adapter
  contract with a generic HTTP(S) adapter: explicit access status, refresh
  timestamps, cached versions versus live content, conditional refresh, no
  redirects, OS-protected credentials (never exported or logged) and cached
  content withheld from agents after access is refused or revoked. Exports list
  omitted linked content. ByAuthorX, Vixl, AI Server Studio and QAI-ality are
  evaluated as optional adapters only.
- Context review (#23): `context.propose`, and `context.promote` under the new
  `trusted_context` action class (a person, or a human approval once or
  standing, task-scoped for task-bound grants; never an autonomy level or
  source text). Exact citations pin capture versions, record revisions or
  source hashes; `citations.check`, `freshness.check` and opt-in scheduled
  checks (`freshness.configure`) flag stale citations and open conflicts;
  `conflicts.create/get/resolve` preserve contradictions and conflicting edits
  and resolve them attributably (keep both, choose, merge, dismiss) without
  rewriting originals. Export/import round-trips citations, proposals,
  conflicts and collections (without grants) with remapped IDs and recomputed
  citation statuses.
- Record provenance and quote selectors (#66): server-set `origin` on context,
  materials, every revision and capture versions; automation cannot claim
  human or pasted authorship and cannot set the actor. TextQuoteSelector
  citations re-anchor after NFKC, ligature, typography and whitespace
  normalization; unknown cite targets are stored unverified instead of
  rejecting the record; imported provenance is kept only as a claim.
- GUI: a Context review panel (proposals, conflicts, source check and
  schedule, provenance and citation details), linked-source and service status
  on material cards, link/service options when adding a material, and a Shared
  context view for collections. New offline eval `propose-cited-finding`; the
  eval count check now follows the task files.
- Added opt-in workspace encryption at rest (#26, ADR 014): Settings >
  Encryption and `encryption.status/enable/lock/unlock/configure/rotate/checkRecoveryKey/disable`.
  Records, settings, request results and components are sealed with
  AES-256-GCM (node:crypto) bound to collection, id, revision and key version;
  component files get keyed names; the search index exists only in memory after
  unlock. A random profile key is wrapped by the OS key store (Electron
  `safeStorage`; Linux `basic_text` is refused), a one-time recovery key and an
  optional scrypt passphrase. Enabling/disabling is in place and crash-safe
  (one transaction plus key-free startup recovery; plaintext overwritten where
  feasible, never called secure erasure); wrapping rotation and resumable
  data-key rotation; encrypted backups carry their keyring; restores re-lock when
  the backup needs a different key; exports from an encrypted profile require
  `acknowledgePlaintext`.
- Added the `locked` outcome (HTTP 423, CLI exit 9; `error.details.reason`) on
  REST, CLI, MCP, GUI IPC and in-process dispatch while encrypted data is
  locked, a full-window GUI lock screen, `encryption` events, and `key_invalid`
  for a wrong passphrase or recovery key. Unlocking is human-only from the Weft
  window; locking stops model turns and plugins and closes tabs.
- Activity summaries now keep identifier-shaped strings only in identifier
  fields (`id`, `...Id`, `name`, `command`, `format`); one-word free text such as
  a note body is reduced to a character count. `passphrase` and
  `recoveryKey` fields are never logged.
- Encrypted-mode performance budgets (enable, write, first/repeated search,
  export, reopen, data-key rotation) in `npm run test:perf`.

- Added a durable task runtime (#8, #58, ADR-016): task plans of command, model,
  review and handoff steps run through the shared dispatcher as the task's bound
  identity (built-in runner, the agent's own grant or the automation token), so
  grants, approvals and emergency stop gate every step. New commands
  `tasks.start`, `tasks.pause`, `tasks.continue`, `tasks.cancel`,
  `tasks.redirect` and human-only `tasks.reassign`, `tasks.review`,
  `tasks.reconcile`, `tasks.retryStep`. One phase vocabulary (`queued`,
  `running`, `waiting_on_human`, `paused`, `completed`, `failed`, `cancelled`,
  `uncertain`) with a transition table; every transition is stored with actor
  and reason and logged as a `task` activity entry. The task state `waiting` is
  renamed `waiting_on_human` (existing records are normalized on open and import).
- Operation records are committed before every step; a startup sweep pauses
  interrupted local work and marks attempted external work `uncertain`, shown
  on the Overview and as a safety notice. Uncertain work is never retried
  blindly: `duplicate_risk` (exit code 3, HTTP 409) until a person reconciles it
  or confirms the duplicate risk. Emergency stop reports already-submitted
  steps. Task results report staleness when their inputs change.
- Workflows (#10) gain typed parameters, substitution, required materials,
  allowed sites, credential references resolved through the credential broker,
  expected-output confirmation and invalidated-step detection; `workflows.run`
  and `workflows.validate` run them as runtime tasks under current grants.
  Workflows written or changed by automation are inactive until a person
  reviews them. Human-only `workflows.recordStart`/`workflows.recordStop`
  record secret-free steps from a person's navigation, commands and trusted
  in-page clicks and field changes.
- Chat models with tools enabled can call `propose_task`; the proposal is shown
  for a person to review and nothing is created or started automatically.
- GUI: task detail with step timeline, blockers, history and controls, review
  of uncertain work (reconcile, duplicate-risk retry), workflow editor with
  parameters and JSON steps, run dialog and recording from the current tab.
- Approval previews withhold sensitive workflow parameter values.
- Headless sessions and display handoff (#11, ADR 015): `--headless` or
  `WEFT_HEADLESS=1` runs the same profile, hidden GUI renderer, policies and
  command catalog with pages rendered offscreen, so reads and captures work
  without a visible window. A single-instance lock turns a second launch into a
  display handoff (no restart); `display.status`, `display.show`, `weft attach`
  and human-only `display.hide` attach and detach. Pending human decisions are
  reported in `display.status` and on stdout while headless. Pages reload when
  they move between offscreen and on-screen rendering, and the transition is
  recorded and disclosed. `--ozone-platform=headless` was evaluated and is
  unsupported (Electron 44 sizes windows and views at 1×1). SIGINT/SIGTERM now
  quit cleanly.
- Resume state, tab groups, tab search and browsing-data import (#24):
  per-workspace resume records (`resume.get`/`resume.save`: section, active tab,
  split panes and focused pane, panel layout, pinned resources) with continuation
  links to blockers, open tasks and handoffs, restore disclosures in the window;
  tab groups (`tabGroups.*`, `tabs.group`) with named colors shown as text;
  `tabs.search` and a Ctrl+Shift+A quick switcher with ownership, group, task and
  suspension indicators; human-only `browsingData.sources/preview/import` for
  Chromium-family `Bookmarks`/`History`, Firefox `places.sqlite` (containers
  listed) and Netscape bookmark HTML, previewed with duplicates, unsupported
  fields and a digest the import must match. Passwords, cookies, sessions,
  autofill and payment data are never read; SQLite files are copied before
  reading.
- Resource scheduling (#30): global, per-client and per-task agent concurrency
  (`resource_busy`, HTTP 429, CLI exit 3), a bounded capture queue for
  screenshots, PDFs and artifact captures with progress events, `captures.list`
  and `captures.cancel`, client run-time and model-spend budgets measured from
  provider-reported usage and configured prices (`budget_exhausted`, HTTP 429,
  CLI exit 4; unpriced models are refused under a spend budget), one home for
  capture and model image limits, `resources.status`, and idle or memory-pressure
  tab suspension (`tabs.suspend`) that keeps URL, title, scroll and records,
  restores on use and never suspends leased, task-bound, busy, playing or edited
  tabs. Human resource limits live in `settings.update` (`resources`).
- Performance: browser commands no longer copy the whole workspace to look up a
  workspace, and browser-session and history writes commit only their own rows.
  `perf/responsiveness.js` measures GUI first render, agent navigation, input and
  scroll latency, memory and CPU in real Electron with concurrent agents;
  `test/responsiveness.test.js` enforces generous budgets in the Linux job.
- Added payment authorization (#7, ADR-019): `payments.propose` has Weft read
  the checkout (browser-verified merchant origin and checkout frame, destination,
  rendered total, subtotal, tax, shipping, ISO 4217 currency, recurrence wording,
  pay-control label) and queues one approval bound to a fingerprint of every
  term plus ceiling, recurrence cap, actor, purpose and task, shown on a
  dedicated payment card in Agent requests. `payments.submit` (once-only
  `payment`) re-reads the checkout immediately before the click and refuses
  `terms_changed` or `merchant_changed` (new error codes, HTTP 409, CLI exit 3,
  fixed `details.changed` words), voiding the approval (new approval status
  `invalidated`). Attempts are committed before the click, one approval allows
  one attempt, and interrupted attempts become `uncertain` until a person
  reconciles them (`payments.reconcile`, `payments.retry`, or the task runtime
  with a registered payment reconciler). New commands `payments.status/list/
  get/propose/submit/cancel/checkCharges` and human-only `payments.reconcile/
  retry/issueCard/closeCard/configureProvider`; MCP `weft_browser` grows
  accordingly (reviewed baseline update) and a `payments` guidance topic was
  added.
- Saved payment cards: `credentials.create` takes `kind: "payment_card"` (card
  details typed into the browser-owned entry window, Luhn/expiry checked by the
  broker, brand and last four digits authenticated with the entry);
  `credentials.fill` fills card fields across the top frame and authorized
  processor frames inside the protected operation and never submits
  (`card_submit_separate`).
- Optional virtual cards (off by default): a provider interface and an
  issuer adapter in the style of Lithic/Privacy.com create single-use or
  merchant-locked cards limited to the approved ceiling, store them directly in
  the vault, close them, and list transactions for reconciliation and for
  checking later charges against an approved recurrence; clear `unsupported`
  outcomes without a provider, for unsupported currencies or issuer refusals.
  Settings gain a Payments section (payment list, virtual-card configuration).

### Fixed

- Opening a workspace whose search index has an older version no longer zeroes
  every page of the old index first (seconds of synced writes on Windows CI; the
  open blocked longer than a full rebuild). The stale index is dropped with
  `secure_delete=FAST` and a durable scrub marker in the same transaction; the
  freed pages are scrubbed with `VACUUM` in the background once the rebuild
  finishes, or at once when content is restricted or purged, and the marker is
  cleared only after a successful scrub. Regression tests reset first and
  restrict, purge or delete afterwards, then check the database and WAL bytes
  (`test/index-reset-privacy.test.js`); the prior `secure_delete` value is
  restored on every path.
- Model-stream deadlines and stops now always end the turn: every body read
  races the turn's abort signal, and cancellation is not awaited. Previously a
  read already in flight could stay pending after the request was aborted (seen
  intermittently with Node 22's fetch), so an idle or total deadline never
  returned and the turn hung. Regression: `test/model-stream-abort.test.js`.
- Test hang guards scale with `WEFT_TEST_TIME_SCALE` (`test/time-budget.js`; the
  unit runner's per-file cap too). CI sets 4 on Windows, where synced writes are
  several times slower, instead of loosening the guards everywhere. Model
  deadline tests use timers that still fire mid-stream on slow runners, and a
  dialog's close event restores keyboard focus to its opener on every close path.
- The offline archive preview no longer fails and closes when the archived
  document has been shown but an embedded resource (for example an `<object>`)
  never finishes loading; after 15 seconds loading stops and the preview stays
  open with `complete: false` and the reason. It still fails if the document
  itself never loads. Found by reproducing a CI-only archive-test failure under
  parallel load.
- Screenshots wait for a painted frame and treat Chromium's transient
  `UnknownVizError` (no compositor surface yet) like an empty frame within the
  bounded retry; new collections keep the workspace they were created in when
  the GUI's active workspace changes meanwhile.

- Windows CI: tests close every store, server, broker and child they open before
  removing their temporary profile (shared `test/temp-profile.js`, which on Linux
  fails a test that removes a directory with a file still open). The failing
  removal hook had also skipped later cleanup hooks, leaving fake model servers
  and timers running, which is what timed out `encryption-integration` on Node 22
  and hung the Node 24 Windows job; the unit runner now also passes
  `--test-force-exit`. No product handle leak was found: closing a workspace
  releases every file, and only the test's simulated external database
  replacement renamed over an open file.
- Real-Electron tests (archives, protected logins, checkouts, page observation,
  recording, knowledge GUI, encryption settings) run only in the Linux Chromium
  job, and every Electron launch, including the packaged smoke test, removes
  `ELECTRON_RUN_AS_NODE` instead of blanking it (Windows treats an empty value as
  set and started Electron as Node: `bad option: --no-sandbox`).
- Crash tests recognise Windows termination (exit code 1, no signal, after the
  child's crash marker); plaintext-scan paths, linked-file canonical paths (8.3
  short names) and the permission-bit scenario are platform-correct; AppImage
  replacement tests are Linux/macOS only, and a database replaced while open is
  asserted to be refused by Windows itself. None of this was run on Windows
  here: it is reasoned from the CI log and verified on Linux.
- The fake 1Password CLI in the credential tests lives in a canonical temporary
  directory: Node passes the broker's permission-model flags to child Node
  processes, and under them a script reached through macOS's `/var` symlink
  could not start.

### Not completed

- See [all 67 issue dispositions](docs/ISSUE-STATUS.md): 58 completed scopes
  (26 in the first pass, PR #71, and 32 in the second pass on this branch) and 9
  items left open (#4 tracker, #6, #20, #26, #31, #33, #36, #54, #60). Each stays
  open for validation that code cannot supply: independent security review,
  real-platform and provider runs, real OS key stores, real assistive
  technology, signing credentials and brand sign-off. Issues close only after
  the changes land on main.
- Browser extensions (unpacked Manifest V3, per workspace) and third-party
  plugins (permission-model child process) are fixture- and Linux/Xvfb-tested
  only; there is no Web Store/CRX install, extension toolbar or options UI,
  optional permissions or Manifest V2, and no real third-party extension or
  plugin ecosystem was exercised.
- Workspace encryption has not been exercised against real macOS Keychain,
  Windows DPAPI or a Linux secret service (injected backends; real Electron
  reports `basic_text` under xvfb). There is no idle auto-lock, rollback of a
  whole profile to an older copy is not detectable.
- Hosted sync, concurrent collaboration and remote deployment are deferred.
- Activity integrity is tamper evidence only; a process that can rewrite the
  profile can rewrite the log.
- The credential broker has not had an independent security review, so
  credential isolation is not asserted (#6 stays open). Not verified: a real
  1Password account, macOS Keychain/Windows DPAPI/libsecret behavior (tests use a
  test-only key protector) and the broker in packaged asar builds. Bitwarden and
  KeePassXC adapters and vault rollback detection do not exist.
- Payments (#7) are tested with fixture pages in real Chromium, scripted
  checkouts, a process kill and a fake card-issuer server only: not validated
  with real merchants, payment processors (3-D Secure, wallets, per-field card
  frames) or a real Lithic/Privacy.com account. Payment records are outside
  workspace exports and backups.
- Task runtime and workflows (#8, #58, #10) are fixture-, process-kill-, GUI- and
  real-Chromium-tested only: not validated with real external accounts, payment
  providers or long runs. No recorded lookup exists for page clicks, fills or
  sign-ins (a person determines the outcome). Recording does not capture typed
  keystrokes, drag and drop, cross-origin frames or closed shadow roots.
- Live-model evals and actual plugin installation in a Claude client have not
  been verified. GUI first-render and responsiveness numbers come from Linux
  under Xvfb with software rendering, not real hardware.
- Headless sessions, offscreen captures and display handoff were tested on
  Linux/Xvfb only; macOS and Windows behavior is not verified. Browsing-data
  import was tested with synthetic profile fixtures, not real browser profiles.
  Memory-pressure tab suspension on Windows and macOS is exercised through
  injected values only.
- Visual goldens were regenerated and reviewed for the accessibility and design
  system work with pinned font rendering, on Linux only; they establish no
  Windows or macOS appearance. The accessibility audit used axe-core and rendered
  checks; no real screen reader, OS magnifier or high-contrast run was done (#31
  stays open), and final brand sign-off (logo, typeface, palette, workspace
  naming) is a human decision (#36 stays open).
- Payment, credential and community-list features have no real-service
  validation: no real merchant, card issuer, password manager account or
  published community list was used, and the threat-intel provider, Mark-of-the-Web
  and macOS quarantine metadata and a real malware scanner were not exercised
  (#20 stays open).
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
