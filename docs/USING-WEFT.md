# Using Weft

Day-to-day details that the [README](../README.md) only summarizes: running Weft,
keyboard controls, model connections, where your data lives, and what Weft does
and does not protect. Workspace instructions, Ask Weft actions, web watches and
email are in [Workspace agents](WORKSPACE-AGENTS.md); message capture, relevant
context and learning are in [Capture and learning](CAPTURE-AND-LEARNING.md).

## Running Weft

Requires **Node.js 22.13+** (for the built-in `node:sqlite` module), npm, and a desktop session. Electron supplies Chromium.

```sh
npm ci
node node_modules/electron/install.js
npm start
```

The API binds only to `127.0.0.1:9222`.

**Port 9222 is also Chrome's conventional DevTools remote-debugging port.** If
Chrome or a tool that drives it (Puppeteer, Playwright, chrome-devtools MCP servers)
already uses 9222, Weft cannot start its API there, and such tools may try to talk to
Weft as if it were Chrome; Weft never speaks the DevTools protocol and refuses those
requests without a token. Set `WEFT_PORT` (and the same port in `WEFT_API_URL`) to
use another port, for example `WEFT_PORT=9333`. The API is IPv4-only: the CLI and
MCP bridge connect `localhost` to `127.0.0.1` and refuse `[::1]`.

Without `WEFT_TOKEN`, the browser generates
a random token and prints it to the local terminal; set `WEFT_TOKEN_FILE` to a path
instead and the generated token is written there (owner-only) rather than printed,
which keeps it out of service-manager logs. The CLI and MCP bridge read the same
`WEFT_TOKEN_FILE`. For automation, choose a strong token (at least 32 characters;
shorter values are refused at startup) and use it in both processes:

```sh
export WEFT_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
npm start
```

Set `WEFT_PORT` to change the port. In PowerShell, use `$env:WEFT_TOKEN = ...`.
A desktop display is required. On headless Linux, `xvfb-run -a npm start` provides
a virtual display. Normal startup keeps Chromium's sandbox enabled.

To run without a visible window (same profile, policies and agent API; pages
render offscreen), start with `npm start -- --headless` or `WEFT_HEADLESS=1`.
Launch Weft again or run `weft attach` to show the window of that running
session; agent requests that need your decision wait until you do. Linux still
needs a display server for this (a desktop session or `xvfb-run`). See
[ADR-015](decisions/015-headless-resume-and-resource-scheduling.md).

### Installers and updates

Stable releases are packaged for Windows x64 (branded per-user NSIS installer),
macOS arm64/x64 (dmg/zip) and Linux x64 (AppImage/deb) from GitHub Releases of
`jxburros/Weft`. Settings > Updates shows the installed version, the stable
channel and any verified staged update. Weft contacts GitHub only when you choose
Check now or turn on daily checks; downloads are size- and SHA-512-verified and
installed only when you choose. `WEFT_DISABLE_UPDATES=1` turns all update traffic
off. Upgrades and uninstalls keep your workspaces unless you explicitly remove
them. Release, signing and support details: [RELEASING.md](RELEASING.md).
Code signing and notarization depend on credentials that are not yet configured,
so current builds are labelled unsigned. On Windows, SmartScreen may warn about
the unsigned `Weft-Setup-X.Y.Z-x64.exe`: check it against the release's
`SHA256SUMS.txt`, then choose **More info** > **Run anyway**. It installs for your
account only and needs no administrator rights.

## Keyboard controls

These work whether focus is in Weft's own controls or inside a website. On macOS
use Cmd where the table says Ctrl. Keys marked † are ones websites conventionally
may claim (a web editor that uses Ctrl+F for its own search, for example): Weft
runs them only when the page did not handle the key itself. The others always
go to Weft. Shortcuts are human input only; an agent's key presses never trigger
them. Page tools (the ⋯ button) lists every shortcut.

| Shortcut | Action |
| --- | --- |
| Ctrl K | Find anything: search project records and actions |
| Ctrl L, Alt D | Focus the address bar |
| Ctrl T | New tab |
| Ctrl W | Close the current tab |
| Ctrl Shift T | Reopen the last closed tab |
| Ctrl Tab / Ctrl Shift Tab, Ctrl PageDown / PageUp | Next / previous tab (on macOS also Cmd Option → / ←) |
| Ctrl 1–8, Ctrl 9 | Go to tab 1–8, the last tab |
| Alt ← / Alt → (macOS Cmd [ / Cmd ]) † | Back / forward |
| Ctrl R, F5 † | Reload; Ctrl Shift R or Shift F5 reloads without the cache |
| Escape † | Stop loading (only while the page loads) |
| Ctrl F † | Find in page (find bar: Enter / Shift Enter or F3 / Shift F3, Ctrl G / Ctrl Shift G for next / previous, Escape closes) |
| Ctrl P † | Print, with the system print dialog |
| Ctrl + / Ctrl − / Ctrl 0 † | Zoom in / out / reset (25%–500%) |
| Ctrl D † | Bookmark this page |
| Ctrl U † (macOS Cmd Option U) | View page source |
| F12, Ctrl Shift I (macOS Cmd Option I) | Developer tools |
| Ctrl J † | Downloads |
| Ctrl Shift A † | Search open tabs |
| Alt Shift ↑ / ↓ on a sidebar tab | Move the tab up or down |
| Shift F10 or the menu key | The page's context menu |
| F6 / Shift F6 | Move between the address bar, page, Ask Weft panel, sidebar and content, including from inside a website |
| Escape | Close the current dialog |

Ctrl Shift N opens a private window. Ctrl Alt N moves the current workspace into
a window of its own (Everything always stays in the main window).

## Everyday browsing

- **Address bar.** Typing shows matching open tabs (switch to them), bookmarks
  and this workspace's history, then a search row. Use ↑/↓ and Enter, or Escape
  to close the list; the page steps aside while the list is open. Suggestions
  come from this workspace only and never from history you cleared. Text that
  is not an address goes to the search engine chosen in **Settings → Browsing**
  (Google, DuckDuckGo, Bing, Brave Search, Startpage, Kagi, or a custom
  `https://` address containing `%s` once). Google is the default because it was
  Weft's only engine before. Nothing you type is sent anywhere until you press
  Enter: Weft does not request suggestions from the engine.
- **Find bar.** Ctrl F opens it under the address bar with the match count
  ("2 of 12"), next/previous and Match case. Escape closes it and clears the
  highlights.
- **Zoom.** Ctrl +/−/0 or Page tools. When a page is not at 100% the address
  bar shows its zoom; select it to reset. Zoom is remembered per site and per
  workspace, and survives suspending and reopening tabs.
- **Print.** Ctrl P or Page tools → Print… opens the system print dialog for the
  page you are looking at (the focused pane). Save as PDF remains
  in Page tools.
- **Context menu.** Right-click (or Shift F10) in a page for link, image,
  selection, text-field and page actions: open a link or image in a new tab,
  copy addresses, download a linked file or image to the Weft downloads folder,
  copy, search the web for the selection, send it to Weft, cut/copy/paste,
  spelling suggestions, back/forward/reload, save the page to the workspace,
  print, view source and inspect. A link a site rule blocks is not opened, and
  Weft says why.
- **Recently closed tabs.** Ctrl Shift T, the "Recently closed" entry under the
  tab list, or Page tools list up to 25 closed tabs per workspace. Reopening
  restores the address, scroll position, zoom, pin and group, with you in
  control; form input, sign-ins and in-page state are not restored. Clearing
  history clears the list.
- **Tab order.** Drag tabs in the sidebar to reorder them, onto the pinned
  area to pin them, onto a tab group to add them, or onto another workspace in
  the rail to move them (with the usual storage-container warning). Alt Shift
  ↑/↓ moves the focused tab. The order is saved.
- **Developer tools and page source.** F12 or Inspect opens Chromium DevTools in
  a separate window; Ctrl U opens a read-only source view of the page in a new
  tab that is not saved with your tabs. DevTools are refused for offline
  previews, during a protected sign-in or payment operation, and on a tab an
  agent drives (take control first). While DevTools are open the tab shows
  "DevTools open" and Weft never fills a saved sign-in into it. Agents cannot
  open DevTools or page source: neither is an agent command.

## Everything, windows and panes

**Everything** is the built-in workspace first in the rail (dashed mark). It holds
pages that are not part of a project yet: links and files other apps ask Weft to
open, and, if you choose when deleting a workspace, that workspace's open pages
(they reopen in Everything's own storage container, so sign-ins and page state do
not move). Everything cannot be renamed, archived or deleted. Move tabs out of it
with **Move to workspace**, and materials or captures with **Move to workspace…**
in their dialogs. History, Bookmarks and Find anything (Ctrl/Cmd K) have a
**Show from** switch: this workspace (default), Everything, or all workspaces.

**Links from other apps.** Settings > Links from other apps chooses where they open:
Everything (default), ask each time, or the workspace the main window shows. Links
are treated as data: they pass your site rules like a typed address, never start
an agent action, never download without the usual approval and never give an agent
access; each is logged as supplied by another app. Only `http`/`https` links are
opened (credentials in a URL are refused); `.html`, `.htm` and `.pdf` files are
copied into the workspace as materials, not loaded as live pages. A link that
arrives while Weft is locked opens after you unlock it. **Use Weft for web links**
(installed builds only) registers Weft as a browser; it is never done silently.
Windows then asks you to confirm in Settings > Apps > Default apps; macOS shows its
own prompt; on Linux, stop using Weft by choosing another browser in your desktop
settings. On Windows, choose **Stop using Weft for web links** before uninstalling:
the uninstaller does not change link handling.

**Windows.** Drag a workspace's rail button out of the window, or choose **Move to
new window** in Manage workspaces, to open it in a window of its own; its tabs keep
running and are not reloaded. Each window has its own rail, address bar, active tab
and pane layout. Drag a workspace onto another window's rail to move it there, or
choose **Return to main window**; closing a window returns its workspaces to the main
window. Everything always stays in the main window, and a workspace is shown in one
window at a time. Closing the main window quits Weft; the other windows reopen where
they were at the next launch (a window whose display is gone opens on the primary
display). Locking an encrypted profile closes the other windows; they reopen after
unlocking. Headless sessions use one window. Approvals, the emergency stop and
settings are available in every window.

**Panes.** The split-view button toggles one and two panes; **Page tools > Pane
layout** offers one, two side by side or stacked, three (one large and two stacked,
or three columns) and a 2×2 grid. A pane shows a live tab, a saved capture (or the
offline archive preview), a material or a task: use **Open in new pane** in their
dialogs, or the choices in an empty pane. Drag a divider, or focus it and use the
arrow keys (Shift for larger steps, Home or a double-click to reset). The focused
pane is framed and labelled "Focused"; when it holds a tab, that tab is the active
tab, so the address bar, find, zoom, printing, shortcuts and Send to Weft act on it.
F6 visits every pane. Each tab pane shows who controls it. Visible tabs are never
suspended. The layout is saved with the workspace and restored; older split views
open as two panes. A window too small for the chosen layout shows fewer panes and
says so. Panes are only what you see: agents act on tabs by id as before.

Use the top-right **Ask Weft** button for conversations and the command icon for
the complete command desk. Sidebar controls remain usable without configuring
any model.

## Model connections

Open **Settings → Model connections** and choose **Add connection**. Pick a
provider preset (OpenAI, an OpenAI-compatible endpoint, Anthropic, Gemini,
DeepSeek, Moonshot, Meta Muse, Ollama or JX Runtime), enter a key or the name of
an environment variable that holds it, and choose **Fetch available models**.
Every endpoint stays editable, and a preset is not a claim that an account,
endpoint or model is available. [Workspace agents](WORKSPACE-AGENTS.md#model-connections)
covers discovery and capability labels.

OpenAI-compatible API bases normally end in `/v1`; a local Ollama example is
`http://127.0.0.1:11434/v1`. The Anthropic adapter uses its messages API. An API key
may be supplied through a named environment variable (`OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` are initial defaults), or saved using OS-backed Electron
`safeStorage`. Plaintext key-storage fallbacks are refused. Model keys live in a
separate file and are excluded from project exports.

The panel shows the destination before sending. Inference happens at that
endpoint; local connection failures never silently select a cloud provider.
Text, explicit project context, and enabled read-only tool results may be sent.
Read-only tools require both an enabled model profile and the message's explicit
opt-in. They are limited to the selected tab and conversation workspace, allow
at most five calls per turn (twenty, shared with app tools, when app tools are
on), and cannot click, fill forms, change policies, or execute
arbitrary code. Tool results retain their source and are expandable in chat.

Replies stream as they are written. **Attach** adds a tab snapshot, materials,
context, tasks, exact capture versions or a pasted passage; before sending, the
review lists what the selected model receives item by item, lets you exclude
items, and shows when older history is omitted to fit the model's context window
(your saved conversation is never rewritten). Images go only to connections you
mark or discover (`models.probe`) as image-capable, or to a vision fallback you
configure, after acknowledgement. Each reply shows endpoint locality,
provider-reported tokens and, if you set prices, a labeled cost estimate. The
Ollama native API (`http://127.0.0.1:11434`) is also supported.

Errors, cancellation and
unsupported responses are shown as such; a stopped reply is kept and marked
interrupted, and the application does not manufacture an assistant reply.

## Site permissions, pop-ups, private windows, passwords and extensions

- **Permission prompts.** When a site asks for your camera, microphone,
  location, notifications, clipboard, screen, MIDI devices or motion sensors,
  Weft shows its own prompt naming the site. Choose *Allow on this visit*,
  *Allow while the site is open*, *Always allow*, *Block* (until you close the
  site) or *Always block*; closing the prompt denies the request. Decisions
  belong to one workspace and site, are not exported, imported or carried when
  a tab moves, and are listed in **Site controls** (the shield in the address
  bar) where you can reset each one, stop camera, microphone and screen sharing
  (the page reloads), or turn on *Never ask*. Screen sharing asks you to pick a
  screen or window every time and shows *Sharing* in the address bar. Tabs in
  the background, suspended tabs, headless sessions and pages only an agent is
  driving are denied without a prompt, and agents can never answer one. USB,
  serial, HID, Bluetooth, fullscreen and similar requests are still denied
  without asking.
- **Pop-ups.** A page may open a pop-up within about five seconds of your click
  or key press in that tab (sign-in and payment windows keep their link to the
  page that opened them, so they can report back and close themselves). Other
  pop-ups are blocked; the address bar then shows a count. Open one once, or
  always allow pop-ups from that site in this workspace (reset it in Site
  controls). Site rules still apply to every pop-up.
- **Private windows.** Page tools > *New private window* (Ctrl/Cmd+Shift+N)
  opens a window with its own dark frame. Its cookies and site data stay in
  memory and are erased when its last window closes (also after a crash, since
  nothing is written to disk); it keeps no history, tab records, captures or
  session restore; downloads need a click and always ask where to save; every
  site permission is denied; and agents cannot see or control it. It does not
  hide you from websites, your network or this computer. Only site rules that
  apply to every workspace, and threat lists, apply in private windows.
- **Saved passwords.** After you sign in, Weft offers to save (or update) the
  password for that site in this workspace. The key button in the address bar
  fills a saved sign-in into this site's own form (never a frame from another
  site, never submitted for you) and can suggest a strong password. Page tools >
  *Saved passwords* lists, shows (after a confirmation), deletes, imports
  (Chrome, Edge, Firefox or Safari CSV exports, optionally deleting the export
  afterwards) and exports them. Passwords are encrypted with your system key
  store (Weft refuses to save them without one) and are separate from the
  sign-ins agents may use; agents cannot list, read, fill or reveal them
  ([ADR-020](decisions/020-human-password-manager.md)). Address and card
  autofill are not available.
- **Extensions.** If an enabled extension has a toolbar button, the extensions
  button in the address bar opens its popup or options page in a separate
  window. Badges, Chrome Web Store installs and ad-blocking rules
  (`declarativeNetRequest`) are not supported
  ([ADR-007](decisions/007-extension-compatibility.md)).

## Where your data lives

Electron uses its OS application-data directory by default. Use a separate
profile with:

```sh
npm start -- --user-data-dir=/absolute/path/to/profile
```

Project records are stored under `workspace-data/`; Chromium storage uses a
persistent partition per workspace. Tabs reopen their URLs after restart, without
restoring arbitrary JavaScript state or unsent form input. Moving a tab opens it
in the destination workspace's storage container and may change its login state.
The original foundation's shared `persist:weft` session is not merged into new
workspace containers.

Exports (format 2) include project records with revisions and revision history,
conversations, exact capture versions with their hashes, annotations, copied
material bytes and task/workflow/evidence links. They exclude browser sessions,
cookies, configured model keys, global policies, activity and browsing history.
Imports create new IDs, rewrite citations of exported IDs, verify capture hashes,
report every lossy mapping and leave imported rules/workflows inactive for review;
imported workspace instructions arrive as memory for you to review, learned
memories arrive scoped to the new workspace, and background learning stays off.
The GUI shows a preview first. Copies use this same behavior. Linked files, folders and
service references export as metadata only; their content, local paths and
credentials are omitted and listed in the import report.

Project metadata is a transactional SQLite database (`workspace.sqlite`, WAL
mode, owned by one Weft process through a profile lock); captures and stored
files are verified content-addressed files under `components/`, so editing
metadata never rewrites them. Search uses a local FTS5 index. Weft keeps
verified automatic backups (daily, latest five) and manual backups under
`backups/`; restoring preserves the replaced data under `recovery/`. With Weft
closed, `weft store backups|verify|restore <workspace-data directory>` recovers
a profile whose database cannot be opened. Unless you turn on opt-in workspace
encryption (Settings > Encryption; [ADR-014](decisions/014-workspace-encryption-and-key-management.md)),
none of this is **encrypted**, and backups on the same disk do not protect against losing that disk. Stored
materials are limited to 10 MiB, PNGs to 20 MiB and JSON imports to 100 MiB.
Free-form content, files, and captures can contain private data; export does not
perform comprehensive secret or personal-information redaction.

## What Weft does and does not protect

Remote pages are sandboxed and have no Node integration or privileged preload.
Unsupported protocols and native launches are blocked; web permission requests
are denied unless you allow them in Weft's prompt. Site rules cover documented Chromium request paths, not an external
agent's independent network tools. Unsolicited downloads are cancelled and can be approved from Downloads. Downloads are never executed automatically
and are not claimed to have been scanned for malware unless you configure a local scanner ([ADR-009](decisions/009-destination-intelligence-and-downloads.md)). Keep Electron current for
Chromium security fixes.
