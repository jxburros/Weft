"""Weft interface icons, drawn as Vixl documents.

Every icon is a 24 x 24 Vixl document of stroked shapes in charcoal (`INK`). The
generator (`scripts/generate-icons.js`) turns charcoal into `currentColor`, so an icon
takes the colour of the control it sits in. Strokes are 1.6 px with round caps and joins;
boxes have modest 2-3 px corners (style guide 6). State markers are 12 x 12 glyphs that
pair with the text of a state badge (style guide 10).
"""

INK = "#27252b"
WIDTH = 1.6
# Only line_cap is set, so Vixl writes native SVG strokes (round caps and joins) instead of outlines.
LINE = {"stroke": INK, "stroke_width": WIDTH, "line_cap": "round", "fill": "none"}


def path(d, **extra):
    return {"type": "shape", "shape": "path", "path": d, **LINE, **extra}


# Closed shapes stroke inside their box, so boxes and rings are given by their stroke's centre line and
# grown by half a stroke here: every icon is drawn on the same centre lines.
def box(x, y, w, h, r=2.5):
    half = WIDTH / 2
    return {"type": "shape", "shape": "rounded-rectangle", "x": x - half, "y": y - half, "width": w + WIDTH,
            "height": h + WIDTH, "radius": r + half, **LINE}


def ring(cx, cy, r):
    return oval(cx - r, cy - r, 2 * r, 2 * r)


def oval(x, y, w, h):
    half = WIDTH / 2
    return {"type": "shape", "shape": "ellipse", "x": x - half, "y": y - half, "width": w + WIDTH, "height": h + WIDTH,
            **LINE}


def dot(cx, cy, r):
    return {"type": "shape", "shape": "ellipse", "x": cx - r, "y": cy - r, "width": 2 * r, "height": 2 * r,
            "fill": INK}


ICONS = {
    "home": [path("M4 10.4 12 4l8 6.4V18.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z"),
             path("M10 20v-5.5h4V20")],
    "grid": [box(3.5, 3.5, 7, 7, 2), box(13.5, 3.5, 7, 7, 2), box(3.5, 13.5, 7, 7, 2), box(13.5, 13.5, 7, 7, 2)],
    "tabs": [box(3.5, 7.5, 13, 13), path("M7.5 3.5h10.5a2.5 2.5 0 0 1 2.5 2.5v10.5")],
    "folder": [path("M3.5 17.5v-11A2 2 0 0 1 5.5 4.5h3.7l2 2.5h7.3a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"),
               path("M3.5 10h17")],
    "context": [path("M12 3.5 20.5 8 12 12.5 3.5 8Z"), path("M3.5 12 12 16.5 20.5 12"),
                path("M3.5 16 12 20.5 20.5 16")],
    "tasks": [path("M3.5 6l1.6 1.6L8 4.8"), path("M3.5 12l1.6 1.6L8 10.8"), path("M3.5 18l1.6 1.6L8 16.8"),
              path("M11 6.2h9.5"), path("M11 12.2h9.5"), path("M11 18.2h9.5")],
    "chat": [path("M5.5 4h13a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17h-1A2.5 2.5 0 0 1 3 14.5v-8A2.5 2.5 0 0 1 5.5 4Z")],
    "artifacts": [box(3.5, 4.5, 17, 15), path("M3.8 16.2l4.7-4.7 4 4 2.5-2.5 5.2 5.2"), ring(15.5, 9, 1.5)],
    "activity": [path("M3 12h3.8l2.7-6.5 5 13 2.7-6.5H21")],
    "search": [ring(10.5, 10.5, 6.5), path("M15.4 15.4 20 20")],
    "plus": [path("M12 5v14"), path("M5 12h14")],
    "arrow": [path("M5 12h14"), path("M13.5 6.5 19 12l-5.5 5.5")],
    "back": [path("M19 12H5"), path("M10.5 6.5 5 12l5.5 5.5")],
    "chevron": [path("m9.5 5.5 6.5 6.5-6.5 6.5")],
    "reload": [path("M19.5 4.5v5h-5"), path("M19.3 9.5A8 8 0 1 0 19 16")],
    "stop": [box(6, 6, 12, 12, 2.5)],
    "shield": [path("M12 3.5 5 6.2v5.6c0 4.3 3 7.4 7 8.7 4-1.3 7-4.4 7-8.7V6.2Z"), path("M9 12.2l2.1 2.1 4-4.3")],
    "split": [box(3, 4.5, 18, 15), path("M12 4.5v15")],
    "more": [dot(5.5, 12, 1.4), dot(12, 12, 1.4), dot(18.5, 12, 1.4)],
    "spark": [path("M12 3.5C12.8 8.6 15.4 11.2 20.5 12 15.4 12.8 12.8 15.4 12 20.5 11.2 15.4 8.6 12.8 3.5 12 8.6 11.2 11.2 8.6 12 3.5Z")],
    "sidebar": [box(3, 4.5, 18, 15), path("M9.5 4.5v15"), path("M5.5 8.5h1.5"), path("M5.5 11.5h1.5")],
    "terminal": [box(3, 4.5, 18, 15), path("M7 9.5l2.8 2.5L7 14.5"), path("M12.5 14.5h4.5")],
    "settings": [path("M4 7.5h8.5"), path("M18.5 7.5H20"), path("M4 16.5h1.5"), path("M11.5 16.5H20"),
                 ring(15.5, 7.5, 2.5), ring(8.5, 16.5, 2.5)],
    "moon": [path("M19.5 14.6A8 8 0 0 1 9.4 4.5 8 8 0 1 0 19.5 14.6Z")],
    "sun": [ring(12, 12, 3.8), path("M12 2.8v1.7"), path("M12 19.5v1.7"), path("M2.8 12h1.7"), path("M19.5 12h1.7"),
            path("M5.5 5.5l1.2 1.2"), path("M17.3 17.3l1.2 1.2"), path("M5.5 18.5l1.2-1.2"), path("M17.3 6.7l1.2-1.2")],
    "download": [path("M12 4v10.5"), path("M7.5 10.5 12 15l4.5-4.5"), path("M4.5 16v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2")],
    "upload": [path("M12 15V4.5"), path("M7.5 9 12 4.5 16.5 9"), path("M4.5 16v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2")],
    "globe": [ring(12, 12, 8.5), path("M3.5 12h17"),
              oval(8.2, 3.5, 7.6, 17)],
    "bookmark": [path("M7.5 3.5h9a1.5 1.5 0 0 1 1.5 1.5v15.5l-6-4-6 4V5a1.5 1.5 0 0 1 1.5-1.5Z")],
    "clock": [ring(12, 12, 8.5), path("M12 7.5V12l3 2")],
    "check": [path("m5 12.5 4.2 4.2L19 7")],
    "close": [path("m6.5 6.5 11 11"), path("M6.5 17.5l11-11")],
    "note": [path("M18.5 14V6a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2H12.5Z"), path("M18.5 14h-4a2 2 0 0 0-2 2v4"),
             path("M8.5 8.5h6.5"), path("M8.5 11.5h4.5")],
    "pin": [path("M9 3.5h6"), path("M10 3.5v5.2l-3.3 3.6v1.9h10.6v-1.9L14 8.7V3.5"), path("M12 14.2v6.3")],
    "workflow": [box(3.5, 3.5, 6, 6, 1.8), box(14.5, 14.5, 6, 6, 1.8), box(3.5, 14.5, 6, 6, 1.8),
                 path("M9.5 6.5h5a3 3 0 0 1 3 3v5"), path("M6.5 9.5v5")],
    "pause": [path("M9 5.5v13"), path("M15 5.5v13")],
    "play": [path("M8 5.3v13.4L18.5 12Z")],
    "file": [path("M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z"), path("M13.5 3.5V9H19")],
    "external": [path("M14 4h6v6"), path("M20 4l-8.5 8.5"), path("M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5")],
    "lock": [box(5, 10.5, 14, 10, 2.2), path("M8 10.5V7.5a4 4 0 0 1 8 0v3"), path("M12 14.5v2.5")],
    "trash": [path("M4 6.5h16"), path("M9 6.5v-2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"),
              path("M6 6.5l.9 12.6A1.5 1.5 0 0 0 8.4 20.5h7.2a1.5 1.5 0 0 0 1.5-1.4L18 6.5"),
              path("M10 10.5v6"), path("M14 10.5v6")],
}

# Agent and ownership state markers (guide 10): one distinct shape per state.
MARK = {"stroke": INK, "stroke_width": 1.8, "line_cap": "round", "fill": "none"}
STATES = {
    "working": [{"type": "shape", "shape": "ellipse", "x": 2, "y": 2, "width": 8, "height": 8, "fill": INK}],
    "waiting": [{"type": "shape", "shape": "ellipse", "x": 1.5, "y": 1.5, "width": 9, "height": 9, **MARK}],
    "paused": [{"type": "shape", "shape": "path", "path": "M4 2.5v7 M8 2.5v7", **MARK}],
    "done": [{"type": "shape", "shape": "path", "path": "M2.2 6.4 4.9 9 9.8 3", **MARK}],
    "blocked": [{"type": "shape", "shape": "path", "path": "M6 1.2 10.8 6 6 10.8 1.2 6Z", "fill": INK,
                 "stroke": INK, "stroke_width": 0.8, "line_cap": "round"}],
    "agent": [{"type": "shape", "shape": "path", "path": "M6 1.8 10.2 6 6 10.2 1.8 6Z", **MARK}],
    "you": [{"type": "shape", "shape": "rounded-rectangle", "x": 2, "y": 2, "width": 8, "height": 8, "radius": 2,
             "fill": INK}],
    "assist": [{"type": "shape", "shape": "ellipse", "x": 1.5, "y": 1.5, "width": 9, "height": 9, **MARK},
               {"type": "shape", "shape": "path", "path": "M6 2.4A3.6 3.6 0 0 0 6 9.6Z", "fill": INK}],
    "available": [{"type": "shape", "shape": "ellipse", "x": 1.8, "y": 1.8, "width": 8.4, "height": 8.4, **MARK,
                   "stroke_width": 1.4, "dash": [1.6, 1.6], "line_cap": "butt"}],
}
