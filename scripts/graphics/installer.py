"""Windows installer bitmaps (NSIS Modern UI), drawn with Vixl.

The sidebar (164 x 314) shows the stacked logo above a restrained weave: alternating plum and
sage weft threads over warp lines, faint enough to stay decorative, and two accent bars at the
foot whose order tells the installer and uninstaller apart. The header (150 x 57) is the
horizontal logo on white. Vixl exports PNG; `node scripts/generate-installer-art.js` encodes
them as the 24-bit BMPs NSIS expects.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOGO = ROOT / "assets" / "logo" / "png"
CANVAS, BRAND, BORDER, SAGE = "#f4f1ea", "#70516f", "#e2ddd5", "#718676"


def rect(name, x, y, width, height, color, opacity=1.0):
    return {"type": "shape", "shape": "rectangle", "name": name, "x": x, "y": y, "width": width, "height": height,
            "fill": color, "opacity": round(opacity, 4)}


def weave(width, top, bottom):
    operations = [rect(f"warp-{x}", x, top, 1, bottom - top, BORDER, 0.7) for x in range(6, width, 12)]
    for row, y in enumerate(range(top, bottom, 8)):
        color = SAGE if row % 2 else BRAND
        opacity = 0.18 + 0.5 * ((y - top) / (bottom - top)) ** 2
        operations += [rect(f"weft-{row}-{x}", x, y, 7, 2, color, opacity) for x in range(0 if row % 2 else 6, width, 12)]
    return operations


def logo(project, file, width, x, y):
    project.import_image(str(LOGO / file), name="logo")
    layer = project.layer("logo")
    height = round(layer["height"] * width / layer["width"])
    project.apply([{"type": "resize", "target": "logo", "width": width, "height": height},
                   {"type": "move", "target": "logo", "x": x, "y": y}])


def sidebar(project, accent_first):
    project.apply(weave(164, 196, 300))
    logo(project, "stacked-full-color-256w@2x.png", 92, 36, 44)
    first, second = (BRAND, SAGE) if accent_first else (SAGE, BRAND)
    project.apply([rect("accent-1", 0, 306, 110, 8, first), rect("accent-2", 110, 306, 54, 8, second)])


def header(project):
    logo(project, "horizontal-full-color-256w@2x.png", 112, 30, (57 - round(241 * 112 / 512)) // 2)


# name: (width, height, background, draw)
BITMAPS = {
    "installer-sidebar": (164, 314, CANVAS, lambda p: sidebar(p, True)),
    "uninstaller-sidebar": (164, 314, CANVAS, lambda p: sidebar(p, False)),
    "installer-header": (150, 57, "#ffffff", header),
}
