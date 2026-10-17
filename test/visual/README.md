# GUI visual regression tests

Run on Linux with the pinned Electron from the lockfile:

```sh
WEFT_VISUAL=1 xvfb-run -a node --test test/visual.test.js
```

The harness loads the real GUI/CSS and preload in Electron with deterministic
local IPC fixtures, bundled Source Sans 3 fonts, UTC, a fixed window, and device
scale 1. No provider or external network is used. The ten committed goldens cover
empty workspace, populated materials/sidebar, Ask Weft, settings, and restricted
destination in both themes. This tests browser-owned chrome, not page rendering.

Color-channel differences up to 12 are ignored. At most 0.3% of pixels may differ;
a failing capture is retried once after settling. Larger differences write
reference, actual, and magenta diff PNGs under `_failures/`. CI retains that folder.
Missing references fail rather than auto-creating a baseline. Keep Linux distro,
Electron, and fonts consistent; a platform upgrade may require reviewed changes.

To update after an intentional visual change:

```sh
WEFT_VISUAL=1 WEFT_UPDATE_GOLDEN=1 xvfb-run -a node --test test/visual.test.js
git diff --stat -- test/visual/golden
```

Review the resulting PNGs alongside the style guide, then rerun without
`WEFT_UPDATE_GOLDEN` and commit the reviewed references with the change. Never
update goldens to silence an unexplained failure. The initial references were
captured and inspected on Linux using Electron 44.9.0. Cross-platform screen-reader
and brand acceptance are separate outstanding work (see `docs/DESIGN-SYSTEM.md`).
