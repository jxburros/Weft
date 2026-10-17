# ADR 019: payment authorization bound to merchant, amounts, currency and recurrence

Status: implemented for issue #7 with unit, process-kill, real-Chromium checkout
and GUI tests. **Not validated with real merchants, payment processors or a real
card-issuer account**; the virtual-card adapter is tested only against a fake
issuer server. Last reviewed: 2026-10-17.

## Context

The authority layer (ADR 005) already had a `payment` action class (once-only:
an exact one-time approval per use, never standing), the task runtime (ADR 016)
recorded `attempted` operations and turned interrupted external work into
`uncertain`, and the credential broker (ADR 017) filled secrets inside an
exclusive protected operation. Nothing used them for purchases: an agent could
only click a pay button (`page.click`, an ordinary external change), so an
approval named a selector, not a merchant or an amount, and a changed total,
redirected checkout or swapped payment frame was invisible to the person.
Specification 13.5–13.6 and AC-12 require approvals bound to merchant,
destination, amount ceiling, currency, tax/shipping total and recurrence,
revalidation immediately before submission, separation of card filling from
purchase authorization, and limited virtual cards where supported.

## Decision

### Proposal: Weft reads the terms, the agent does not state them

`payments.propose` (agent-callable, `local_write`) takes the tab, a merchant
name and purpose (agent-supplied text), an amount ceiling in major units, an
ISO 4217 currency, a recurrence (`none`, or `recurring` with interval,
intervalCount and a cap: `maxCharges` and/or `endsAt`), an optional task and
the **checkout targets**: CSS selectors or snapshot refs for the total, optional
subtotal, tax, shipping, currency and recurrence elements, and the pay control;
`checkout.frameOrigin` when the checkout lives in an embedded frame.
`Browser.paymentObserve` then reads, without agent involvement:

- the top-level origin from the browser process (`WebFrameMain.origin`,
  cross-checked with the committed URL); HTTPS only (HTTP for loopback test
  pages);
- the one frame with the declared checkout origin (exactly one must exist);
- the rendered text (`innerText`, visible elements only) of each target, in the
  top frame's isolated world or, for an embedded checkout, the frame's own world
  (Electron has no isolated world for subframes; that text is the frame's own
  content either way). Snapshot refs are top-frame only and are converted to a
  structural selector that is re-read later.

`src/payment-terms.js` parses amounts conservatively in the declared currency's
minor units (ISO 4217 exponents): the amount must be the only number or the only
number next to a currency indicator, every visible indicator must be consistent
with the currency, and ambiguous separators (`$1,234`) are refused, never
guessed. Recurrence wording (`/mo`, `billed monthly`, `every 2 weeks`,
`subscribe`, `free trial`) must match the declaration: a one-time proposal on a
page that shows a billing period, or a recurring proposal whose recurrence
element shows another period, is refused. A total above the ceiling, a missing,
ambiguous or disabled element and an unshown currency are refused with fixed
reason words before any approval is queued.

The payment record stores the browser-verified merchant origin and checkout
frame origin, the checkout destination (origin and path for display, SHA-256 of
origin+path+query for binding), every observed amount, the currency indicator,
the recurrence text, the pay-control label, the selectors, the actor, purpose,
task and an attempt number. A SHA-256 **fingerprint of all of them** becomes the
fingerprint of one request in the single approval queue (command
`payments.submit`, class `payment`). The page strings are kept, bounded, as data.

### Approval: a browser-owned payment card

The approval queue shows payment requests on a dedicated card built from the
payment record (not from agent arguments): the Weft-verified merchant site,
checkout frame and page, the total and itemized subtotal/tax/shipping as read
from the page, the ceiling, currency, recurrence, requester, workspace, task and
attempt. The merchant name and purpose are labelled agent-supplied data; the raw
page text is in a collapsed section labelled as data. Only "Approve this payment
once" and "Reject" are offered (standing approvals are refused for the class).

`Authority.authorize` gained one hook, `approvalBinding(command, args, context,
target)`: for `payments.submit` it returns the payment's fingerprint and card
preview, so the gate matches the approval queued at proposal time regardless of
tab version, and it refuses first (not found, voided, invalidated, already
submitted, uncertain, other tab, other actor, closed task) so no useless request
is queued. The approval stays bound to the proposing identity.

### Submission: revalidate, record, click once

`payments.submit` (class `payment`, resource `tabs`, effect external) needs the
exact approval. `Browser.paymentSubmit` takes the tab's input slot (serialized
with all other input), applies the usual control checks (lease,
`expectedVersion`, fresh inspection), refuses during a protected operation, then
**re-reads the checkout** with the stored selectors and frame origin. Anything
that differs from the approved terms is refused before any click:

- `merchant_changed` — top-level origin or checkout frame differs (a redirect,
  a lookalike, a swapped payment frame);
- `terms_changed` — destination, total, subtotal, tax, shipping, currency
  indicator, recurrence text or pay-control label differs, the total exceeds the
  ceiling, or an element is missing or ambiguous.

The error carries `details.payment` and `details.changed` (fixed words only),
HTTP 409 and CLI exit 3. The payment becomes `invalidated` and its approval
`invalidated` (a new approval status): it is never given back, and a new
proposal is needed. Pre-check refusals that are not about the terms (tab busy,
stale version, loading page, protected operation) give the approval back, as
for any once-only command.

When the terms match, the payment service commits the attempt (`submitting`,
attempt entry with approval and task ids, activity `attempted`) with an fsynced
write **before** the click. The browser re-checks that tab, frames and origins
did not change during the write (otherwise nothing is clicked), clicks the one
visible, enabled pay control (isolated world for the top frame) and observes
navigation. The result is `submitted` with outcome `externally_uncertain`: Weft
saw the click accepted, not the merchant's charge.

**One approval allows at most one attempt.** After an attempt the approval stays
consumed whatever happens; a pay control that vanished before the click
(`not_clicked`) moves the payment to the next attempt number, which changes the
fingerprint and needs a new approval. Concurrent submits of one payment are
refused (`submission_in_flight`).

### Card filling is a separate authorization

Card details are a credential entry of kind `payment_card` in the ADR-017
vault: number, expiry, security code and optional name typed into the
browser-owned entry window (or received from a virtual-card issuer), sealed with
AES-256-GCM, with kind, brand and last four digits authenticated as associated
data (login entries keep the original associated data, so existing vaults stay
valid). The broker validates the number (Luhn), expiry and code before sealing.
Agents see only `Visa •••• 4242`, the exact merchant origins and processor
frame origins.

`credentials.fill` on a card entry (class `credential_use`: its own exact
approval or task grant) runs the same exclusive protected operation as a login
fill: observation and input routes are refused during the fill and cooldown,
the top-level origin must be authorized, and every frame that holds card fields
(`cc-number`, `cc-exp`, `cc-exp-month/year`, `cc-csc`, `cc-name`, or conservative
name hints) must be the top origin or an authorized processor frame; each frame
receives only the values for the fields it holds. Filled fields are marked so
snapshots redact them, screenshots mask them and `page.evaluate` is refused on
the document. `submit: true` is refused (`card_submit_separate`): filling a card
never buys anything.

### Interruption, duplicates and reconciliation

- **Startup sweep**: `PaymentService.init()` (before the API listens) turns any
  `submitting` payment into `uncertain` and logs it; the task runtime does the
  same for a `payments.submit` step's operation record.
- **No blind retries**: an uncertain payment refuses `payments.submit`
  (`duplicate_risk`, `externally_uncertain`). A person either records what
  happened (`payments.reconcile`: `completed`, `not_completed` or `lookup`) or
  accepts the duplicate risk (`payments.retry` with `confirmDuplicateRisk:
  true`). Both are human-only; either way a new attempt needs a new approval.
- **Reconciler**: the payment service registers `registerReconciler(
  'payments.submit', …)` with the task runtime. With a virtual card it lists the
  card's transactions: an approved or settled charge after the attempt is
  `completed` (evidence: the transaction id), only a decline is `not_completed`,
  nothing yet is `unknown`. Without a card it returns `unknown` and the person
  checks the merchant or statement. Determinations recorded on either side
  (`tasks.reconcile`, `tasks.retryStep` with duplicate-risk confirmation, or
  `payments.reconcile`) are applied to both the task operation and the payment.

### Recurrence and later charges

A recurring approval covers the agreement it shows: interval, ceiling per
charge, currency and cap. Weft cannot see merchant-initiated renewals except
through a virtual card: `payments.checkCharges` lists its transactions and
classifies each as within terms or outside (`amount_over_ceiling`, `currency`,
`too_soon` — closer than 80% of the interval, `charge_count`, `after_end`, or a
second charge on a one-time payment). Any outside charge marks the payment
`needs_new_approval` with a notice and an activity entry: the approval no longer
covers it; the person closes the card and approves a new payment for further
charges. Issuer limits enforce what they can: single-use cards for one-time
payments, a monthly/annual spend limit for monthly/yearly recurrences, a
per-transaction limit otherwise.

### Cancellation

`payments.cancel` (the proposer or a person) voids an unsubmitted payment and
invalidates its approval. Closing the payment's task (cancelled, failed or
completed) voids its unsubmitted payments through the task-transition notices.
A submitted or uncertain payment is never "cancelled": the refusal says it was
already submitted (or may have been), that Weft cannot cancel or refund it, and
that the outcome is not verified. Weft never reports a refund.

### Virtual-card providers

`src/virtual-cards.js` defines the provider interface (`capabilities`,
`supports`, `createCard`, `closeCard`, `listTransactions`) and one adapter,
`IssuerApiProvider`, for a generic issuing REST shape modelled on Lithic and
Privacy.com (`POST /v1/cards` with `SINGLE_USE` or `MERCHANT_LOCKED`,
`spend_limit` and `spend_limit_duration`; `PATCH /v1/cards/{token}`;
`GET /v1/transactions?card_token=`). It is **off by default**; a person enables
it (`payments.configureProvider`, human-only) with an HTTPS base URL and an API
key stored only wrapped by OS-protected storage (refused on basic_text).
`payments.issueCard` (human-only) creates a card limited to the payment's
ceiling, stores the returned number directly in the vault as a `payment_card`
entry for the merchant origin (and processor frames), and keeps only the issuer
token and last four digits on the payment record (the token is never shown to
agents). A failure to store the card closes it at the issuer. Clear
`unsupported` outcomes with fixed reasons: `provider_not_configured`,
`provider_disabled`, `currency_unsupported` (configured currency list, USD by
default), `provider_rejected` (the issuer refused, for example a merchant or
category it does not support; its message is not echoed), `provider_auth_failed`,
`provider_response_invalid` (for example an account without full card-number
access), `no_virtual_card`.

### Records, activity and privacy

Payment records live in `<profile>/payments/payments.json` (fsynced atomic
writes), outside `workspace-data`, like the vault: workspace exports and backups
do not include them. They hold no card numbers or security codes. Activity
entries record proposals, approvals, attempts, outcomes, invalidations,
cancellations and card issuance with ids, merchant origin, amounts in minor
units, currency, recurrence type and at most the last four digits; never a card
number or code.

### Core versus plugin

Kept in core: payments are authority, credentials and external effects
(question 3 of the checklist in `docs/PLUGINS.md` / ADR 003). The issuer adapter
is optional and off by default but sits behind the same human-only
configuration for the same reason.

## Consequences and limits

- Weft verifies what the checkout page shows, not what the merchant charges.
  A merchant whose page shows one total and charges another is not detected
  without a virtual card's transaction list.
- Weft reads the elements the agent names; it cannot prove that the element
  named `total` is what the merchant will charge (an agent could point at the
  shipping line). The card therefore shows the text around each element and a
  button to show the checkout tab, and a virtual card limited to the ceiling
  enforces the amount at the issuer; without one, the person's review is the
  check.
- Terms are read from configured elements. A page that shows the real terms
  elsewhere (or only in an image or canvas) is not understood; the person sees
  the page text Weft read and decides. Amount parsing refuses ambiguous formats
  rather than guessing, which can refuse legitimate pages (`$1,234` without
  decimals).
- Embedded checkouts are read in the frame's main world (no isolated world for
  subframes); the frame origin is still verified by the browser process.
- Wallet buttons (Apple Pay, Google Pay), 3-D Secure challenges and redirects
  to a processor's hosted page after the click are outside this flow: the
  click is the submission, and later steps are the person's.
- Payment records are not in workspace exports or backups.
- The issuer adapter was never run against a real account; Lithic and
  Privacy.com field names and plan limits (PAN access, currencies) may differ.

## Verification

- `test/payments.test.js`: amount/currency/recurrence parsing, fingerprint
  coverage of every term, proposal → approval card → one submission, changed
  total/tax/pay control/path, redirected and re-framed checkouts (approval
  voided, never restored, nothing clicked), proposal refusals (ceiling,
  currency, ambiguity, hidden or mismatched recurrence, insecure checkout),
  recurring approvals with a virtual card and later charges inside and outside
  the recurrence, cancellation before and after submission and by task closure,
  duplicate and concurrent submission, uncertain outcomes with human
  determination and duplicate-risk retry, `not_clicked`, client grants without
  the payment class, unsupported provider outcomes, task-runtime integration
  with the payment reconciler, and a SIGKILL during the click followed by restart
  and virtual-card reconciliation (`test/fixtures/payment-crash-child.mjs`).
- `test/payments-browser.test.js` (real Chromium under Xvfb): payment-card vault
  entry; proposal with a snapshot ref; card fill across the top frame and a
  processor frame with every observation route refused during the protected
  operation and `card_submit_separate`; changed total refused before the click;
  one approved submission posts once to the merchant; a redirect to a lookalike
  origin and a swapped processor frame are refused; an unchanged embedded
  checkout submits inside its frame; no card number or code in outcomes, events,
  activity, approvals, payment records or the vault file.
- `test/gui.test.js`: the dedicated payment approval card (verified terms,
  labelled agent and page text, no period approval), payment list and the
  virtual-card settings off by default.

Not verified: real merchants, processors (Stripe Elements-style split frames are
modelled by one processor frame), 3-D Secure, wallets, real Lithic/Privacy.com
accounts, packaged builds, and independent security review of the card path.
