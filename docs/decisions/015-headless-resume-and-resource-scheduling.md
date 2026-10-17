# ADR 015: Headless sessions, resume state and resource scheduling

Status: accepted (2026-10-17). Issues: #11, #24, #30.

## Context

Weft required a visible window. Tests used a virtual display, but there was no
supported way to run the same session without a window and let a person attach
later (#11). Restarted projects reopened tabs but not the person's last view, and
there were no tab groups, tab search or browsing-data import (#24). Individual
request limits existed, but nothing bounded total agent concurrency, queued costly
captures, measured responsiveness or released idle tabs (#30).

## Decision 1: headless means a hidden window, not a windowless engine

Electron 44 has no supported windowless mode for an application that hosts its
own trusted UI. We evaluated the options on Linux with Electron 44.9.0 /
Chromium 152 (probe scripts: hidden and shown windows, offscreen views, CDP
captures, under Xvfb and under `--ozone-platform=headless`):

| Option | Observed result | Decision |
| --- | --- | --- |
| `--ozone-platform=headless` (no display server) | Windows and child views are sized 1×1 whatever bounds are requested; the GUI renders at 1×1; normal views capture as empty images; CDP screenshots hang. Offscreen `BrowserWindow`s render at full size, but Weft hosts pages as `WebContentsView` children, which stay 1×1. | Unsupported. `display.status` reports it with the reason; Weft warns at startup. |
| Hidden window (`show: false`) with normal page views | The GUI renderer loads and runs (trusted IPC works). Page views report `visibilityState: hidden`; `capturePage` fails with "Current display surface not available"; CDP screenshots hang. | Used for the GUI only. |
| Hidden window with **offscreen** page views (`webPreferences.offscreen`) | Pages render at the host window size while hidden; viewport, region and full-page captures work; an unattached offscreen view has a 0×0 size, so a view must be attached while it renders. Offscreen views draw nothing in a shown window. | **Chosen** for pages while headless. |
| Shown window on a virtual display (Xvfb) | Everything works, but it is a test environment, not a product mode. | Supported host for headless Weft on Linux servers. |

So a headless session is the normal application with `show: false`: the same
profile (`userData`), workspace store, Chromium partitions (`persist:weft-<id>`),
authority gate, approvals, client grants, API server and command catalog. Pages
created while the window is hidden render offscreen; the active tab (and any tab
being captured) stays attached to the hidden window so it has a size. Linux still
needs a display server (a desktop session or Xvfb); macOS and Windows use their
normal window system. Only Linux/Xvfb was exercised.

Launch: `--headless` or `WEFT_HEADLESS=1`. Attach without restart:

- launching Weft again with the same profile (a single-instance lock hands the
  launch to the running process, which shows its window instead of starting a
  second browser on the same profile — the store's profile lock would refuse it
  anyway);
- `weft attach` / `display.show` (local_write; the bootstrap token may call it,
  scoped clients may not because display controls are browser-resource commands).

Detach: human-only `display.hide` (with `confirmReload: true`) from the window,
or closing the window of a session that was started headless. Closing the window
of a normally launched session still quits.

**Transition cost.** Chromium cannot move a live offscreen renderer into a
window or back. A mode change therefore checkpoints the tab (URL, title, scroll,
zoom, version) and recreates its renderer, so the page reloads: on attach, the
tabs the person sees are converted immediately and other tabs convert when
opened; on detach, every tab converts. In-flight agent input finishes first.
Every transition is recorded (`display.status.transitions`, durable activity type
`display`, live `display` events) with the reloaded tab ids and which of them had
detected unsaved input. Tab versions advance, so agents must inspect again;
agent leases stay with the running process; human ownership persists across
restarts and agent leases do not (unchanged rule).

**Human decisions while headless.** Approvals still need a person in the trusted
window. `display.status` reports the pending count and an attach hint, the
process prints a line on stdout when a new request waits, and the window shows
the request queue once attached. No approval path was added for headless use.

## Decision 2: resume records are view state; links are computed

Each workspace has one resume record (`resumeStates`, keyed `resume_<workspace>`):
section, active tab, split pane tab and focused pane, panel layout (sidebar,
agent panel, open conversation) and up to 50 pinned resources. `resume.get`
recomputes continuation links from current records (blocked/waiting/paused tasks,
open tasks, open and accepted handoffs, pinned materials) and reports pins or
panes whose targets disappeared instead of pointing at stale copies. The GUI saves
the record as the person works and applies it at startup and on workspace switch,
unless the person navigates first. Restore disclosures are fixed text: pages
reload from saved URLs, sites may ask to sign in again, unsent form input and
live script state are not restored, suspended tabs stay unloaded, agent leases end.

Tab groups (`tabGroups`) are workspace records holding name, named color and
collapsed state; tabs reference a group by id and only within their workspace.
Colors are always shown with their names. `tabs.search` matches titles, URLs and
group names and returns ownership, task, group and suspension labels as text.
Resume records and tab groups describe this profile's tabs, so they are excluded
from exports and search, and deleted with their workspace.

## Decision 3: browsing-data import reads two kinds of files, copied first

Human-only commands import bookmarks and history from Chromium-family profiles
(`Bookmarks` JSON, `History` SQLite), Firefox (`places.sqlite`, with
`containers.json` listed for review) and Netscape bookmark HTML. Only those files
(and Chromium's `Local State` for profile names) are opened; SQLite files are
copied to a private temporary folder first. Passwords, cookies, site storage,
sessions, autofill, payment data and extensions are never read. URLs must be
HTTP(S) without credentials; sensitive query parameters are removed. The preview
lists counts, folders, duplicates (within the source and against the workspace),
unsupported fields (for example Chromium `meta_info`, Firefox tags and keywords,
HTML icons), skipped entries and the history retention cap, and returns a digest
the import must echo, so the person imports exactly what was previewed. Bookmarks
become pinned website materials; history becomes workspace visits (latest 1,000
kept). Firefox does not record containers per visit or bookmark, so items cannot
be separated by container; this is disclosed.

Checked against the core-versus-plugin checklist (ADR-003, `docs/PLUGINS.md`):
the importer is optional, but it needs native reads outside the profile and
record writes, which plugins may not have (question 3), so it stays in core as a
human-only administration command. Headless display control, resume state and
resource scheduling touch session isolation, tab leases and the authority gate
(question 4) and are core by definition.

## Decision 4: resource scheduling is typed backpressure

- **Concurrency**: every top-level non-human command takes one slot; limits are
  global (default 8), per client (4) and per task-bound grant (2). Exceeding one
  fails with `resource_busy` (HTTP 429, CLI exit 3) naming the resource and a retry
  delay. People and the internal model reader are never throttled.
- **Capture queue**: `page.screenshot`, `page.pdf` and `artifacts.capture` run
  through one queue (concurrency 1, eight agent jobs waiting). People are queued
  ahead of agents and never refused. Jobs emit `capture` events and are listed
  with progress by `captures.list`; `captures.cancel` cancels queued jobs, discards
  a running screenshot/PDF result (reported as cancelled) and reports running
  artifact captures as not cancellable.
- **Budgets**: client grants may set `maxRuntimeSeconds` (sum of command run time)
  and `maxCost` (model spend measured only from provider-reported tokens and a
  configured price). Spending stops with `budget_exhausted` (HTTP 429, CLI exit 4).
  With a spend budget, a model connection without a configured price is refused,
  never estimated. The existing `maxCommands`/`maxPerMinute` action limits remain.
- **Resolution**: capture limits and model image limits live in
  `src/resources.js`; a human `maxCaptureEdge` caps every caller's captures.
- **Suspension**: background tabs idle past `idleSuspendMinutes` (default 30) or,
  with `memoryBudgetMb`, least recently used tabs while page renderers exceed the
  budget, release their renderer. The tab keeps its id, URL, title, version,
  ownership, group and records; scroll and zoom are restored when it is opened or
  used. A tab is never suspended while active, in split view, pinned, leased or
  assisted by an agent, referenced by an open task, running or queuing input,
  downloading, audible, playing media, fullscreen, holding edited form fields or
  focused content-editable text (main frame), or when the page check fails.
  Suspension never changes task state. Suspended tabs are restored unloaded after
  a restart.
- **Indexing** stays incremental inside each record transaction (measured by
  `perf/budgets.js`); there is no deferred indexing queue, and a search-index
  version change still rebuilds at startup.
- Frequent browser-session and history writes commit only their own rows, and
  browser commands no longer copy the whole workspace per call.

## Integration with later decisions

Merged with ADR 012-014 and 016-018:

- **Suspension** also refuses a tab in a credential broker's protected
  operation or its cooldown (ADR 017), a tab being captured (bundle, screenshot
  or resource archive, ADR 012), a tab being recorded for a workflow, and a tab
  a runtime task's plan step targets (ADR 016). A suspended tab reloads before
  a capture or a credential fill. Tab search withholds the titles of protected
  tabs.
- **Scheduling** applies to task-runtime steps (each step is a top-level command
  of the task identity, with its per-task limit and the grant's budgets);
  nested plugin and export-hook reads reuse their caller's slot. A busy step
  pauses the task; a spent budget pauses it with a `grant` blocker. Exit codes
  stay categories: `resource_busy` is 3 (retryable conflict, like
  `duplicate_risk`), `budget_exhausted` is 4 (a refusal a person resolves, like
  `site_blocked`); both are in the ADR 018 outcome tables (`conflict` and
  `blocked`, HTTP 429).
- **Encryption** (ADR 014): resume records and tab groups are sealed workspace
  records (and in backups); row-scoped session and history writes are sealed the
  same way. A headless manual-unlock profile starts locked; `display.status`
  reports `locked` with an attach hint and stdout says so; `display.status` and
  `display.show` work while locked; unlocking stays human-only in the window.
  Idle suspension and session persistence do nothing while locked.
- Capture jobs and tab suspension publish `capture` and `tab` events through
  the ADR 018 event registry; the legacy `waiting` task state is read as
  `waiting_on_human` in resume continuation links.

## Measured targets

`perf/README.md` records reference numbers from `perf/responsiveness.js`
(Linux/Xvfb, software rendering) and `test/responsiveness.test.js` enforces
generous ceilings: GUI first render < 15 s, agent navigation p95 < 3 s, input and
scroll p95 < 1.5 s, total memory < 3.5 GB and main-process CPU < 400% during a
3,000-record workload with four concurrent agents.

## Consequences and limits

- Headless operation, offscreen capture and display handoff are verified on
  Linux/Xvfb only. A Linux server without any display server is not supported.
- Moving between headless and headed rendering reloads pages; work that lives
  only in a page (unsent forms, in-page state) is lost at that boundary and
  reported, not preserved.
- Memory pressure uses Chromium process metrics against a configured budget; it
  does not subscribe to an OS memory-pressure signal. Cross-origin frames are not
  inspected for unsaved input or media.
- Browsing-data import is fixture-tested; Safari, encrypted or locked profile
  formats and synced data are not supported.
