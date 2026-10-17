# Offline pinned community site lists

Verified against code: 2026-10-17. This implements the verifiable distribution layer in #59; community hosting, curation, updates, corrections and appeals in #28 remain future work.

The trusted human command interface exposes `lists.install`, `lists.status`, and `lists.rollback`. Automation cannot call these commands. Installation receives the exact UTF-8 JSON text in `data`; no arbitrary local path is opened and no network request occurs. A caller can read a downloaded file locally and submit its contents. The supplied `sourceRepo` (`owner/repository`), full 40-hex Git commit, repository-relative `path`, SHA-256 and exact byte count pin the reviewed source. A hash verifies supplied bytes, not publisher trust or that GitHub hosts those bytes. Metadata and rules commit together through the workspace queue and atomic store.

Example source data:

```json
{"format":"weft-site-list","version":1,"rules":[{"hostname":"example.com","reason":"Reviewed community entry","mode":"navigation","behavior":"warn"}]}
```

Rules accept only `hostname`, `includeSubdomains`, `path`, `behavior`, `mode`, `reason` and `note`. The format is data only; unknown fields, invalid hostnames/paths and duplicate descriptors fail without modifying state. Maximum source size is 500,000 bytes and maximum rule count is 5,000. Every installed rule records list ID, source repository/commit/path/hash/byte count and source rule index in `provenance`. Browser block notices can show this source; it never conveys extra authority.

New installs, updates and rollbacks create disabled workspace-scoped rules. Review and enable rules explicitly through the existing human site-rule controls. `lists.status` reports exact pins, stored-byte integrity, rule/enabled counts and the previous pin without downloading. Reinstalling an unchanged pin is a no-op and retains human rule choices. Updating replaces only the rules owned by that subscription and preserves the previous source bytes for one-step rollback. Rollback revalidates those bytes and restores that previous source with rules disabled; it does not silently restore old enablement decisions or manual rule edits. Personal rules and other subscriptions are preserved. Source bytes, normalized rule descriptors and pins are retained locally, not as an independent trusted repository mirror.

Subscriptions currently live in the local project manifest's `siteLists` extension. Generic workspace export/import retains installed rule data but does not preserve subscription history or imported provenance. This limitation remains under #27; exported community rules are inactive on import. Deleting a workspace removes its subscription metadata; scoped snapshots include only that workspace’s subscriptions. No automated download, background update, signature/key trust service, subscription-wide enable switch, moderation or appeal mechanism is implied.

Validation: `node --test test/community-lists.test.js` covers offline install/restart, pin provenance, disabled activation, update/rollback, personal-rule preservation, idempotence, scope, automation denial, hash/size/schema failures and atomic rollback on external store conflict.

Community lists are preference/reputation opinions, not security intelligence. Malicious-destination threat lists use a separate `weft-threat-list` format, `threats.*` commands and `kind: "security"` findings (see [ADR 005](decisions/005-destination-intelligence-and-downloads.md)). `siteRules.explain` shows community rules with their provenance, enabled state and precedence beside personal rules and security findings.
