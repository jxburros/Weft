# ADR 004: community list hosting, publisher verification and governance

Status: accepted for the client and file format (issue #28); no hosted service
exists or is planned in this repository. Last reviewed: 2026-10-17.

## Decision

1. **No Weft-operated service.** Weft contacts no list host, registry or
   moderation service by default and ships none. A community list is a static
   signed file (`weft-signed-list`) that a group publishes from any git
   repository, static website or file share. Hosting a public moderation
   service, its funding, legal exposure and abuse handling are outside this
   repository. If a group runs one, it is just another publisher whose key the
   subscriber pins. Operating a project-wide service would need its own ADR with
   privacy, abuse/legal and sustainability gates.
2. **Publisher verification is key pinning, not hosting trust.** Each list is
   signed with Ed25519 (`node:crypto`). The subscriber supplies the publisher's
   public key when subscribing; Weft displays its SHA-256 key ID (the
   fingerprint) so it can be compared out of band. A release naming or signed by
   any other key is rejected. TLS, GitHub account ownership and commit hashes
   are transport, not publisher identity. The pre-existing unsigned
   hash-pinned install (`lists.install`) stays available for single files a human
   reviewed, and is documented as integrity-only.
3. **Key rotation is a statement signed by both keys.** A release carrying
   `keyRotation` must be signed by the pinned key (authority) and the named
   successor (possession). It appears as a warning in the preview and pins the
   successor only when a human applies it. There is no remote revocation: a
   compromised, unrotated key cannot be recovered by the client, and the group
   must tell subscribers out of band to unsubscribe and re-pin.
4. **Version integrity.** Each release has a monotonically increasing sequence.
   A subscription records the highest accepted sequence and digest. Lower
   sequences are refused unless a human explicitly allows an older release
   (or uses rollback); a different release with an already-accepted sequence is
   rejected as equivocation; releases may carry an expiry that refuses stale
   freezes. Applying any release requires confirming the previewed payload
   digest, so the applied bytes are those a human saw.
5. **Egress is explicit and download-only.** Subscribing and updating work from
   bytes the human supplies. A subscription may carry an https `sourceUrl`;
   fetching it happens only on an explicit `lists.check` or when a human enabled
   a scheduled check, uses a plain GET without cookies or redirects, and stores
   a verified *pending* update that still needs human preview and apply. Nothing
   about browsing history, local rules, other subscriptions or the workspace is
   transmitted. The host still sees the fetching IP address and URL.
6. **Governance is data in the list, enforced on both sides.** The list carries
   roles (maintainer, reviewer, submitter), the reviewer threshold, stale-review
   period and anti-abuse limits. Maintainer tooling (`scripts/community-list.js`)
   cannot publish entries that break them, and the subscriber re-evaluates the
   same rules on the signed data, so a hand-edited or careless publication
   cannot silently exceed policy.
7. **Designation is deliberately hard; de-designation is easy.** A submission is
   only a proposal. An entry designates only after the greater of the list's
   threshold and the subscriber's floor of independent reviewers (not the
   submitter or last editor, holding the reviewer role) approve its current
   round. A dispute, an expired review date, a stale mark or a correction
   immediately reduces it to a label or to no effect until re-reviewed; a
   maintainer can retire an entry at once. Opinions cannot block, claims about
   an entity can only label, and the subscriber's mode (label, warn, block) is a
   ceiling over the publisher's recommendation.

## Alternatives rejected

- Weft-hosted registry or moderation API: contradicts local-first operation,
  creates a central censor/target and an operations burden.
- Trust-on-first-fetch of a key embedded in the list, or trusting a domain:
  lets a host takeover mint a "publisher". The key is supplied by the human.
- Unsigned hash pins only: prove bytes, not who authorised them or whether an
  update is newer.
- Web of trust, threshold/multi-publisher signatures and transparency logs:
  stronger, but unjustified complexity before any group uses the format. They
  can be added as new `version` envelopes without breaking pinned keys.

## Consequences and honest limits

- The pinned key is a single trust root. Anything its holders sign is accepted
  if it is well formed and (by the client's re-check) satisfies governance data
  the same holders also signed. Roles and member names are attestations by the
  maintainers; authenticating contributors is the git host's or group's job.
  Malicious or coerced maintainers can publish harmful but valid lists.
- Without a hosting service there is no independent availability, takedown or
  legal-process path; groups own those obligations.
- Subscribers can view claims but Weft does not verify sources or truth. List
  text is untrusted data and never an instruction to an agent.
- No automatic update is applied; users who never check never receive
  corrections. Schedule checks only reduce the delay.
- Subscription records (including signed bytes) live in the local project
  manifest and are not preserved by generic workspace export/import (see #27).
- Verified with fixtures and offline tests only. No real hosted list, external
  publisher, independent security review or user study was exercised.

## Core versus plugin checklist (ADR-003)

The feature stays in core because it feeds the browser's request-blocking policy
(workspace authority, persistence integrity and site-rule resolution). It
introduces no executable content (the format is strict data), no plugin code, no
new listener, and uses only `node:crypto`, `zod` and an injectable fetch for the
opt-in check. It cannot bypass human-only gates: every `lists.*` command is
human-only administration.
