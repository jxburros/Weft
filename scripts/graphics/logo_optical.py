"""Small-size optical variant of the Weft app icon (#36), drawn with Vixl.

It keeps the supplied mark's geometry: the same two band centrelines (the "under" V on the
left, the "over" V on the right, crossing once) in the same place on the same rounded tile.
Only the parts that disappear at favicon sizes change: the bands are thicker, the mark fills
more of the tile and the over-under cut is wide enough to survive rasterisation at 16-32 px
(`npm run logo:validate` measures this). Edit the numbers here, run
`python scripts/graphics/build.py logo`, then `npm run logo:validate -- --write`.
"""

OPTICAL = {"band_px": 1.75, "gap_px": 1.25, "mark_scale": 1.25, "tile": 16}
# Band centrelines of the supplied mark, in its 512-unit drawing (from assets/logo/svg/mark-full-color.svg).
UNDER = [(92, 155), (190, 417), (313, 89)]
OVER = [(199, 89), (322, 417), (420, 155)]
# Placement of the mark on the 1024-unit app-icon tile (from assets/logo/icons/app-icon-light.svg).
PLACE = {"scale": 1.45, "x": 140.8, "y": 130.65, "radius": 224}
PALETTES = {
    "light": {"tile": "#F4F1EA", "over": "#70516F", "under": "#718676"},
    "dark": {"tile": "#27252B", "over": "#CDA9CB", "under": "#A3B8A8"},
    "plum": {"tile": "#70516F", "over": "#F4F1EA", "under": "#C9D3CB"},
}
SIZES = (16, 24, 32)


def to_tile(point, size, mark_scale):
    """A mark point on the tile; mark_scale enlarges the mark about the tile centre (small tiles have less margin)."""
    x, y = ((PLACE["x"] + PLACE["scale"] * point[0]) / 1024, (PLACE["y"] + PLACE["scale"] * point[1]) / 1024)
    return tuple(round((0.5 + (v - 0.5) * mark_scale) * size, 3) for v in (x, y))


def polyline(points):
    tile, scale = OPTICAL["tile"], OPTICAL["mark_scale"]
    placed = [to_tile(point, tile, scale) for point in points]
    return "M" + " L".join(f"{x:g} {y:g}" for x, y in placed)


def operations(palette):
    colors = PALETTES[palette]
    tile, band, gap = OPTICAL["tile"], OPTICAL["band_px"], OPTICAL["gap_px"]
    band_line = {"type": "shape", "shape": "path", "fill": "none", "line_cap": "butt", "line_join": "round"}
    return [
        {"type": "shape", "shape": "rounded-rectangle", "name": "tile", "width": tile, "height": tile,
         "radius": round(PLACE["radius"] / 1024 * tile, 3), "fill": colors["tile"]},
        {**band_line, "name": "under", "path": polyline(UNDER), "stroke": colors["under"], "stroke_width": band},
        # The over-under cut: a tile-coloured band, wider than the over band, separates the crossing.
        {**band_line, "name": "cut", "path": polyline(OVER[:2]), "stroke": colors["tile"],
         "stroke_width": band + 2 * gap},
        {**band_line, "name": "over", "path": polyline(OVER), "stroke": colors["over"], "stroke_width": band},
    ]
