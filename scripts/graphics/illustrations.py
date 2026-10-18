"""Spot illustrations for Weft's empty states, drawn as Vixl documents.

Each is a 120 x 90 scene: a warm patch, two crossing threads (the one woven detail the style
guide allows in empty states, section 6) and a simple object in the workspace's colours.
Colours are the light theme's token values; the generator turns each into a class painted
with that token, so the same drawing follows the dark theme. Keys are the icon names the
empty states already use.
"""

SIZE = (120, 90)

TOKENS = {"canvas": "#f4f1ea", "white": "#fffefa", "muted": "#68616a", "border": "#e2ddd5", "brand": "#70516f",
          "brand-soft": "#ece5ed", "sage": "#526d58", "sage-soft": "#e7ece4", "clay": "#9c543d",
          "clay-soft": "#f5e7dd"}
T = TOKENS
LINE = 1.6


def stroke(d, color=T["muted"], width=LINE, **extra):
    return {"type": "shape", "shape": "path", "path": d, "stroke": color, "stroke_width": width, "line_cap": "round",
            "fill": "none", **extra}


def solid(d, color, line=None, width=LINE, **extra):
    layer = {"type": "shape", "shape": "path", "path": d, "fill": color, **extra}
    if line:
        layer.update(stroke=line, stroke_width=width, line_cap="round")
    return layer


def card(x, y, w, h, fill=T["white"], line=T["muted"], r=4, **extra):
    """A rounded card whose stroke is centred on the given box, like the paths around it."""
    half = LINE / 2
    layer = {"type": "shape", "shape": "rounded-rectangle", "x": x - half, "y": y - half, "width": w + LINE,
             "height": h + LINE, "radius": r + half, "fill": fill, **extra}
    if line:
        layer.update(stroke=line, stroke_width=LINE, line_cap="round")
    return layer


def disc(cx, cy, r, fill, line=None, width=LINE):
    layer = {"type": "shape", "shape": "ellipse", "x": cx - r, "y": cy - r, "width": 2 * r, "height": 2 * r,
             "fill": fill}
    if line:
        layer.update(stroke=line, stroke_width=width, line_cap="round")
    return layer


def scene(*objects, threads=(T["sage"], T["clay"])):
    """The shared backdrop: a warm patch with two threads crossing behind the object."""
    under, over = threads
    return [
        solid("M22 18C38 6 82 4 98 16 112 27 114 62 100 74 84 87 36 88 20 75 6 63 7 29 22 18Z", T["canvas"]),
        stroke("M4 64C30 40 58 76 84 54 96 44 104 40 116 42", under, 1.4, opacity=0.55),
        stroke("M6 30C30 34 46 62 74 58 92 55 104 64 114 76", over, 1.4, opacity=0.45),
        *objects,
    ]


ILLUSTRATIONS = {
    "folder": scene(
        card(46, 18, 32, 38, r=3),
        stroke("M53 28h18"), stroke("M53 34h14"),
        solid("M33 39a3 3 0 0 1 3-3h13l4 5h31a3 3 0 0 1 3 3v24a3 3 0 0 1-3 3H36a3 3 0 0 1-3-3Z", T["brand-soft"],
              T["brand"]),
        stroke("M33 47h54", T["brand"]),
    ),
    "context": scene(
        solid("M60 22 88 36 60 50 32 36Z", T["brand-soft"], T["brand"]),
        stroke("M32 46 60 60 88 46", T["sage"]),
        stroke("M32 56 60 70 88 56", T["clay"]),
    ),
    "tasks": scene(
        card(36, 16, 48, 58),
        stroke("M43 30l3 3 5-6", T["sage"], 1.8), stroke("M57 30h20"),
        disc(47, 45, 3.2, T["brand"]), stroke("M57 45h16"),
        disc(47, 60, 3.2, "none", T["muted"], 1.4), stroke("M57 60h18"),
    ),
    "chat": scene(
        solid("M34 24h34a5 5 0 0 1 5 5v18a5 5 0 0 1-5 5H48l-8 7v-7h-6a5 5 0 0 1-5-5V29a5 5 0 0 1 5-5Z",
              T["white"], T["muted"]),
        stroke("M38 34h24"), stroke("M38 41h16"),
        solid("M58 44h28a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5h-3v6l-7-6H58a5 5 0 0 1-5-5V49a5 5 0 0 1 5-5Z",
              T["brand-soft"], T["brand"]),
        stroke("M61 53h22", T["brand"]), stroke("M61 59h14", T["brand"]),
    ),
    "workflow": scene(
        card(30, 22, 18, 16, T["brand-soft"], T["brand"], 3),
        card(72, 22, 18, 16, T["sage-soft"], T["sage"], 3),
        card(51, 54, 18, 16, T["clay-soft"], T["clay"], 3),
        stroke("M48 30h24"), stroke("M39 38v6a6 6 0 0 0 6 6h6v6"), stroke("M81 38v6a6 6 0 0 1-6 6h-6"),
    ),
    "artifacts": scene(
        card(36, 22, 40, 48, rotation=-8),
        card(46, 18, 40, 50),
        card(50, 22, 32, 24, T["sage-soft"], None, 2),
        stroke("M51 44l9-9 7 7 4-4 10 10", T["sage"]),
        disc(73, 29, 3, T["clay"]),
        stroke("M51 54h26"), stroke("M51 60h18"),
    ),
    "clock": scene(
        disc(60, 45, 23, T["white"], T["muted"]),
        stroke("M60 30v15l9 6", T["brand"], 2),
        disc(60, 45, 2.4, T["brand"]),
        stroke("M60 24.5v2"), stroke("M80.5 45h-2"), stroke("M60 65.5v-2"), stroke("M39.5 45h2"),
    ),
    "bookmark": scene(
        card(40, 16, 42, 58),
        solid("M64 16h12v24l-6-4.5-6 4.5Z", T["brand"]),
        stroke("M47 48h28"), stroke("M47 55h22"), stroke("M47 62h25"),
    ),
    "activity": scene(
        card(34, 18, 54, 56),
        stroke("M45 33v8"), stroke("M45 51v8"),
        disc(45, 28, 3.5, T["brand"]), stroke("M54 28h24", T["brand"]),
        disc(45, 46, 3.5, T["sage"]), stroke("M54 46h18", T["sage"]),
        disc(45, 64, 3.5, T["clay"]), stroke("M54 64h21", T["clay"]),
    ),
    "lock": scene(
        stroke("M50 41v-8a10 10 0 0 1 20 0v8", T["brand"], 2.2),
        card(42, 41, 36, 30, T["brand-soft"], T["brand"], 6),
        disc(60, 53, 3.4, T["brand"]),
        stroke("M60 55v7", T["brand"], 2.4),
    ),
    "shield": scene(
        solid("M60 17 39 25v16c0 14 9 23 21 29 12-6 21-15 21-29V25Z", T["sage-soft"], T["sage"]),
        stroke("M50 43l7 7 13-14", T["sage"], 2.2),
    ),
    "download": scene(
        solid("M36 54h12l4 6h16l4-6h12v12a4 4 0 0 1-4 4H40a4 4 0 0 1-4-4Z", T["white"], T["muted"]),
        stroke("M60 18v30", T["brand"], 2.2), stroke("M50 39l10 10 10-10", T["brand"], 2.2),
    ),
    "tabs": scene(
        card(30, 36, 40, 30, T["sage-soft"], T["sage"]),
        card(40, 28, 40, 30, T["clay-soft"], T["clay"]),
        card(50, 20, 40, 30),
        stroke("M57 30h20", T["brand"]), stroke("M57 37h14"),
    ),
    "search": scene(
        disc(55, 41, 17, T["white"], T["muted"]),
        stroke("M48 35a9 9 0 0 1 9-4", T["brand"]),
        stroke("M67.5 53.5 81 67", T["muted"], 3.2),
    ),
}
