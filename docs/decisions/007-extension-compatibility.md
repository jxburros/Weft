# ADR 007: Chromium extension compatibility and policy

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
| `chrome.management`, `chrome.action` | Present in the worker | `management` permission denied; the action popup is shown from Weft's toolbar menu (addendum below), badges and other `chrome.action` calls have no effect |
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
- **Validated (addendum, #98):** `action` (`default_title`, `default_icon`,
  `default_popup` only), `options_page` and `options_ui.page`; each page must
  be an `.html` file in the package.
- **Ignored and reported:** `devtools_page`, `commands`, `omnibox`, `side_panel`, `chrome_url_overrides`,
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

## Addendum (2026-10-19, issue #98): toolbar, popups, options, CRX and declarativeNetRequest

| Question | Decision | Reason |
| --- | --- | --- |
| Toolbar button and action popup | **Ship, minimal.** The Extensions button in the address bar lists the extensions enabled in the current workspace (title, raster icon). Choosing one opens its `default_popup` in a separate browser-owned window. | Installed extensions were otherwise invisible. A separate window keeps extension UI out of Weft's trusted interface and out of page views. |
| Options page | **Ship.** "Options" opens `options_page`/`options_ui.page` in the same kind of window. | Settings are the other everyday extension surface. |
| Badges, `chrome.action.*` (setBadgeText, setPopup, onClicked), `open_in_tab` | **Not supported.** Calls have no visible effect; the menu says so. | Electron implements no `chrome.action` UI. |
| Packaged `.crx` / Chrome Web Store install | **No-ship.** | No verified update or signature path Weft controls; a packaged install would skip the reviewable unpacked audit and hash pinning. Unpacking a CRX by hand and auditing it stays possible. |
| `declarativeNetRequest` (ad blocking) | **No-ship; still denied.** | Electron 44 does not implement it, and request rewriting could route around site rules. Weft's own site rules and community lists cover blocking. |
| Optional permissions | **Still refused.** | No runtime permission prompt; extension UI never expands the audited allowlist (`storage`, `scripting`, `tabs`). |

Extension windows use the extension's workspace session, are sandboxed and
context-isolated with no preload, cannot open new windows or navigate outside
`chrome-extension://<id>/`, close when the extension is disabled or removed,
and refuse to open while the active tab is in a protected sign-in or payment
operation. Every `extensions.*` command, including `extensions.actions` and
`extensions.openPage`, is human-only. The real-Chromium test
(`test/extensions-browser.test.js`) opens a fixture popup and options page,
checks that `chrome.storage` works while `chrome.cookies` and `chrome.debugger`
stay undefined, that the popup cannot navigate away, that the recorded
permissions are unchanged and that a toolbar extension asking for
`declarativeNetRequest` is refused.
