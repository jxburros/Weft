# ADR 004: model turn lifecycle, context limits and vision fallback

Status: accepted and implemented. Last code review: 2026-10-17. Related: #12,
#13, #53 and the event-replay part of #14.

## Decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| Streaming transport | Adapters request streaming when the connection allows it and choose the parser from the actual response type (SSE, NDJSON or whole JSON). | Compatible servers may ignore `stream`; a single normalized result keeps the tool loop and persistence identical. |
| Turn ownership | The originating request (GUI IPC call or REST request) owns a turn. Its disconnect stops the turn; followers on `/v1/turns/{turnId}/events` never do. | A client that asked for work can withdraw it; observers must not be able to cancel someone else's turn. |
| Stops versus failures | Cancel, disconnect, emergency stop, the admission latch and deadlines keep any partial text as an `interrupted` assistant message with its `finishReason`. Runtime errors, in-band error frames and streams without a finish signal are recorded only in the turn manifest as `failed`. | Partial output the user stopped is still the model's actual output; text from a failed run is not a reply and must not enter later history. |
| Continuation | Length and deadline stops are marked `continuable`; continuing is an ordinary new turn whose history contains the partial reply. | No hidden provider-specific continuation protocol; the transcript remains the record. |
| Deadlines | First data frame, idle gap and total turn deadlines; before the first frame only first-token and total apply. | Silent endpoints fail predictably without cutting long non-streamed replies at the idle limit. |
| Context limits | Effective window = configured, else probed, else an assumed 32,768 tokens (disclosed as assumed). The new message and attachments are fixed; older history is omitted oldest-first; nothing is summarized or rewritten. A turn that cannot fit is `unsupported_capability`. | Summarization would itself send data to a model and alter evidence; omission is predictable and fully disclosed. |
| Capabilities | Configured value > endpoint probe (`models.probe`, human-only) > adapter default; every value names its source. Probe results reset when endpoint, model or API format changes. | Most APIs do not report capabilities; humans stay authoritative and stale probes never carry to a new destination. |
| Images | Only PNG bytes from stored materials or exact artifact versions, bounded per image and per turn; oversized captures are downscaled locally in the desktop app or refused. Paths and opaque files are references, never visual evidence. | Evidence must reflect what was actually transmitted; provenance (artifact, version, hashes, regions) is kept in the manifest. |
| Vision fallback | Used only for the selected connection's human-configured `visionFallbackId`, after per-turn acknowledgement. It receives only the new message text and the listed images; its description is persisted as an untrusted tool record and passed to the selected model as second-hand text. Failure fails the turn; no other model is tried. | Avoids silent retargeting and keeps the fallback's data scope minimal and visible. |
| Event replay | `/v1/events` keeps one bounded in-memory retention buffer (1,000 events / 1 MiB / 15 min) with ids `<boot>-<seq>`; turn streams keep 10,000 frames / 4 MiB per turn for 60 s after the end. Gaps are explicit. | Replay is a reconnection aid, not an audit log; nothing is written to disk. |

## Consequences and limits

Token budgeting uses a byte heuristic, not a tokenizer; provider-reported usage
is shown after the reply. Anthropic and Ollama tool use, non-PNG images and
summarization of omitted history are not implemented. Region redaction is
consumed from capture version metadata (`redactions`, `inaccessibleRegions`);
producing that metadata belongs to capture/redaction work. All behavior is
verified with local fake providers, not real provider accounts.
