# Open-issue disposition — 2026-10-17

This pass reviewed all 67 issues open at the start. “Completed” describes the bounded issue scope implemented and regression-tested in PR #71; broader parent issues remain open. Closure occurs only after integration checks pass and changes land. Platform signing, real screen readers/accounts and hosted services are not inferred from fixture tests.

## Completed scope

| Issue | Evidence/change |
| --- | --- |
| [#32](https://github.com/jxburros/Weft/issues/32) | Cross-platform Node CI, Linux Chromium/visual jobs, lockfile installs, syntax checks and retained failure artifacts. |
| [#34](https://github.com/jxburros/Weft/issues/34) | Real Electron 44/Chromium 152 fixture evaluation and ADR-004 support matrix; human-only per-workspace unpacked MV3 install/enable/disable/remove with exact host grants, audited permission allowlist, hash pinning, extension egress limited to granted hosts and site rules; hostile fixtures refused. Residual risk (code in granted pages) documented; macOS/Windows not evaluated. |
| [#35](https://github.com/jxburros/Weft/issues/35) | ADR-002 explicitly retains local-only operation and defers hosted sync/collaboration/remote service with concrete future gates. |
| [#37](https://github.com/jxburros/Weft/issues/37) | Actionable bounded validation errors, field paths, allowed values, suggestions and shared API error schema. |
| [#38](https://github.com/jxburros/Weft/issues/38) | Shared typed outcomes across GUI/REST/CLI/MCP, stable error/exit codes and explicit unverified page-action outcomes. |
| [#40](https://github.com/jxburros/Weft/issues/40) | Hashed structured untrusted-data framing for selected context, history and tool outputs; sensitive editable fields removed from readable pages. |
| [#42](https://github.com/jxburros/Weft/issues/42) | Human-issued scoped workspace/client tokens, expiry, live revocation, attribution, event scoping and trusted settings management. |
| [#44](https://github.com/jxburros/Weft/issues/44) | Shared admission latch covers API/CLI/MCP and model reads, human-only resume; aborts model requests even when pausing tasks fails. |
| [#45](https://github.com/jxburros/Weft/issues/45) | Eight grouped MCP tools, full reference lookup, authority annotations and a reviewed serialization-size ratchet. |
| [#46](https://github.com/jxburros/Weft/issues/46) | Small shared command/field alias registry with reported normalization and strict rejection of conflicts/unknown fields. |
| [#47](https://github.com/jxburros/Weft/issues/47) | Canonical guidance registry, packaged agent skill and plugin metadata, generated references and guide.get. |
| [#48](https://github.com/jxburros/Weft/issues/48) | Generated command reference, described schemas and in-process/REST/CLI/MCP/real GUI outcome parity. |
| [#49](https://github.com/jxburros/Weft/issues/49) | Published command examples validated against the canonical catalog; executable reference tasks checked offline. |
| [#50](https://github.com/jxburros/Weft/issues/50) | Automation ambiguity rejection, resolved workspace/tab targets and echoed outcomes, scoped record lookup and focus-safe dispatch. |
| [#51](https://github.com/jxburros/Weft/issues/51) | Cross-process ownership lock, external-change detection, verified temporary writes, file/directory flush and preserved conflicts. |
| [#52](https://github.com/jxburros/Weft/issues/52) | Versioned migration runner, historical state/export fixtures, original backups and refusal of newer/invalid schemas. |
| [#55](https://github.com/jxburros/Weft/issues/55) | Bounded readable provider errors with literal and encoded credential redaction, including short keys. |
| [#56](https://github.com/jxburros/Weft/issues/56) | Recursive secret-field guards, sensitive-term export scan with found/clean/unverifiable outcomes, GUI review. |
| [#57](https://github.com/jxburros/Weft/issues/57) | Itemized provider disclosure, scoped cloud acknowledgement, local-only restrictions and durable per-turn manifests. |
| [#59](https://github.com/jxburros/Weft/issues/59) | Offline list installs pinned to repository/commit/path/hash/size, disabled rules, provenance, status and verified rollback. |
| [#61](https://github.com/jxburros/Weft/issues/61) | Strict data-only manifests, built-in plugin list, `plugin.<name>.*` catalog commands, five named hooks via a registry, digest-bound human enablement, sandboxed third-party plugins off for automation by default, permission-fed autonomy gate, import-boundary test with `KNOWN_COUPLINGS`, and docs/PLUGINS.md checklist. Grants are profile-wide, not per workspace. |
| [#62](https://github.com/jxburros/Weft/issues/62) | Three scripted MCP reference tasks with task success, round trips, errors/retries, result size and baseline deltas. |
| [#63](https://github.com/jxburros/Weft/issues/63) | Separate measured regression budgets for 10k-record writes/search/export/import and command/OpenAPI generation. |
| [#64](https://github.com/jxburros/Weft/issues/64) | Reviewed light/dark Linux Electron goldens, fixed fixtures/fonts, tolerance, retry and failure diff artifacts. |
| [#65](https://github.com/jxburros/Weft/issues/65) | Seeded record shadow model and hostile import rollback tests, inert traversal filenames, control/provider locality matrices and timeouts. |
| [#68](https://github.com/jxburros/Weft/issues/68) | Sync-folder/placeholder/conflicted-copy warnings and preserved copies, visible in GUI. |
| [#69](https://github.com/jxburros/Weft/issues/69) | Canonical AGENTS/CLAUDE guidance, core identity/invariants, change checklist and consistent changelog. |
| [#70](https://github.com/jxburros/Weft/issues/70) | Single machine-readable design-token source, generated theme CSS, reduced-motion tokens and drift/contrast checks. |

## Remains open

Each row states the specific uncompleted requirement and why this pass does not justify closing it. These are remaining implementation or validation dependencies, not silent failures or claims that the work is impossible.

| Issue | Remaining work / reason |
| --- | --- |
| [#4](https://github.com/jxburros/Weft/issues/4) | The umbrella tracker remains open because required child roadmap items below remain incomplete. |
| [#5](https://github.com/jxburros/Weft/issues/5) | Per-client scopes are implemented, but destination/purpose/data-class grants and comprehensive approval enforcement remain absent. |
| [#6](https://github.com/jxburros/Weft/issues/6) | No isolated credential broker or protected login transport; generic page evaluation/account access remains powerful. Requires a separate trusted process and adversarial validation. |
| [#7](https://github.com/jxburros/Weft/issues/7) | No payment/virtual-card broker, exact transaction approvals or external outcome reconciliation; depends on credential and task-execution foundations. |
| [#8](https://github.com/jxburros/Weft/issues/8) | Tasks remain records, not an autonomous executor. Durable external-action reconciliation and retry safety are not implemented. |
| [#9](https://github.com/jxburros/Weft/issues/9) | Tab serialization/takeover is hardened, but structured handoff requests, review/acceptance and multi-agent task collaboration remain incomplete. |
| [#10](https://github.com/jxburros/Weft/issues/10) | Workflow records do not execute; parameter binding, permission rechecks and resumable review points require the task runtime. |
| [#11](https://github.com/jxburros/Weft/issues/11) | No supported headless session inspection/display-handoff lifecycle. Xvfb testing is not a shipped headless product mode. |
| [#12](https://github.com/jxburros/Weft/issues/12) | Cloud disclosure improved, but token streaming, richer attachment ingestion/context management and complete usage UI remain unfinished. |
| [#13](https://github.com/jxburros/Weft/issues/13) | Adapters remain text-only; capability negotiation, vision payloads and explicit fallback are not implemented. |
| [#14](https://github.com/jxburros/Weft/issues/14) | Typed outcomes and clients are complete, but pagination, replayable events, deadline propagation and broader integration contracts remain missing. |
| [#15](https://github.com/jxburros/Weft/issues/15) | Readable extraction removes obvious sensitive controls; semantic/accessibility snapshots, stable element fingerprints and bounded region capture remain missing. |
| [#16](https://github.com/jxburros/Weft/issues/16) | Captures remain text/PNG; resource archives and comparison UI need a larger artifact-storage design. |
| [#17](https://github.com/jxburros/Weft/issues/17) | Export residue inspection helps review but does not implement redaction editing or controlled derivatives/original access. |
| [#18](https://github.com/jxburros/Weft/issues/18) | Persistent Chromium partitions remain; temporary sessions and crash-safe storage-mode lifecycle require separate browser storage work. |
| [#19](https://github.com/jxburros/Weft/issues/19) | Pinned-list provenance and additional redirect tests landed; all-match explanations, evidence/review workflow and comprehensive engine-path coverage remain incomplete. |
| [#20](https://github.com/jxburros/Weft/issues/20) | No malicious-destination intelligence feed, executable reputation or quarantine pipeline; needs a selected feed/trust/update policy. |
| [#21](https://github.com/jxburros/Weft/issues/21) | Workspace token scopes do not implement shared context collections or explicit authenticated-session sharing. |
| [#22](https://github.com/jxburros/Weft/issues/22) | Linked-file/service records remain descriptive; file watchers, missing-file lifecycle and refreshable OAuth/service adapters are not built. |
| [#23](https://github.com/jxburros/Weft/issues/23) | Revision checks remain, but promotion/approval, stale-source warnings and conflict-resolution UI are incomplete. |
| [#24](https://github.com/jxburros/Weft/issues/24) | Basic tab restoration exists; full resume state, tab groups/search and browsing-data import remain unfinished. |
| [#25](https://github.com/jxburros/Weft/issues/25) | JSON storage is hardened but still rewritten wholesale; transactional metadata database and separate durable artifacts require a storage migration. |
| [#26](https://github.com/jxburros/Weft/issues/26) | ADR-001 records threat model/recovery requirements; no encryption/key lifecycle implementation. Avoids claiming plaintext captures are encrypted. |
| [#27](https://github.com/jxburros/Weft/issues/27) | Migration backups and import rollback are improved, but automatic verified restore, lossless revisions/citation remapping and large-transfer parity remain unfinished. |
| [#28](https://github.com/jxburros/Weft/issues/28) | Pinned offline list distribution is implemented; moderation, correction/appeal governance, publishing and verified background updates remain absent. |
| [#29](https://github.com/jxburros/Weft/issues/29) | Client attribution and model manifests improve evidence; retention/deletion/privacy controls and complete durable permission/activity history remain unfinished. |
| [#30](https://github.com/jxburros/Weft/issues/30) | Store/catalog budgets exist; idle-tab scheduling, capture queues and GUI-first-render budgets remain unfinished. |
| [#31](https://github.com/jxburros/Weft/issues/31) | Focus, dialog labels/trapping, themes and scaling improved; full screen-reader, magnification, keyboard-flow and platform audits remain unverified. |
| [#33](https://github.com/jxburros/Weft/issues/33) | CI exists, but no signed installers, verified updater, rollback activation or named Chromium maintenance/release ownership. Signing credentials are not configured. |
| [#36](https://github.com/jxburros/Weft/issues/36) | Tokens and visual fixtures landed; final logo-size, interaction, brand/product and cross-platform accessibility reviews remain open. |
| [#39](https://github.com/jxburros/Weft/issues/39) | Record request IDs, atomic batches and dry runs are not implemented; requires transaction semantics across store mutations and retention. |
| [#41](https://github.com/jxburros/Weft/issues/41) | Tab version/lease/concurrency checks and secret-field extraction improved; immutable element fingerprints and semantic grounding remain missing. |
| [#43](https://github.com/jxburros/Weft/issues/43) | Every command is classified and a pure policy evaluator exists; a trusted approval broker/queue and integrated autonomy-level enforcement are not shipped. |
| [#53](https://github.com/jxburros/Weft/issues/53) | Provider turn manifests improve auditability, but streaming, partial response persistence and resumable event/deadline lifecycle are not implemented. |
| [#54](https://github.com/jxburros/Weft/issues/54) | No custom Windows installer; packaging, code signing, upgrade/uninstall policy and native installer verification remain unimplemented. |
| [#58](https://github.com/jxburros/Weft/issues/58) | No durable job executor/uncertain-state recovery; requires remote action identity and reconciliation contracts before safe retry. |
| [#60](https://github.com/jxburros/Weft/issues/60) | Release/update mechanisms are not implemented; stable-channel trust roots, verified activation, rollback, kill switch and signing pipeline remain open. |
| [#66](https://github.com/jxburros/Weft/issues/66) | Basic actors/capture versions exist, but full record provenance and normalized quote-selector re-anchoring are not implemented. |
| [#67](https://github.com/jxburros/Weft/issues/67) | Search remains local text matching; FTS5 ranking and optional hybrid retrieval depend on the transactional storage/index design. |

## Verification references

See [validation commands and limits](VALIDATION.md), [storage safety](STORAGE-SAFETY.md), [browser audit](BROWSER-SAFETY-AUDIT.md), [design checks](DESIGN-SYSTEM.md), [offline evaluations](../evals/README.md), and [performance budgets](../perf/README.md). CI results on PR #71 identify the exact tested revision. Scripted MCP evaluations do not measure live-model performance. Visual fixtures cover Linux browser chrome; they do not establish real screen-reader or native installer support.
