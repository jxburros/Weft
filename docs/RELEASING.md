# Releasing Weft

Last verified against code: 2026-10-18. Policy and rationale: [ADR 010](decisions/010-distribution-and-updates.md).

This document is the release procedure, the signing/hosting setup, the trust roots
for installers and updates, and the support and security-maintenance commitments.
Statements marked **not yet verified** have not been exercised with real
credentials, real hardware or a published release.

## Supported platforms and channels

| Platform | Architectures | Package | In-app update | Rollback |
| --- | --- | --- | --- | --- |
| Windows 10/11 | x64 | NSIS assisted installer (`Weft-Setup-X.Y.Z-x64.exe`), per-user by default | Verified installer runs visibly with `--updated` after the human chooses Install | One click to a retained, re-verified previous installer when one exists; otherwise manual |
| macOS (current and previous major) | arm64, x64 | `Weft-X.Y.Z-<arch>.dmg` and `.zip` | Verified `.dmg` is opened for a visible drag-to-Applications install | Manual (previous release from GitHub) |
| Linux (glibc, x86_64) | x64 | `Weft-X.Y.Z-x86_64.AppImage`, `Weft-X.Y.Z-amd64.deb` | AppImage replaced atomically then relaunched; `.deb` opened in the system installer | AppImage: previous file kept, automatic after failed health checks; `.deb`: manual |

Windows arm64, Linux arm64, rpm/snap/Flatpak and app stores are not built. Running
from source (`npm start`) remains supported for development and is never updated in
place. The only distribution channel is **stable** GitHub Releases of
`jxburros/Weft`; there are no beta, nightly or prerelease channels. The MIT license
and the Weft name are unchanged; there is no paid tier or account requirement.

## Support policy

- Only the latest stable release receives fixes. Security fixes ship as a new patch
  release; there are no backports to older minor versions.
- Electron/Chromium security releases are adopted within **14 days** of the upstream
  stable release, or within **72 hours** for a Chromium fix of an exploited-in-the-wild
  vulnerability. Weft stays on an Electron major that upstream still supports
  (the three most recent majors); moving off an end-of-life major is a release blocker.
- Workspace data formats are migrated forward by `src/migrations.js`. Downgrading to a
  release with an older schema is refused by the store; rollback is therefore offered
  only to the version that ran immediately before an update.

## Maintenance ownership

The repository maintainers with release permission on `jxburros/Weft` own releases,
the signing identities and Electron/Chromium security updates. Dependabot opens
weekly npm and GitHub Actions update PRs (`.github/dependabot.yml`); Electron is
grouped separately so its security review is never bundled with routine updates.
Naming an individual on-call owner is a maintainer decision recorded in the
repository settings, not in this file.

## Security review gates

A release tag is blocked unless all of these hold:

1. `node scripts/release/metadata.js vX.Y.Z` passes: the tag equals `package.json`,
   `package-lock.json` and `.claude-plugin/plugin.json`, and `CHANGELOG.md` has a
   `## vX.Y.Z — YYYY-MM-DD` section (used as the release notes).
2. `npm audit --omit=dev --audit-level=high` reports no high/critical advisory in
   shipped runtime dependencies. Build-only advisories (for example the current
   moderate `sprintf-js` advisory under `electron-builder`) are reviewed and noted in the
   changelog when accepted.
3. The full suite passes with real Chromium (`xvfb-run -a npm test`), plus
   `npm run test:docs` and `npm run evals`.
4. Every platform builds, and the packaged app passes `scripts/release/smoke-packaged.js`
   (authenticated loopback API, version, kill switch honored, automation refused
   update checks, clean exit).
5. `scripts/release/verify-assets.js` re-verifies each `latest*.yml` with the same
   strict parser the app uses and every listed file's size and SHA-512, then writes
   `SHA256SUMS.txt`.
6. For an Electron major/minor bump, a maintainer also reviews: Electron breaking
   changes and security notes, `webPreferences`/sandbox defaults, new permission or
   `session` behavior, `test/browser*.test.js` results, and the browser safety audit
   (`docs/BROWSER-SAFETY-AUDIT.md`). Record the review in the release notes.

## Release procedure

1. Choose the version (semver; patch for fixes and security updates).
2. `npm version X.Y.Z --no-git-tag-version`, then set the same version in
   `.claude-plugin/plugin.json`. Add a `## vX.Y.Z — YYYY-MM-DD` section at the top of
   `CHANGELOG.md` with the user-visible changes, verification limits and the Electron
   version.
3. `npm run release:check` locally, commit, open a PR and merge after CI passes.
   CI also packages and launches a Linux AppImage on every PR, and builds the
   Windows NSIS installer on `windows-latest`, installs it silently, launches the
   installed app, reinstalls over it and uninstalls it
   (`scripts/release/windows-install-check.ps1`). The unsigned installer is kept as
   the `weft-windows-installer-unsigned-<sha>` workflow artifact for 14 days.
4. Tag the merge commit: `git tag -s vX.Y.Z -m "Weft X.Y.Z" && git push origin vX.Y.Z`.
5. `.github/workflows/release.yml` runs the gate and full suite, builds Windows,
   macOS and Linux packages, signs where credentials exist, verifies signatures,
   smoke-tests each package (Windows also runs the install/reinstall/uninstall
   check against the real installer), uploads everything to a **draft** release, confirms the
   draft has exactly the verified assets plus `SHA256SUMS.txt`, then publishes it as
   the latest release. Updaters see a release only after publication.
6. Spot-check the published release: install on a clean machine per platform, and
   upgrade from the previous release using the in-app Update Center.

A dry run (`workflow_dispatch`, default) builds and smoke-tests without creating a
release. Local packaging: `npm run dist -- --linux AppImage` (or `--win nsis`,
`--mac dmg zip`); outputs go to `dist/` (ignored by git).

### Revoking a bad release

Mark the GitHub release as a prerelease or delete its assets: `/releases/latest`
then resolves to the previous stable release, and clients stop being offered the bad
version. Clients that already staged it can still install it, so publish a fixed
higher version promptly. Never re-upload different bytes under an existing version.

## Signing setup

Without these secrets the workflow still releases, but each package is labelled
**UNSIGNED** in the release notes and on Windows the updater verifies only the
manifest's size and SHA-512. Unsigned Windows release notes also tell people how
to check the installer against `SHA256SUMS.txt` and get past the SmartScreen
"Windows protected your PC" prompt (**More info** > **Run anyway**).

| Secret | Purpose |
| --- | --- |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Microsoft Entra service principal allowed to sign with Azure Trusted Signing |
| `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` | Trusted Signing endpoint, account and certificate profile |
| `WEFT_WINDOWS_PUBLISHER` | Publisher common name exactly as in the certificate |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Alternative to Azure: base64 PFX code-signing certificate for signtool |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Base64 Developer ID Application certificate (.p12) |
| `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key for notarization |
| `RELEASE_GPG_KEY` | Optional armored private key to sign `SHA256SUMS.txt` |

Store signing secrets in a protected GitHub **environment** with required reviewers
before first use. EV/HSM-backed certificates should prefer Azure Trusted Signing.
**Not yet verified:** no signing identity exists for this repository, so signing,
notarization, Gatekeeper assessment and the signature verification steps have not run.

## Trust roots

- **Release source:** the fixed repository `jxburros/Weft` on GitHub, over HTTPS with
  Chromium's certificate verification. The update URL is compiled into
  `src/updater.js`; workspaces, pages, agents and command arguments cannot change it.
  Redirects are followed only to `github.com/jxburros/Weft/releases/...`,
  `objects.githubusercontent.com` and `release-assets.githubusercontent.com`.
- **Integrity:** `latest*.yml` from that release supplies the exact size and SHA-512
  of each file. The manifest's version must equal the release tag reached through
  `/releases/latest`, must be stable `x.y.z`, and must be newer than the running
  version. Staged files are hashed again immediately before installation.
- **Publisher (Windows):** when the running Weft is Authenticode-signed, an update is
  accepted only with a valid signature from the same certificate subject. An unsigned
  installation records that only hash verification applied.
- **Publisher (macOS):** Gatekeeper verifies the Developer ID signature and
  notarization when the updated app is opened.
- **Linux:** SHA-512 manifest and `SHA256SUMS.txt` (optionally GPG-signed). There is
  no package signature.

GitHub account compromise of a maintainer with release rights is the residual risk
for unsigned builds: an attacker who can publish a release can publish a matching
manifest. Code signing (Windows/macOS) is what defends against that.

## Update behavior and recovery

- Nothing is contacted until a person selects **Check now** in Settings > Updates or
  turns on daily background checks (off by default). Background checks run at most
  every 24 hours and only download and verify; installing always waits for a person.
- `WEFT_DISABLE_UPDATES=1` (any value except empty/`0`/`false`/`no`/`off`) is a
  kill switch: no update requests, no installs. Running from source never has an
  update transport, so tests and development runs generate no update traffic.
- After installing, the new version must pass a health check (GUI loaded, local API
  listening, workspace store open) within its first two launches. A version that does
  not is marked failed: AppImage restores the retained previous file automatically;
  Windows offers the retained previous installer; macOS and `.deb` show manual
  guidance. A failed version is not re-staged by background checks.
- Manual recovery anywhere: download the previous release from
  <https://github.com/jxburros/Weft/releases>, verify it with `SHA256SUMS.txt`
  (`sha256sum -c` / `Get-FileHash`), and install it over the current version.
  Workspace data in the `weft` profile folder is kept by installs, upgrades and
  uninstalls unless the person explicitly chooses removal in the Windows uninstaller.

## Validation status

| Item | Status |
| --- | --- |
| Updater policy (prerelease/downgrade refusal, size/SHA-512 mismatch, tampered manifest, redirect host/repository limits, kill switch, offline, rollback state machine, background cadence) | Unit-tested with fixtures, no network (`test/updater.test.js`) |
| Electron network transport (redirect surfacing, streaming, no cookies) | Real Electron against a loopback fixture (`test/update-transport.test.js`) |
| Linux AppImage and `.deb` packaging; generated `latest-linux.yml` parsed by the app's parser | Built locally with electron-builder 26.15.3; packaged AppImage smoke-tested under Xvfb |
| Windows NSIS scripts (custom pages, uninstall data choice, branded bitmaps) | Both installer and uninstaller scripts compiled with makensis 3.0.4.1 on Linux; generated `latest.yml` parsed |
| Windows installer (silent per-user install, uninstall registry entry, Start menu and desktop shortcuts, launch of the installed app, reinstall over an existing copy, silent uninstall keeping workspace data and removing the update cache) | Checked on every PR and release by `scripts/release/windows-install-check.ps1` on GitHub's `windows-latest` runner. **Not yet confirmed passing**: added 2026-10-18 and its first CI run is pending. The interactive pages (welcome, install folder, uninstall data choice and its confirmation) are not exercised by a silent run |
| macOS dmg/zip, signing, notarization, Gatekeeper | **Not yet verified** (requires macOS runner and Apple credentials) |
| Install, upgrade across real versions, uninstall data preservation, real rollback on each OS | **Not yet verified** on real machines |
