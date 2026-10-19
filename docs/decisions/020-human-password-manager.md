# ADR 020: the person's own saved passwords

Status: implemented for issue #95 with unit and real-Chromium tests. Not
independently security-reviewed; not exercised with real OS key stores (macOS
Keychain, Windows DPAPI, libsecret) beyond the `safeStorage` checks shared with
ADR-017. Last reviewed: 2026-10-19.

## Context

The credential broker (ADR-017) lets **agents** use a sign-in without seeing
it. A person browsing by hand got nothing: no "save this password?", no
autofill, no generator, no import. Issue #95 asks for that, with a hard rule
that agents can never read, list, fill or reveal what the person saved.

## Options

| Option | Assessment | Decision |
| --- | --- | --- |
| One vault, two consumers (extend the ADR-017 broker store) | Every human entry would sit one flag away from agent use; the broker's authorization model (exact origins, purposes, approvals per use) is the wrong shape for everyday autofill; a bug in the flag check would expose personal passwords to agents. | Rejected. |
| **A separate vault beside the broker** | Agent-facing code never touches it; the human-only rule is structural (separate commands, separate file, separate key), not a field check. | **Chosen.** |
| Use Chromium's built-in password manager | Electron does not ship Chromium's password manager UI or storage. | Not available. |

## Decision

- **Storage.** `<userData>/passwords/vault.json`, outside `workspace-data`, so
  workspace exports, imports and backups never contain it. Each entry (username
  and password) is sealed with AES-256-GCM under a 256-bit data key; the
  authenticated data binds the entry id, workspace and origin. The data key is
  wrapped by Electron `safeStorage`. Linux `basic_text` or unavailable
  encryption is refused: nothing is saved, as for provider keys and the broker.
  The vault is not additionally sealed by workspace encryption (ADR-014); while
  an encrypted profile is locked, the dispatcher refuses every password command.
- **Per-workspace vaults.** An entry belongs to one workspace, matching isolated
  sign-in state. `passwords.update` can share it with other workspaces
  explicitly (`sharedWith`); nothing is shared implicitly.
- **Human-only.** Every `passwords.*` command is human-only administration in
  the shared catalog, and `PasswordService.execute` refuses any non-human actor
  again. Agents, CLI/MCP/REST clients and the internal model tools get
  `permission_required`. Entries never appear in model context, captures,
  exports or the activity log (which records only the origin and the action).
- **Saving.** A capture script in its own isolated world (never visible to the
  page) notes a sign-in form the person submits (trusted click, Enter or
  submit). Because Electron defers page scripts while a main-frame navigation
  loads, Weft also reads the filled form when the person presses the mouse or
  Enter, and offers it if a navigation follows; script sign-ins without a
  navigation are read 0.8 s after the click. Only after real human input in the
  last 10 s, and only for the page's own top-level origin. The offer (save, or
  update when the username exists with another password) shows site and
  username only; the password stays in main-process memory for 2 minutes.
  "Never for this site" is remembered per workspace.
- **Filling.** Only when the person chooses an entry in Weft's own interface
  (the address-bar key menu), only when the page's top-level origin equals the
  saved origin, and only into frames whose origin equals it (the top frame in
  Weft's isolated world, same-origin subframes through their own frame). A
  login form in a frame from another origin is never filled. Weft does not
  submit. After a fill the ADR-017 residue rules apply to the document:
  automation `page.evaluate` is refused and filled fields stay redacted from
  observation.
- **Generator.** `passwords.generate` fills a 20-character (12–64) password with
  upper, lower, digit and symbol classes into `autocomplete="new-password"`
  fields (or up to two empty password fields); saving follows the normal offer
  when the form is submitted.
- **Import/export.** CSV exports from Chrome/Edge, Firefox and Safari (url,
  username and password columns) up to 5 MiB, from a file the person picks; the
  person can have Weft delete the plaintext source afterwards. Export writes a
  plaintext CSV only with `acknowledgePlaintext: true`, mode 0600, never over an
  existing file.
- **Reveal.** `passwords.reveal` shows a native confirmation dialog owned by the
  main process before returning the password to Weft's interface. Weft does not
  ask for an OS re-authentication (no cross-platform Electron API); the
  workspace-encryption lock is the stronger gate when enabled.

## Deferred

- Address and payment-card autofill for the person. Payment cards for agents
  remain the ADR-019 flow; mixing a personal card store into it is out of scope.
- Inline in-page suggestions and autofill on focus: a page could observe or
  spoof in-page UI, so filling is offered only from Weft's own address bar.
- Login forms that load while the main frame is still loading are not read at
  submit; sign-ins in cross-origin frames are not offered for saving.
- Import from browser profiles directly (only CSV exports), and OS
  re-authentication before reveal.
