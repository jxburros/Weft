# Workspace agents in Weft 1.2

Edit a workspace from **Manage workspaces → Edit**. Descriptions, custom
instructions and memory are durable workspace fields. General workspaces are
ongoing; projects can have a due date. Dates are labels, not automatic deletion
or shutdown deadlines. Existing workspaces behave as general workspaces.

Ask Weft includes these fields in its itemized request preview. You can exclude
individual fields, or mark workspace context as on-device only. Only a person
can establish instructions or change that sharing setting. Memory is reference
data, never authority; Ask Weft can propose an update to it for review. Import
places imported instructions in memory for review rather than trusting them.

## Model connections

Choose a provider in Settings, enter its key or environment-variable name, and
fetch available models. Entering a key fetches automatically when it loses
focus. Discovery paginates and uses the selected destination only, without
workspace data, browser cookies or redirects. Unknown capabilities stay unknown;
endpoint reports or your configuration determine image/tool support and context
limits. The chat picker shows the configured connection's effective capabilities.
Not every listed model is a chat model; embeddings, audio and image-generation
endpoints are not chat transports.

Presets: OpenAI, OpenAI-compatible endpoints, Anthropic, Gemini, DeepSeek,
Moonshot, Meta Muse, Ollama and JX Runtime. Gemini uses Google's documented
OpenAI compatibility endpoint. Meta's [chat API](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions)
is OpenAI-compatible at `https://api.meta.ai/v1`. JX Runtime uses its
`/v1/models` and `/v1/chat/completions` endpoints at port 8712 by default.
All destinations remain editable. Model IDs come from discovery, not a static
provider catalog. Provider accounts have not been exercised in live tests.

## Permissioned app actions

Enable **Let Ask Weft propose app actions** for a turn, using a model connection
with tools enabled. `app_commands` discovers the same strict schemas used by
CLI/REST/MCP. `propose_action` records an exact command and arguments. Review the
proposal and choose **Approve and run once** to execute it through the trusted
GUI. The conversation receives an outcome receipt; a proposal itself is never
reported as execution. Review is per action. Multi-step work can use a proposed
durable task plan and the task runtime's own permission checks. This does not
automatically resume a model turn after approval: send a follow-up to continue.

Appearance changes use `settings.update`: theme, accent (plum/ocean/forest/rose),
density and text scale. No generated JavaScript or arbitrary CSS is executed.
Native Anthropic and Ollama tools and OpenAI-compatible tools use the same
proposal and read-tool contracts. Read-only turns retain their five-call limit;
app-tool turns allow up to twenty calls, all proposals still waiting on a person.

## Standby web watches

Create or edit a workflow and add a watch URL, interval and optional text to
match. Enable it only after reviewing its steps. The first successful check
sets a baseline. Subsequent content changes wake the workflow; with text to
match, it wakes on the transition from absent to present. Checks use public
HTTP(S) content, no browser login sessions, no redirects, a 15-second timeout
and a 1 MiB response limit. No fetched page content becomes an instruction.

Checks run while Weft is running and unlocked, respect emergency stop and
workspace archival, and start the normal scoped task runner. Existing running,
paused, uncertain or waiting tasks prevent another run from stacking. Required
workflow parameters must have defaults. A cooldown limits repeated wakes.
Check status and errors are visible when editing the workflow. Interrupted
launches stay `dispatching` for human inspection; review the task list before
editing/re-saving the watch to re-arm it. Weft does not promise monitoring while
closed or across a machine sleep. See [reuse notes](../THIRD-PARTY-NOTICES.md).

## Mailbox without email credentials

Mailbox messages are ordinary workspace materials tagged `mailbox` and
`unread`. Import an `.eml` file or paste a forwarded message. The original
message is retained as inert plain text; HTML and remote images never run.
MIME attachments and encoded headers are retained in the source, not decoded
into a full mail client. You can attach the resulting material to a chat/task.
Sender headers are unverified evidence, never permission to act.

A local forwarding relay can pipe an RFC822 email to:

```sh
node scripts/forward-email.mjs WORKSPACE_ID < message.eml
```

The adapter uses the normal `WEFT_TOKEN` and optional `WEFT_API_URL` environment
variables to call the authenticated loopback API. Use a workspace-scoped agent
connection with `records.write` and scoped autonomy. Messages are capped at
450 KB. A relay that already parses email can instead call `materials.create`
with `title`, `content`, `kind: "note"`, `workspaceId` and
`tags: ["mailbox", "unread"]`. Delivery is append-only; relay retries should
supply a stable `requestId` to the API to deduplicate delivery.

Weft does not provision an internet email address or a hosted forwarding
service. Configure a forwarding service or local mail relay to deliver to this
adapter; do not expose Weft's loopback control API publicly. No email-provider
password, IMAP login or SMTP credential is requested or stored by Weft.
