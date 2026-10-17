# Weft logo

The mark is two interlocking bands forming a W, with one over-under crossing. It follows section 8 of the
[Visual Style Guide](../../Weft-Visual-Style-Guide.md) (interlocking bands concept). It is a proposal until a final logo is chosen.

| Colour | Hex |
| --- | --- |
| Weft plum (front band, wordmark) | `#70516F` |
| Muted sage (back band) | `#718676` |
| Warm ivory (light tile) | `#F4F1EA` |
| Charcoal (dark tile) | `#27252B` |
| Orchid / light sage (on dark) | `#CDA9CB` / `#A3B8A8` |

Wordmark: Source Sans 3 SemiBold, outlined to vector paths in the SVG and PDF files, so no font is needed to use them.

## Folders

- `svg/`, `pdf/`, `png/`: `mark`, `horizontal` and `stacked` lockups, each as `full-color`, `mono-black`, `mono-white`,
  `on-light` and `on-dark`. PNGs are at 256 and 1024 px wide, at 1x, 2x and 3x. PDFs come in RGB and `-cmyk`.
- `dark/`: the mark and horizontal lockup recoloured for dark backgrounds (orchid and light sage), transparent.
- `icons/`: app-icon tiles (light, dark, plum) as SVG and PNG, `favicon.ico`, `apple-touch-icon.png`.
- `social/`: `avatar.png` (800 x 800) and `og-image.png` (1200 x 630).
- `source/`: editable [Vixl](https://github.com/jxburros/Vixl) documents. `weft-logo-master.vixl` is the master; edit it and
  re-export rather than editing the exports.

## Notes

- Check small sizes before shipping: the mark holds at 16 px, but a simplified optical variant may still help.
- The `on-dark` variants from the package keep the plum and sage and have only about 3:1 contrast on near-black;
  prefer `dark/` on dark surfaces.
- Contrast of the palette has not been validated against accessibility targets.
