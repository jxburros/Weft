# ADR 008: browser-owned site storage modes and temporary sessions

Status: implemented and tested with real Chromium fixtures (Electron 44).
Last reviewed: 2026-10-17. Issue: #18.

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
platforms such as `github.io` are treated as one site (under-blocking). An
explicit session or remember exception for the embedded site allows its
cross-site cookies. Script cookie access inside cross-site frames is not blocked
by this default, and nothing here prevents fingerprinting, link decoration or
server-side tracking. Weft makes no necessary-versus-tracker classification.

## Verified engine limitations

- Electron exposes no per-site cookie content setting; enforcement uses
  `webRequest` header hooks, the CSP sandbox and the cookie-change event.
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
each storage API in block mode, header removal, cross-site cookie removal and
exceptions, clean-exit erasure, and erasure after a `SIGKILL` crash while
remembered data (cookies, localStorage, IndexedDB, Cache Storage, service
worker) survives. `test/site-security.test.js` covers header logic, write-ahead
journaling and revocation without Electron.
