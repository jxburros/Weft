# Accessibility audit and manual test script

Last verified against code: 2026-10-18.

This is the record for issue #31 (keyboard, screen reader, scaling and theme
accessibility). It separates what is **checked automatically in real Electron**
from what still needs **people with real assistive technology**. The automated
results are evidence for the checks listed, not an accessibility certification.

> **Not collected in this environment:** no real screen reader (NVDA, JAWS,
> VoiceOver, Narrator or Orca) and no OS magnifier was run, and nothing was
> checked on Windows or macOS. The automated audit runs on Linux under Xvfb.
> Orca was not run: under a virtual X display without an accessibility bus and
> speech output it would not give meaningful evidence. Issue #31 stays open for
> the manual evidence described in [Manual test script](#manual-test-script).

## How the automated audit works

`test/accessibility.test.js` starts the real application (`src/main.js`, real
Chromium, real command catalog, a temporary profile) with realistic records:
two workspaces, materials, context, tasks with steps and a waiting task, a
conversation, a workflow, a site rule, two live fixture pages in a tab group, two
capture versions, a structured handoff, a pending agent request and a pending
payment approval. It injects [axe-core](https://github.com/dequelabs/axe-core)
4.13.0 (a pinned development dependency) and the checks in
`test/a11y-checks.js` into the GUI renderer and fails on any finding.

```sh
xvfb-run -a node --test test/accessibility.test.js
WEFT_A11Y_REPORT=/tmp/a11y.json xvfb-run -a node --test test/accessibility.test.js   # keep the full report
```

| Check | How it is measured |
| --- | --- |
| axe-core | Rule tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice` over the whole document, the open modal dialog or the lock screen. |
| Rendered contrast | For every visible text node: the computed colour composited with opacity over the composited ancestor backgrounds, against 4.5:1 (3:1 for large text). States are classified as text, selected (`.active`, `aria-current`, `aria-pressed`, `aria-selected`), error (`role=alert`, `.form-error`, danger buttons) and disabled. Disabled controls are exempt in WCAG 1.4.3; Weft holds them to 3:1 anyway. Hover is covered by the token check of every text token on the hover surface. |
| Text size | No visible text below 11 px. |
| Focus indicator | Each control is focused after keyboard use; its outline (or the address field's ring) must be at least 2 px and 3:1 against the surface behind it. |
| Target size | Every control at least 24 × 24 CSS px, or the WCAG 2.2 spacing exception; a checkbox counts its whole label row. axe `target-size` runs too. |
| Keyboard reachability | Real `Tab` key events walk the view or dialog; every visible control must be reached, focus must cycle back (no trap) outside modal dialogs and stay inside modal dialogs. |
| Focus restoration | A dialog is opened from its control with `Enter`, closed with `Escape`; focus must have moved into it and must return to the same control. |
| Native page boundary | `F6` from the address bar focuses the live page (a separate Chromium view); `F6` and `Ctrl+L` pressed inside the page return focus to Weft; the page never receives those keys; the "Move focus into the page" control works. |
| Live regions | Only the toast, the announcer, the alert announcer and dialog error regions are live; four seconds of idle polling announce nothing and replace no controls; a new agent request is announced once. |
| Ownership and split view | Agent control and takeover update the ownership chip, the page frame (with the handoff transition) and an announcement; split view states the focused pane in text and moves keyboard focus into the chosen pane. |
| Zoom and text scaling | At the minimum window (1000 × 640) with 200% browser zoom (a 500 × 320 CSS px viewport) and separately with 200% root text: no horizontal overflow, no clipped control outside a scroll container, no overlapping visible controls, no cut-off text. |
| Reduced motion | With `prefers-reduced-motion: reduce` emulated, no element runs an animation or transition and the handoff duration token is `0ms`. |

## Audit matrix

Result legend: **pass** = checked automatically with no finding after the fixes
below; **manual** = needs the manual script; **n/a** = not applicable. Every row
was audited in both the light and the dark theme (102 audited states).

| View or surface | axe | Contrast and states | Focus ring | Targets | Keyboard / trap | Restore focus | Zoom 200% / text 200% | Screen reader |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Overview (with restore notice, resume panel, attention list) | pass | pass | pass | pass | pass (56 controls) | pass (4 dialogs) | pass / pass | manual |
| Materials, Context, Conversations, Workflows, Artifacts | pass | pass | — | pass | — | — | — | manual |
| Tasks (runtime task, waiting task, handoffs) | pass | pass | — | pass | pass (52) | pass | pass / pass | manual |
| Activity, History, Bookmarks, Downloads, Tabs table, Updates | pass | pass | — | pass | — | — | — | manual |
| Agent requests (generic and payment approval cards) | pass | pass | pass | pass | pass (46) | — | pass / pass | manual |
| Shared context | pass | pass | — | pass | — | — | — | manual |
| Settings (incl. display & resources, encryption, lists, agent input entries) | pass | pass | pass | pass | pass (71) | pass (2 dialogs) | pass / pass | manual |
| Privacy & site rules | pass | pass | pass | pass | pass (50) | — | pass / pass | manual |
| Community site lists | pass | pass | — | pass | pass (41) | pass | pass / pass | manual |
| Live page chrome (address bar, ownership chip, frame) | pass | pass | — | pass | boundary pass | — | — | manual |
| Stop page (site rule) | pass | pass | — | pass | — | — | — | manual |
| Split view (pane headers and frames) | pass (light) | pass | — | pass | pane focus pass | — | — | manual |
| Agent panel (chat) | pass | pass | — | pass | Escape returns focus | pass | — | manual |
| Command palette, tab search, command desk | pass | pass | pass | pass | modal pass (26) | pass | pass / pass | manual |
| Record editors (material, task, workspace) | pass | pass | pass | pass | modal pass (12) | pass | pass / pass | manual |
| Task review, artifact viewer, compare versions | pass | pass | pass | pass | modal pass (9) | — | — | manual |
| Redaction editor | pass | pass | pass | pass | modal pass (8, incl. keyboard area entry) | — | — | manual |
| Agent connections, create connection, agent input | pass | pass | pass | pass | modal pass (5, 6) | pass | pass / pass | manual |
| Saved sign-ins, payments, plugins, extensions, backups, resource limits, export, encryption, retention, model connection, semantic search, explain address, storage coverage, page tools | pass | pass | pass | pass | — | — | — | manual |
| Subscribe to a community list (and its preview) | pass | pass | pass | pass | modal pass (12) | pass | pass / pass | manual |
| Lock screen | pass | pass | pass | pass | trapped inside, app inert | pass after unlock | — | manual |
| Credential entry window (separate secret window) | n/a | token-checked only | manual | manual | manual | n/a | manual | manual |
| Website content inside the live page | n/a (the website's own) | n/a | n/a | n/a | boundary only | n/a | n/a | n/a |

A dash means that combination is not exercised separately; the row's other
checks cover its markup. The credential entry window is a separate sandboxed
window and is not yet driven by the audit.

## Findings fixed in this pass

| Finding | Fix |
| --- | --- |
| The page view could trap keyboard focus: once inside a website there was no key back to Weft. | `F6`/`Shift+F6`, `Ctrl/Cmd+L` and `Ctrl/Cmd+K` are intercepted before the page sees them (`src/browser.js` `chromeShortcut`) and return focus to the chrome; `F6` cycles address bar → page → agent panel → sidebar → content; a "Move focus into the page" control appears on focus. These keys are not human takeover. |
| Polling replaced the sidebar, tab list, notices and view every snapshot change, destroying the focused control (screen readers lost their place) and restoring focus to the wrong duplicate control. | Markup is replaced only when it changes (`setHTML`), and focus restoration remembers the region and position of the control. |
| Outcome codes were lost across the preload bridge, so a lock made outside the window never showed the lock screen and status labels never applied. | The renderer unwraps `executeOutcome` itself. |
| The status bar was a live region announcing every "Running …/Done"; streamed chat tokens, the approval list, activity filters, update and display panels were live regions too. | One polite announcer and one alert announcer; announcements for completed replies, new agent requests, stopped automation, tasks needing attention, ownership changes, palette results and filter results; streaming text is `aria-hidden` and the log is `aria-busy` while a reply streams. |
| Content behind the lock screen and behind a live page could receive focus. | The app is `inert` while locked; the placeholder behind a live page is hidden. |
| Redaction areas could only be drawn with a pointer. | Numeric left/top/width/height entry adds the same area from the keyboard. |
| Missing landmarks and headings: address bar and notices outside landmarks, card headings skipping levels, no `h1` in the browser view, unlabeled groups, a prohibited `aria-label`. | Named form and region landmarks, visually hidden section headings, an `h1` for every view, the agent panel title as `h2`, `role="group"` where labelled. |
| Text at 8–10.8 px (wordmark tagline, tags, `<small>`). | An 11 px floor in the type scale; `<small>` is 12 px. |
| Contrast below 4.5:1: muted text on hover, rail and tinted surfaces (4.19–4.39), the selected section count, the breadcrumb slash; disabled buttons at 1.97–2.42 via opacity. | Muted ink darkened to `#68616a` (4.77:1 or more on every light surface); disabled controls use dedicated tokens at 3:1+ with a dashed edge on labelled buttons. |
| Scrollable regions (command schema/result, long dialogs) unreachable by keyboard. | Scrollable regions without controls get a tab stop and a name. |
| 12 px checkboxes in the composer. | 16 px boxes on 24 px label rows. |
| The rail overlapped its own buttons at 200% zoom. | The rail scrolls. |
| Opening the agent panel left focus on the toggle; the palette had no arrow-key navigation. | Opening from the keyboard focuses the message field, `Escape` returns to the toggle; arrow keys move through palette results and `Enter` opens the first. |
| A stray `}` in `gui.css` silently dropped the tab-group styles. | Removed. |

## Keyboard reference

| Keys | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Move through controls. The first stop is "Skip to workspace content". |
| `F6` / `Shift+F6` | Next / previous region: address bar, live page, agent panel, sidebar, workspace content. Works from inside a website. |
| `Ctrl+L` (`Cmd+L`) | Address bar, also from inside a website. |
| `Ctrl+K` (`Cmd+K`) | Find anything, also from inside a website. Arrow keys move through results. |
| `Ctrl+Shift+A` | Search tabs. |
| `Ctrl+T`, `Ctrl+W`, `Ctrl+F`, `Ctrl+J` | New tab, close tab, find in page, downloads (from Weft's chrome). |
| `Escape` | Closes the dialog and returns focus to the control that opened it; inside the agent panel, closes the panel. |

## Manual test script

Run each part with a real screen reader and record the date, OS and version,
screen reader and version, browser zoom/text settings and the result per step in
the issue. A step passes only if it works without a mouse.

**Setup.** Fresh profile, one model connection (a local endpoint is enough), two
workspaces, a few materials, a task with steps, a captured page. Start a second
client to create one pending agent request (for example a material created with
the bootstrap token at "Ask before any change").

Screen readers: NVDA (latest) and JAWS (latest) on Windows 11 with Narrator spot
checks; VoiceOver on the current macOS; Orca on GNOME (Wayland and X11).

1. **Orientation.** Launch Weft. Use the landmark/region list: expect Workspaces
   navigation, Workspace sections navigation, the main content, "Address and page
   controls", "Agent conversation" (when open), "Status". Use the heading list:
   each view has one level-1 heading.
2. **Skip link and views.** `Tab` once: "Skip to workspace content". Activate it;
   focus is in the view. Choose each sidebar section; the new view's heading is
   read and the section is marked current.
3. **Ownership.** Open a website. Expect "Move focus into the page (F6)" to be
   read. The ownership badge beside the address bar reads "You drive". From the
   second client let an agent claim the tab: one announcement "… Agent drives:
   <name>", the badge and status bar change; take control back (Page tools → Take
   control) and hear one announcement.
4. **Page boundary.** `F6` into the page, use the page's own links, then `F6`
   and `Ctrl+L` back. The page must not receive those keys; the agent must not
   lose control because you left with `F6`.
5. **Split view.** With two live pages, turn on split view, use the "Left pane" /
   "Right pane" buttons; the pressed state and "Focused" are read and focus moves
   into that pane.
6. **Agent requests and payment.** On a new agent request one announcement is
   read; open Agent requests; each card starts with "Weft browser control · Agent
   request" (or "Payment approval"); approve once with the keyboard.
7. **Dialogs.** Open Find anything, a record editor, Agent connections, Saved
   sign-ins and Site controls; each is announced as a dialog with its title, `Tab`
   stays inside, `Escape` returns to the opening control.
8. **Chat.** Send a message; while it streams nothing is read token by token; at
   completion one announcement reads the start of the reply. Browse the log with
   the virtual cursor.
9. **Redaction.** Open a capture → Review & redact; add an area with the
   position fields and remove it; hear the updated list.
10. **Community lists.** Settings → Manage community lists → Subscribe. The
    preview reads the publisher fingerprint and every newly blocked domain before
    "Subscribe"; add and remove an exception; roll back.
11. **Lock.** Settings → Encryption → Lock now. Only the lock dialog is reachable;
    after unlocking, focus returns where it was.
12. **Credential window.** Add a saved sign-in: the separate window is announced,
    its "Weft browser control" band is read first, fields are labelled, `Escape`
    or Cancel closes it.

**Magnification and scaling** (Windows Magnifier and ZoomText; macOS Zoom; GNOME
magnifier): at 200% and 400% magnification with focus tracking, the focused
control stays in view through steps 2, 6, 7 and 10. With OS text scaling at 200%
(Windows "Text size", macOS larger text, GNOME large text) and with Weft's own
page zoom, repeat steps 2, 6 and 7 at the minimum window size (1000 × 640): no
clipped or overlapping essential content, horizontal scrolling only inside long
tables or code.

**High contrast.** Windows contrast themes and macOS Increase Contrast: focus
rings, ownership badges, state markers and disabled controls stay visible.

**Reduced motion.** Turn on the OS setting: the loading line and working markers
are static, handoffs show no border animation while the text still changes, views,
dialogs, the toast and the agent panel appear without an entrance, and the Vixl
animations (the overview mark, "Waiting for your model") show their resting frame.

## Known limits

- Website content inside the live page is the website's responsibility; Weft only
  guarantees the way in and out.
- Native `<select>` popups, file pickers and the OS credential prompts are
  platform UI and are only covered by the manual script.
- Disabled controls are measured at 3:1, a Weft choice above WCAG's exemption.
- The audit uses Chromium's accessibility tree through axe-core, not the
  platform accessibility APIs a screen reader reads.
