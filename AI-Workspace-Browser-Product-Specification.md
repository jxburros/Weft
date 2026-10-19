# AI Workspace Browser — Product Specification

**Working name:** Unnamed AI Workspace Browser  
**Specification version:** 1.0  
**Date:** October 17, 2026  
**Status:** Product definition for review, written before implementation began

This document describes product direction, not implemented behavior. Several choices it lists as open (sections 1.2 and 23) have since been made: the product is named Weft, built on Electron/Chromium in JavaScript and released under the MIT license; other decisions are recorded in [docs/decisions](docs/decisions/). A local client for the community-list extension (section 18) exists ([docs/COMMUNITY-LISTS.md](docs/COMMUNITY-LISTS.md)). Implemented coverage and its limits are in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## 1. Purpose and decision status

Build a human-usable, AI-first browser organized around persistent project workspaces. Humans, built-in agents, and external agents work with the same project environment through a graphical interface, CLI, MCP, and REST API.

The central promise is: **Everything needed to continue this project is here—for you or your chosen agent.**

This document consolidates the product discussion into one specification. “Must” identifies required behavior in this specification; “should” identifies recommended behavior. Detailed mechanisms, defaults, schemas, and acceptance criteria below are proposed implementation requirements that make the discussed concept concrete, rather than claims that every detail was individually approved.

### 1.1 Established product direction

- Persistent workspaces combine tabs, materials, context, tasks, conversations, activity, and saved page artifacts.
- Humans and agents can work within the same browser and hand work back and forth.
- Agents work both inside the browser through a chat panel and outside through CLI, MCP, and REST/API connections.
- Users provide cloud-model API keys or connect local models.
- Site restrictions, storage controls, credential permissions, and action permissions apply consistently to all agent entry points.
- Credentials can be used through a trusted broker without exposing raw values to agents.
- The browser protects against malicious web behavior without requiring blanket advertisement blocking.
- Browser-owned cookie and storage controls operate independently of website consent banners.
- A personal “Don’t trust this site” list supports security concerns and personal preferences, with explicit overrides.
- Shared and community-maintained avoidance lists are an intended future extension.
- Saved page artifacts remain attached to workspaces for future human and agent reference.

### 1.2 Unresolved choices

The product name, engine, desktop framework, implementation languages, license, supported operating systems, distribution model, vault integration, synchronization service, and commercial model remain undecided. The examples in this document do not select those technologies.

This is a unified product specification, not an MVP or phased delivery plan. The community-list extension is identified separately because it was explicitly discussed as eventual functionality.

## 2. Intended users and outcomes

### 2.1 Primary users

- People managing long-running projects that involve browsing, documents, research, and repeated online tasks.
- Users who want to choose their own AI providers or local models.
- Developers and agent operators who need a visible browser that is controllable programmatically.
- People who want their privacy preferences and personal browsing boundaries enforced for agents as well as themselves.

### 2.2 Representative workspace

**Friends and Flames Release** contains station submission tabs, the artist website, approved biographies, release information, press photos, links to audio files, saved submission instructions, an outreach tracker, and research tasks. A human reviews candidate stations while an agent researches alternatives in assigned tabs. A week later, either can resume with the evidence and unfinished work intact.

### 2.3 Success outcomes

1. Returning to a project reveals what is done, what is waiting, and what comes next.
2. A different agent or model can continue a task using saved project state.
3. Important references survive closed tabs, changed websites, and unavailable sources.
4. Users can inspect what agents accessed and changed.
5. An agent cannot silently expand its permissions or bypass browser-enforced boundaries.
6. Ordinary browsing remains simple when project and AI features are not needed.

## 3. Product principles

1. **Workspace first:** project organization extends beyond tab grouping.
2. **One command system:** UI, CLI, MCP, REST, and internal agents invoke shared operations and policy checks.
3. **User-selected intelligence:** model choice is independent of browser ownership.
4. **Visible collaboration:** agent work, tab control, evidence, and blockers are inspectable.
5. **Explicit authority:** page content is data, not permission or trusted instructions.
6. **Durable references:** saved artifacts are retained until explicitly deleted.
7. **Enforced boundaries:** security relies on isolation and authorization, with redaction as additional protection.
8. **Portable projects:** users can export their materials and project state without a mandatory hosted service.
9. **Quiet defaults:** apply established rules without repeated interruptions; request decisions when authority is missing.

## 4. Application structure and everyday browsing

### 4.1 Main interface

- Workspace selector and sidebar.
- Address bar, back/forward, reload/stop, and standard navigation controls.
- Central browsing area with optional split views. (Implementation note: Weft shows 1–4 panes of tabs, captures and documents, and workspaces can move to their own windows; see docs/USING-WEFT.md.)
- Tab groups with ownership and agent-activity indicators.
- Workspace sections: Overview, Tabs, Materials, Context, Tasks, Conversations, Artifacts, and Activity.
- Collapsible agent chat panel.
- Command palette for browser and workspace actions.
- Browser-owned panels for site restrictions, storage, permissions, downloads, and credential use.

Panels must be collapsible. Users must be able to open a URL immediately without creating a task, configuring an agent, or filling out project metadata. A default general-browsing workspace is a proposed convenience.

### 4.2 Everyday capabilities

Support bookmarks, history, find in page, zoom, downloads, file upload, printing/PDF output where supported, pinned tabs, keyboard shortcuts, tab search, session recovery, and accessible navigation. Provide browsing-data import/export where feasible for the chosen engine. Extension compatibility is desirable but must be evaluated against the security model before being promised.

### 4.3 Workspace overview

Show pinned resources, recent artifacts, active tasks, blockers, last activity, and items needing human attention. Provide “Resume last view” and direct access to tabs. Overview content must link to underlying records rather than present an untraceable AI summary.

## 5. Workspace model

### 5.1 Workspace record

Each workspace must have a stable ID, name, optional description/icon/color, timestamps, materials, context records, tabs, tasks, conversations, artifacts, policies, model preferences, credential grants, and activity references.

Support create, rename, duplicate, archive, restore, export, and delete. Duplication must explain whether materials are copied or referenced and must exclude credentials and live session tokens by default. Archiving must not delete saved materials.

### 5.2 Isolation and sharing

- Workspace context is separate by default.
- Each workspace receives a separate cookie/storage container by default.
- Sharing context collections and sharing authenticated sessions are separate decisions.
- A shared collection must identify participating workspaces and whether access is read-only or writable.
- Cross-workspace agent access requires an explicit grant.
- Moving a tab across containers must explain whether it reloads and changes login state.
- Linked external files retain their own filesystem or service permissions; linking does not grant unrestricted folder access.

### 5.3 Persistence

Persist tab metadata, task checkpoints, context, conversations, policies, and artifact references across restart. Do not persist unsent sensitive form values by default. Restoring a tab cannot guarantee restoration of arbitrary live JavaScript state; show when reload, login, or revalidation is required.

## 6. Materials and project context

### 6.1 Supported material forms

| Form | Required behavior |
| --- | --- |
| Stored file | Retain a workspace-managed copy with size, type, provenance, and integrity metadata |
| Linked file or folder | Preserve the reference; report missing, moved, inaccessible, or changed sources |
| Website reference | Store title, URL, notes, and optional related artifacts |
| Workspace note | Editable text with revision history |
| External service reference | Identify source, authorization status, last refresh, and cached-versus-live content |
| Shared collection item | Show owning collection, access level, and connected workspaces |

Rich integrations with ByAuthorX, Vixl, AI Server Studio, and QAI-ality are optional extensions. Ordinary files and documented APIs must remain usable without those apps.

### 6.2 Context categories

- **Confirmed information:** user-entered or explicitly approved project facts.
- **Agent findings:** attributed observations with sources and dates.
- **Open questions:** unresolved issues or conflicting information.
- **Instructions and preferences:** user-authored operating guidance, separate from factual records.
- **Decisions:** chosen course of action, decision maker, time, and rationale.

Agents may propose updates. Promotion into confirmed information must be explicit and attributable; task-scoped preauthorization may govern routine updates but cannot be inferred from webpage text.

### 6.3 Freshness and conflicts

Identify live references versus historical snapshots. Record last refresh, source version where available, and material changes. Preserve conflicts rather than silently overwriting one source with another. Agents must be able to cite the exact record or artifact version used.

## 7. Tabs, ownership, and handoff

### 7.1 Tab ownership

A tab can be human-controlled, agent-controlled, available for assignment, or temporarily protected for a credential operation. Show the current controller and task. Shared visibility does not permit concurrent conflicting input.

Use an input lease or equivalent mechanism to serialize control. Human takeover must be immediate at a safe boundary and revoke stale agent commands. Agents may inspect only what their grant permits.

### 7.2 Handoff record

Capture objective, completed actions, current URL, relevant tabs, findings, blocker, next step, and navigation/state version. Preserve references to evidence without retaining secrets. After handoff, the receiving agent must inspect current state before using stale element references or repeating an action.

### 7.3 Multi-agent behavior

Support multiple agents in different tabs or tasks, with configurable concurrency limits. Coordinate writes to shared materials through version checks. Tab ownership does not itself grant credential access or permission to submit forms.

### 7.4 Headed and headless operation

Support agent sessions without a visible window where the selected engine permits it. The same workspace and command semantics must be available. A human must be able to inspect or attach a graphical view to a supported running session without creating an unrelated second session. If changing display mode requires a restart, preserve the project checkpoint and disclose the limitation.

## 8. Tasks and reusable workflows

### 8.1 Task contents and states

A task includes objective, assignee, workspace, relevant materials/tabs, permissions, progress, evidence, outputs, checkpoint, and blocker.

Supported states: queued, running, waiting for human, paused, completed, failed, and cancelled. State changes must identify actor and cause. Closing a window must not imply completion.

### 8.2 Execution controls

Users can start, pause, cancel, redirect, or reassign a task. Cancellation prevents new actions and reports any action already submitted. Retrying a task must not blindly repeat purchases, messages, or other externally consequential operations. Uncertain outcomes require reconciliation before retry.

### 8.3 Reusable workflows

Support saving a sequence as an editable workflow with parameters, required materials, allowed sites, credential references, review points, and expected outputs. Recordings must omit literal secrets. A saved workflow is an executable plan subject to current permissions, not permanent authorization. Show when site changes invalidate a step.

## 9. Built-in chat and model connections

### 9.1 Providers

Allow user-supplied keys for supported cloud providers and connections to local model servers. Provide adapters for provider-specific APIs and configurable compatible endpoints. Local connections must not silently fall back to cloud services.

Store provider keys in the secret system. Do not place keys in workspace exports, page-accessible storage, model prompts, ordinary logs, or command-line arguments.

### 9.2 Chat behavior

- Save conversations within their workspace.
- Attach tabs, selected passages, files, tasks, and artifact versions.
- Show the active model and destination endpoint before sending content.
- Show accessible context and permit exclusions.
- Stream responses and display tool actions with inspectable results.
- Support task creation, delegation to connected agents, pause, takeover, and continuation.
- Preserve user decisions and durable task state when switching models.
- Make summarization and context truncation visible; preserve original records separately.

### 9.3 Capability negotiation

Track tool calling, image input, context limits, streaming, and other supported features. Text-only models receive structured page tools. Visual tasks require image support or a user-configured vision fallback. Warn about unsupported tasks rather than inventing visual observations.

API-key ownership does not mean inference occurs locally. Clearly distinguish on-device processing, local-network endpoints, and external providers. Display usage and estimated cost where provider data permits; label estimates.

## 10. Shared command and integration architecture

### 10.1 Interfaces

| Interface | Contract |
| --- | --- |
| Graphical UI | Human-readable controls over shared commands |
| CLI | Scriptable commands, structured JSON, useful exit codes, and discoverable help |
| MCP | Typed tools, scoped resources, and actual image content for visual results |
| REST API | Versioned endpoints, authorization, pagination, and documented errors |
| Event stream | Task, navigation, handoff, policy, and artifact updates |
| Internal agent runtime | Same authorization and command dispatcher used by external clients |

Use one canonical schema with generated or validated adapters to avoid divergent implementations. Publish an OpenAPI description and agent integration guide. Expose capabilities and versions programmatically.

### 10.2 Command groups

Workspaces; tabs; navigation; page inspection; screenshots; materials; context; tasks; workflows; conversations; artifacts; permissions; site rules; storage; credentials; downloads; and activity.

Administrative commands must be distinguished from agent-usable commands. Equal capability across interfaces does not mean every caller receives every permission.

### 10.3 Proposed examples

`browserctl` is an illustrative command name only.

```text
browserctl workspace open --id ws_release
browserctl tabs list --workspace ws_release --json
browserctl page inspect --tab tab_station --format accessibility
browserctl capture save --tab tab_station --kind bundle --workspace ws_release
browserctl tasks resume --id task_research
```

```http
POST /v1/workspaces/ws_release/artifacts
Authorization: Bearer <scoped-client-token>
Content-Type: application/json

{
  "tab_id": "tab_station",
  "kind": "reference_bundle",
  "note": "Submission instructions used for this task",
  "expected_navigation_version": 12
}
```

### 10.4 Command envelope

Requests should include request ID, actor identity, workspace ID, target ID, optional task ID, expected state/version, timeout, and idempotency key for applicable mutations.

Responses must distinguish success, partial success, blocked, approval required, stale state, unsupported capability, and failure. Suggested error codes include `SITE_BLOCKED`, `PERMISSION_REQUIRED`, `TAB_OWNED`, `STALE_STATE`, `SECRET_OPERATION_PROTECTED`, `CAPTURE_INCOMPLETE`, and `MODEL_CAPABILITY_MISSING`.

### 10.5 Connection security

Disable unauthenticated control. Local transports require user-bound authorization; local HTTP services require tokens, strict origin validation, and protection against browser-origin requests. Bind to loopback by default. Remote access is opt-in with authenticated encrypted transport and revocable client identities. Do not expose raw debugging ports as a substitute for the protected API.

## 11. Page understanding and screenshots

Offer accessibility-tree or semantic snapshots, readable text, element references, and bounded screenshot capture. Support viewport, full-page, element, and region images.

Return image bytes through supported image-content mechanisms. A filesystem path alone is not evidence that a model received or inspected an image. Where transport lacks image support, return a safe artifact reference and explicit next-step instructions or use the configured vision service.

Include capture dimensions, scale, viewport, scroll position, URL, timestamp, and navigation version. Coordinate-based actions must validate the frame/viewport state. Allow cropping and resolution selection to manage cost and legibility.

Sensitive-operation protections override screenshot and inspection requests. Screenshots and structured inspection must report inaccessible or redacted regions rather than implying complete visibility.

## 12. Permanent artifacts

### 12.1 Capture types

| Type | Contents |
| --- | --- |
| Screenshot | Viewport, full page, region, or element image |
| Readable snapshot | Extracted text and relevant page structure |
| Page archive | Offline representation with missing-content report |
| Reference bundle | Image, text, provenance, notes, and related task |

Reference bundles are the proposed default for “Save to workspace.” Capture may be initiated by humans or authorized agents.

### 12.2 Artifact metadata

Stable artifact ID; version ID; workspace; title; original and final URLs; capture interval; creator; capture method; viewport details; content hashes; component types and sizes; notes; tags; task references; redaction status; limitations; and relationships to previous versions.

URLs and metadata can themselves contain secrets. Remove sensitive query values and headers, and never include cookies, authorization headers, or raw session tokens in ordinary capture metadata.

### 12.3 Capture integrity

Wait for a configured readiness condition with a bounded timeout. Record changes between text and image capture. Full-page capture must account for lazy loading and report truncation, virtualization, failed resources, authentication walls, or content that cannot be preserved.

Do not claim that an offline archive reproduces every interactive application. Hashes detect byte changes; they do not prove a source was truthful or establish independent timestamp authenticity.

### 12.4 Persistence and versions

Saved artifacts remain until explicitly deleted and are independent of live tabs. Recapture creates a new immutable capture version. Editable annotations have their own revision history. Support search, preview, comparison, export, backup, and links from findings to exact artifact versions.

### 12.5 Safe viewing and sensitive captures

Render archives without active scripts, external resource loading, automatic navigation, or submission behavior by default. Viewing an artifact from a blocked site must not revisit that site.

Protect captures containing personal data. Allow redaction before agent access and distinguish originals from sanitized derivatives. A redacted derivative must not contain recoverable hidden text or image layers. Retention and export of originals require explicit permission.

Artifact text remains untrusted source content; storing it does not promote embedded instructions into workspace authority.

## 13. Credential broker and payments

### 13.1 Objective and boundary

Agents may request approved credential use without receiving raw passwords, payment credentials, provider keys, authentication seeds, or session secrets. Integrate an established vault where possible rather than inventing cryptography.

The trusted broker and protected browser operation must run outside the agent's readable process/filesystem/debugging boundary. An agent with unrestricted host access cannot be promised isolation from secrets on that host. Document supported threat assumptions.

### 13.2 Broker flow

1. Agent requests a purpose-bound operation using a credential reference.
2. Broker verifies actor, workspace, exact destination, frame, credential scope, expiry, and action permission.
3. Broker takes exclusive protected control and disables agent observation routes for the sensitive operation.
4. Trusted code performs authentication or payment.
5. Broker inspects the result, removes sensitive residual exposure where possible, and resumes an appropriately restricted session.
6. Agent receives sanitized status; activity records contain no raw secret values.

The website or payment processor necessarily receives data needed for the operation. The secrecy objective concerns the agent and unauthorized components, not preventing the authorized recipient from receiving it.

### 13.3 Exposure routes to cover

Protect DOM values, JavaScript evaluation, screenshots, accessibility output, clipboard, network bodies, tracing, console output, crash dumps, session storage, cookies, exports, and vault interfaces. Arbitrary page execution and raw debugging cannot remain available where they defeat the promise. Sanitize subsequent observations as needed; do not assume the secret disappears immediately after submission.

### 13.4 Grants

Grants include credential reference, allowed origins, workspace, actor, purpose, lifetime, usage limits, and review requirements. Show account/card nicknames and approved non-sensitive identifiers. Support revocation and a private activity history. Do not export raw credentials with workspaces.

### 13.5 Payment authorization

Bind approval to merchant, destination, amount ceiling, currency, tax/shipping total, and recurrence status. Revalidate immediately before submission. Any material change requires renewed authority. Separate payment submission from card filling; possession of a card reference is not purchase authorization. Support compatible merchant-bound or limited virtual cards where available without assuming universal support.

### 13.6 Authenticated-account limits

Secret protection does not prevent misuse of an authenticated account. Form submissions, messages, account changes, purchases, data export, and other consequential actions require their own permission policy. Cookies and session tokens are credentials and must not become an alternate agent-readable route.

## 14. Permissions and trust model

### 14.1 Authorities

Distinguish human intent, browser-enforced policy, workspace instructions, task-scoped grants, agent suggestions, and untrusted web/artifact content. Only authorized human/admin controls may expand grants or weaken protected policies.

### 14.2 Suggested action classes

| Class | Examples | Proposed handling |
| --- | --- | --- |
| Observation | Read approved tabs and materials | Allowed within granted scope |
| Local reversible work | Create notes, save artifacts, organize assigned tabs | Workspace-configurable |
| External changes | Submit forms, send messages, modify accounts | Explicit standing or task-specific grant |
| Sensitive operations | Credential use, payments, bulk export | Broker/purpose-specific authorization |
| Policy administration | Change site rules, client access, vault grants | Human-authorized administration |

Repeated prompts are unnecessary when a valid grant covers the action. Approvals must state the action and scope and must not be spoofable by webpage UI. Emergency stop revokes agent input and prevents further task actions.

### 14.3 Prompt injection and exfiltration

Websites and artifacts can contain malicious instructions. Preserve provenance, enforce tool permissions outside model reasoning, and limit access to unrelated materials. Sensitive outbound transmission must respect destination and data-access grants. Model instructions alone are not a security boundary.

## 15. Malicious-content and download protection

The goal is to reduce malicious installation and launch behavior without requiring all ads to be hidden. Apply protections to all web content, including embedded frames and popups.

- Block unsolicited and unauthorized repeated downloads.
- Never automatically execute downloaded installers, scripts, or archives.
- Require browser-owned authorization for external application/protocol launches.
- Require human authorization for extension installation and privileged integration changes.
- Restrict notification requests and deceptive permission escalation.
- Support reputable malicious-destination intelligence and local rules; keep threat feeds distinct from personal preference lists.
- Show download source, initiating page, file type, and scan status where available; preserve operating-system origin/security metadata.
- Keep downloaded content separate from executable application components and never let ordinary page scripts invoke native commands.

Do not weaken engine sandboxing or site isolation to enable agent functionality. Ship security updates promptly. Behavior controls and reputation checks cannot guarantee prevention of browser exploits or malware. Preserve user overrides only where technically and safely supported and explain their scope.

## 16. Browser-owned cookies and storage controls

### 16.1 User controls

| Mode | Behavior |
| --- | --- |
| Block site storage | Refuse supported cookie and persistent-storage access; disclose compatibility effects |
| Allow for this session | Permit configured temporary storage, then clear it according to session policy |
| Remember this site | Retain permitted site data in its workspace container |
| Clear this site | Remove supported stored data and explain sign-out effects |

Enforce cookie acceptance and sending, script-level cookie access, local storage, IndexedDB, service-worker storage/caches, and other covered persistence paths. Publish a coverage matrix for the chosen engine; unsupported controls must not appear as guarantees.

### 16.2 Defaults and exceptions

Cross-site tracking protection and workspace container isolation are proposed defaults. Show a quiet browser-owned indicator with blocked activity and specific exceptions. Sites and agents cannot override these settings. Exceptions should be scoped and revocable.

Define session lifetime explicitly. Crash recovery must honor temporary-data deletion rather than silently retaining it indefinitely. Explain that clearing data does not revoke server-side account sessions or remove every record held by a service.

### 16.3 Consent and limitations

Enforcement does not depend on a website honoring its own consent banner. Do not silently click “Accept all.” Storage settings do not automatically express every legal consent preference or prevent server-side tracking and fingerprinting. Do not promise perfect automatic classification of necessary versus advertising cookies.

## 17. Personal “Don’t trust this site” rules

### 17.1 Rule creation

Provide an address-bar action and management panel. Users can flag a site for suspected malicious behavior, deception, privacy concerns, personal preference, or another reason without being required to justify a personal choice.

A rule contains ID, domain/hostname scope, optional path scope, reason, note, evidence links, workspace/global scope, warn/block behavior, navigation/connection mode, creator, timestamps, and optional review date.

Do not automatically block related brands or businesses based on an inferred relationship. Show proposed domains for explicit selection.

### 17.2 Enforcement

- Navigation mode blocks top-level visits, redirects, and popups to matching destinations.
- Connection mode additionally blocks supported embedded and background connections.
- Evaluate destination rules before DNS resolution or destination contact where the request path is browser-controlled; disable relevant speculative preconnect/prefetch paths.
- Apply rules to browser-controlled agent tools as well as visible tabs.
- Acknowledge that an external agent's independent network tools require their own enforcement.

Normalize hostnames and domain boundaries safely, display internationalized-domain information where appropriate, and avoid substring matching that blocks unrelated domains. Recheck redirects and frame destinations. Document any engine-level paths outside coverage.

### 17.3 Overrides

Use a browser-owned stop page showing the matching rule, source, reason, and options: Go back, Allow this visit, Change rule. Temporary overrides are destination- and session-scoped and do not delete the rule. Do not implicitly permit an entire redirect chain or all embedded destinations.

Agents receive a structured blocked response and may seek an alternative or request human authorization. They cannot approve their own exception.

## 18. Community-list extension

Support private-group and public lists, subscriptions, and user-selected label/warn/block behavior. Participation and publication are explicit; do not upload personal browsing history or private list entries by default.

### 18.1 Entry provenance

Each entry identifies domain, business/entity, reason category, specific claim, supporting sources, submitter, reviewer, relevant dates, last review, current status, and revision history. Distinguish company contributions, personal contributions by executives, public endorsements, and other claims. Opinions and evidence-backed factual claims must be visibly distinguishable.

### 18.2 Governance

Support group roles, moderation, corrections, disputes, stale-entry review, appeals, and measures against spam or coordinated false reports. A single report must not automatically become a universal malicious-site designation.

### 18.3 Subscription updates

Show list publisher, version, changes, newly blocked domains, and entry provenance. Verify update integrity and support rollback or unsubscribe. Personal exceptions remain visible. Never collapse community disagreements into an unexplained universal trust score.

### 18.4 Rule precedence

Expose all matching rules and why an outcome occurred. A task permission cannot override a site block. Human-approved exceptions may override eligible personal/community rules within their scope, while mandatory security policies remain separately identified. Conflicts must not be resolved invisibly.

## 19. Activity, evidence, and auditability

Record meaningful commands, actors, task links, state transitions, permission decisions, credential-use statuses, blocks, overrides, and artifact creation. Show concise activity by default with inspectable detail.

Exclude secrets and minimize unnecessary personal data. Apply retention controls to ordinary activity independently from explicitly permanent artifacts. Label actions that are irreversible or whose external outcome is uncertain. Link findings to source versions. Never describe activity history as proof that every external action succeeded.

## 20. Data model and persistence

### 20.1 Core entities

| Entity | Key relationships |
| --- | --- |
| Workspace | Owns project state and policy references |
| Storage container | Holds site sessions; separate from context-sharing configuration |
| Tab | Workspace, task, controller, navigation/state version |
| Material | Workspace/collection, stored copy or live reference |
| Context record | Category, author, source, approval and revision state |
| Task | Objective, assignee, state, grants, checkpoint, outputs |
| Conversation | Workspace, model runs, messages, attachment references |
| Artifact/version | Immutable capture components and provenance |
| Workflow | Parameterized steps, requirements, review points |
| Agent client | Identity, connection, capabilities, scope, revocation state |
| Permission grant | Actor, resource, action, purpose, expiry, constraints |
| Credential reference | Vault metadata only; secret values outside ordinary project data |
| Site rule/list | Scope, source, policy, evidence, revision |
| Activity event | Actor, action, result, timestamps, related IDs |

### 20.2 Storage requirements

Use transactional metadata and durable artifact storage with integrity checks. Version the schema and migrations. Recover interrupted writes without orphaning visible records. Treat local indexes, embeddings, thumbnails, caches, and backups as potentially sensitive project data.

Encrypt secret material with established mechanisms. Workspace encryption-at-rest and its key/recovery design require an explicit implementation decision; do not imply ordinary database files are encrypted. Document protections and limits against host compromise.

### 20.3 Export and recovery

Export a versioned manifest, materials, context, tasks, conversations, artifact components, and policy descriptions. Exclude raw credentials, API keys, authentication cookies, and session tokens by default. Report linked files not included. Import must preview active policies and workflows before enabling them and defend against unsafe archive paths and active content.

Provide backups and verified restore. Synchronization is not a substitute for backup. Synchronization and multi-user collaboration beyond community lists remain undecided; core local work must not depend on them.

## 21. Nonfunctional requirements

### 21.1 Reliability and performance

Keep navigation, scrolling, and input responsive while agents run. Queue costly captures/indexing and expose progress/cancellation. Bound agent concurrency, CPU/memory usage, image resolution, request size, and task budgets. Suspend idle tabs without deleting durable project state. Set measurable latency and resource targets after engine selection rather than inventing untested performance claims.

### 21.2 Accessibility

Provide keyboard access, screen-reader labels, visible focus, scalable text, adequate contrast, and reduced-motion support. Ownership, errors, and policy states must not rely on color alone. Browser-owned dialogs and block pages require the same accessibility standard as the main UI.

### 21.3 Privacy

Keep project storage local by default as a proposed architecture. Make cloud-model transmission explicit and scope it to authorized materials. Do not send browsing history or page contents through telemetry by default. Separate crash reporting from content collection and provide redaction controls.

### 21.4 Updates and supply chain

Use verified application updates, dependency tracking, reproducible release procedures where feasible, and an engine-update process. Security tests and independent review are required before making strong credential-isolation claims. Optional plugins/integrations must declare scopes and cannot inherit unrestricted native access merely because they extend the browser.

## 22. Acceptance criteria

| ID | Scenario | Required result |
| --- | --- | --- |
| AC-01 | Reopen an existing project | Tabs, materials, context, tasks, and artifacts return; blockers are visible |
| AC-02 | Compare UI, CLI, MCP, and REST actions | Equivalent commands apply equivalent policies and produce consistent state |
| AC-03 | Internal and external agent request the same prohibited action | Both are blocked with an inspectable reason |
| AC-04 | Human takes an agent-controlled tab | Stale commands stop; resumption requires current-state inspection |
| AC-05 | Two agents request control of one tab | Conflicting input is serialized or rejected |
| AC-06 | Switch providers or models | Conversation and checkpoint persist; unsupported capabilities are disclosed |
| AC-07 | Text-only model requests visual analysis | No fabricated observation; configured fallback or clear unsupported result |
| AC-08 | Capture and close a page, then remove network access | Saved text/image remains readable without contacting the source |
| AC-09 | Recapture a changed page | New capture version; previous content remains intact |
| AC-10 | Archive includes scripts or external resources | Default viewer does not execute or fetch them |
| AC-11 | Protected login while agent requests DOM/network/screenshot access | Secret-bearing observations are denied; safe status is returned |
| AC-12 | Checkout total or merchant changes | Prior transaction approval cannot silently authorize changed terms |
| AC-13 | Page tries unsolicited download or external-app launch | Applicable browser-owned policy blocks or requires explicit permission |
| AC-14 | Site lacks a consent banner and attempts storage | Browser policy still applies across documented covered mechanisms |
| AC-15 | Same site opens in isolated workspaces | Authenticated storage remains separate unless explicitly configured otherwise |
| AC-16 | Blocked site reached by redirect or popup | Destination is stopped before contact within documented coverage |
| AC-17 | Human allows one blocked visit | Permanent rule remains; unrelated destinations remain blocked |
| AC-18 | Agent reads an artifact containing instructions to change policy | Source text cannot modify grants or policy |
| AC-19 | External webpage calls local control endpoint | Unauthorized request fails without leaking project data |
| AC-20 | Task outcome is uncertain after interruption | Resume reconciles state before repeating consequential actions |
| AC-21 | Export and import a workspace | Project contents restore with limitations disclosed; no secrets exported by default |
| AC-22 | Temporary browsing session crashes | Recovery honors documented temporary-storage retention/deletion policy |
| AC-23 | Community entry is corrected | Subscribers can inspect the correction, provenance, and changed behavior |
| AC-24 | Local-model configuration loses connectivity | No silent transmission to a cloud model |

## 23. Decisions required before implementation

1. Product name, branding, and command name.
2. Browser engine/framework and supported desktop platforms.
3. Engine update ownership, extension compatibility, and supported headless/display handoff.
4. Vault integration and exact isolated credential-execution architecture.
5. Provider adapters, local endpoint support, and optional vision fallback.
6. Durable file format, artifact/archive formats, encryption-at-rest, backup, and recovery design.
7. Policy defaults, standing authorization UX, and network/storage enforcement coverage.
8. Community hosting, publisher verification, moderation, and distribution.
9. Optional synchronization, shared-workspace collaboration, and remote deployment.
10. License, distribution, business model, and maintenance commitments.

These decisions must preserve the shared command architecture, workspace continuity, user control, model choice, durable artifacts, and enforced security boundaries described above.
