# ADR 003: extensions and native plugin boundaries

Status: design only; third-party loading unsupported. Issues #34 and #61 remain
open pending implementation and hostile-plugin tests. Last reviewed: 2026-10-17.

## Compatibility decision

Do not promise Chrome extension parity. Electron 44 exposes session extension
loading APIs, but the presence of an API in Electron's type definitions does not
establish Web Store, Manifest V3, service-worker, native messaging or arbitrary
Chrome API support. Weft currently has no extension installer, manifest audit,
scoped grant store, revocation lifecycle or compatibility fixture suite. Loading
an extension directly in a privileged browser session is not an acceptable
substitute for that work. No installation surface is offered while unsupported.

A compatibility evaluation must pin Electron/Chromium versions and run fixtures
for storage, content scripts, tabs/navigation, webRequest, background/service
workers and host permissions in isolated workspace partitions. Test unknown
permissions/APIs, wildcard origins, cross-workspace reads, native messaging,
credential access and revocation. Publish a per-API support/denial matrix from
those results. Static type inspection alone cannot close #34.

## Weft-native plugin contract

Keep native plugins distinct from Chromium extensions and from the external MCP
client plugin in `.claude-plugin/` (which launches Weft, not arbitrary code inside
it). A proposed manifest is data-only and strict:

```json
{
  "name": "example-export",
  "version": "1.0.0",
  "apiVersion": 1,
  "commands": ["plugin.example-export.export"],
  "hooks": ["export-format"],
  "permissions": { "workspaceRead": true, "workspaceWrite": false, "origins": [], "nativeAccess": false }
}
```

A manifest cannot carry functions, module import paths or executable schemas.
Commands provide declarative strict JSON schemas that the catalog validates;
names must use `plugin.<name>.<operation>`, never shadow built-ins. Reject unknown
manifest/schema keys, unsupported API versions and undeclared hook names. Merely
listing installed manifests must never import plugin code.

| Named hook | Input | Permitted output |
| --- | --- | --- |
| capture-format | Authorized immutable capture + format options | New derived artifact bytes and provenance |
| page-extract | Authorized bounded page snapshot | Untrusted extracted text + source locations |
| after-command | Sanitized command metadata | Informational event; no mutation of completed result |
| activity-report | Authorized filtered activity | Report content with source references |
| export-format | Authorized export snapshot | Export bytes + explicit exclusions |

Core code reaches plugins only through a registry dispatcher at these hooks.
The registry routes requested commands into the same schema/authority/egress
checks as built-ins. Every call receives a scoped capability object, never the
raw service, Electron session, filesystem, provider credentials or Node import
loader. A JavaScript object facade alone is not an isolation boundary: run
third-party code in a separately sandboxed worker/process with bounded RPC,
time/memory/output budgets and no inherited ambient native/network authority.

Installation and privileged grant changes require the existing human interface;
automation callers cannot install or enable plugins by default. Grants bind
plugin identity/version to workspace, actions, destinations and data categories.
Revocation terminates in-flight plugin processes and invalidates outstanding
capabilities. Upgrades that expand permissions require a new human grant.

## Core versus plugin checklist

Keep workspace authority, schemas, session isolation, persistence integrity and
tab leases in core. Prefer a plugin for an optional format, site-specific
extraction or reporting integration with a narrow named hook. If a feature needs
unrestricted core imports or bypasses policy, redesign the boundary; do not add
a privileged escape hatch to make it fit.

## Implementation and verification still required

Implement manifest discovery/validation, a registry, namespace integration,
scoped sandbox RPC, grant/revocation storage and UI before enabling plugins.
Then add an import-boundary test scanning core import statements for plugin
implementation paths (and forbid dynamic loader shortcuts), plus adversarial
fixtures for privilege escalation, manifest/schema injection, cross-workspace
reads, egress, denial of service, revocation during calls and duplicate names.
An import-boundary test over a repository with no plugin implementation would
be vacuous, so this ADR does not claim it as completed validation.
