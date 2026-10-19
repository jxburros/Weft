# Production design system and validation

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
| `accent-ocean`, `accent-forest`, `accent-rose` | `#28657c`, `#436743`, `#93526b` | `#83b9cd`, `#a0c49a`, `#d6a0b4` | Optional interface accents (below) |

Rendered contrast of text, selected, error, disabled and focus states is measured
in real Electron in both themes by `test/accessibility.test.js`; token pairs are
checked by `test/design-tokens.test.js`. Neither is a certification.

### Appearance preferences

`settings.update` takes `appearance: {accent, density, textScale}` beside `theme`
(`system`, `light`, `dark`). Settings → Appearance offers only the color theme;
the other preferences are set through `settings.update`, including an approved
Ask Weft proposal ([WORKSPACE-AGENTS.md](WORKSPACE-AGENTS.md)).

- **Accent**: `plum` (default), `ocean`, `forest` or `rose`, set as `data-accent`
  on the root. A non-plum accent rebinds `brand` to the matching `accent-*` token,
  so primary actions, selection, the agent frame and the working and agent markers
  described below as plum take the accent; `brand-soft`, `focus-ring` and the
  trusted-surface tokens stay plum. The accent tokens are not yet in the automated
  contrast checks.
- **Density**: `comfortable` (default) or `compact` (`data-density`). Compact
  reduces settings-row and record-card padding only.
- **Text scale**: 0.85–1.3, applied as the root font size (16 px × scale), so every
  rem type token scales with it.

## Type

Source Sans 3 (regular and semibold, bundled, OFL) is used in the main window and
the credential entry window; monospace appears only for fingerprints, digests and
command data. Sizes are rem tokens, so browser zoom, text scaling and the text
scale preference all apply:

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
| Motion | `motion-fast` 150 ms ease-out (hover, selection, quick-card lift), `motion-enter` 200 ms `motion-enter-easing` (dialogs, toast and agent panel rise or slide in; a new view fades in once on navigation, opacity only so live page bounds never move), `motion-loading` 1 s (loading line, working marker), `motion-handoff` 600 ms (control handoff). The section icon grid's hover/focus lift uses a fixed 160 ms ease, not a token. | `prefers-reduced-motion` sets them all to 0, disables animations and removes the icon lift; state is always also in text. |

## Layout and sidebar density

64 px workspace rail (scrolls when short), 242 px sidebar (222 px under 1200 px,
200 px under 950 px, hidden under 700 px or when the agent panel opens under
1050 px), 320 px agent panel (285 px under 1200 px). Workspace sections are a
three-column icon grid above the tab list: 24 px icons in buttons at least 54 px
tall, with a count on Materials, Tasks and Artifacts. Section names are visually
hidden but remain each button's accessible name and hover tooltip, and the
current section has `aria-current="page"`. Tab rows are at least 36 px; every
control is at least 24 × 24 px. At the minimum window (1000 × 640) with 200% zoom
or 200% text the layout reflows without overlap (audited).

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
- **Panes** (guide 7.4). One to four panes with 6 px dividers that show the focus
  ring on hover and keyboard focus; each pane has a header with its position
  button ("Left pane", "Top right pane", …; `aria-pressed`), the title, the
  ownership badge for tabs, a "Focused" label and a close button; the focused pane
  has a focus-ring frame and an underline. Captures and documents render on the
  surface color inside the pane. Choosing a pane moves keyboard focus into it.
- **Everything and windows.** Everything's rail button has a dashed 2 px border and
  the grid icon; a workspace shown in another window is dimmed with a small ↗ mark,
  and its accessible name says where it is.
- **Browser-owned surfaces** (guide 6, 13). One visual language: a band reading
  "Weft browser control · <kind>" on the trusted surface with a plum edge, a
  shield icon and a 4 px top edge on dialogs. Used for agent requests, payment
  approvals, sign-in and payment-card dialogs, the separate credential entry
  window, site controls, stop pages, application-launch requests, extension
  permissions, agent access, encryption, model destination review and community
  lists. A website cannot draw outside its view, so it cannot imitate the band.
  Personal-preference stops and security stops share the band but say which they
  are; strong warning colors stay reserved for real risk.

## Icons, illustrations and animation (Vixl)

Every icon, illustration and animation in the interface is drawn with
[Vixl](https://github.com/jxburros/Vixl); see [`assets/graphics/README.md`](../assets/graphics/README.md)
for the sources and the rebuild steps.

- **Icons** (41) are 24 px drawings on one set of centre lines: 1.6 px strokes, round
  caps and joins, 2–3 px corners on boxes (guide 6). They are exported as native SVG
  strokes and inlined by `src/icons.js`, generated from the exports; charcoal becomes
  `currentColor`, so an icon takes its control's colour in both themes.
- **State markers** are 12 px glyphs, one shape per state (guide 10), painted in the
  badge's colour (plum working and agent, clay waiting, sage done and assist, danger
  blocked, muted paused and available, ink you).
- **Empty-state illustrations** (14) share one 120 × 90 scene: a warm patch, two faint
  crossing threads (the only woven detail, which guide 6 allows in empty states) and a
  simple object in brand, sage and clay. Their colours are light-theme token values
  that the generator turns into token classes (`f-brand`, `s-sage`), so each drawing
  follows the dark theme without a second copy.
- **Animations** are Vixl timelines exported as animated WebP, one per theme, with an
  SVG still for reduced motion. `mark-in` (1.1 s, plays once) slides the mark's two
  bands in from opposite sides on the overview: the occasional identity moment of
  guide 11. `waiting-dots` (1.2 s loop) beside "Waiting for your model" is small and
  local like the working marker: three knots in plum, sage and clay pass over and
  under a thread in turn.

`test/graphics.test.js` checks that `src/icons.js` matches the exports, that every
named icon exists, that drawings carry only token colours and vector shapes, and that
each animation has both themes, a still and the right play count.

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

Decision: **adopt the optical variant for 16–32 px only.** It is drawn with Vixl
by `scripts/graphics/logo_optical.py` from the supplied band centrelines with thicker
bands (1.75 px at 16 px), a wider over-under cut and the mark enlarged 1.25× on the
tile. `assets/logo/optical/` holds the SVG and 16/24/32 px PNG exports (masters in
`assets/logo/source/app-icon-*-small.vixl`), and `assets/logo/icons/favicon.ico`
holds the optical 16/24/32 px images plus the supplied 48 px export. Large icons,
the window icon and installer art keep the supplied artwork. `test/logo.test.js`
checks the favicon against the exports and re-measures both conclusions under Xvfb.

## Terminology

The section grid uses Overview, Materials, Context, Tasks, Conversations,
Artifacts, Activity, Workflows and Mailbox, beside Workspaces and Tabs (guide 3,
7.2). `test/gui-terminology.test.js` checks that section list, rejects
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
5. Sidebar density and panel breakpoints, motion durations, the handoff pulse,
   the icon-only section grid, and the optional ocean, forest and rose accents.
6. Appearance of the Windows installer art and of the icons on each platform's
   dock/taskbar at native sizes.
