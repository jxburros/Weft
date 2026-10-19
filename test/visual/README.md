# GUI visual regression tests

Run on Linux with the pinned Electron from the lockfile:

```sh
WEFT_VISUAL=1 xvfb-run -a node --test test/visual.test.js
```

The harness loads the real GUI/CSS and preload in Electron with deterministic
local IPC fixtures, bundled Source Sans 3 fonts, UTC, and device scale 1. The
window menu is removed before setting a 1200 × 800 content viewport; captures
wait for those exact renderer dimensions. This avoids distro-dependent menu
heights changing the screenshot size. Captures reset transient status and move
the pointer off controls. No provider or external network is used. The twelve
committed goldens cover
empty workspace, populated materials with the sidebar icon grid, Ask Weft, settings, agent connections, and restricted
destination in both themes. The harness also drives the Update Center with
fixture update states (no captures). This tests browser-owned chrome, not page rendering.

Glyph rasterisation follows fontconfig even for the bundled web fonts, so the
harness writes its own `fonts.conf` (passed as `FONTCONFIG_FILE`): it includes the
system configuration and then pins the stock Ubuntu result (slight hinting,
greyscale antialiasing, no subpixel order, DejaVu Sans first for sans-serif
fallback glyphs). Without it, a machine-local override such as a forced
unhinted/greyscale rule or a preferred UI font (for example Inter) shifts text
edges by roughly 0.85% of pixels even on unchanged code. With the pin, the
references captured on a stock CI image reproduce on such machines.

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
captured and inspected on Linux using Electron 44.9.0. They were regenerated and
reviewed for the accessibility and design-system pass (#31, #36: 11 px type floor,
consolidated spacing/radius scales, disabled-state treatment, trusted stop-page
band, landmark and heading fixes) with the pinned font configuration above.
Since 1.1.2 the harness forces `prefers-reduced-motion`, so goldens show the
resting frame of each animation; they were regenerated for the 1.2 sidebar icon
grid and again for the 1.3 Ask Weft, connections and Settings changes.
Cross-platform screen-reader
and brand acceptance are separate outstanding work (see `docs/DESIGN-SYSTEM.md`).
