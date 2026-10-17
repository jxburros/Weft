# Production design system and validation

Last verified against code: 2026-10-17.

`assets/tokens.json` is the canonical source for light/dark colors, type, spacing,
radius, elevation, and motion. `node scripts/generate-tokens.js` writes
`assets/tokens.css`, imported by `src/gui.css`. Commit both files. The token test
rejects stale generated output, undefined token references, theme key mismatches,
and raw color literals in component CSS.

The guide's ivory canvas, soft surface, charcoal ink, and plum brand remain the
production palette. Sage and clay text use darker light-theme variants than the
decorative guide swatches so status labels remain readable. Dark mode uses
separately chosen foreground/background pairs. Destructive text, control borders,
avatar colors, backdrop, and shadows are theme tokens too. The regression check
covers actual text/status pairs at 4.5:1; this is not an accessibility certification.

Source Sans 3 remains bundled locally. Font sizes use rem tokens, allowing base
text scaling. Spacing and radius tokens preserve the existing compact browser
layout. Standard transitions use 150 ms ease-out; the loading indicator uses a
1 s cycle. Reduced-motion sets both durations to zero and disables animations and
transitions. State remains visible in text. Existing supplied logo variants are
retained; no replacement brand or textile terminology has been introduced.

## Automated evidence

- `node --test test/design-tokens.test.js`: canonical/generated consistency,
  component token usage, light/dark text contrast.
- `xvfb-run -a node --test test/gui.test.js`: real browser, model fixture, records,
  captures, workspace switching, palette search, and minimum-window workflow.
  Capture now refreshes tab state before opening its dialog, preventing the
  recently navigated tab from being mistaken for an empty tab.
- `WEFT_VISUAL=1 xvfb-run -a node --test test/visual.test.js`: twelve Linux Electron
  goldens, native dialog Escape/focus restoration and naming, 200% text scale
  application bounds, reduced-motion emulation, cloud acknowledgement/cancel,
  storage-conflict notice, automation resume, export residue review, scoped
  client creation/revocation, token disposal on close, and Update Center flows
  (no check on open, staged verification display, opt-in daily checks, install of
  the exact staged version, kill-switch disabled controls).
- `xvfb-run -a node --test test/gui-knowledge.test.js`: Context review panel
  (proposal promotion, citation status, source check, conflict inspection and
  resolution), linked-source cards and Shared context collection dialogs. These
  views reuse existing card, tag (sage/clay status), notice and dialog
  components; no new tokens or colors were introduced. Golden fixtures contain
  no linked, shared, cited or proposed records, so those views render the same
  markup as before.
- `node --test test/release.test.js`: Windows installer sidebar/header bitmaps are
  regenerated from `assets/tokens.json` and the committed logo exports by
  `scripts/generate-installer-art.js` and must match the committed BMPs byte for
  byte. Their appearance inside the real Windows installer has not been reviewed.

Accessibility fixes include a skip link, named dialogs and command inputs,
expanded state on panel controls, a conversation log, focus restoration when
polling replaces controls, focus return when closing Ask Weft, and suppressing
application shortcuts inside modal dialogs. Controls have a 24 px minimum target.
Settings offers scoped client creation, listing, and revocation. Tokens appear
only in their creation dialog and are removed from its DOM on close; quiet
execution keeps them out of the command-result desk. The block page labels
community-list repository/commit provenance as untrusted.

The narrow layout stacks workspace cards and wraps settings rows. Safety notices
persist independently of the transient status bar and include text labels.

## Remaining review (#31 and #36)

Both broad audit issues remain open. Automated Linux checks do not establish
screen-reader behavior on Windows, macOS, or Linux assistive technology; they do
not cover all native-page focus boundaries, split views, permission/credential
surfaces, or every state at magnification. The supplied favicon and application
icons still need optical review at platform sizes. Final brand approval and
interaction validation for future credential/approval and structured handoff
features remain human/product review tasks. Do not describe the screenshots or
contrast tests as completing those audits.
