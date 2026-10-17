# Weft

An agent-human handshake browser: a Chromium GUI with the same command catalog
available through the CLI, authenticated REST API, and MCP.

## Run

Requires Node.js 22.12+, npm, and a desktop session on Linux, macOS, or Windows.
Electron supplies Chromium; you do not need a separate Chrome installation.

```sh
npm ci
# Choose a strong token and keep it out of source control:
export WEFT_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
npm start
```

The browser opens with a tab bar, address bar, navigation controls, and a
**Command desk**. The desk discovers every command and its input schema from the
same catalog used by the API and MCP. Results appear alongside the live page;
screenshots and PDFs can be saved from the desk.

The API listens **only on `127.0.0.1:9222`**. Set `WEFT_PORT` before starting to
choose another port. If `WEFT_TOKEN` is omitted, Weft generates a random token and
prints it to the local terminal; copy it into the CLI/MCP environment.
In PowerShell, use `$env:WEFT_TOKEN = ...` instead of `export`.

Browser storage uses Electron's persistent `weft` partition in the OS application
data directory; pass `npm start -- --user-data-dir=/absolute/path/to/profile`
to use a separate profile. Tabs are shared live between humans and agents, but are not
restored after restart. Downloads are saved under the OS Downloads directory in
`Weft/`, with unique filenames to prevent overwrites.

## CLI

Keep the browser running. In another terminal, use the same `WEFT_TOKEN`:

```sh
node bin/weft.js commands
node bin/weft.js tabs.new '{"url":"https://example.com"}'
node bin/weft.js page.title
node bin/weft.js page.fill '{"selector":"input[name=q]","value":"hello"}'
node bin/weft.js page.click '{"selector":"button[type=submit]"}'
node bin/weft.js page.screenshot '{"fullPage":true}'
```

`npm run cli -- <command> '<JSON arguments>'` is equivalent. `npm link` optionally
makes the `weft` command available on your PATH. Output is JSON; errors go to
stderr with a nonzero exit code. Omit `tabId` to target the active tab. CLI and MCP
use `WEFT_API_URL` (default `http://127.0.0.1:9222`); only loopback HTTP origins are
accepted and redirects are not followed.

## REST API

Every request requires an `Authorization` header using the `Bearer` scheme and
the browser token. There are two routes:

* `GET /v1/commands` → `{ "commands": { "<name>": { "description", "inputSchema" } } }`
* `POST /v1/execute` with `{ "command": "<name>", "args": {} }` → `{ "result": ... }`

```sh
AUTH_HEADER=$(printf 'Authorization: %s %s' 'Bearer' "$WEFT_TOKEN")
curl -H "$AUTH_HEADER" http://127.0.0.1:9222/v1/commands
curl -H "$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"command":"tabs.new","args":{"url":"https://example.com"}}' \
  http://127.0.0.1:9222/v1/execute
```

Errors have the shape `{ "error": { "message": "..." } }`. Status codes:
`400` invalid command/arguments/JSON, `401` authentication failure, `403`
browser-origin request, `404` unknown route, `413` body larger than 1 MiB,
`415` wrong content type, and `422` browser execution failure.
Unknown argument fields are rejected, not silently ignored.

### Command catalog

| Commands | Arguments |
| --- | --- |
| `browser.info`, `browser.close` | `{}` |
| `tabs.list` | `{}` |
| `tabs.new` | optional `url` (defaults to `about:blank`) |
| `tabs.activate`, `tabs.close` | required positive integer `tabId` |
| `page.navigate` | required `url`, optional `tabId` |
| `page.back`, `page.forward`, `page.reload`, `page.stop` | optional `tabId` |
| `page.title`, `page.content` | optional `tabId` |
| `page.evaluate` | required JavaScript `expression`, optional `tabId` |
| `page.click` | required CSS `selector`, optional `tabId` |
| `page.fill` | required `selector` and string `value`, optional `tabId` |
| `page.screenshot` | optional `tabId`, `fullPage` |
| `page.pdf` | optional `tabId` |
| `cookies.list` | optional HTTP(S) `url` |
| `cookies.set` | required HTTP(S) `url`, `name`, `value`; optional `secure`, `httpOnly` |
| `cookies.clear` | `{}` (clears cookies only) |
| `downloads.list` | `{}` |
| `downloads.cancel` | required positive integer `downloadId` |

Screenshots and PDFs return `{ "data": "<base64>", "mimeType": "..." }`.
`page.evaluate` returns a JSON-serializable value (`undefined` becomes `null`);
non-serializable results fail. `page.fill` supports inputs, textareas, selects,
and content-editable elements and dispatches input/change events.
Navigation permits HTTP(S) and `about:blank`, not local files or URLs containing
credentials. Back/forward/reload initiate navigation; query the page again after
it has loaded. `downloads.list` tracks this run's downloads only.

## MCP

Start the browser first, then configure an MCP client to launch the stdio bridge:

```json
{
  "mcpServers": {
    "weft": {
      "command": "node",
      "args": ["/absolute/path/to/Weft/bin/weft.js", "mcp"],
      "env": {
        "WEFT_TOKEN": "<same token as the running browser>",
        "WEFT_API_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

Every command is an MCP tool, with dots replaced by underscores
(`page.navigate` → `page_navigate`). Input schemas match REST and GUI exactly.
Screenshots return MCP image content; other results return JSON text. Tool
execution failures return `isError: true`. The bridge writes only MCP protocol
messages to stdout. You can also launch it with `npm run mcp --silent`.

## Security and scope

Treat the token as full control of the browser profile: authorized agents can
read pages/cookies, execute page JavaScript, initiate downloads, and quit the
browser. Use a dedicated profile and do not expose the API through a public
proxy. The API has no CORS support and rejects browser-origin requests.
Remote pages have no Node.js integration or privileged preload, run sandboxed
with context isolation, and cannot call the GUI's IPC bridge. Permission
requests are denied by default. Popups become managed tabs; unsupported
navigation schemes are blocked.

This is a runnable browser foundation, not a Chrome distribution: it does not
include Chrome account sync, extensions, a password manager, an installer, or
automatic application updates. All **implemented browser commands** are exposed
through all four interfaces. Keep Electron current for Chromium security fixes.

## Development

```sh
npm test
```

Tests use Node's built-in test runner. The interface tests exercise validation,
authentication, REST, the CLI subprocess, and MCP protocol discovery/execution.
The real Chromium integration test also exercises the GUI, page interaction,
screenshots/PDFs, cookies, and downloads. On Linux without `DISPLAY` it is
explicitly skipped; run `xvfb-run -a npm test` to include it. Integration-test
subprocesses use `--no-sandbox` for CI environments without a configured setuid
helper; the normal application does not disable the sandbox.

No separate bundler or compilation step is required. On headless Linux, launch
the GUI under an X server (for example, `xvfb-run -a npm start`); a normal desktop
launch is recommended for interactive use. Do not disable Chromium's sandbox in
production.
