# Offline agent task evaluations

Run `npm run evals` or `node evals/run.js`. Ordinary `npm test` also runs the
reference scenarios. No model account, external website or display is needed.
Rerun after changes to tool descriptions, schemas, names, error text or command
normalization. Commit baseline updates only after reviewing why the task changed.

Each JSON task has a prompt, setup description, scripted reference calls and
programmatic store/tab checks. Bindings such as `$claim.version` use prior tool
results, not hard-coded versions. The harness starts the real MCP server over
SDK in-memory transport with a fresh durable workspace. It discovers grouped or
legacy tools from their advertised schemas. Browser control and capture use the
real Browser class with fake WebContents backed by a loopback HTTP fixture.
Only that fixture origin is reachable by the fake browser. Human-policy tests
exercise the actual service's automation boundary. Each task cleans up its
server and temporary workspace, including on failure.

The report includes success, tool call round trips (excluding initial discovery),
tool errors, expected policy/stale errors, explicit recovery retries, UTF-8
result bytes and a **rough byte/4 token estimate**, not model tokenizer usage.
Deltas compare round trips/errors/retries with the committed baseline. Failure
or increased counts makes the runner exit nonzero. Error text changes can
legitimately break expected-refusal matching and require review.

Tasks cover capture → finding → release, stale-version recovery, refused
human-only site/trust operations, and a cited proposal whose promotion to
confirmed context is refused. These prove reference solvability and detect
contract drift; they do not measure a model's independent reasoning quality,
Chromium rendering, network policy completeness or prompt-injection resistance.
A live-model adapter and real-browser eval mode are not implemented. Passing a
live-agent option fails clearly rather than silently running the reference.

To add a task, supply the JSON and baseline entry together. Use observable
state checks; never mark a task successful solely because its reference calls
returned without errors. Add a real browser regression separately whenever a
behavior depends on Chromium rather than the command/service contract.
