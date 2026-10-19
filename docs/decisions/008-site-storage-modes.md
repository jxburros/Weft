# ADR 008: browser-owned site storage modes and temporary sessions

Status: implemented and tested with real Chromium fixtures (Electron 44).
Last reviewed: 2026-10-18. Issue: #18.

## Decision

Storage policy is enforced by the browser process, per workspace partition,
independently of anything a site displays. Weft never clicks consent banners.

| Mode | Mechanism |
| --- | --- |
| Block site storage | Response `Set-Cookie` and request `Cookie` headers for the host are removed. Main-frame and frame documents from the host receive an added `Content-Security-Policy: sandbox …` without `allow-same-origin`, so Chromium gives them an opaque origin and itself refuses `document.cookie`, Web Storage, IndexedDB, Cache Storage and service-worker registration (SecurityError). Service-worker script fetches (`Service-Worker: script`) are cancelled. Blocked documents get `Cache-Control: no-store`. Cookies for the host created by any other path are deleted when Chromium reports them. Setting a site to block erases its existing data. |
| Allow for this session | Data is allowed. Before the first request to a session-mode origin proceeds, Weft durably records the origin in `workspace-data/temporary-storage-journal.json` (write-ahead, fsync). At clean exit Weft erases journaled origins (cookies, Web Storage, IndexedDB, Cache Storage, service workers, file system, HTTP cache) and the journal. If the process dies first, the next startup erases them **before** restoring tabs. |
| Remember this site | Data is retained in the workspace container (the previous behavior). |
| Clear this site | `storage.clear` erases supported data now; the site keeps its mode. |

Workspace defaults (`storage.setDefaultMode`) choose remember, session or block
for sites without an exception. Site exceptions (`storage.setSiteMode`) are
workspace-scoped, cover subdomains unless narrowed, and are revoked with
`mode: "default"`. All changes are human-only administration; agents can read
`storage.policy`. A session lasts from startup until clean exit.

### Why the CSP sandbox instead of a page script shim

A main-world shim can be raced or bypassed by page scripts and same-origin
frames. The sandbox is enforced by Blink and also covers workers created by the
document. The cost is compatibility: the document's origin is opaque, so its own
same-origin requests become cross-origin (CORS) and sign-in flows break. That is
disclosed in the GUI; it is the expected cost of refusing storage.

## Cross-site tracking default

Chromium already defaults unmarked cookies to `SameSite=Lax`, which it neither
sends nor accepts on cross-site subresource requests. Weft additionally removes
cookie headers on cross-site requests for cookies marked `SameSite=None` (the
cookies third-party trackers use) by default. "Cross-site" compares an
approximate registrable domain (last two labels, or three for common
`co.uk`-style suffixes); Weft does not bundle the Public Suffix List, so hosting
platforms such as `github.io` are treated as one site (under-blocking). A
subresource or frame request is cross-site when its requesting document
(`initiatorOrigin`) or its top page is on another site, as in Chromium's own
SameSite rules; top-level navigations are first-party. For a top-frame request
the requesting document's origin is used as the top page, because the frame can
still report the previous page (see engine limitations). An
explicit session or remember exception for the embedded site allows its
cross-site cookies. Script cookie access inside cross-site frames is not blocked
by this default, and nothing here prevents fingerprinting, link decoration or
server-side tracking. Weft makes no necessary-versus-tracker classification.

## Verified engine limitations

- Electron exposes no per-site cookie content setting; enforcement uses
  `webRequest` header hooks, the CSP sandbox and the cookie-change event.
  Chromium's own third-party cookie blocking does work in Electron 44, but only
  process-wide through test switches (`--test-third-party-cookie-phaseout`,
  feature `ForceThirdPartyCookieBlockingEnabled`), with no per-session or
  per-site exceptions, so it cannot express workspace defaults, the `allow`
  policy or site exceptions and is not used. Rewriting `SameSite=None` cookies
  to `Lax` was also rejected: it would also withhold cookies from cross-site
  top-level POSTs (SAML and OIDC `form_post` sign-in), which this policy treats
  as first-party, and the original attribute could not be restored when an
  exception is granted.
- Commit race (measured 2026-10-18): a new top document's first subresource
  requests can reach the main process before its commit. Their `frame.url`,
  `frame.top.url` and `webContents.getURL()` then all still name the previous
  page (3 of 160 fresh-process navigations in a probe). Judging by those
  values sent a tracker its first-party cookie when the person went from the
  tracker to a site embedding it. Weft judges by the requesting document's origin instead.
  When Electron cannot resolve the requesting frame it omits both `frame` and
  `webContents`; the initiator rule then still applies rather than failing open.
- Cookie header visibility: Electron passes the `Cookie` header to
  `onBeforeSendHeaders` only on its "extra headers" path. It uses that path for
  requests with a nonzero network-service request ID while listeners exist.
  Renderer and navigation requests qualify (no renderer subresource request
  lacked the header in 240 fresh-process probes). Main-process `net` requests
  have ID 0, so their cookies are attached after the hook; Weft's own
  main-process requests do not use session cookies.
- Shared and service workers have no frame, so their requests are judged by
  their initiator only; a third-party service worker's requests to its own site
  are not detected as cross-site.
- Data held by pages that remain open, back/forward-cache pages, HSTS, socket
  pools, DNS cache, shared dictionaries, permissions, client hints, Private State
  Tokens and favicons are outside the modes.
- Origin-scoped clearing covers default-port origins and origins observed in the
  current run or journal; data from non-default ports in earlier runs cannot be
  enumerated through Electron APIs.
- A crash leaves temporary data on disk until the next Weft start; another
  program can read it in between. Removing the profile lock after a crash
  remains a human step (see storage safety).

## Evidence

`test/browser-security.test.js` loads fixture pages in real Chromium and checks
each storage API in block mode, header removal, cross-site cookie removal
(including the transition from a first-party tracker visit to several fresh
embedding sites, where the commit race occurs) and exceptions, clean-exit erasure, and erasure after a `SIGKILL` crash while
remembered data (cookies, localStorage, IndexedDB, Cache Storage, service
worker) survives. `test/site-security.test.js` covers header logic (including
stale and unresolved frames, deterministically), write-ahead journaling and
revocation without Electron.

## Addendum (2026-10-19, issue #94): private windows

- **What it is.** Ctrl/Cmd+Shift+N or Page tools > *New private window* (trusted
  GUI only; no command exists) opens a separate window with its own minimal,
  always-dark chrome labelled *Private*. Its page uses an in-memory Chromium
  partition (`weft-private-<uuid>`, no `persist:` prefix): cookies, storage,
  caches and service workers never touch the profile. Pop-ups after a click
  open as further private windows on the same in-memory session (without an
  opener); the session is erased when its last window closes. A crash leaves
  nothing to clean up because nothing was written (verified by a SIGKILL test
  that scans every profile file for the page's markers).
- **No workspace.** A private window belongs to no workspace: no tab records,
  history, recently-closed entries, bookmarks, captures, resume state or
  exports. Activity records only that a private window opened or closed (with
  a count), never an address. Downloads need a recent click or key press and
  always open a save dialog; they are not listed in Downloads.
- **Agents: refused by default, no opt-in offered.** Private pages are not in
  `tabs.list`, and their ids are reserved in the tab id space so any tab or
  page command naming one fails with `permission_required` (`private_window`).
  There is no per-session "allow this agent here" option: inviting an agent
  into a private window would need its own grant model and evidence trail,
  which would contradict "leaves nothing behind". Revisit only with a separate
  decision.
- **Saving a page** from a private window is not offered in this version.
- **Policy.** Every web permission is denied without a prompt. Only site rules
  with global scope and installed threat lists apply (there is no workspace
  scope); while an encrypted profile is locked every request is refused, as for
  workspace pages.
- **Interaction with other windows.** Private windows are separate from
  workspaces and from any future multi-window or Everything workspace work.
- **Limits.** It does not hide you from websites, your network or this
  computer; the operating system may still page memory to swap.
