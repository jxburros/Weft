# Community site lists

Verified against code: 2026-10-19. Implements #28 on top of the offline pinned installs from #59. Decisions on hosting and publisher verification are in [ADR 004](decisions/004-community-list-hosting-and-verification.md).

Community lists are opt-in, human-controlled claims about sites, published by a group as signed files. Weft ships no list service and contacts nobody unless a human configures a source URL and asks (or opts into a scheduled check). Nothing from the workspace, browsing history, personal rules or other subscriptions is ever uploaded. List text is untrusted data; it never carries instructions or authority beyond the rule effect a human's chosen mode allows.

## Two kinds of subscription

| | Signed subscription (this document, sections below) | Legacy pinned install |
| --- | --- | --- |
| Commands | `lists.subscribe`, `lists.preview`, `lists.update`, `lists.configure`, `lists.exception`, `lists.unsubscribe`, `lists.check`, `lists.matches`, plus shared `lists.status` and `lists.rollback` | `lists.install`, `lists.status`, `lists.rollback` |
| Trust | Ed25519 publisher key pinned by the human | Repository/commit/hash/size pin only; proves bytes, not authorship |
| Rules | Enforced according to subscription mode | Always created disabled for manual review |

All `lists.*` commands are human-only administration (GUI IPC, CLI and REST with the human interface; automation callers are refused). They are in the shared catalog, so [COMMANDS.md](COMMANDS.md) lists them.

## Publisher verification

A release is a `weft-signed-list` envelope: the exact payload text plus Ed25519 signatures over `weft-community-list-v1\n` + payload. The subscriber supplies the publisher's base64 SPKI public key when subscribing; Weft shows its SHA-256 key ID so it can be compared with one published elsewhere. Rejected before any state change: unsigned or plain-JSON lists, any payload change, signatures by other keys, a release naming a different publisher key, a different list ID, an expired release, and schema or governance violations that make entries unusable.

Key rotation: a release with `keyRotation` must be signed by both the pinned key and the named successor and includes a human-readable statement. The preview flags it; applying pins the successor and records the retired key and statement in the subscription. The old key then cannot sign updates. Rollback restores content but never un-rotates the pinned key.

Versions must increase. The subscription keeps the highest accepted sequence and digest: an older sequence is refused (`LIST_ROLLBACK`) unless the human passes `allowOlder` (preview marks it `ROLLBACK`) or uses `lists.rollback`; a different release with an accepted sequence is refused (`LIST_EQUIVOCATION`); rolling forward again to the highest accepted release after a rollback is allowed. `lists.subscribe` and `lists.update` require `payloadSha256` from the preview of the same bytes, so the applied release is the previewed one. Stored bytes are re-verified (signature and schema) every time they are used; a modified stored copy reports `integrity: mismatch` and enforces nothing.

## Subscribing, modes, updates

`lists.subscribe` takes `groupType` (`private-group` or `public`), the public key, the signed `data`, the confirmed digest, a `mode`, optional `minReviewers`, `sourceUrl` and `scheduledCheck`.

- **label** (default): entries are shown as labels with provenance (`lists.matches`, tab info `communityLabels`, status line) and never warn or block.
- **warn** / **block**: ceilings. An entry's effective behavior is the minimum of what its status and claim allow, the publisher's recommendation, and this mode. Enforcement is carried by ordinary workspace site rules whose `provenance` records the list, entry, revision, claim kind, approvals, publisher key ID, sequence and payload digest. Rules appear under Privacy and site rules and in the block notice; manual edits to subscription-owned rules are overwritten by the next change, so use exceptions instead.
- The reviewer floor defaults to 1 for a private group and 2 for a public list; the effective threshold is the larger of this floor and the list's own `minReviewers`.

Updates happen only by explicit human action: supply new bytes to `lists.preview` then `lists.update`, or run `lists.check` once. A check performs one plain GET (no cookies, no body, no redirects, https only, no URL credentials, 1,000,000 byte cap) of the configured `sourceUrl`, verifies the result and stores it as a pending update that still needs `lists.preview`/`lists.update`. `scheduledCheck: {enabled, intervalHours}` is off by default; when a human enables it, the desktop app runs the same check on that interval (the poll timer wakes every 15 minutes). Results, including rejections of unsigned/tampered/rolled-back downloads, are recorded in `lastCheck` and the activity log. The source host learns the requester's IP address and that the URL was fetched.

`lists.preview` never mutates state and returns: added, removed and changed entries (with before/after status, behavior, fields and correction note), `newlyBlocked`, `noLongerBlocked`, `newlyWarned`, governance changes (roles, reviewer threshold, limits), key rotation, rollback and warnings. `lists.rollback` restores the previous verified release (re-verified against the key it was signed with) and swaps the previous slot, so the same command rolls forward again. `lists.unsubscribe` deletes the subscription and all rules it owns. `lists.exception` adds or removes a visible exception for a hostname; any entry whose subject is that hostname (or an entity listing it) is suppressed for this subscription, and `lists.status`/`lists.matches` show it. An exception cannot carve a subdomain out of a broader entry (site rules have no allow rule); use the one-time `page.allowOnce` or narrow the entry through the list's correction process.

## Entry schema

Every entry has a stable `id`, one `subject`, a specific `claim` (10-500 characters), `claimType` (`factual` or `opinion`), `category`, a `recommended` behavior, `sources`, workflow `status`, `submitter`, `lastEditor`, `createdAt`/`updatedAt`/`reviewBy` dates, `revision` and review `round` numbers, `reviews`, `disputes` (with appeals), a `correctionNote` and a bounded `history` of revisions. Unknown fields fail.

- **Domain vs entity.** A `domain` subject names a canonical lowercase hostname with `includeSubdomains` and `path`. An `entity` subject describes a party (organization, person, product, service, project) with a list of associated domains. Entity claims describe who something is, so they can only label.
- **Fact vs opinion.** A factual claim needs at least one source (title, https/http URL, retrieval date, optional excerpt) and may recommend blocking. An opinion needs no sources, is labelled "Opinion" everywhere, and cannot block.
- **Status.** `proposed` (never enforced), `accepted`, `corrected`, `disputed` (label only), `stale` (label only), `retired` (nothing). A review date in the past reduces `accepted`/`corrected` to a label on the subscriber's clock even before maintainers mark it `stale`.
- **Review sufficiency.** An accepted or corrected entry designates only while at least `minReviewers` distinct, current-round approvals exist from members holding the `reviewer` role who are neither the submitter nor the last editor. Otherwise it has no effect and the preview/status say why (`insufficient review`). Entries from unknown submitters, entries over a rate or pending limit and oversized claims are disabled and counted in `governanceViolations`. A single report therefore cannot become a designation, and a publisher cannot grant itself one by editing the file without the approvals the file itself must show.

## Governance for maintainers (file-based)

A group keeps a directory (for example a git repository) with `list.json` (governance state) and `published/` (signed releases to host anywhere). Use `scripts/community-list.js` (run `node scripts/community-list.js help`):

```sh
node scripts/community-list.js keygen --out ./keys
node scripts/community-list.js init --dir ./list --id our-list --name "Our list" --maintainer ana --public-key ./keys/publisher.pub --min-reviewers 2
node scripts/community-list.js role-add --dir ./list --as ana --member ben --role reviewer
node scripts/community-list.js submit --dir ./list --as ana --hostname bad.example --claim "bad.example served a fake bank login on 2026-09-20." --claim-type factual --category phishing --recommended block --source-url https://reports.example/42 --source-title "Incident report"
node scripts/community-list.js review --dir ./list --as ben --entry <id> --decision approve
node scripts/community-list.js publish --dir ./list --key ./keys/publisher.key.pem
```

Roles are `maintainer` (manages roles and policy, retires entries, decides appeals, publishes), `reviewer` (approves/rejects, corrects) and `submitter`. Workflow commands: `submit`, `review`, `correct` (new revision, status `corrected`, fresh review round, required note; narrows or fixes a claim), `dispute` (any member, with an optional external `--reporter`; the entry is label-only at once and a new round of N independent approvals is needed to uphold it), `appeal` (disputant or submitter, once per resolved dispute) and `decide-appeal` (a maintainer not involved in the entry, dispute or review), `retire` (immediate), `stale` (mark entries past their review date; a fresh round reaffirms them), `status`, `publish` (increments the sequence, refuses entries that violate governance), `rotate-key` and `verify`. Anti-abuse limits in the list (`maxSubmissionsPerDay`, `maxPendingPerSubmitter`, `maxOpenDisputesPerMember`, `maxClaimLength`, `maxEntries`) are enforced by the tooling and re-checked by subscribers. Limits and output sizes are bounded (1,000,000 byte signed file, 5,000 entries).

Limits of this model: member names are attestations made under the signing key; the CLI does not authenticate who ran it. Protect the list repository (branch protection, pull-request review for `list.json`) and the private key. Anyone holding the key can publish valid-looking lists; a malicious maintainer is outside what this format can prevent.

## Matching and precedence

`CommunityLists.matchesForUrl(url, workspaceId)` (also at `workspace.communityLists`) returns every community entry whose subject matches the URL, including label-only, disputed, stale, retired, under-reviewed and excepted ones, each with `effectiveBehavior`, `active`, `reasons`, `enforcedByRuleId` and provenance (submitter, last editor, approving reviewers and threshold, sources, dates, disputes, correction note, recent history, list sequence, publisher key ID and payload digest). `lists.matches` combines it with every site rule that applies (personal, global and community; disabled rules flagged) ordered by the browser's precedence: enabled block rules in connection mode, then other enabled block rules, then the first remaining (warn) rule. The first enabled rule is the winner; a test asserts it equals `matchSiteRule`. The same function is the plug-in point for a site-rule explain command.

## Legacy pinned install

`lists.install` accepts the exact UTF-8 JSON text in `data` with a pinned `sourceRepo`, full 40-hex `commit`, repository-relative `path`, SHA-256 and byte count. A hash verifies supplied bytes, not publisher trust. The format is `{"format":"weft-site-list","version":1,"rules":[...]}` with rules limited to `hostname`, `includeSubdomains`, `path`, `behavior`, `mode`, `reason` and `note`; maximum 500,000 bytes and 5,000 rules; unknown fields, invalid hostnames/paths and duplicates fail without changing state. Installs, updates and rollbacks create disabled workspace-scoped rules with source provenance; reinstalling an unchanged pin is a no-op; updating replaces only the rules owned by that subscription and keeps the previous bytes for one-step rollback. A signed subscription id cannot be overwritten by `lists.install`.

## Storage, export and limits

Subscriptions live in the local project manifest's `siteLists` extension with their signed bytes (current and one previous). Generic workspace export/import retains installed rule data but not subscription history or imported provenance (#27); exported community rules are inactive on import. Deleting a workspace removes its subscriptions; snapshots include only that workspace's. Settings (and Privacy & site rules) open the Community site lists screen: subscribing shows the publisher key fingerprint (to compare with one obtained out of band) and the full preview (added, changed and removed entries, newly blocked and warned domains, opinions marked as such, warnings and governance changes) and needs an explicit acknowledgement; updates (fetched by Check for update or supplied as a file) are previewed and applied by their confirmed digest; mode, reviewer floor, source and scheduled checks, exceptions, rollback, unsubscribe and all matches for an address are on the same screen. The commands remain available through the command desk, CLI, REST and MCP (human only). Not implemented: authenticated member identities, transparency logs, multi-publisher or threshold signatures, remote key revocation, a hosted moderation service, and automatic application of updates.

## Validation

`node --test test/community-lists.test.js test/community-governance.test.js test/community-subscriptions.test.js` covers the offline pinned install; signature, tamper, wrong-key, unsigned, rollback, equivocation, expiry and rotation handling; the reviewer-threshold, conflict-of-interest, rate/pending/size/dispute limits; dispute, appeal, correction, stale and retirement flows; the maintainer CLI end to end; subscribe/preview/update/rollback/exception/unsubscribe; explicit and scheduled checks with an injected fetcher; match precedence parity with the browser matcher; and an end-to-end corrected entry through a signed update with changed subscriber behavior and inspectable provenance. These are fixture and offline tests; no real hosted list, external publisher or browser-level blocking of a live page was exercised.

Community lists are preference/reputation opinions, not security intelligence. Malicious-destination threat lists use a separate `weft-threat-list` format, `threats.*` commands and `kind: "security"` findings (see [ADR 009](decisions/009-destination-intelligence-and-downloads.md)). `siteRules.explain` shows community rules with their provenance, enabled state and precedence beside personal rules and security findings.
