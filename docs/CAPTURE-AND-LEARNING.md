# Capture inbox, retrieval and learning in Weft 1.3

## Capture a message without connecting an email account

Open webmail inside Weft. **Send to Weft** appears in the browser toolbar when a
supported expanded message or a text selection is detected. The initial
adapters recognize Gmail (`mail.google.com`) and Outlook
(`outlook.live.com`, `outlook.office.com`, `outlook.office365.com`). Detection
returns availability only; it does not save message content or contact a model.

Choose **Send to Weft**, review the subject, sender/date claims, body and source,
and select a destination workspace. The default is the last expanded message;
**Capture expanded messages** includes all currently expanded messages. You can
edit the captured text. The message is rechecked before saving; changing the
page or message during review requires a new capture. **Page tools → Send
selected text to Weft** works on other sites. Editable input fields are excluded.

A capture becomes a revisioned material tagged `mailbox`, `unread` and
`captured-message`, with the original URL, capture time and limitations. New
captures default to **on-device only**. Uncheck that setting in the preview, or
edit the material later, if you want to send it to a cloud model. Source HTML
is never executed. Hidden messages, attachments and images are not captured;
message bodies are capped at 200,000 characters with an explicit truncation
notice. Site markup varies; these adapters were tested in real Chromium with
representative fixtures, not signed-in Gmail or Outlook accounts. No relay,
custom domain, mail password, public port or provider API key is needed for capture.

In **Mailbox**, read a message and choose **Summarize**, **Sort**, **Remember** or
**Make a task**. These open an Ask Weft draft with that material attached and
relevant-context retrieval selected. Review and send the draft; proposed app
actions still require approval. Archive removes the item from Mailbox but keeps
the material searchable. Imported `.eml` messages remain supported.

## Relevant context and embeddings

Enable embeddings in **Settings → Semantic search** with an existing Ollama or
OpenAI-compatible connection and an available embedding model. Weft combines
keyword ranking with semantic similarity, chunks long documents, reuses
unchanged chunks and invalidates vectors when the configured model changes.
Cloud/network embeddings require an explicit sharing acknowledgement;
on-device-only documents never go to those endpoints.

Workspace description and manual memory now participate in search, alongside
materials, learned memories, context, tasks and saved capture versions. Trusted
workspace instructions remain separate. **Find relevant workspace context** in
Ask Weft attaches up to eight ranked results with passages of up to 3,000
characters each, source IDs, revisions and timestamps. Retrieved content shares
the existing context-window budget; the outbound preview shows what is sent or
withheld. If embeddings are disabled or unavailable, automatic search uses
keyword search and reports its coverage. Explicit hybrid mode fails if unavailable.

Normal search snippets remain short. API callers can request `passageChars`
(300–6000) on `search.query`. Results stay within the authorized workspace and
explicitly shared collections; shared app-wide memories are labelled and searched
lexically outside their owner workspace. Existing profiles rebuild the derived
keyword index and queue workspace-memory embeddings once after upgrade.

## Editable background learning

**Settings → Learning & memory → Configure learning** enables learning separately
for each workspace. Choose a model, and optionally **Share new learned memories
across all workspaces**. Shared entries are app-wide on this local profile, not
synchronized to another device. Cloud/network learning requires confirmation of
background source sharing and possible usage charges. It is off by default.

Learning summarizes saved materials, context records, task objectives/checkpoints
and user/assistant conversation messages. It does not watch unsaved browsing or
read an email account. A model receives at most the last 12,000 characters from
one saved source per minute across the app, with no tools. Local-only sources
and conversations containing local-only messages are excluded from cloud learning.
The system records source IDs/revisions, time and model provenance. These are
AI-generated claims, not verified facts, instructions, permissions or model-weight
training. Every summary remains untrusted reference material.

Review, add, edit or erase individual entries. Erased unchanged source revisions
are suppressed; a later source revision can produce another entry. **Erase
workspace memory**, **Erase shared memory** or **Erase all learned memory** also
pauses the affected learning configurations. Source records, manually maintained
workspace memory, existing conversation copies and backups are separate and are
not erased by those controls. Import demotes shared memories to workspace scope
and never enables background learning. Personal edits are never overwritten by
the learner; new source revisions may create separate memories.

Learning runs only while Weft is open, unlocked, not emergency-stopped and the
source workspace is not archived. Changing the model or destination requires
reconfiguration. Failed/interrupted source revisions are recorded and not
silently retried; the UI surfaces failures. Limits: 200 memory entries per source
workspace and 10,000 processed source fingerprints per profile. These limits
stop further learning instead of evicting user edits or relearning erased data.

The eight most recently stored eligible memories are included as individually
excludable reference items in Ask Weft's context preview, subject to local-only
rules and context limits. Other entries remain searchable. Scope changes affect
future requests; they cannot retract text already sent to a provider. Deleting
a source does not delete independently stored learned summaries; manage those
in Learning & memory.

Commands: human-only `learning.status`, `learning.configure`, `learning.erase`
and `memories.create/update/delete`; scoped `memories.list/get` and `search.query`.
The `page.message` preview command is human-only. All share the GUI/CLI/REST/MCP
catalog; no remote caller can claim to be the trusted GUI.
