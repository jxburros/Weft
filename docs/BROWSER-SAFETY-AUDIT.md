# Browser safety audit and remaining boundaries

Verified against the October 2026 issue-remediation implementation. Reference: [AI-Server-Studio browser-tab audit](https://github.com/jxburros/AI-Server-Studio/blob/main/audits/AI-Server-Studio-Browser-Tab-Audit-2026-09-30.md), especially BT-01 through BT-09 and the blocked-action finding BT-17.

| Finding | Weft behavior and evidence |
| --- | --- |
| Redirects escape destination checks | Rules are checked at request level, not after an action returns. Chromium `onBeforeRequest` checks main frames, subframes and connection-mode subresources before contact; `will-navigate` and `will-redirect` add navigation checks. Real Chromium fixtures assert that direct navigation, HTTP redirects, link clicks (human and agent), meta-refresh, script redirects, `location.replace`, a frame navigating `top`, form POST submission and background fetch never reach the blocked routes, and that blocked agent navigations return a structured `site_blocked` outcome. See the engine-path table below. This is site-rule enforcement, not a network firewall. |
| Page popups evade policy | Native window creation is denied. A page may open a tab only during real input in that tab (two seconds, current document) or while an automation action is in flight on it; other popups are recorded on the tab and shown in site controls. The replacement tab passes `allowedUrl` and request interception, and records its opener. Real Chromium tests cover page-initiated popups without input, a human click popup, blocked-rule and unsafe-protocol popups. |
| Input values reach readable content | Readable text and HTML remove input, textarea, select, editable, script, style and template elements. HTML also removes event handlers and attributes whose names contain value/token/password/secret. A Chromium fixture asserts password, credit-card and one-time-code field contents are absent. Arbitrary page text, screenshots, PDFs, JavaScript evaluation and page-authored mirrors of secrets are **not** a credential isolation boundary. |
| Page-controlled title reaches authority text | Browser title results and persisted visit titles are capped at 1,000 characters. Treat all page titles/URLs/content as untrusted; provider framing is maintained separately. A title never grants authority. |
| Stale or overlapping actions | Every automation mutation requires `expectedVersion`, including available tabs. Only one automation input operation may be in flight per tab. Native input, explicit takeover and emergency stop invalidate the control epoch. A command interrupted by takeover reports `action_interrupted`, because scripts and external effects already submitted cannot be undone. Chromium tests exercise concurrent promises and takeover. |
| Click claimed complete despite blocking | Click/fill report `submitted` with an `unverified` outcome. If blocking is already observable when the action returns, the command fails. A later redirect can still occur: callers must inspect state and evidence to verify a consequential outcome. |
| Element identity changes between inspection and action | **Not completed.** Version checks cover browser mutations/navigation, not arbitrary DOM changes. CSS selectors are not immutable element fingerprints. A future semantic snapshot/approval contract must bind URL, element identity and freshness (#15, #41). No coordinate/keyboard automation command is exposed. |
| Explicit control modes | Existing controller labels and human claim/release/takeover remain. A full Observe/Suggest/Act/Autonomous UX and scoped grants remain separate work. |

## Engine-path coverage for site rules (#19)

Tested in `test/browser-security.test.js` with a connection-mode rule and a
positive control on an allowed host for every row, so a passing row means the
mechanism ran and the blocked host was not contacted.

| Path | Result |
| --- | --- |
| Top-level navigation, HTTP redirect, meta refresh, script/`location.replace`, form POST, frame navigating `top`, link click | Stopped before contact; stop page shown. |
| Frames (`iframe`), images, stylesheets, `fetch`, `sendBeacon`, `EventSource` | Stopped before contact. |
| WebSocket from the page and from a dedicated worker | Stopped before contact. |
| Dedicated worker, shared worker and service worker `fetch` | Stopped before contact. |
| Popups (`window.open`, `target=_blank`) | Stopped before contact; page-initiated popups without input are not opened at all. |
| `<link rel=prefetch>`, speculation-rules prefetch and prerender | Chromium still issues these in Electron 44 even with the `SpeculationRulesPrefetch`/`Prerender2` feature switches disabled. Weft cancels every request marked `Sec-Purpose: prefetch` for **all** destinations; rules also see them first. They never create a stop page. |
| `<link rel=preconnect>` | Observed to open no connection to the fixture host in Electron 44. Not interceptable by `webRequest`; recorded as an observation, not a guarantee. |
| `dns-prefetch` and DNS resolution generally | DNS prefetch is disabled by switch. Resolution performed by Chromium before a request is cancelled, and OS-level DNS, cannot be observed by these fixtures: **not covered**. |
| Requests from browser-external tools (an agent's own HTTP client, shell, other apps) | **Not covered.** Site rules govern Weft's Chromium sessions only. |

Exact-visit exceptions cover one URL in one tab visit: other tabs, other
destinations, embedded resources and redirect chains remain blocked, the
permanent rule is unchanged, and exceptions are never persisted (a restart ends
them). Security findings require an explicit risk acknowledgement.

Emergency stop uses one `AutomationAdmission` latch shared by dispatch, browser and model loops. Only trusted human/admin code can resume. Resume does not release human tab leases. The latch lasts for the running application process; restart starts a new session, and provider requests cannot survive process exit. This does not retract already delivered requests.

`autonomy.js` classifies every baseline command and provides a pure policy evaluator with immutable deny floors. The application does not yet have a trusted, target-bound approval broker and queue. Do not treat this evaluator or a caller-supplied `approved` flag as authorization. Issue #43 remains open until policy decisions, queue UI and broker integration are implemented and tested.

`resolveCommandTargets` freezes defaults before asynchronous dispatch. With several non-archived workspaces, automation must name workspaceId for workspace-scoped schemas and tabId for page operations/capture. Explicit record IDs resolve their owning workspace. The shared dispatcher and transport response metadata must preserve these resolved targets; they are also required for scoped client authorization.

Validation: `xvfb-run -a node --test test/browser-security.test.js` covers engine paths, popups, storage modes, launches, intelligence and downloads. `PATH=/workspace/.local/weft-system/usr/bin:$PATH xvfb-run -a node --test test/admission.test.js test/browser-workspace.test.js` passes the pure policy/target tests and real Chromium security fixture. A display is needed for the existing native layout/screenshot assertions; Chromium's ozone headless mode can stall the fixture's animation-frame wait.
