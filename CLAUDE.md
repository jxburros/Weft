# Weft agent overlay

Read [AGENTS.md](AGENTS.md), the canonical contributor instructions. This overlay
adds no authority or approval rules.

Before reporting a change: check implementation and relevant regression tests,
update affected docs/guidance and CHANGELOG.md, regenerate guidance if changed,
and report unverified items. For schema/MCP changes run docs checks and offline
evals. Keep manifests/version strings aligned on a version change. New optional
integrations should pass the core-versus-plugin checklist in
`docs/decisions/003-extensions-and-plugins.md`.
