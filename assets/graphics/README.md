# Weft interface graphics

Every icon, illustration and animation in the Weft interface is drawn with
[Vixl](https://github.com/jxburros/Vixl), in the style of the
[visual style guide](../../Weft-Visual-Style-Guide.md) and the token palette in
[`assets/tokens.json`](../tokens.json). The design notes are in
[DESIGN-SYSTEM.md](../../docs/DESIGN-SYSTEM.md#icons-illustrations-and-animation-vixl).

| Folder | Contents | Used by |
| --- | --- | --- |
| `icons/` | 41 interface icons, 24 × 24 SVG | `icon()` in `src/icons.js` |
| `states/` | 9 agent and ownership state markers, 12 × 12 SVG | `stateMarker()` in `src/icons.js` |
| `illustrations/` | 14 empty-state illustrations, 120 × 90 SVG | `illustration()` in `src/icons.js` |
| `motion/` | `mark-in` and `waiting-dots`, animated WebP per theme, plus an SVG still for reduced motion | `motionArt()` in `src/gui.js` |
| `source/` | Vixl masters of the animations (`.vixl`) | |

Each SVG is a Vixl export and carries its editable document: `vixl import` gives back the layers.
The drawings themselves are defined in `scripts/graphics/` (`icons.py`, `illustrations.py`,
`motion.py`); the same build draws the optical favicon variant (`logo_optical.py`, into
`assets/logo/`) and the Windows installer art (`installer.py`, into `packaging/source/`).

## Rebuild

With a Python that can import Vixl 0.27 or later and the `vixl` command on `PATH`:

```sh
python scripts/graphics/build.py              # every part; or name parts: logo installer icons illustrations motion sheets
node scripts/generate-icons.js                # src/icons.js from icons/, states/ and illustrations/
node scripts/generate-installer-art.js        # packaging/*.bmp from packaging/source/*.png
npm run logo:validate -- --write              # re-measure the optical variant and rebuild favicon.ico (Electron)
```

`sheets` writes review contact sheets to `artifacts/` (`icons-*.png`, `illustrations-*.png`).
`test/graphics.test.js`, `test/logo.test.js` and `test/release.test.js` fail when a generated
file drifts from its Vixl export. Colours outside the light token palette are an error in the
generator: illustrations are painted through token classes so they follow the dark theme.
