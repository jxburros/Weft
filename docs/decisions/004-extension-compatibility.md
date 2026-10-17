# ADR 004: Chromium extension compatibility and policy

Status: accepted and implemented for unpacked Manifest V3 extensions per
workspace. Evaluated 2026-10-17 on Electron 44.9.0 / Chromium 152.0.7977.167,
Linux under Xvfb. Not evaluated on macOS or Windows.

## Decision

Weft does **not** offer Chrome Web Store or Chrome-extension parity. It supports
a narrow, audited subset: a person may install an unpacked Manifest V3
extension into **one workspace**, granting exact host patterns. The extension
loads only into that workspace's Chromium session partition, its own network
requests are limited to the granted hosts and to site rules, and anything Weft
has not verified is refused before loading rather than failing later.

## Evidence

`test/extensions-browser.test.js` runs a fixture extension
(`test/fixtures/extensions.json`, `probe`) in real Electron through the same
`WorkspaceExtensions`, `Browser` and dispatcher code the app uses, with a second
workspace, a site rule and a local HTTP server. It runs in `xvfb-run -a npm test`.
`test/extension-policy.test.js` covers the manifest audit, hash pinning,
revocation and the request policy without a display. Electron type definitions
were not used as evidence.

| Area | Observed result | Weft policy |
| --- | --- | --- |
| Manifest V3 service worker, `chrome.runtime` messaging | Works | Allowed (`background.service_worker` only) |
| Content scripts (`content_scripts`) | Inject into matching pages of the workspace; not into other workspaces | Allowed for granted hosts |
| `chrome.storage.local` | Works, per workspace profile | `storage` allowed |
| `chrome.scripting.executeScript` | Works on granted hosts | `scripting` allowed |
| `chrome.tabs.query` | Returns only tabs of the same workspace session | `tabs` allowed |
| `chrome.runtime.connectNative` | Absent (`is not a function`) | `nativeMessaging` denied |
| `chrome.cookies`, `chrome.webRequest`, `chrome.debugger` | Undefined in the worker | `cookies`, `webRequest*`, `debugger` denied |
| `chrome.management`, `chrome.action` | Present in the worker | `management` permission denied; `action` UI ignored (no toolbar) |
| Worker `fetch` to a granted host | Succeeds | Allowed |
| Worker `fetch` to a site-rule-blocked path (navigation-mode rule) | Cancelled before reaching the server | Any block rule applies to extension-originated requests |
| Worker `fetch` to an ungranted host | Cancelled before reaching the server | Extension-originated requests must match a granted host |
| Content script `document.cookie` | Sees the page's non-HttpOnly cookies | Residual risk (below) |
| Disable / remove | Unloaded immediately; reloaded pages have no content script; copy deleted on remove | Human revocation |
| Re-enable | Content scripts return after reload | Human only |
| Hostile fixtures (native messaging, policy-bypass permissions, `<all_urls>` without grant, MV2) | Refused at audit; nothing loaded | — |

## Policy

- **Human only.** `extensions.list/audit/install/enable/disable/remove` require
  the trusted browser interface. Automation receives `human_required`.
- **Explicit scope.** `extensions.audit` shows requested hosts (broad patterns
  flagged), allowed permissions with their meaning, ignored UI keys, refusals
  and residual risks. `extensions.install` requires the exact requested host
  list as `hostGrants` (no more, no fewer) and the audited package digest.
  `<all_urls>` and other broad patterns work only when granted explicitly.
- **Pinned copy.** Installation copies the hashed bytes into the profile;
  links and special files are refused (1,000 files, 50 MiB). Enable and
  startup re-hash the copy and re-run the audit; a changed copy is refused and
  disabled with a reason.
- **Allowed permissions:** `storage`, `scripting`, `tabs` (each verified above).
- **Denied:** `nativeMessaging`, `debugger`, `proxy`, `webRequest`,
  `webRequestBlocking`, `webRequestAuthProvider`, `declarativeNetRequest*`,
  `cookies`, `management`, `privacy`, `contentSettings`, `downloads*`,
  `history`, `topSites`, `sessions`, `bookmarks`, `readingList`, `browsingData`,
  `clipboardRead`, capture APIs, `identity`, `geolocation`, `userScripts`,
  `background` and enterprise/certificate/VPN/filesystem providers; manifest
  keys `externally_connectable`, `oauth2`, `declarative_net_request`,
  `chrome_settings_overrides`, native/file handlers; CSP relaxations;
  `file:`/`chrome:`/other non-HTTP host patterns.
- **Unsupported (refused, not silently degraded):** unverified permissions such
  as `alarms`, `notifications`, `contextMenus`, `activeTab`, `webNavigation`,
  `offscreen`, `sidePanel`; `optional_permissions`/`optional_host_permissions`
  (no runtime prompt); sandbox pages; shared modules; Manifest V2; unknown keys
  and permissions (fail closed).
- **Ignored and reported:** `action`, `options_page`/`options_ui`,
  `devtools_page`, `commands`, `omnibox`, `side_panel`, `chrome_url_overrides`,
  `update_url` (Weft never auto-updates an extension).
- **Network:** requests whose initiator is an extension origin are cancelled
  unless the URL matches one of that extension's granted hosts in that
  workspace, and any matching block rule cancels them regardless of rule mode.
- **No packaged distribution:** no CRX/Web Store install, no updates, no
  extension sync.

## Residual risk

An enabled extension runs code inside every matching page of its workspace. It
can read and change what those pages show, including form fields typed by the
person and non-HttpOnly cookies, and it acts with the page's origin. Requests a
content script makes (or causes a page to make) are governed by site rules
like the page's own requests, not by the extension's host grant, so a granted
extension can still exfiltrate page data to any destination site rules allow.
Weft audits the manifest and pins file hashes; it does not review extension
code. Grant only extensions you trust with those sites.

## Consequences

Product copy must say "unpacked Manifest V3 extensions, per workspace" and not
"Chrome extensions". Supporting another permission requires adding a fixture
case to the Electron test, observing the result on the pinned Electron version,
and updating this record. Electron upgrades must rerun the Electron test before
changing the allowed set.
