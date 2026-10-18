# Weft

**Everything needed to continue a project is here, for you or the agent you choose.**

Weft is a desktop browser built around persistent project workspaces. Each
workspace keeps its tabs, notes, files, decisions, tasks, conversations and saved
page captures together, so you can close the window on Friday and pick the work
up on Monday, or hand it to an agent, without re-explaining anything.

![Weft workspace overview](artifacts/weft-overview.png)

## What it looks like in practice

You are releasing an album. One workspace holds the radio-station submission
pages, your artist site, the approved bio, press photos, a tracker of who you have
contacted, and your submission instructions. You review candidate stations in one
tab while an agent researches alternatives in another. When it wants to fill in a
form or run a script, the request waits for you to approve it. When you want a
tab back, you take it, and the agent's control ends. A week later, you or a
different agent can open the workspace and see what is done, what is waiting and
what comes next. The pages you cited are still there as saved captures, even if
the sites have changed.

## How control works

You are always the one in charge, and you can see what is happening.

- **Every tab has a visible owner.** You drive, you and an agent share, or the
  agent drives. Only you can change that, and taking a tab back invalidates the
  agent's control.
- **Agents ask before acting outside your project.** Reading and local note-taking
  run freely. Clicks, form fills, scripts and sending content to a model wait in
  an approval queue until you allow them once, for a period, or by standing
  grant.
- **Each agent gets its own limits.** Tokens are scoped by workspace, sites,
  data and lifetime, and revoking one takes effect on the next command.
- **Everything is recorded.** The activity log shows what ran, what was asked and
  what was decided. A stop control halts agent activity at once.
- **Pages are data, not orders.** Text from a page, a capture or an import never
  gains the authority to instruct an agent.

The same rules apply whether an agent works through the built-in chat, the CLI,
MCP or REST. Details: [connecting clients](docs/CONNECTING.md) and
[ADR-005](docs/decisions/005-agent-authority-and-audit.md).

## What you can do

- **Browse** with native Chromium pages, separate sign-in state per workspace,
  split view, bookmarks, history, downloads and find.
- **Organize** notes, website references, copied files, and what you have
  confirmed, found, asked and decided, per workspace.
- **Continue work** with tasks that record objectives, blockers, checkpoints and
  next steps, and reusable workflows that pause for your approval. Work whose
  outcome is unknown is marked `uncertain` instead of being retried blindly.
- **Keep evidence** by saving readable page text and screenshots as versions you
  can open offline and cite later.
- **Choose your model** among OpenAI-compatible endpoints, Anthropic or local
  Ollama. You see where each message goes and exactly what it includes before it
  is sent. Weft never silently switches to a cloud provider.
- **Set boundaries** with personal site rules, blocked redirects and background requests,
  per-site storage controls and optional signed community lists.
- **Automate** from outside the app. The GUI, CLI, MCP and REST all use the same
  validated commands.

## Install and run

Requires **Node.js 22.13+**, npm, and a desktop session.

```sh
npm ci
node node_modules/electron/install.js
npm start
```

The control API listens only on `127.0.0.1:9222`. Weft prints a random access
token to the terminal at startup, or you can set your own with `WEFT_TOKEN`. Use
`npm start -- --user-data-dir=/absolute/path` for a separate profile, and see
[Using Weft](docs/USING-WEFT.md) for headless mode, installers, updates,
keyboard shortcuts and model setup.

Open **Ask Weft** (top right) for conversations and the command icon for the full
command desk. Everything in the sidebar works without configuring a model.

## Connect an agent

With Weft running and the same token in your client's environment:

```sh
node bin/weft.js commands
node bin/weft.js workspaces.list
node bin/weft.js tabs.new '{"url":"https://example.com"}'
node bin/weft.js page.readable
node bin/weft.js tasks.create '{"title":"Review the source","objective":"Check the evidence"}'
```

For MCP clients, point them at `bin/weft.js mcp`. The setup, REST endpoints, scoped
tokens and error codes are in [docs/CONNECTING.md](docs/CONNECTING.md), and guidance for
integration authors is in [docs/AGENT-INTEGRATION.md](docs/AGENT-INTEGRATION.md).

## Status and limits

This is version 1.1.0: a working browser that implements a large part, but not all,
of the [product specification](AI-Workspace-Browser-Product-Specification.md).
[Implementation coverage](docs/IMPLEMENTATION.md) assesses it section by section.

Please know before relying on it:

- **It is a local, single-user application.** Sync and collaboration are
  deliberately deferred ([ADR-002](docs/decisions/002-sync-collaboration-remote.md)).
- **Installers are unsigned** until signing credentials are configured. Windows may show a SmartScreen warning; see [Using Weft](docs/USING-WEFT.md#installers-and-updates).
- **Not yet independently verified:** the credential broker, payment
  authorization with real merchants and card issuers, screen-reader behavior, and
  the OS key stores used by optional workspace encryption.
- **Your data is not encrypted** unless you turn on workspace encryption, and
  backups on the same disk do not protect against losing the disk.
- **Weft does not protect secrets from an agent that controls your computer.** A
  page an agent can read or script is as powerful as the account signed in to it.
- **Extensions** are limited to audited, unpacked Manifest V3 packages
  ([ADR-007](docs/decisions/007-extension-compatibility.md)).

More on protections and their limits: [Using Weft](docs/USING-WEFT.md#what-weft-does-and-does-not-protect).

## Documentation

See the [documentation index](docs/README.md). It separates guides for using
Weft from material for people changing it.

To contribute, read [AGENTS.md](AGENTS.md), then run:

```sh
npm test
npm run test:docs
npm run evals
# Include real Chromium and GUI tests on headless Linux:
xvfb-run -a npm test
```

No bundler or compilation step is needed. Fonts and logos carry their own
licenses and provenance: `assets/fonts/LICENSE.md` and
[assets/logo/README.md](assets/logo/README.md). Weft is MIT licensed.
