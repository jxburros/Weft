# ADR 017: credential broker, purpose-bound references and protected login

Status: implemented for issue #6 with fixture and real-Chromium adversarial
tests. **Independent security review has not been performed**, so Weft does not
assert credential isolation; the 1Password CLI adapter is tested only against a
fake `op` program, not a real account. Last reviewed: 2026-10-17.

## Context

Agents need to sign in to sites without learning passwords. Before this change,
only model-provider keys were stored (Electron `safeStorage`), page observation
had a protected-operation gate raised only by focused sensitive fields, and an
agent that wanted to sign in had to type a secret through `page.fill`, which
puts it in command arguments, activity summaries and approvals. The product
specification (13.1–13.4, 13.6, 14; AC-11) asks for an established vault,
references instead of values, exact origin binding, exclusive protected
operations, sanitized results and observation suppression.

## Vault selection

| Option | Assessment | Decision |
| --- | --- | --- |
| OS keychain per item (Keychain, DPAPI, libsecret) | Electron exposes only `safeStorage` (encrypt/decrypt with an app key), not per-item keychain records; native keychain modules such as keytar are archived native dependencies. | Use `safeStorage` only to wrap one data key. |
| Local vault file, AES-256-GCM, data key wrapped by `safeStorage` | No new dependency, works offline, same OS assumptions already accepted for provider keys; integrity of metadata can be bound to the ciphertext. | **Default.** |
| KeePassXC (KeePassXC-Browser protocol) | Native-messaging protocol for browser extensions: requires a running KeePassXC, an association handshake and NaCl box encryption (new crypto dependency), and per-site lookups by URL that KeePassXC itself decides. | Deferred; the provider interface can host it. |
| 1Password CLI (`op read op://…`) | Established, scriptable secret references; authentication is the CLI's own (desktop-app integration or `OP_SERVICE_ACCOUNT_TOKEN`). | **Adapter implemented**, off by default, validated only with a fake CLI. |
| Bitwarden CLI (`bw get password …`) | Needs an unlocked `BW_SESSION` key that Weft would have to obtain and hold. | Not implemented; same interface. |

Linux `basic_text` (`safeStorage` with no keyring) is plaintext obfuscation. Weft
refuses to create or open a vault on it, or when encryption is unavailable, the
same rule provider keys follow (`credentials.status` reports `vault:
unprotected`; the person is not even asked for a secret).

## Decision

### Process and file boundary

- `src/credential-broker-child.cjs` runs as a **separate OS process** (Node, or
  Electron with `ELECTRON_RUN_AS_NODE`, the mechanism the plugin sandbox already
  uses) started by `src/credentials.js` with: an empty environment (only the
  1Password CLI's variables — `PATH`, home/config directories, `OP_*` — when a
  person enables that adapter); Node's permission model with filesystem read and
  write limited to `<profile>/credentials/vault/`, no workers or addons, and
  child processes only while the 1Password adapter is enabled; a 64 MB heap;
  `--disallow-code-generation-from-strings`; stderr discarded. It is
  self-contained CommonJS using built-in modules so the permission model need
  not allow reading other source files. `utilityProcess` was not used because it
  cannot apply Node's permission model and would tie the broker (and its tests)
  to Electron.
- The broker starts at launch when a vault exists (so approval cards can name
  the credential) and otherwise when a person creates the first credential.
- The broker owns `vault/vault.json`. The main process owns `key.wrapped` (the
  random 256-bit data key wrapped by `safeStorage`), `providers.json` and
  `grants.json`, beside the vault directory. The data key is unwrapped only to
  start the broker and is sent over its stdin (never argv or environment), then
  zeroed in the main process.
- The credentials directory is outside `workspace-data`, so workspace exports,
  packages and backups never include it.
- Each entry is sealed with AES-256-GCM. Security-relevant metadata (id,
  workspace, label, purpose, origins, frame origins, provider, account
  identifier, timestamps, expiry, revocation, revision) is authenticated as
  associated data: editing the file (for example adding an origin or removing a
  revocation) makes the entry `integrity_failed` and unusable. Metadata changes
  re-seal the entry. Revocation discards the secret.
- Writes are temporary file + read-back verification + rename. Node's
  permission model disables `fsync`, so durability against power loss relies on
  `writeFile`'s `flush` option where the runtime allows it.

### Purpose-bound references

A person creates a reference only in the trusted GUI (`credentials.create`,
human-only and refused unless `source: gui`): label, purpose, 1–10 **exact
origins** (scheme, host, port; HTTPS, or HTTP only for loopback; no wildcards,
paths or credentials), optional **frame origins** for embedded sign-in frames,
optional expiry and an optional safe account label. The secret is typed into a
**separate browser-owned window** (`src/credential-entry.html`, its own
preload and IPC channel, sandboxed, DevTools disabled) — never into the main
GUI renderer and never as a command argument (the strict schema rejects
`password`, `secret`, `value` and `username`). The main process passes it to
the broker and drops it. Agents see only the opaque id, label, purpose,
origins, frame origins, provider, a masked account identifier (`a***e@example.com`
or the person's label), expiry and status (`credentials.list/get/status`).
`credentials.update`, `revoke`, `delete`, `grantTask`, `revokeGrant` and
`configureProvider` are human-only administration.

### Authorization

`credentials.fill` is `credential_use`, a once-only class: no standing approval
and no autonomy level admits it. Each use needs either:

- an **exact one-time approval** bound to the fingerprint of the command, its
  arguments (credential id, tab, expected version, ref, submit), actor,
  workspace, tab and the tab's **destination URL at request time**. A redirect
  or navigation before the retry changes the fingerprint and needs a new
  approval. The approval card shows the credential label, masked account,
  authorized origins and purpose; or
- a **task grant** (`credentials.grantTask`, human-only): one credential, one
  open task in the same workspace, 1–20 uses, 5–1440 minutes (never past the
  credential's expiry). The gate accepts it only for `credentials.fill` with
  that task id from trusted context (a task-bound client grant or the in-process
  task runtime), and a use is spent only when the broker releases the secret.
  Closing the task, revoking the credential or the grant ends it.

Client tokens additionally need the `tabs.control` scope and the
`credential_use` class in their grant, and their destination patterns apply.

### Protected login operation (`credentials.fill`)

`Browser.credentialFill` (`src/browser.js`):

1. Takes the tab's input slot (serialized with all other input) and applies the
   usual control checks (lease, `expectedVersion`, fresh inspection, ref from
   the actor's latest snapshot).
2. Starts an **exclusive protected operation** on the tab.
3. Refuses a blocked tab, a loading main frame or an attached debugger.
4. Reads the top-level origin from the browser process (`WebFrameMain.origin`,
   cross-checked with the committed URL); it must be one of the exact origins.
5. Finds the login target: the snapshot ref (top frame, isolated world) or the
   single login form across frames. A login form has exactly one visible,
   enabled, writable password field that is not `new-password`; hidden
   honeypots, sign-up and multi-form pages are refused (`no_login_form`,
   `ambiguous_login_form`). A form in a frame whose origin is neither the top
   origin nor a listed frame origin is refused (`frame_origin_not_authorized`).
6. Asks the broker to release the secret for the (top origin, frame origin)
   pair; the broker re-checks workspace, revocation, expiry, integrity and both
   origins against the authenticated metadata.
7. Re-verifies that the tab version, main frame, target frame and both origins
   are unchanged and no debugger attached (`navigated`, `interrupted`).
8. Fills in the top frame's **isolated world** (the page cannot patch the
   functions used) — or, for an authorized subframe, in that frame's own world,
   because Electron offers no isolated-world execution for subframes — after the
   script re-checks `location.origin`. Fields are marked
   (`data-weft-credential`, plus an isolated-world set and a SHA-256 digest of
   the secret for the top frame). With `submit: true` the form is submitted.
9. Returns sanitized status only: `filled`/`submitted`, which fields, top or
   subframe, the authorized origin, a navigation word, `outcome: unverified`.
   Refusals use fixed `error.details.credential` words.
10. Ends the protection; when a secret was released, a cooldown (default 1.5 s)
    follows.

### Observation boundary

| Route for automation | During operation and cooldown | After the cooldown on the filled document |
| --- | --- | --- |
| page.snapshot, readable, content, title, find, screenshot, pdf | refused (`protected_operation`) | allowed; filled fields redacted (`value: null`) and masked in images; snapshot/screenshot/pdf refused (`credential_revealed`) if the page reveals or copies the secret into a plain field |
| page.evaluate (main-world code) | refused | refused (`credential_residue`) until the document changes; on later documents in that tab, refused while any password or marked field holds a value (for example a back/forward cache restore) |
| page.click/fill/press/clickAt/navigate, tabs.* except list/release | refused | ordinary rules |
| page.inspect, tabs.list | allowed; page title withheld (`[protected operation]`) | allowed |
| artifacts.capture, plugin page extractors, model page reads | refused (they read through the routes above) | as above |
| cookies, storage clearing, workspace export | human-only (unchanged) | human-only |
| clipboard, network logs, DevTools/CDP | Weft exposes no clipboard read, network log or debugger route to automation; the fill refuses to run while a debugger is attached | same |
| activity, approvals, events, errors | contain ids, origins and fixed words only; never values | same |

The person is never blocked. Crash data: Weft has no crash reporter (ADR-005);
an operating-system crash or core dump of the main, renderer or broker process
taken while a secret is in memory could contain it.

### Residual exposure (inherent or not addressed)

- After a fill the value is in the page's DOM. Scripts of the authorized origin
  can read it and send it anywhere that origin chooses; this is inherent in
  signing in. Copies the site makes into JavaScript variables or page text are
  not detected (the reveal check covers plain form fields only).
- The main process holds the value transiently between the broker and the page
  (it must, to inject it); the entry window's renderer holds typed values until
  submission.
- A subframe fill runs in that frame's main world, so its own scripts could
  observe the script that sets the value (they receive the value anyway).

### Threat boundary and explicit limits

Protected against, by design and tests: agents (any non-human caller, including
internal model tools and plugins) reading values through commands, results,
errors, approvals, events, activity or observation routes; filling into a wrong
top-level origin, an unauthorized cross-origin frame, a redirected page or a
changed document; use after expiry or revocation; replay of an approval for a
different destination; edits to the vault file that widen authorization.

**Not** protected against: malware or another program running as the same OS
user (it can ask the OS keychain to unwrap the key, read process memory, inject
into Weft, log keystrokes in the entry window or replace the vault with an older
copy — rollback is not detected); a compromised Weft main process or Electron
runtime; administrator/root access; OS memory dumps, swap or hibernation files;
screen capture by other software while the person types; a malicious authorized
site; or a person approving a fill they did not intend. This is not an
unrestricted-host-access defense.

### Task runtime integration (#8)

A task step calls the catalog command through the dispatcher with the task id in
trusted context, never a secret: `dispatch('credentials.fill', { id, tabId,
workspaceId, expectedVersion, ref?, submit? }, { actor, taskId })`. Without a
task grant it receives `approval_required` like any agent and must wait; a
refusal is final for that attempt (`error.details.credential` explains why).

### Core versus plugin

Kept in core: it handles credentials, sessions and authority (question 3 of the
checklist in docs/PLUGINS.md). The 1Password adapter is optional and off by
default but lives inside the broker for the same reason.

## Verification

- `test/credentials.test.js`: AES-GCM sealing and metadata tampering, exact
  origin normalization, masking; basic_text/unavailable storage refused before
  any prompt; GUI-only creation and rejection of secret-bearing arguments;
  broker process separation, empty environment, permission flags and restart;
  approval binding (preview, once-only, destination change, broker-side origin
  and frame refusal, approval given back on refusal); expired, revoked,
  tampered and cross-workspace references; task grants (other task, use limit,
  closed task); 1Password adapter with a fake `op` CLI (environment passthrough,
  failure without leaking CLI output); no secret in events, activity,
  approvals, grants or stores.
- `test/credentials-browser.test.js` (real Chromium under Xvfb): every
  observation/input route refused during the protected window and cooldown
  (snapshot, readable, content, title, find, screenshot, pdf, evaluate, click,
  artifacts.capture; cookies stay human-only; inspect withholds the title);
  values filled and the hidden honeypot left empty; redaction after cooldown;
  `credential_residue` for evaluate; a page script that reveals and copies the
  password (`credential_revealed`); phishing top-level origin; cross-origin
  login iframe refused until explicitly authorized, then filled; redirect
  between origin check and fill; ambiguous and honeypot-only pages; ref
  selection; submit reaching only the authorized server; revocation; no secret
  in command outcomes (what GUI IPC returns), events, activity or the vault file.

Not verified: independent security review; a real 1Password account; macOS
Keychain/Windows DPAPI/libsecret prompts and behavior (tests use a test-only key
protector because CI has no keyring); packaged (asar) builds launching the
broker; Bitwarden and KeePassXC.
