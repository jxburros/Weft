# ADR 009: malicious-destination intelligence and download protection

Status: implemented; provider adapter and OS metadata paths tested against
fixtures only. Last reviewed: 2026-10-17. Issue: #20.

## Destination intelligence

Weft keeps security intelligence separate from personal and community site
rules. Findings carry `kind: "security"`, a category (malware, phishing,
unwanted-software, harmful-download), source, publisher and freshness, and are
listed first in `siteRules.explain`. A person may proceed past a finding only for
one destination in one tab visit and only with `acknowledgeSecurityRisk: true`.

Two sources are supported. Both are off until a person configures them:

1. **Offline, hash-pinned threat lists (default integration).** A person
   installs a `weft-threat-list` v1 JSON file with `threats.install`, supplying
   the SHA-256 and byte count published by its source (the same pinning model as
   community lists). Entries are hosts (domain-boundary matching), URL prefixes
   or SHA-256 file hashes. Lists never update in the background. Each list has
   a `maxAgeHours` (default 72); past it, findings and status say `stale` while
   the entries continue to block. No list is bundled: Weft does not choose a
   publisher on the user's behalf.
2. **Optional hash-prefix provider.** `threats.configureProvider` enables a
   client for the Google Safe Browsing **v4 Update API** wire format
   (`threatListUpdates:fetch` with RAW hash prefixes, then `fullHashes:find`).
   This protocol was selected because it lets the browser check URLs locally and
   disclose only short SHA-256 prefixes when a local prefix matches; the
   Lookup API alternative sends full URLs and was rejected. Enabling requires
   `acknowledgeEgress: true`. The API key is read from a named environment
   variable and never stored. Egress: list names and opaque client state on
   update; 4–32 byte hash prefixes on a local match; never URLs, page content or
   cookies. The provider sees the client IP address. Checksums are verified
   after every update and a failing list is discarded. Lookup failures fail open
   and are shown as warnings (matching mainstream browsers); installed offline
   lists are still enforced. Only main-frame and frame requests trigger remote
   confirmation.

Open points, not validated here: Google documents v4 as superseded by v5 and the
free Safe Browsing API as non-commercial (commercial users need Web Risk). The
adapter has only been tested against a local fake server implementing the v4
format; no live account was used. The endpoint is configurable for compatible
services. A v5 (`hashes:search`) adapter is future work.

## Downloads and external applications

- A download starts only within two seconds of real input in its tab (or a
  human click command) on the current document; the grant ends when the tab
  commits another document. Otherwise it is cancelled and recorded with source
  page, title, MIME type, file category (installer, executable, script, archive,
  macro-capable document) and redirect hosts. Repeated attempts for the same URL
  collapse into one record with an attempt count; more than five unsolicited
  records per tab per minute are counted, not listed. A person can approve one
  exact retry.
- Files are written to a separate `Downloads/Weft` folder (refused if it would
  be inside the application directory), created `0600`, and never opened or run.
- After completion Weft records the SHA-256, applies OS origin metadata and
  reports the outcome: Windows Mark-of-the-Web (`Zone.Identifier`, ZoneId=3),
  macOS `com.apple.quarantine` via `/usr/bin/xattr`, Linux
  `user.xdg.origin.url`/`user.xdg.referrer.url` via `setfattr` when installed
  (advisory; Linux enforces nothing). URLs are sanitized first.
- Hashes listed by installed intelligence and files flagged by the optional
  scanner move to `Downloads/Weft/quarantine` as read-only `.quarantined` files.
- `downloads.configureScanner` runs one human-configured local program (absolute
  path, no shell) with the file path as the last argument and maps exit codes
  to `clean` / `infected`; anything else is `scan-failed`. Without a scanner the
  status is `unscanned`. `clean` is labelled as "not a guarantee".
- External protocol launches (`mailto:`, app schemes) from page navigations or
  Chromium's `openExternal` permission become pending requests showing source
  page, frame and scheme. Only a person can approve one, once, within five
  minutes. Schemes with abuse history (`ms-msdt`, `search-ms`, `file`, `smb`, …)
  are refused even with approval. Frame-initiated external protocol navigations
  were observed to be dropped by Chromium without reaching the permission hook.
- All web permission requests remain denied; repeated or deceptive prompts are
  counted per tab and never reach the person.

## Verification limits

Real Chromium fixtures cover frames, popups, repeated and burst downloads,
blocked and refused launches, stale intelligence, quarantine and scanner
statuses on Linux. Windows and macOS origin-metadata code paths are unit-tested
with injected writers but have not been verified on those operating systems.
No real antivirus engine or live reputation service was exercised. Threat
intelligence cannot detect new or targeted threats or prevent browser exploits.

## Core versus plugin checklist (ADR 003)

Destination checks run inside Chromium's request interception before contact
and decide whether a request proceeds, so they are network policy and stay in
core alongside site rules. Both optional integrations are data or process
boundaries, not code loaded into Weft: threat lists are inert pinned JSON, the
provider is a fixed HTTPS protocol client, and the scanner is a separate
process launched without a shell that only receives a file path. None can
change authority, schemas, session isolation or tab leases, and all are
configured through human-only catalog commands.
