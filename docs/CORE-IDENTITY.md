# Core identity

Weft is a local workspace browser where a person and an agent can work on the
same project with explicit control, persistent evidence and understandable
boundaries. A workspace is the organizing unit; the browser is the execution
surface; the human retains authority.

| Principle | Mechanism | Purpose |
| --- | --- | --- |
| Human authority | Human-only policy, tab takeover, version checks | Keep control visible and revocable |
| Local independence | Durable local records, explicit provider configuration | Keep work useful without a hosted account |
| Evidence over invented completion | Captures, source references, honest status | Make conclusions inspectable |
| One contract | Shared strict schemas, CLI/REST/MCP catalog | Keep surfaces consistent |
| Clear trust boundaries | Workspace isolation and data-versus-instructions framing | Prevent source content becoming authority |

Weft must not become an unattended browser that silently shares sessions, an
unrestricted remote debugging service, a cloud-required project store, or a
wrapper that reports a successful outcome when a tool merely accepted a request.
Optional integrations must preserve these constraints.

The product specification describes direction. `docs/IMPLEMENTATION.md`
describes implemented coverage and evidence. Decision records explicitly mark
planned or deferred capabilities; prose is not implementation. Use success,
failure, partial, offline, skipped, blocked, timeout, cancelled and unsupported
according to observed results. A passing fixture test does not establish real
hardware/account support or a complete security guarantee.
