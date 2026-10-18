"""Build Weft's interface graphics with Vixl.

    python scripts/graphics/build.py            # everything
    python scripts/graphics/build.py icons      # one part: logo, installer, icons, illustrations, motion, sheets

Needs a Python with Vixl 0.27 or later importable (`pip install <Vixl checkout>`); the
`vixl` command must be on PATH for the motion exports. Afterwards run
`node scripts/generate-icons.js` to refresh `src/icons.js`. The SVG exports carry their
editable Vixl document, so `vixl import` on any of them gives back the layers.
"""

import shutil
import subprocess
import sys
from pathlib import Path

from vixl import Project

sys.path.insert(0, str(Path(__file__).parent))
from icons import ICONS, INK, STATES  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "graphics"


def svg(project, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    project.export(str(target), overwrite=True, svg_policy="strict")


def glyph(size, operations):
    project = Project(size, size, background="transparent")
    project.apply(operations)
    return project


def build_icons():
    for name, operations in ICONS.items():
        svg(glyph(24, operations), OUT / "icons" / f"{name}.svg")
    for name, operations in STATES.items():
        svg(glyph(12, operations), OUT / "states" / f"{name}.svg")


def build_illustrations():
    from illustrations import ILLUSTRATIONS, SIZE
    for name, operations in ILLUSTRATIONS.items():
        project = Project(*SIZE, background="transparent")
        project.apply(operations)
        svg(project, OUT / "illustrations" / f"{name}.svg")


def build_motion():
    from motion import ANIMATIONS
    vixl = shutil.which("vixl")
    if not vixl:
        raise SystemExit("motion exports need the vixl command on PATH")
    for name, (make, exports) in ANIMATIONS.items():
        for theme, palette in (("light", "light"), ("dark", "dark")):
            project = make(palette)
            source = OUT / "source" / f"{name}-{theme}.vixl"
            source.parent.mkdir(parents=True, exist_ok=True)
            project.save(str(source), overwrite=True)
            target = OUT / "motion" / f"{name}-{theme}.webp"
            target.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([vixl, "-p", str(source), "export-timeline", "--out", str(target), "--format", "webp",
                            "--quality", "92", "--overwrite", *exports], check=True, stdout=subprocess.DEVNULL)
            # Reduced motion shows the resting pose, which is the last frame.
            svg(project, OUT / "motion" / f"{name}-{theme}-still.svg")


def build_logo():
    """The small-size optical app icon: SVG, the 16/24/32 px PNGs favicon.ico uses, and the Vixl masters."""
    from logo_optical import OPTICAL, PALETTES, SIZES, operations
    logo = ROOT / "assets" / "logo"
    for palette in PALETTES:
        project = glyph(OPTICAL["tile"], operations(palette))
        project.save(str(logo / "source" / f"app-icon-{palette}-small.vixl"), overwrite=True)
        svg(project, logo / "optical" / f"app-icon-{palette}-small.svg")
        for size in SIZES:
            project.export(str(logo / "optical" / f"app-icon-{palette}-small-{size}.png"), overwrite=True,
                           scale=size / OPTICAL["tile"], alpha="keep")


def build_installer():
    """Windows installer bitmaps as PNG; scripts/generate-installer-art.js encodes them as BMP."""
    from installer import BITMAPS
    for name, (width, height, background, draw) in BITMAPS.items():
        project = Project(width, height, background=background)
        draw(project)
        project.save(str(ROOT / "packaging" / "source" / f"{name}.vixl"), overwrite=True)
        project.export(str(ROOT / "packaging" / "source" / f"{name}.png"), overwrite=True, alpha="keep")


def build_sheets():
    """Contact sheets for review: every icon and state marker at 1x and 2x, light and dark."""
    names = list(ICONS)
    columns, cell = 12, 56
    rows = -(-len(names) // columns)
    for theme, background, ink in (("light", "#fcfaf6", INK), ("dark", "#2e2b31", "#f3eee7")):
        sheet = Project(columns * cell, rows * cell + 48, background=background)
        operations = []
        for index, name in enumerate(names):
            x, y = (index % columns) * cell + 16, (index // columns) * cell + 8
            for layer, operation in enumerate(ICONS[name]):
                operations.append(recolor(offset(operation, x, y), ink, f"{name}-{layer}"))
            operations.append({"type": "text", "name": f"{name}-label", "text": name, "x": x - 8, "y": y + 28,
                               "size": 9, "color": ink})
        for index, name in enumerate(STATES):
            x, y = index * cell + 22, rows * cell + 12
            for layer, operation in enumerate(STATES[name]):
                operations.append(recolor(offset(operation, x, y), ink, f"state-{name}-{layer}"))
        sheet.apply(operations)
        target = ROOT / "artifacts" / f"icons-{theme}.png"
        sheet.export(str(target), overwrite=True, scale=2)


def build_illustration_sheets():
    import json
    from illustrations import ILLUSTRATIONS, SIZE, TOKENS
    themes = json.loads((ROOT / "assets" / "tokens.json").read_text())["themes"]
    names = list(ILLUSTRATIONS)
    columns, (w, h) = 5, SIZE
    rows = -(-len(names) // columns)
    for theme in ("light", "dark"):
        swap = {value: themes[theme][token] for token, value in TOKENS.items()}
        sheet = Project(columns * (w + 16), rows * (h + 16), background=themes[theme]["white"])
        operations = []
        for index, name in enumerate(names):
            x, y = (index % columns) * (w + 16) + 8, (index // columns) * (h + 16) + 8
            for layer, operation in enumerate(ILLUSTRATIONS[name]):
                moved = offset(operation, x, y)
                operations.append({**{k: swap.get(v, v) if isinstance(v, str) else v for k, v in moved.items()},
                                   "name": f"{name}-{layer}"})
        sheet.apply(operations)
        sheet.export(str(ROOT / "artifacts" / f"illustrations-{theme}.png"), overwrite=True, scale=2)


def offset(operation, dx, dy):
    moved = dict(operation)
    if moved.get("shape") == "path":
        moved["x"], moved["y"] = dx, dy
    else:
        moved["x"], moved["y"] = moved.get("x", 0) + dx, moved.get("y", 0) + dy
    return moved


def recolor(operation, ink, name):
    changed = {key: (ink if value == INK else value) for key, value in operation.items()}
    changed["name"] = name
    return changed


def build_all_sheets():
    build_sheets()
    build_illustration_sheets()


PARTS = {"logo": build_logo, "installer": build_installer, "icons": build_icons, "illustrations": build_illustrations, "motion": build_motion, "sheets": build_all_sheets}

if __name__ == "__main__":
    for part in sys.argv[1:] or PARTS:
        PARTS[part]()
