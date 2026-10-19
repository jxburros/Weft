# Credential broker and payment path: independent review brief

Last verified against code: 2026-10-19.

This brief prepares the **independent security review** that ADR-017 and issue
#6 require before Weft may claim credential isolation. It is a scope and a
checklist for an outside reviewer, plus the maintainers' own self-review
results. A self-review is **not** the independent review: until a reviewer who
did not write this code signs off, `docs/IMPLEMENTATION.md` keeps saying
"not independently security-reviewed".

## Scope

| In scope | Files |
| --- | --- |
| Broker process, vault format, key wrapping | `src/credential-broker-child.cjs`, `src/credentials.js` (`BrokerProcess`, `CredentialService`) |
| Browser-owned entry window | `src/credential-entry.js`, `src/credential-entry.html`, `src/credential-entry-view.js`, `src/credential-entry-preload.cjs` |
| Protected fill and observation boundary | `src/browser.js` (`credentialFill`, `fillCard`, `assertNoCredentialResidue`, `precheckControl`), `src/page-observation.js` |
| Authorization of each use | `src/authority.js`, `src/autonomy.js` (`credential_use`, `payment` classes), `src/approvals.js` |
| Payment authorization bound to checkout terms | `src/payments.js`, `src/payment-terms.js`, `src/virtual-cards.js` (ADR-019) |
| 1Password CLI adapter | `OnePasswordCli` in `src/credential-broker-child.cjs` |

Out of scope (documented limits, ADR-017 "Threat boundary and explicit
limits"): malware running as the same OS user, a compromised Weft main process
or Electron runtime, root/administrator, OS memory dumps/swap, screen capture,
a malicious authorized site, and a person approving a fill they did not intend.

## Questions the reviewer should answer

1. **Process boundary.** Can the broker read or write anything outside
   `<profile>/credentials/vault/` under Node's permission model as launched
   (`ELECTRON_RUN_AS_NODE`, Electron 44 / Node 24)? Is anything inherited from
   the parent environment, argv or open file descriptors?
2. **Key handling.** Is the data key zeroed in the main process after it is
   sent over stdin? Can it reach logs, crash output, `process.title`, activity
   records or the GUI renderer?
3. **Vault integrity.** Does every security-relevant field sit in the AES-GCM
   associated data? Can an edited, reordered or truncated `vault.json` produce a
   usable entry with a wider authorization? (Whole-vault rollback to an older
   copy is a known, documented gap.)
4. **Entry window.** Can the GUI renderer, a page, an extension or an agent
   reach the entry window's IPC channels, read its DOM, or open a look-alike?
   Are typed values cleared on every exit path (submit, cancel, Escape, close)?
5. **Fill target.** Can a page, frame, redirect, `bfcache` restore or
   navigation race make `credentials.fill` write into an origin or frame that is
   not authorized, or into a different document than the one checked?
6. **After the fill.** Which automation routes can still observe a filled
   value (snapshot, readable, content, screenshot, PDF, evaluate, find, archive
   capture, plugin extractors, model page reads)? Is the reveal check sound for
   plain fields and are its limits stated?
7. **Payments.** Can automation complete a purchase without a `payments.submit`
   approval bound to the current terms, for example by `page.click` after a
   card fill (fixed in 1.4.0 for #103: input on a document holding a filled card
   is refused for non-human callers)? Can terms change between the re-read and
   the click?
8. **Authority.** Can any non-human caller (bootstrap token, scoped client,
   CLI, MCP, REST, in-process model tools, plugins, task runtime) obtain
   `credential_use` or `payment` without a person's exact approval or task
   grant? Do grants respect expiry, revocation and use counts under concurrency?
9. **Outputs.** Do results, errors, approvals, events, activity details and
   exports ever contain a secret, a card number or a security code?
10. **1Password adapter.** Can a crafted `op://` reference or CLI output inject
    arguments, read other items, or leak through stderr?

## Self-review checklist (maintainers, before handing over)

| Check | Evidence | Result (2026-10-19) |
| --- | --- | --- |
| Adversarial unit tests for the broker, vault tampering and authorization | `test/credentials.test.js`, `test/task-credentials.test.js` | pass |
| Real-Chromium protected fill, hostile pages, frames, redirects | `test/credentials-browser.test.js` | pass |
| Real-Chromium checkout, protected card fill, terms changes | `test/payments-browser.test.js`, `test/payments.test.js` | pass |
| No secret in activity, approvals, events or errors | assertions in the files above | pass |
| Entry window accessibility (both kinds, both themes) | `test/accessibility.test.js` | pass |
| 2026-10-19 audit finding: automation input after a card fill | #103 (fixed in 1.4.0 by the security pass) | see #103 |
| Broker inside a packaged asar build | not run | **open** |
| Real macOS Keychain, Windows DPAPI, Linux libsecret/KWallet | not run (CI uses `basic_text`, which is refused) | **open** |
| Real 1Password account | not run (fake `op` only) | **open** |
| Independent review | not performed | **open** |

## Handing over

Give the reviewer this file, ADR-017, ADR-019, `docs/BROWSER-SAFETY-AUDIT.md`
and a tagged commit. Record the reviewer, date, commit and findings in a new
section here and in `docs/VALIDATION.md`; fix or explicitly accept every
finding; only then update the status lines in ADR-017 and
`docs/IMPLEMENTATION.md`.
