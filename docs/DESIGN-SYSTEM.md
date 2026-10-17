# Production design system and validation

Last verified against code: 2026-10-17.

`assets/tokens.json` is the canonical source for light/dark colors, type, spacing,
radius, elevation and motion. `node scripts/generate-tokens.js` writes
`assets/tokens.css`, imported by `src/gui.css` and `src/credential-entry.css`.
Commit both files. `test/design-tokens.test.js` rejects stale generated output,
undefined token references, theme key mismatches, raw color literals in component
CSS, off-scale spacing/radius/type tokens and the contrast pairs listed below.

This document records the production choices measured against the
[visual style guide](../Weft-Visual-Style-Guide.md) (#36). Items the guide leaves
to a human decision are listed under [Needs human sign-off](#needs-human-sign-off).
Accessibility evidence is in [ACCESSIBILITY.md](ACCESSIBILITY.md).

## Color

The guide's ivory canvas, soft surface, charcoal ink and plum brand are the light
palette. Sage and clay text use darker variants than the decorative guide swatches
so status text stays readable; the guide swatches remain in the logo. Dark mode
uses separately chosen pairs (guide 4.2), not an inversion.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `canvas` | `#f4f1ea` | `#252329` | Application background |
| `surface` / `white` | `#fcfaf6` / `#fffefa` | `#2e2b31` / `#332f36` | Panels, cards, inputs |
| `ink` | `#27252b` | `#f3eee7` | Main text |
| `muted` | `#68616a` | `#bcb2bf` | Secondary text; at least 4.5:1 on every surface, hover, rail and tint |
| `brand` / `brand-soft` | `#70516f` / `#ece5ed` | `#cda9cb` / `#493b4a` | Primary actions, selection, identity |
| `sage` / `sage-soft` | `#526d58` / `#e7ece4` | `#b2c6af` / `#354438` | Positive or settled status |
| `clay` / `clay-soft` | `#9c543d` / `#f5e7dd` | `#e4a88f` / `#4e3830` | Waiting / needs attention |
| `danger` | `#af453c` | `#f1a39a` | Destructive actions and errors |
| `border`, `border-strong`, `control-border` | `#e2ddd5`, `#a9a0a8`, `#8a7e8c` | `#464049`, `#827787`, `#827787` | Separators; input edges at 3:1 |
| `focus-ring` | `#70516f` | `#cda9cb` | 2 px focus outline, 3:1 or more on every surface |
| `disabled-surface` / `disabled-ink` | `#e9e5de` / `#7a727c` | `#39343c` / `#9a919d` | Disabled controls: readable at 3:1, plus a dashed edge on labelled buttons |
| `trusted-surface` / `trusted-border` / `trusted-ink` | `#f1ebf2` / `#70516f` / `#4f3a4e` | `#3a3140` / `#cda9cb` / `#e7cfe5` | Browser-owned decisions (below) |
| `group-*` | sky, sand, rose, slate | lighter pairs | Tab-group accents, always shown with the color's name |

Rendered contrast of text, selected, error, disabled and focus states is measured
in real Electron in both themes by `test/accessibility.test.js`; token pairs are
checked by `test/design-tokens.test.js`. Neither is a certification.

## Type

Source Sans 3 (regular and semibold, bundled, OFL) is used in the main window and
the credential entry window; monospace appears only for fingerprints, digests and
command data. Sizes are rem tokens, so text scaling works:

| Token (px) | Use |
| --- | --- |
| 34 | View title (`h1`) |
| 26, 22, 20 | Browser placeholder and stop page, intro panel, section and dialog titles |
| 17, 16 | Settings/overview section headings, card titles |
| 14, 13 | Navigation, body and dialog text |
| 12 | Controls, `<small>` metadata, notices |
| 11 | Floor: tags, state badges, status bar, captions |

The earlier 8 px tagline and 10 px labels were below the guide's "secondary
metadata that remains readable" (5.1, 14); nothing renders below 11 px now.

## Spacing, radius, elevation, motion

| Scale | Values | Notes |
| --- | --- | --- |
| Spacing | 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40 px | Replaces 30 ad-hoc pixel values (each moved to the nearest step). Compact chrome uses 4–12, content and cards 16–40. |
| Radius | 4 (tags, badges, frames), 6 (images), 8 (controls), 12 (cards, panels, dialogs, rail buttons) | "Modestly rounded" (guide 6). |
| Elevation | `shadow-subtle` (active tab, lock card), `shadow` (dialogs, toast) | Two levels; borders carry most separation. |
| Motion | `motion-fast` 150 ms ease-out (hover, selection), `motion-loading` 1 s (loading line, working marker), `motion-handoff` 600 ms (control handoff) | `prefers-reduced-motion` sets all three to 0 and disables animations; state is always also in text. |

## Layout and sidebar density

64 px workspace rail (scrolls when short), 242 px sidebar (222 px under 1200 px,
200 px under 950 px, hidden under 700 px or when the agent panel opens under
1050 px), 320 px agent panel (285 px under 1200 px). Section links are 14 px text
with 8/12 px padding; tab rows are at least 36 px; every control is at least
24 × 24 px. At the minimum window (1000 × 640) with 200% zoom or 200% text the
layout reflows without overlap (audited).

## Components finished in this pass

- **Agent presence and ownership** (guide 10, 10.1). State badges pair a text
  label with a distinct marker shape: working (pulsing dot), waiting (ring),
  paused (bars), completed (check), blocked/failed/outcome unknown (diamond),
  agent drives (outlined diamond), you drive (square), assist (half circle),
  available (dashed ring). Tabs in the sidebar show Working / Agent drives /
  Assist / waiting counts; task cards and task detail use the same badges. The
  shown page has a persistent ownership badge beside the address bar and the
  status bar states controller, version and running command.
- **Handoff transition.** Live pages sit inside a 3 px frame that only Weft can
  draw (pages are native views and cannot paint there). The frame is dashed plum
  while an agent drives; a change of controller plays a 600 ms border pulse and is
  announced once. Reduced motion removes the pulse; the badge text still changes.
- **Split view** (guide 7.4). A 6 px divider between panes; each pane has a header
  with "Left pane"/"Right pane" buttons (`aria-pressed`), the page title, its
  ownership badge and a "Focused" label; the focused pane has a focus-ring frame
  and an underline. Choosing a pane moves keyboard focus into it.
- **Browser-owned surfaces** (guide 6, 13). One visual language: a band reading
  "Weft browser control · <kind>" on the trusted surface with a plum edge, a
  shield icon and a 4 px top edge on dialogs. Used for agent requests, payment
  approvals, sign-in and payment-card dialogs, the separate credential entry
  window, site controls, stop pages, application-launch requests, extension
  permissions, agent access, encryption, model destination review and community
  lists. A website cannot draw outside its view, so it cannot imitate the band.
  Personal-preference stops and security stops share the band but say which they
  are; strong warning colors stay reserved for real risk.

## Logo at small sizes

`npm run logo:validate` (Electron) renders every supplied variant at 16, 24, 32,
48, 64, 128 and 256 px and measures, from the pixels, how many separate band
pieces remain (the over-under crossing is legible only while the three pieces of
the 256 px reference stay apart), the band width and the peak contrast. Results:
[`artifacts/logo-validation.json`](../artifacts/logo-validation.json) and the
contact sheet [`artifacts/logo-contact-sheet.png`](../artifacts/logo-contact-sheet.png).

| Variant | 16 px | 24 px | 32 px | 48 px | 64 px and up |
| --- | --- | --- | --- | --- | --- |
| App icon light / dark (supplied SVG) | crossing lost | lost | lost | lost | legible |
| App icon plum (supplied SVG) | lost | lost | lost | legible | legible |
| Mark on ivory / one colour / on charcoal | lost | lost | lost | legible | legible |
| Supplied PNG exports (light) | lost | — | legible | legible | legible |
| **Optical variant** (light, dark, plum) | legible (band 1.75 px) | legible | legible | legible | legible |

Decision: **adopt the optical variant for 16–32 px only.** It is generated by
`scripts/logo-optical.js` from the supplied band centrelines with thicker bands
(1.75 px at 16 px), a wider over-under cut and the mark enlarged 1.25× on the
tile. `assets/logo/optical/` holds the SVGs and 16/24/32 px PNGs, and
`assets/logo/icons/favicon.ico` now holds the optical 16/24/32 px images plus the
supplied 48 px export. Large icons, the window icon and installer art keep the
supplied artwork. `test/logo.test.js` keeps the files in sync with the generator
and re-measures both conclusions under Xvfb.

## Terminology

Navigation uses Workspaces, Tabs, Materials, Context, Tasks, Conversations,
Artifacts and Activity (guide 3, 7.2). `test/gui-terminology.test.js` rejects
textile vocabulary in interface strings, keeps "woven" to the brand tagline and
allows "desk" only in "Command desk" and the empty-task line "A clear desk".

## Automated evidence

- `node --test test/design-tokens.test.js`: generated tokens, token use, text and
  state contrast pairs, scales.
- `xvfb-run -a node --test test/accessibility.test.js`: axe-core and rendered
  checks over every view and dialog in both themes (see ACCESSIBILITY.md).
- `WEFT_VISUAL=1 xvfb-run -a node --test test/visual.test.js`: twelve Linux
  goldens with pinned font rendering (see `test/visual/README.md`), regenerated
  and reviewed for this pass.
- `xvfb-run -a node --test test/gui-lists.test.js`, `test/gui.test.js`,
  `test/gui-knowledge.test.js`: real-GUI workflows.
- `xvfb-run -a node --test test/logo.test.js`: logo measurements and generated
  optical assets.
- `node --test test/release.test.js`: installer bitmaps regenerated from tokens and
  the logo exports must match byte for byte (their appearance inside the real
  Windows installer has not been reviewed).

## Needs human sign-off

These are product or brand decisions; the implementation is ready for them but
does not make them:

1. Final logo and wordmark, including whether the optical small-size variant
   (bands thickened, cut widened, mark enlarged) is acceptable brand-wise.
2. Final typeface (Source Sans 3 is implemented; IBM Plex Sans was the guide's
   alternative) and the type scale above.
3. The dark palette, the status/warning/error/focus colors and the trusted-surface
   treatment as the permanent look of browser-owned UI.
4. Workspace naming (Workspaces, Desks or Hubs); "Command desk" would need a new
   name if "Desks" is chosen.
5. Sidebar density and panel breakpoints, motion durations, and the handoff pulse.
6. Appearance of the Windows installer art and of the icons on each platform's
   dock/taskbar at native sizes.
