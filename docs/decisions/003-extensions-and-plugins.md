# ADR 003: extensions and native plugin boundaries

Status: accepted and implemented. Weft-native plugins (#61) and per-workspace
unpacked Chromium extensions (#34) ship with the bounded scope below; the
extension compatibility evidence is [ADR-004](004-extension-compatibility.md).
Last reviewed: 2026-10-17.

## Compatibility decision

Do not promise Chrome extension parity. The presence of an API in Electron's
type definitions does not establish Web Store, Manifest V3, service-worker,
native messaging or arbitrary Chrome API support. Weft therefore supports only
what a pinned-version fixture run verified: unpacked Manifest V3 extensions,
installed by a person into one workspace partition with explicit host grants,
an audited permission allowlist, hash pinning and revocation. Everything else
is refused before loading. [ADR-004](004-extension-compatibility.md) records
the per-API matrix, policy and residual risk.

## Weft-native plugin contract

Native plugins are distinct from Chromium extensions and from the external MCP
client plugin in `.claude-plugin/` (which launches Weft, not arbitrary code
inside it). The full reference is [docs/PLUGINS.md](../PLUGINS.md). Manifests
are data-only and strict:

```json
{
  "name": "example-export",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Example export format",
  "hooks": { "export-format": ["example"] },
  "permissions": { "workspaceRead": true, "pageRead": false, "workspaceWrite": false, "origins": [], "nativeAccess": false },
  "commands": {},
  "requires": []
}
```

A manifest cannot carry functions, module import paths or executable schemas
(built-in plugins declare zod field schemas in reviewed source; third-party
plugins declare a bounded JSON-schema subset). Built-in commands are merged into
the catalog as `plugin.<name>.<operation>` and can never shadow core commands;
third-party commands run through `plugins.invoke`. Unknown manifest/schema keys,
unsupported API versions, undeclared hook names, hooks without their required
permission, write/egress/native permissions and duplicate or reserved names are
refused. Listing installed manifests never imports plugin code.

| Named hook | Input | Permitted output |
| --- | --- | --- |
| capture-format | Authorized immutable capture text + metadata | Derived text and MIME type; core adds provenance |
| page-extract | Authorized bounded page snapshot | Untrusted items whose text must equal the cited offsets |
| after-command | Sanitized command metadata | Ignored; no mutation of completed result |
| activity-report | Authorized filtered activity | Report content; core returns cited event ids |
| export-format | Authorized export snapshot | Export bytes + explicit exclusions; core limitations appended |

Core code reaches plugins only through the registry (`hooks(point)`,
`first(point, id)`, `notify(point, event)`). Hook inputs are gathered by
re-entering the dispatcher with the caller's authority, so the same schema,
scope, autonomy and egress checks as built-in commands apply. Built-in plugin
commands receive a frozen capability object with listed reads only, never the
raw service, Electron session, filesystem, provider credentials or Node import
loader. Third-party code runs in a separate process per plugin with Node's
permission model, an empty environment, a small heap, a `vm` context without
Node/network/timer globals or string code generation, JSON-only messages and
per-call time/output limits.

Installation and privileged grant changes require the human interface;
automation callers cannot enable plugins, and third-party plugins never run for
automation callers unless the person explicitly allowed it. Grants bind plugin
name, version and manifest/code digests; any change requires a new grant.
Declared permissions raise the command action class fed to the autonomy gate.
Revocation and emergency stop terminate plugin processes and fail in-flight
calls.

## Core versus plugin checklist

Keep workspace authority, schemas, session isolation, persistence integrity and
tab leases in core. Prefer a plugin for an optional format, site-specific
extraction or reporting integration with a narrow named hook. If a feature needs
unrestricted core imports or bypasses policy, redesign the boundary; do not add
a privileged escape hatch to make it fit. The ordered checklist is in
[docs/PLUGINS.md](../PLUGINS.md#is-a-new-feature-a-plugin). Community site lists
were reviewed against it and remain core because they install workspace policy.

## Verification

- `test/plugin-boundary.test.js`: core→plugin imports only through the registry,
  plugin→core and infra→service imports, dynamic loader shortcuts in core, a
  shrinking `KNOWN_COUPLINGS` list, and self-checks that the scanner catches
  violations. Built-in plugins exist, so the check is not vacuous.
- `test/plugins.test.js`: manifest/schema injection, overprivileged requests,
  catalog merging and classification, all five hooks end to end, output
  contract enforcement, cross-workspace reads through scoped clients, discovery
  without execution, digest-bound enablement, automation exclusion, sandbox
  escapes (`require`, `process`, `fetch`, `eval`, constructor escape, timers),
  infinite loops, output/memory exhaustion, revocation during a call, reserved
  names and emergency stop.
- `test/extension-policy.test.js` and `test/extensions-browser.test.js`: see
  ADR-004.

## Remaining limits

- Plugin grants are profile-wide rather than per workspace (plugins only see
  the workspace the caller targets).
- Third-party plugins have no capability RPC back into Weft beyond the record
  collections they declare; there is no plugin-specific approval broker.
- The plugin sandbox is defense in depth (permission model + `vm` + process),
  not an OS-level network sandbox.
- Extension residual risk is described in ADR-004.
