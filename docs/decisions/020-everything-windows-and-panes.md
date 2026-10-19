# ADR 020: Everything workspace, multiple windows and 1–4 panes

Status: accepted (2026-10-19). Issues #87, #99, #100, #101.

## Decision

- **Everything** is a built-in workspace (fixed id `ws_e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0`,
  `builtin: "everything"`) added to new and existing profiles. It is a normal workspace for
  storage (own Chromium partition and records) but cannot be deleted, renamed or archived.
  It is stored after the project workspaces, so callers that take the first listed workspace
  keep reaching a project; the GUI shows it first in the rail. A project workspace that
  already used the id is never taken over.
- **Links and files from other apps** (first launch, second launch, macOS `open-url` and
  `open-file`) are untrusted data. Only `http`/`https` URLs without credentials open, through
  the same admission and site rules as a typed URL; `.html`, `.htm` and `.pdf` files (regular
  files up to 10 MiB, symlinks resolved) are copied in as materials and never load as
  `file://` pages. They wait until the window is ready and the profile is unlocked, open in
  the configured destination (Everything, ask, last used) and are logged with actor
  `external-app`. They never start an agent action or change an agent's access.
- **Default browser** registration is opt-in from Settings in installed builds and
  reversible on Windows and macOS. Linux removal and the Windows default-app confirmation
  are the platform's. Install-time declarations: macOS and Linux declare the `http`/`https`
  schemes and HTML/PDF documents; Windows declares nothing, because registering file types
  there could take over `.html`/`.pdf` silently.
- **Agents and Everything.** It never makes a profile ambiguous and is never an implicit
  target (workspace or current tab); naming it is explicit and a scoped client needs it in
  its grant.
- **Windows.** Browser keeps per-window display state (viewport, attached views, active tab;
  main window = the workspace service's active workspace; other windows = the workspaces moved
  into them). A workspace is shown in at most one window; Everything stays in the main window.
  Moving a workspace re-parents its page views without reloading. Commands from a second
  window default to its workspace and tab. Closing a second window returns its workspaces to
  the main window; **closing the main window quits Weft**, and the arrangement (bounds,
  maximized state, workspaces) reopens at the next launch, falling back to the primary
  display. Locking closes second windows until unlock; headless sessions stay single-window.
  `windows.list` is informational; moving and focusing are human-only.
- **Panes.** The browse area shows 1–4 panes (layouts `1`, `2-columns`, `2-rows`, `3-main`,
  `3-columns`, `4-grid`) holding a tab, a capture version (or the offline preview), a
  material or a task. The trusted GUI computes the rectangles (`src/panes.js`, shared with the
  main process, which validates that pane tabs belong to the window's workspace). The focused
  tab pane is the active tab, so existing routing for the address bar, find, zoom, print,
  shortcuts and capture applies. Visible pane tabs are never suspended. The layout is saved in
  the resume record (`panes`), and older `split` records read as two panes.

## Limits

- Real pointer drags out of the rail and between windows, multiple physical displays and
  macOS/Windows window behaviour were not exercised; the tested path is the command and IPC.
- Document panes render escaped text and PNG only (no PDF rendering in a pane).
- The archive preview is one view: it shows in the window that holds its workspace.
- The Windows uninstaller does not undo a default-browser registration; stop using Weft for
  web links in Settings first.
