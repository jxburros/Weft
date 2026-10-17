# ADR 004: distribution, installers and update policy

Status: accepted for the first packaged release; signing and cross-platform
installation remain unverified (issues #33, #54, #60). Last reviewed: 2026-10-17.

## Context

Weft ran only from source. Issues #33, #54 and #60 ask for installers (a branded
Windows installer), a release pipeline, integrity-verified updates with rollback, a
kill switch and an owned Electron/Chromium maintenance process. Weft's invariants
apply: local work must stay usable offline, there is no unacknowledged data egress,
humans alone change trusted state, and outcomes must be reported honestly.

## Decisions

1. **Packaging with electron-builder** (dev dependency, pinned 26.15.3). Targets:
   Windows NSIS x64, macOS dmg+zip arm64/x64, Linux AppImage+deb x64. Configuration is
   `electron-builder.config.cjs`; signing activates only when secrets are present.
2. **Windows installer:** assisted (not one-click) NSIS, per-user by default with an
   optional all-users choice and changeable directory. Branded welcome/finish and
   uninstall sidebars and header are generated deterministically from
   `assets/tokens.json` and the committed logo exports by
   `scripts/generate-installer-art.js`; `packaging/installer.nsh` supplies Weft's text.
   Upgrades (`--updated`) never touch user data. Uninstall keeps the `weft` profile
   folder unless the person ticks a separate, confirmed "permanently delete" option;
   the disposable update cache is always removed. Packaged builds pin the profile
   folder to `appData/weft`, the same folder source runs use, so the product name
   "Weft" cannot silently split data.
3. **Own updater instead of electron-updater.** electron-updater provides sha512
   checks, but: it adds a runtime dependency tree to a security-sensitive process; its
   provider URLs come from `app-update.yml` and runtime setters rather than one compiled
   constant; macOS in-place updates require Squirrel.Mac and a signed app; its health
   check/rollback and staged-only background policy would still need custom code; and
   it is hard to test without Electron. `src/updater.js` (~600 lines, Node built-ins
   plus zod) implements exactly the policy below, is fully unit-testable with a fake
   transport, and keeps electron-builder's `latest*.yml` format so tooling stays
   standard. The release workflow validates every generated manifest with the same
   strict parser, so a format change fails a release instead of breaking clients.
4. **Stable-only, fixed source.** Releases come only from
   `https://github.com/jxburros/Weft/releases/latest/download/<latest*.yml>`; GitHub's
   `latest` excludes drafts and prereleases. The redirect chain must name the release
   tag, which must equal `v<manifest version>`. Prerelease/build versions, downgrades,
   equal versions, foreign hosts, other repositories, credentials in URLs and unknown
   manifest keys are refused. No command, workspace, page or agent can supply a URL.
5. **Disclosed, human-controlled egress.** No update request is made unless a person
   clicks Check now or enables daily background checks (default **off**, shown with
   the hosts contacted and what they learn). Background checks run at most every 24 h
   and only download and verify. Installation, rollback and configuration are
   human-only commands (`update.check`, `update.install`, `update.rollback`,
   `update.configure`); `update.status` is a local read available to automation and
   scoped read clients. Update requests use an isolated, cookie-less session.
6. **Verification:** exact size and SHA-512 while streaming; re-hash immediately
   before install; Windows Authenticode publisher pinning when the running build is
   signed; macOS relies on Gatekeeper at open; Linux on SHA-512 and published
   `SHA256SUMS.txt`.
7. **Installation per platform:** Windows runs the verified installer visibly
   with `--updated` and quits; AppImage is replaced by copy-verify-rename with the
   previous file retained, then relaunched; macOS opens the verified dmg and `.deb`
   opens the system installer — both visible manual steps, reported as
   `handed_off_manual`, never as completed.
8. **Health check and rollback:** a new version is on probation until the GUI has
   loaded, the API listens and the store opened. After two launches without passing,
   it is marked failed. AppImage rolls back automatically; Windows offers a verified
   retained installer (only available when the previous version was itself installed
   through the updater); macOS and `.deb` show manual recovery guidance. Failed versions
   are not re-staged automatically. A crash before Weft's JavaScript runs (e.g. a
   broken Electron binary) cannot be observed by this mechanism; the launch counter
   then triggers on the next launch that does reach it.
9. **Kill switch:** `WEFT_DISABLE_UPDATES` (fails closed) stops all update traffic and
   installs. Source runs have no transport at all.
10. **Release pipeline:** tag-triggered; the tag must match package/lock/plugin
    versions and a changelog section; builds on Windows/macOS/Linux runners;
    unsigned builds are labelled; packaged apps are smoke-tested; assets go to a draft
    release and are published only after the verified asset set (with
    `SHA256SUMS.txt`) is attached. Maintenance cadence and review gates are in
    `docs/RELEASING.md`.

## Consequences and open items

- Real signing, notarization, a Windows installer run, cross-version upgrades and
  uninstall behavior on real machines are not yet verified; issues stay open until
  they are.
- Windows rollback is unavailable for the first updated version (no retained
  installer). Users can install the previous release manually.
- Supporting more architectures or an rpm/Flatpak channel means extending
  `detectInstall()` and the release matrix.
- Delta/blockmap downloads are not used; each update downloads the full package.
