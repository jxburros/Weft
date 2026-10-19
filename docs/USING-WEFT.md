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

The API binds only to `127.0.0.1:9222`. Without `WEFT_TOKEN`, the browser generates
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

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd K | Search project records and actions |
| Ctrl/Cmd L | Focus the address bar |
| Ctrl/Cmd T | New tab |
| Ctrl/Cmd W | Close the current tab |
| Ctrl/Cmd F | Find in page |
| Ctrl/Cmd J | Downloads |
| Ctrl/Cmd Shift A | Search open tabs |
| F6 / Shift F6 | Move between the address bar, page, Ask Weft panel, sidebar and content, including from inside a website |
| Escape | Close the current dialog |

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
at most five calls, and cannot click, fill forms, change policies, or execute
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
Unsupported protocols and native launches are blocked; permission requests are
denied. Site rules cover documented Chromium request paths, not an external
agent's independent network tools. Unsolicited downloads are cancelled and can be approved from Downloads. Downloads are never executed automatically
and are not claimed to have been scanned for malware unless you configure a local scanner ([ADR-009](decisions/009-destination-intelligence-and-downloads.md)). Keep Electron current for
Chromium security fixes.
