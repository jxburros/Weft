# Changelog

Entries describe implemented changes and verification limits. Product direction
alone is not a shipped capability.

## 2026-10-17 — Agent

### Changed

- Hardened JSON storage with ownership locks, verified writes, migrations,
  secret guards, export residue review and sync-conflict warnings.
- Unified outcomes/errors and compact MCP tools; added scoped client credentials,
  shared emergency stop, pinned targets and serialized browser input.
- Added provider disclosure/manifests, untrusted-content framing and error-key
  redaction; offline pinned community lists with verified rollback.
- Centralized design tokens, improved keyboard/dialog behavior, added reviewed
  light/dark GUI goldens and real Chromium/cross-platform Node CI.
- Added packaging with electron-builder 26.15.3 (build-time dev dependency):
  Windows assisted per-user NSIS installer with generated brand bitmaps and Weft
  text, data-preserving upgrades and opt-in confirmed data removal on uninstall;
  macOS dmg/zip; Linux AppImage/deb. Packaged builds keep the `weft` profile folder.
- Added a stable-only verified updater (`update.status`, human-only `update.check`,
  `update.install`, `update.rollback`, `update.configure`) and a Settings > Updates
  center: fixed GitHub source, size/SHA-512 verification, prerelease/downgrade
  refusal, opt-in daily staging-only checks, health check with rollback and the
  `WEFT_DISABLE_UPDATES` kill switch. No update traffic occurs unless a person
  checks or opts in.
- Added a tag-gated release workflow (version/changelog gate, signing when secrets
  exist, packaged smoke tests, SHA256SUMS, draft-then-publish), a CI Linux package
  smoke job, Dependabot, ADR-004 and `docs/RELEASING.md` (platforms, support policy,
  Electron/Chromium cadence, trust roots, security gates). Releases need a
  `## vX.Y.Z — date` changelog section.

- Added canonical agent guidance, a generated skill reference, and a local MCP
  client plugin manifest/configuration. Guidance is available as `guide.get`
  through the shared catalog.
- Added offline documentation schema checks, three MCP reference task evals
  with baseline deltas, and separate store/search/catalog performance budgets.
- Added canonical contributor instructions, a thin Claude overlay, product
  identity and architecture decisions for encryption, extensions/plugins and
  current local-only collaboration/deployment scope.

### Not completed

- See [all 67 issue dispositions](docs/ISSUE-STATUS.md) for the 26 completed
  scopes and 41 broader/partial items left open.

- Workspace encryption, key lifecycle/recovery, extension compatibility testing,
  native plugin isolation/permissions and plugin loading remain unimplemented.
- Hosted sync, concurrent collaboration and remote deployment are deferred.
- Live-model evals, actual plugin installation in a Claude client and GUI
  first-render performance measurements have not been verified.
- Installers are unsigned (no signing/notarization credentials). The Windows
  installer was compiled but not built runnable or run; macOS packages, the
  release workflow on GitHub and real updates between published versions have not
  been exercised. Automatic rollback is AppImage-only.

### Notes

Validation: Linux Chromium/GUI/golden checks, transport/security regressions and
syntax checks passed locally; CI additionally verifies Node 22/24 on Windows,
macOS and Linux. Offline MCP reference scenarios passed (3/3); performance budgets
passed for 10k materials and 1k captures. Integrated documentation, grouped MCP eval and performance checks passed
(6 tests, no skips; 11 documented command examples). These checks do not
establish cross-platform hardware/account support.
