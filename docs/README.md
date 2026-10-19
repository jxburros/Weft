# Weft documentation

Start with the [project README](../README.md) for what Weft is and how control
works. This index groups everything else by who it is for.

## Using Weft

| Document | Read it to |
| --- | --- |
| [Using Weft](USING-WEFT.md) | Run Weft, learn the shortcuts, set up a model, understand where your data lives and what is and is not protected |
| [Workspace agents](WORKSPACE-AGENTS.md) | Set workspace instructions and memory, connect a model provider, approve Ask Weft actions, watch pages and import email |
| [Capture and learning](CAPTURE-AND-LEARNING.md) | Send webmail or page text to Weft, retrieve relevant context, and control background learning |
| [Accessibility](ACCESSIBILITY.md) | See what keyboard and screen-reader support exists and what has been tested |
| [Community lists](COMMUNITY-LISTS.md) | Subscribe to or publish signed site lists |
| [Storage safety](STORAGE-SAFETY.md) | Understand backups, recovery, locking and encryption |
| [Releasing](RELEASING.md) | Learn how installers are built, signed and updated |

## Connecting agents and tools

| Document | Read it to |
| --- | --- |
| [Connecting from the CLI, MCP and REST](CONNECTING.md) | Wire a client to a running Weft and understand scoped tokens |
| [Agent integration](AGENT-INTEGRATION.md) | Write a reliable integration: discovery, outcomes, deadlines, streaming, guidance |
| [Command reference](COMMANDS.md) | Look up every command, error code and exit code (generated) |
| [Plugins](PLUGINS.md) | Understand what plugins can and cannot do |

## Product, design and decisions

| Document | Read it to |
| --- | --- |
| [Core identity](CORE-IDENTITY.md) | Know what Weft is and must not become |
| [Architecture decisions](decisions/) | See why significant choices were made, and which are deferred |
| [Product specification](../AI-Workspace-Browser-Product-Specification.md) | See the intended direction, which is broader than what ships |
| [Visual style guide](../Weft-Visual-Style-Guide.md) and [design system](DESIGN-SYSTEM.md) | Match the interface's look and tokens |

## Contributing and maintenance

These are working records for people changing Weft, not guides for using it.

| Document | Read it to |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | Follow contributor rules and invariants |
| [Implementation coverage](IMPLEMENTATION.md) | Compare shipped behavior to the specification, with evidence and gaps |
| [Validation](VALIDATION.md) and [browser safety audit](BROWSER-SAFETY-AUDIT.md) | See what the checks do and do not establish |
| [Issue disposition](maintainers/ISSUE-STATUS.md) | Trace each completed or partial backlog item |
| [Changelog](../CHANGELOG.md) | See what changed in each version |

Documents that make verification claims (implementation coverage and
accessibility) carry a "Last verified against code" date. Other guides describe
behavior and do not.
