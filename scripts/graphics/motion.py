"""Weft's identity animations, made with Vixl timelines.

Motion explains a state or marks a rare identity moment (style guide 11); none of it
loops behind content. Each animation is built for the light and the dark theme and
exported as animated WebP; the GUI shows a still under reduced motion.

- `mark-in`: the mark's two bands slide in from opposite sides and interlock, once, on the
  workspace overview. Its last frame is the logo itself.
- `waiting-dots`: three small knots crossing a thread in turn, beside "Waiting for your model".
  Local and small, like the working marker.
"""

from pathlib import Path

from vixl import Project

ROOT = Path(__file__).resolve().parents[2]
LOGO = ROOT / "assets" / "logo" / "source"

# The light and dark colours of the tokens these animations use (assets/tokens.json).
PALETTES = {
    "light": {"thread": "#e2ddd5", "brand": "#70516f", "sage": "#526d58", "clay": "#9c543d"},
    "dark": {"thread": "#464049", "brand": "#cda9cb", "sage": "#b2c6af", "clay": "#e4a88f"},
}


# The logo masters name their bands differently: (file, under band, over band).
MARKS = {"light": ("mark-full-color.vixl", "under-cut", "over-band"), "dark": ("mark-dark.vixl", "u-cut", "o")}


def mark_in(theme):
    source, under, over = MARKS[theme]
    project = Project.load(str(LOGO / source))
    project.apply([
        {"type": "timeline-set", "duration": 1100, "fps": 30, "loop": 1},
        {"type": "animate", "target": under, "property": "translate-y", "from": 70, "to": 0, "duration": 760,
         "easing": "ease-out"},
        {"type": "animate", "target": under, "property": "opacity", "from": 0, "to": 1, "duration": 420,
         "easing": "ease-out"},
        {"type": "animate", "target": over, "property": "translate-y", "from": -70, "to": 0, "start": 200,
         "duration": 760, "easing": "ease-out"},
        {"type": "animate", "target": over, "property": "opacity", "from": 0, "to": 1, "start": 200,
         "duration": 420, "easing": "ease-out"},
    ])
    return project


def waiting_dots(theme):
    colors = PALETTES[theme]
    project = Project(48, 16, background="transparent")
    knots = [("knot-1", 10, colors["brand"]), ("knot-2", 24, colors["sage"]), ("knot-3", 38, colors["clay"])]
    project.apply([
        {"type": "timeline-set", "duration": 1200, "fps": 30, "loop_mode": "seamless"},
        {"type": "shape", "shape": "path", "name": "thread", "path": "M2 8H46", "stroke": colors["thread"],
         "stroke_width": 1.5, "line_cap": "round", "fill": "none"},
        *({"type": "shape", "shape": "ellipse", "name": name, "x": x - 2.5, "y": 5.5, "width": 5, "height": 5,
           "fill": color} for name, x, color in knots),
        # A short piece of thread drawn over each knot shows only while the knot is below the line.
        *({"type": "shape", "shape": "path", "name": f"{name}-over", "path": f"M{x - 4} 8H{x + 4}",
           "stroke": colors["thread"], "stroke_width": 1.5, "line_cap": "round", "fill": "none"}
          for name, x, _ in knots),
        # Each knot rises over the thread and dips under it, a sixth of a cycle after the one before.
        *({"type": "keyframes", "target": name, "property": "translate-y",
           "sample": {"fn": "sin", "period": 1200, "amplitude": 3.5, "phase": -index / 6, "step_ms": 50,
                      "duration": 1200}} for index, (name, _, _) in enumerate(knots)),
        *({"type": "keyframes", "target": f"{name}-over", "property": "opacity",
           "sample": {"fn": "square", "period": 1200, "amplitude": 0.5, "offset": 0.5, "phase": -index / 6,
                      "step_ms": 50, "duration": 1200}} for index, (name, _, _) in enumerate(knots)),
    ])
    return project


# name: (builder, extra `vixl export-timeline` arguments)
ANIMATIONS = {
    "mark-in": (mark_in, ["--scale", "0.4", "--fps", "30"]),
    "waiting-dots": (waiting_dots, ["--scale", "2", "--fps", "30"]),
}
