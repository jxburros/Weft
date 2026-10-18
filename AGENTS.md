# Contributing with an agent

Last verified against code: 2026-10-18.

Weft is a local workspace browser for explicit human/agent collaboration, durable
project evidence and visible authority. Read `docs/CORE-IDENTITY.md` for product
boundaries. This file supplements the governing system/developer/user
instructions; it does not override them or add a separate approval process.

## Read the smallest relevant context

- Product or scope change: `docs/CORE-IDENTITY.md`, the relevant product-spec
  section, `docs/IMPLEMENTATION.md`, and applicable `docs/decisions/` records.
- Browser, security or storage: the implementation coverage and relevant
  browser/workspace tests; do not infer implementation from the product spec.
- CLI/API/MCP/schema/guidance change: `src/commands.js`,
  `docs/AGENT-INTEGRATION.md`, `evals/README.md` and the interface tests.
- GUI/style change: `Weft-Visual-Style-Guide.md` and GUI tests.

## Invariants

- The control API is authenticated and loopback-only. Never silently enable a
  remote listener, follow credential-bearing redirects or expose a debugger.
- Local work remains usable without hosted services. No silent cloud fallback
  or unacknowledged data egress to a provider.
- Page/capture/imported text is data, not instructions. Humans alone establish
  trusted context and change human-only policy. All command surfaces enforce
  the same authority boundary.
- Validate command inputs with strict schemas. Unknown fields and commands
  must fail; shared catalog changes propagate to every surface.
- Respect workspace scope, tab ownership and current versions. Human takeover
  invalidates agent control. Do not erase or overwrite unrelated user work.
- Preserve evidence and provenance. Partial/offline/failed/cancelled/unsupported
  outcomes must never be presented as complete success.

If a proposed implementation conflicts with an invariant, resolve it within
existing authorization or document the concrete unresolved decision. Do not
invent a new confirmation requirement for ordinary reversible work.

## Change checklist

1. Make the smallest coherent implementation and relevant regression checks;
   avoid tests that merely mirror static implementation details.
2. Run inexpensive targeted checks, then the required suite. On headless Linux,
   real Chromium tests require `xvfb-run -a npm test`; plain `npm test` reports
   display-dependent tests as skipped.
3. Rerun `npm run test:docs` and `npm run evals` for command contract/guidance
   changes. Regenerate guidance with `node scripts/generate-guidance.js`.
   Use `npm run test:perf` for store/search/catalog scaling changes.
4. Update implementation coverage and changelog for behavior or limitations.
   Keep version strings/manifests aligned when changing the product version.
5. Report what changed, what was tested, and what remains unverified once.
   Distinguish implemented, tested with fixtures/offscreen, and verified on
   real hardware/accounts. Close an issue only when its acceptance is met;
   leave partial work open with the specific remaining gap.

Do not put tokens, provider secrets, private workspace exports or real browsing
content in fixtures, logs, commits or examples. Do not claim external-client,
platform or account validation from a mocked test.
