# ADR 012: resource archives, capture comparison and redaction derivatives

Status: accepted and implemented for issues #16 and #17. Last reviewed:
2026-10-17. Limits and deferred work are listed below.

## Context

Captures were immutable text/PNG bundles. There was no way to keep the page's
resources for offline review, to compare versions, or to share or hand a capture
to an agent or model without also handing over everything it contained. Exports
already omitted secrets and sanitized selected URL fields, but notes, screenshots
and captured text could still expose personal data. Any solution must stay
local, keep evidence immutable and never present partial captures or partial
redaction as complete.

## Decision

### Archive format (weft-archive format 1)

**Source.** `artifacts.capture` with `kind: "archive"` serializes the rendered
page with Chromium's MHTML generator (`webContents.savePage(path, "MHTML")`)
into a temporary file in the profile and parses it (`src/archive.js`). Blink's
serializer removes script elements and takes subresources from the renderer's
loaded resources, so archiving does not fetch the page again and adds no network
traffic. We chose MHTML parts over `HTMLComplete` folders because parts keep
their exact `Content-Location` URL and MIME type, and over our own re-fetching
because a second fetch could differ from what the person saw and would repeat
requests with their cookies.

**Storage.** Each part becomes a resource entry in a manifest stored on the
immutable version (`version.archive`): `url` (credentials, fragment and
secret-named query parameters removed, the same rule as stored URLs), `role`
(`document`, `frame`, `subresource`), `mimeType`, `size`, `sha256` and
`status`. Stored bodies (`bodyBase64`) are content-addressed components
(ADR-011), so identical resources across versions are stored once and verified
on every read. Before storing, archived HTML has the values of password,
hidden, payment-card, one-time-code and secret-named fields removed, and MHTML
frame references (`cid:`) are rewritten to archive-local URLs; both are recorded
as `transformed`. A manifest digest is listed in `version.components`.

**Explicit missing resources.** Resources the page referenced (DOM scan in the
isolated world, performance entries and the session's own request log for the
tab) that are not in the MHTML are listed, never dropped: `failed` (HTTP error
or network error from the request log), `missing` (not loaded, lazy, blocked or
evicted), `not-archived-script` (scripts and script-initiated requests are never
archived), `omitted-size` (over `maxResourceBytes`, default 8 MiB, max 32 MiB)
and `omitted-budget` (over the 64 MiB archive total). `purged` marks content
removed later by a human.

**Bounded capture.** Readiness waits for load completion up to `readyTimeoutMs`
(default 5 s, max 30 s); the whole capture is bounded by `maxDurationMs`
(default 30 s, max 120 s), and a serialization that times out or fails still
saves an honest version (`archive.status: "failed"`). `version.capture` records
start/finish time and duration, readiness state, original and final URL,
navigation version at start and end, viewport (size, device pixel ratio,
scroll, document size), navigation and in-page state changes observed during
capture, request failures, coverage from the semantic snapshot (virtualized
lists, pending lazy images, busy regions, inaccessible frames) and
`complete`/`incomplete` with reasons. Cross-origin frames become
`inaccessibleRegions` in screenshot pixels. Recapture always creates a new
version; earlier versions never change.

### Offline preview

`artifacts.preview` (human-only) opens a version in a dedicated
`WebContentsView` that replaces the live tabs until closed. Its session is an
in-memory partition (`weft-archive-preview`) whose `http`/`https` protocol
handlers answer only from the open archive's verified stored resources and
return 404/405 for everything else (non-GET included), so nothing in the
preview can reach the network. JavaScript is disabled in web preferences, every
served response carries a CSP with `sandbox`, `script-src 'none'`,
`connect-src 'none'` and `form-action 'none'`, renderer-initiated navigation and
redirects are cancelled, popups, downloads and permissions are refused, and
webviews are blocked. A damaged component is withheld and reported; a damaged
document refuses the preview.

### Comparison

`artifacts.compare` returns a line diff of readable text (LCS with prefix/suffix
trimming, approximate multiset fallback for very large changes), a resource
diff by URL (added, removed, changed bytes, changed status) and an optional
pixel diff of screenshots with a highlighted PNG (`src/png.js`, pure JavaScript).
The GUI shows the same result.

### Redaction derivatives and access/retention decisions

**Derivatives.** `artifacts.redact` builds a new immutable version from a source
version: selected text spans (`{start,end}`, every `literal`, a time-bounded
`pattern`, or a detector kind) are replaced with `[REDACTED]`; the same
non-offset selectors also apply to the version title, the artifact title and
the URL (which falls back to origin or nothing when they match). The screenshot
is decoded and re-encoded as a fresh RGBA PNG with only IHDR/IDAT/IEND, with
region pixels replaced by black, so no hidden layer, text chunk or original
pixel survives; it can also be omitted. The resource archive and capture URLs
are never carried into a derivative. The version records `derivedFrom`,
`redactions` (`{type:"text", at, label}` or `{type:"region", x, y, width,
height, pixels, label}`; never the removed text, its length or the selector),
`inaccessibleRegions`, review metadata and `redactionStatus: "redacted"`. Model
media code reads these arrays (`regionSummary`). `preview: true` returns the
derivative without saving it; the GUI editor previews before saving.

**Access.** Whether agents may read an original is a separate, human-only
decision (`artifacts.setAccess`, `restricted`/`standard`). A restricted version
is returned to every non-human caller (REST, CLI, MCP, plugins, model readers)
as a withheld stub naming its derivatives; review, compare and redact of it are
refused; it is removed from the full-text index with FTS5 `secure-delete`
(index merge and WAL truncation follow) and never re-indexed while restricted.
Model attachments of a restricted original send its newest derivative instead,
with provenance (`substitutedFor`, `derivedFrom`), or nothing.
`artifacts.readOriginal` is the only agent path to a restricted original: it
carries the new `restricted_original` data class, which client grants never
receive by default, and every non-human read needs an exact one-time human
approval (no standing approval, no autonomy level, observe-level identities
such as model readers are denied).

**Retention.** `artifacts.purgeContent` (human-only, irreversible, dryRun)
deletes a version's stored text, image and archive bodies while keeping its
metadata and hashes; components still used elsewhere (for example an unchanged
screenshot) are kept and counted.

**Exports.** `workspaces.export`, `workspaces.exportPackage` and
`workspaces.exportAs` take `captures`: `exclude-restricted` (default),
`derivatives-only`, or `all` (an explicit human choice). Every excluded version
is listed in `excludedContent` with a reason; linked live pages, files and
services are listed in `linkedSourcesNotIncluded`; `reviewMetadata` adds a
URL/path/query and detection-assistance review; the residue scan decodes text
archive resources and reports images as unverifiable. Imports keep derivative
metadata and report a missing `derivedFrom` source as a lossy mapping.

**Detection assistance.** `artifacts.review` and the editor offer pattern
matches for emails, phone numbers, Luhn-valid card numbers, API-key-like strings
and JWTs, with masked previews, labelled as assistance that does not find names,
addresses, free-form secrets or text in images.

## Consequences and limits

- Hashes show stored bytes are unchanged since capture. They do not prove what
  a site served, that the page is authentic, or when it was captured; there is
  no independent timestamp authority.
- The archive is Chromium's serialization of the DOM at capture time (including
  state set by page scripts), not the original HTTP responses. Script-driven
  behavior, canvas/media streams, closed shadow roots, cross-origin frame
  content outside Chromium's serialization and resources never loaded are not
  archived; they are listed or reported as incomplete.
- Archived HTML, stylesheets and images are not redactable; derivatives omit
  the archive. Text selectors do not remove text inside screenshots: people
  must draw regions or omit the image. Artifact notes, tags and annotations are
  human-written history and are not rewritten by redaction; matches there are
  reported.
- Purging deletes files from the profile; Weft cannot guarantee physical erasure
  from storage devices, filesystem snapshots or sync copies, and backups or
  exports made earlier still contain the content.
- The preview renders untrusted HTML/CSS in Chromium with scripts disabled and
  no network; it is not a guarantee against renderer vulnerabilities in image,
  font or CSS handling.
- Deferred: OCR-assisted image redaction, redaction of archived HTML, WARC
  export, and signed or third-party timestamps.
