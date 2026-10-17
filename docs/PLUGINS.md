# Weft plugins

Last verified against code: 2026-10-17.

Weft plugins add optional formats, extractors, reports and small read-only
commands without widening core authority. They are distinct from Chromium
browser extensions ([ADR-007](decisions/007-extension-compatibility.md)) and
from the external MCP client plugin in `.claude-plugin/`, which only launches
Weft. The governing decision is [ADR-003](decisions/003-extensions-and-plugins.md).

## Layers

| Layer | Files | May import |
| --- | --- | --- |
| Core | `src/*.js` | Other core modules and **only** `src/plugins/registry.js` from the plugin layer |
| Plugin infrastructure | `src/plugins/registry.js`, `manifest.js`, `sandbox.js`, `sandbox-child.cjs` | Pure core helpers (`autonomy.js`, `storage-safety.js`), never services or the catalog |
| Built-in plugins | `src/plugins/builtin/*.js`, listed in `builtin/index.js` | `zod` and sibling plugin files only |
| Third-party plugins | `<user data>/plugins/<name>/` | Nothing: data files read by the registry, code run only in a sandbox process |

`test/plugin-boundary.test.js` scans every source import and fails on a new
core-to-plugin import, a plugin importing core, plugin infrastructure importing
a core service, or a dynamic loader shortcut (`import()`, `require`,
`createRequire`, `new Function`, `eval`, `node:vm`) in core. Reviewed exceptions
live in its `KNOWN_COUPLINGS` list, and stale entries fail so the list only
shrinks. The only current entry is the Electron preload's required CommonJS
`require('electron')`, which is unrelated to plugins.

## Manifest

Manifests are strict, data-only objects (`src/plugins/manifest.js`). Unknown
keys, unsupported API versions, undeclared hook names, handler-less
declarations and executable values are refused.

```json
{
  "name": "csv-export",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "CSV exports of context titles",
  "permissions": { "workspaceRead": true, "pageRead": false, "workspaceWrite": false, "origins": [], "nativeAccess": false },
  "hooks": { "export-format": ["csv"] },
  "commands": {
    "count": {
      "description": "Count context records",
      "actionClass": "local_read",
      "reads": ["context"],
      "input": { "type": "object", "properties": { "label": { "type": "string", "maxLength": 20 } }, "required": ["label"], "additionalProperties": false }
    }
  },
  "requires": []
}
```

- `name`: 2–40 lowercase letters, digits or hyphens; built-in names are
  reserved, and a third-party directory name must equal it.
- `permissions`: `workspaceRead` (records of the workspace the caller already
  targets) and `pageRead` (the bounded readable text of an explicitly targeted
  page) are the only grantable capabilities. `workspaceWrite` is refused as
  unsupported; `origins` (network egress) and `nativeAccess` are denied. A
  plugin asking for them is listed as invalid, not loaded with fewer rights.
- `hooks`: hook point → handler ids. Each point requires the permission listed
  below.
- `commands`: built-in commands use zod field schemas and any action class;
  third-party commands use a bounded JSON-schema subset (string with
  `maxLength`, number/integer bounds, boolean, array with `maxItems`; no
  `pattern`) and must be `local_read`. `reads` names record collections the
  core passes in (`materials`, `context`, `tasks`, `artifacts`, `activity`).
  `workspaceId` is reserved: the core supplies the authorized target.
- `requires`: plugins that must be active for this plugin to be active.

The effective action class of a plugin command is the more restrictive of its
declared class and what its permissions imply (`pageRead` → `external_read`).
That class feeds `evaluateAutonomy`, so automation callers are denied anything
beyond reads, and scoped client tokens need the `read` scope.

## Named hook points

Core code reaches plugins only through `PluginRegistry.hooks(point)`,
`first(point, id)` and `notify(point, event)`. Inputs are gathered by core
through the dispatcher with the caller's own authority, validated against the
hook's input schema, deep-frozen for built-ins, and outputs are validated
before use.

| Hook | Permission | Signature | Core caller |
| --- | --- | --- | --- |
| `capture-format` | workspaceRead | `(capture {artifactId, workspaceId, versionId, number, title, url, createdAt, method, text, components, limitations}) → {mimeType, content}`; images are never passed | `artifacts.render` |
| `page-extract` | pageRead | `(snapshot {url, title, text, links}) → {items: [{kind, text, start, end}]}`; every item must equal `text.slice(start, end)` | `page.extract` |
| `after-command` | none | `(event {command, actor, status, workspaceId, actionClass, createdAt}) → ignored` | dispatcher, after the outcome is final |
| `activity-report` | workspaceRead | `(activity {workspace {id, name}, generatedAt, events: [...]}) → {mimeType, content}` | `activity.report` |
| `export-format` | workspaceRead | `(snapshot weft-workspace export) → {mimeType, extension, content, exclusions[]}`; core limitations are always appended | `workspaces.exportAs` (human only, like JSON export) |

An unknown format/extractor id fails with the `unsupported` error code. Observer
failures are counted and never change or delay a command outcome; observers do
not run for automation callers while the emergency stop is active.

## Built-in plugins

| Plugin | Hooks | Commands | Permissions |
| --- | --- | --- | --- |
| `markdown` | `export-format`, `capture-format`, `activity-report` (`markdown`) | `plugin.markdown.digest` | workspaceRead |
| `citations` | `page-extract` (`citations`: URLs, DOIs, arXiv ids with offsets) | — | pageRead |
| `session-stats` | `after-command` (`count`) | `plugin.session-stats.summary` (in-memory, this run only) | workspaceRead |

Built-in commands join the one shared catalog as `plugin.<name>.<operation>`,
so GUI, REST, CLI and MCP (`weft_workspace`) all expose them with strict
schemas. Built-ins are enabled by default; `plugins.disable` turns one off
(persisted) and its commands then fail with `unavailable`. Built-in commands
receive a frozen capability `{workspaceId, actor, store, read(command, args)}`.
`read` allows only listed record reads (and `page.readable` with `pageRead`) and
re-enters the dispatcher with the caller's context, so a scoped client gets no
more than its token allows.

Markdown output escapes untrusted record text so viewers cannot turn it into
HTML, links or code that looks like Weft structure. The Markdown export cannot
be imported back; use JSON for round trips.

## Third-party plugins

1. Place `weft-plugin.json` and `plugin.js` in `<user data>/plugins/<name>/`.
   `plugin.js` assigns `globalThis.weftPlugin = { hooks: { point: { id(input) } }, commands: { op(args, data) } }`.
   Handlers are synchronous and return JSON-serializable values.
2. `plugins.list` (any caller) reads manifests and hashes files; it never
   imports or runs code. It shows status (`disabled`, `enabled`, `changed`,
   `invalid`), permissions, hooks, commands, problems and a human-readable scope.
3. A person enables it in **Settings → Plugins & browser extensions** or with
   `plugins.enable` (human only), supplying the listed `manifestSha256` and
   `codeSha256`. The grant binds name, version and both digests; any file
   change marks it `changed` and stops it until re-enabled. Upgrades therefore
   always need a new grant.
4. Third-party hooks and `plugins.invoke` never run for automation callers
   unless the person ticked “allow agents” (`allowAutomation`).
5. `plugins.disable` revokes the grant and kills the plugin process; in-flight
   calls fail as `cancelled`. Emergency stop also terminates plugin processes.

Third-party code runs in one child process per plugin: Node's permission model
(no filesystem, child processes, workers or addons), an empty environment, a
64 MiB heap, `--disallow-code-generation-from-strings`, and a fresh `vm`
context without `require`, `process`, timers, `fetch` or string code
generation. Only JSON strings cross the boundary. Each call has a 2 s limit and
an 8 MiB output limit; a timeout kills the process. The registry checks that the
code defines exactly the declared handlers.

Third-party commands are invoked through `plugins.invoke {name, operation,
args}` rather than appearing as `plugin.<name>.*` catalog entries, because the
strict shared catalog is also loaded by detached CLI/MCP processes that cannot
see runtime enablement. Their results are labelled untrusted.

## Limits

- Grants are profile-wide, not per workspace; plugins only see the workspace a
  caller already targets, but a person cannot enable a plugin for one
  workspace only.
- There is no capability RPC from third-party code back into Weft: third-party
  commands receive only validated arguments and the record collections they
  declared. Built-in plugins may call the listed reads.
- The `vm` context plus permission-model process is defense in depth, not a
  formally verified sandbox; a V8 or Node escape would reach an unprivileged
  child process that has network access at the OS level.
- No plugin can write records, change policy, reach the network, read
  credentials or touch Electron objects.
- Inside Electron the sandbox process is the Electron binary run as Node
  (`ELECTRON_RUN_AS_NODE`). A future packaged build that disables the
  RunAsNode fuse must ship another Node runtime for plugins, or third-party
  plugins will fail to start (they fail closed, not unsandboxed).

## Is a new feature a plugin?

Answer in order; the first “no” keeps the feature in core or calls for a
boundary redesign. Do not add a privileged escape hatch to make a feature fit.

1. Is it optional, so Weft remains coherent and safe without it?
2. Does it fit an existing named hook (a format, an extractor, a report, an
   observer) or a read-only command over data the caller can already read?
3. Can it work with `workspaceRead`/`pageRead` only — no writes, egress,
   credentials, sessions, policy or native access?
4. Does it avoid workspace authority, schemas, session isolation, persistence
   integrity, tab leases and policy enforcement? Those stay in core.
5. Can its output be validated by the hook contract and labelled untrusted?
6. Would disabling it leave records, policies and evidence intact?

If all answers are yes, prefer a plugin. Built-ins live under
`src/plugins/builtin/` and pass the boundary test; anything needing a new hook
point requires an ADR update, a hook schema in `manifest.js`, a core call site
using `hooks()`/`first()`, and adversarial tests. Community site lists were
reviewed and stay in core: they install workspace policy, which question 3
excludes.
