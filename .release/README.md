# Release integration

The workflow and toolkit checkout are pinned to infrastructure commit `e219396d4dcab9a14c9d7ee1730320fc94006dcc`. Keep those pins equal when upgrading. The local build/package/signing steps remain responsible for application-specific smoke tests and existing updater signatures. The shared final stage runs only pinned toolkit code with repository write permissions.

`release.json` is authoritative; `.release/config.json` lists embedded version fields, app scopes, required platform deliverables, bounded package variants, release notes, checksum naming, and the executable security profile. Exact required assets must all exist. Any optional filename rule has explicit bounds and does not exempt a required platform.

The initial migration uses the shared **standard** inventory profile while retaining existing app/updater/OS signing checks. The optional strict Ed25519 inventory is implemented in the shared engine but has not been provisioned here; this migration does not claim strict inventory signing. To elevate it, check in a reviewed per-app PEM public key, set security/publicKey in the config, provision its matching environment secret, and validate a signed dry run. Do not generate or replace updater trust roots as a shortcut.

Before a live release, verify actual environment reviewers/branch restrictions, required checks, signing secrets, registry publisher identities, and native package/install/update smoke results. Names in YAML do not prove these settings exist. This GitHub connection cannot read or administer secrets or repository environment protections. Keep release/signing runners disposable and separate from persistent QA runners.

Existing checksum filenames and the primary stable latest-release alias are retained explicitly for installed clients. Auxiliary app releases never take over that alias. Where existing detached GPG checksum signatures are enabled, the shared publisher validates the final coverage and preserves the signed bytes. Required updater signatures remain fail-closed.

To bump locally, obtain the pinned toolkit at `.toolkit`, run `node .toolkit/src/release.mjs bump --app APP_ID`, regenerate any application-specific resources/generated bundles, update the version-specific notes file, and run the repository's checks. All meaningful main changes require at least one advance; shared source/workflow changes require every affected app to advance.

Validation for this migration: shared engine syntax/test suite and workflow lint; manifest/embedded-version validation is run against the prepared changes. Hosted/native consumer release dry runs and actual publication have not been performed from these unmerged branches. No release/tag was created by this migration.

Hosted validation note (2026-10-20): GitHub reported that an Actions budget prevented some jobs from starting. Other repositories also reported dependency advisories in unchanged dependency graphs. These gates remain enforced; the migration does not claim an end-to-end native release where those checks are blocked.
