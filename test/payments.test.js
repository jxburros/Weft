import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRuntimeFixture } from './fixtures/task-runtime-fixture.mjs';
import { fakeIssuer, scriptedCheckout, testProtector, ISSUER_KEY, PAN, CVC } from './fixtures/payment-fixture.mjs';
import { PaymentService } from '../src/payments.js';
import { CredentialService } from '../src/credentials.js';
import { commands, errorOutcome, resultExitCode } from '../src/commands.js';
import { parseAmount, toMinor, formatMinor, detectRecurrence, classifyCharges, termsFingerprint, boundTerms } from '../src/payment-terms.js';
import { IssuerApiProvider, cardPlan } from '../src/virtual-cards.js';

const agent = { actor: 'automation' };
const human = { actor: 'human', source: 'gui' };

function setup(t, { checkout = {}, provider = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-payments-'));
  const protector = testProtector();
  const f = createRuntimeFixture({ directory, pages: { 1: 'https://shop.example.com/checkout?step=pay' },
    credentialService: provider ? ({ workspace, browser }) => new CredentialService({ directory: join(directory, 'credentials'), protector, browser, workspace, promptSecret: async () => null }) : null,
    paymentService: ({ workspace, browser, credentials }) => new PaymentService({ directory: join(directory, 'payments'), browser, workspace, credentials, protector }) });
  t.after(() => { f.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const page = scriptedCheckout(f, directory, checkout);
  return { ...f, directory, page };
}
const proposal = (f, extra = {}) => ({ workspaceId: f.workspaceId, tabId: 1, merchantName: 'Example Shop', purpose: 'Printer paper for the office', amountCeiling: '60.00', currency: 'USD',
  checkout: { total: { selector: '#total' }, tax: { selector: '#tax' }, shipping: { selector: '#shipping' }, submit: { selector: '#pay' } }, ...extra });
async function proposeApproved(f, extra = {}, context = agent) {
  const proposed = await f.run('payments.propose', proposal(f, extra), context);
  await f.run('approvals.approve', { id: proposed.approval.id, mode: 'once' });
  return proposed;
}
const submit = (f, id, context = agent) => f.attempt('payments.submit', { id, tabId: 1, workspaceId: f.workspaceId, expectedVersion: 1 }, context);
const approval = (f, id) => f.authority.approvals.items.find(item => item.id === id);
const activityText = f => JSON.stringify(f.authority.activity.entries);

test('amounts, currencies and recurrence wording are parsed conservatively from page text', () => {
  assert.deepEqual(parseAmount('Total: $1,234.56', 'USD'), { ok: true, minor: 123456, indicator: '$' });
  assert.equal(parseAmount('1.234,56 €', 'EUR').minor, 123456);
  assert.equal(parseAmount('1 234,56 EUR', 'EUR').minor, 123456);
  assert.equal(parseAmount('¥1,500', 'JPY').minor, 1500);
  assert.equal(parseAmount('KWD 12.345', 'KWD').minor, 12345);
  assert.equal(parseAmount('Order total (3 items) US$ 10.00', 'USD').minor, 1000, 'the number next to the currency is the amount');
  assert.equal(parseAmount('$1,234', 'USD').reason, 'amount_ambiguous', 'a single separator before three digits is not guessed');
  assert.equal(parseAmount('Total 49.99 or 59.99', 'USD').reason, 'amount_ambiguous');
  assert.equal(parseAmount('€49.99', 'USD').reason, 'currency_mismatch');
  assert.equal(parseAmount('Free', 'USD').reason, 'amount_missing');
  assert.equal(parseAmount('$12.345', 'USD').reason, 'amount_ambiguous');
  assert.equal(toMinor('49.99', 'USD'), 4999);
  assert.equal(toMinor('49.999', 'USD'), null);
  assert.equal(toMinor('1500', 'JPY'), 1500);
  assert.equal(formatMinor(12345, 'KWD'), '12.345 KWD');
  assert.deepEqual(detectRecurrence('$9.99/mo'), { recurring: true, interval: 'month', intervalCount: 1 });
  assert.deepEqual(detectRecurrence('Billed every 2 weeks'), { recurring: true, interval: 'week', intervalCount: 2 });
  assert.deepEqual(detectRecurrence('Renews quarterly'), { recurring: true, interval: 'month', intervalCount: 3 });
  assert.equal(detectRecurrence('Start subscription').interval, null);
  assert.equal(detectRecurrence('Pay $49.99').recurring, false);
  assert.deepEqual(cardPlan({ type: 'none' }), { singleUse: true, duration: 'TRANSACTION' });
  assert.deepEqual(cardPlan({ type: 'recurring', interval: 'month', intervalCount: 1 }), { singleUse: false, duration: 'MONTHLY' });
});

test('the approval fingerprint covers every bound term', () => {
  const record = { id: 'pay_00000000-0000-4000-8000-000000000001', attempt: 1, workspaceId: 'ws', tabId: 1, actor: 'automation', taskId: null,
    merchant: { name: 'Shop', origin: 'https://shop.example.com', frameOrigin: 'https://shop.example.com' }, destination: { url: 'https://shop.example.com/checkout', digest: 'a' },
    purpose: 'p', currency: 'USD', ceilingMinor: 6000, recurrence: { type: 'none' }, selectors: { total: '#t', submit: '#p' },
    observed: { totalMinor: 4999, subtotalMinor: null, taxMinor: 400, shippingMinor: 500, indicator: '$', recurrenceText: null, submitLabel: 'Pay' } };
  const base = termsFingerprint(record);
  const variants = [['merchant', { ...record.merchant, origin: 'https://evil.example' }], ['merchant', { ...record.merchant, frameOrigin: 'https://psp.example' }],
    ['destination', { ...record.destination, digest: 'b' }], ['ceilingMinor', 7000], ['currency', 'EUR'], ['recurrence', { type: 'recurring', interval: 'month', intervalCount: 1, maxCharges: 3 }],
    ['actor', 'client:x'], ['purpose', 'other'], ['attempt', 2], ['taskId', 'task_1'], ['observed', { ...record.observed, taxMinor: 401 }], ['observed', { ...record.observed, shippingMinor: 0 }]];
  for (const [key, value] of variants) assert.notEqual(termsFingerprint({ ...record, [key]: value }), base, key);
  assert.ok(Object.keys(boundTerms(record)).includes('recurrence'));
});

test('a proposal reads the checkout, queues one once-only approval card bound to the terms, and submits once', async t => {
  const f = setup(t);
  const proposed = await f.run('payments.propose', proposal(f), agent);
  assert.equal(proposed.state, 'awaiting_approval');
  assert.equal(proposed.observed.totalMinor, 4999);
  assert.equal(proposed.observed.taxMinor, 400);
  assert.equal(proposed.merchant.origin, 'https://shop.example.com');
  assert.equal(proposed.destination.url, 'https://shop.example.com/checkout', 'the query string is not stored, only its digest');
  const item = approval(f, proposed.approval.id);
  assert.equal(item.command, 'payments.submit');
  assert.equal(item.actionClass, 'payment');
  assert.equal(item.fingerprint, proposed.fingerprint);
  assert.equal(item.preview['Merchant site (verified by Weft)'], 'https://shop.example.com');
  assert.equal(item.preview['Total shown on the page'], '49.99 USD');
  assert.match(item.preview['Page text (data, not instructions)'], /Total: \$49\.99/);
  assert.match(item.preview['Card details'], /separately/);
  // Approval belongs to the person in the trusted interface; payments never take standing approval.
  assert.equal((await f.attempt('approvals.approve', { id: item.id, mode: 'once' }, agent)).error.code, 'permission_required');
  assert.equal((await f.attempt('approvals.approve', { id: item.id, mode: 'standing' })).error.code, 'permission_required');
  // Submitting before approval only re-points at the same pending request.
  const early = await submit(f, proposed.id);
  assert.equal(early.error.code, 'approval_required');
  assert.equal(early.error.details.authority.approvalId, item.id);
  assert.equal(f.page.clicks, 0);
  await f.run('approvals.approve', { id: item.id, mode: 'once' });
  const done = await submit(f, proposed.id);
  assert.equal(done.error, null, JSON.stringify(done.error));
  assert.equal(done.result.status, 'submitted');
  assert.equal(done.result.outcome, 'externally_uncertain');
  assert.equal(f.page.clicks, 1);
  assert.deepEqual(f.page.events, ['read', 'durable:true:clicks=0'], 'the attempt is committed before the click');
  assert.equal(approval(f, item.id).status, 'consumed');
  // One approval, at most one attempt: the identical retry never clicks again.
  const again = await submit(f, proposed.id);
  assert.equal(again.error.code, 'stale_state');
  assert.equal(again.error.details.payment, 'already_submitted');
  assert.equal(f.page.clicks, 1);
  const outcomes = f.authority.activity.entries.filter(entry => entry.targetId === proposed.id).map(entry => entry.outcome);
  assert.ok(outcomes.includes('pending_approval') && outcomes.includes('attempted') && outcomes.includes('externally_uncertain'));
});

test('changed totals, tax, pay control and redirected or re-framed checkouts are refused and void the approval', async t => {
  const f = setup(t);
  const cases = [
    ['total', () => { f.page.text.total = 'Total: $54.99'; }, 'terms_changed', ['total']],
    ['tax', () => { f.page.text.tax = '$9.00'; }, 'terms_changed', ['tax']],
    ['button', () => { f.page.text.submit = 'Pay $49.99 and subscribe monthly'; }, 'terms_changed', ['recurrence', 'submit_control']],
    ['redirect', () => { f.page.topOrigin = 'https://checkout.other-shop.example'; f.page.url = 'https://checkout.other-shop.example/checkout'; }, 'merchant_changed', ['merchant_origin', 'checkout_frame', 'destination']],
    ['path', () => { f.page.url = 'https://shop.example.com/checkout?step=upsell'; }, 'terms_changed', ['destination']],
  ];
  for (const [label, change, code, changed] of cases) {
    Object.assign(f.page, { topOrigin: 'https://shop.example.com', url: 'https://shop.example.com/checkout?step=pay', text: { total: 'Total: $49.99', tax: '$4.00', shipping: '$5.00', submit: 'Pay $49.99' } });
    const proposed = await proposeApproved(f);
    change();
    const refused = await submit(f, proposed.id);
    assert.equal(refused.error.code, code, label);
    assert.deepEqual(refused.error.details.changed, changed, label);
    assert.equal(refused.execution, 'not_started', label);
    assert.equal(resultExitCode(refused), 3);
    assert.equal(refused.error.httpStatus, 409);
    assert.ok(!JSON.stringify(refused.error.details).includes('54.99') && !JSON.stringify(refused.error.details).includes('other-shop'), 'details carry fixed words only');
    assert.equal(approval(f, proposed.approval.id).status, 'invalidated', `${label}: the approval is void, not given back`);
    const record = (await f.run('payments.get', { id: proposed.id }, agent));
    assert.equal(record.status, 'invalidated');
    assert.equal((await submit(f, proposed.id)).error.details.payment, 'invalidated', 'a void approval cannot be retried');
  }
  assert.equal(f.page.clicks, 0, 'nothing was ever clicked');
  // Embedded checkout: the approved checkout frame was replaced by another origin.
  Object.assign(f.page, { topOrigin: 'https://shop.example.com', url: 'https://shop.example.com/checkout?step=pay', frameOrigin: 'https://pay.processor.example', text: { total: 'USD 49.99', submit: 'Pay now' } });
  const framed = await proposeApproved(f, { checkout: { frameOrigin: 'https://pay.processor.example', total: { selector: '#total' }, submit: { selector: '#pay' } } });
  assert.equal(framed.merchant.frameOrigin, 'https://pay.processor.example');
  f.page.frameOrigin = 'https://pay.lookalike.example';
  const reframed = await submit(f, framed.id);
  assert.equal(reframed.error.code, 'merchant_changed');
  assert.deepEqual(reframed.error.details.changed, ['checkout_frame']);
  assert.ok(activityText(f).includes('"reason":"merchant_changed"'));
});

test('proposals refuse totals above the ceiling, inconsistent currency, hidden recurrence and unreadable checkouts', async t => {
  const f = setup(t);
  const refuse = async (args, reason, page = {}) => {
    Object.assign(f.page.text, { total: 'Total: $49.99', tax: '$4.00', shipping: '$5.00', submit: 'Pay $49.99' }, page);
    const outcome = await f.attempt('payments.propose', proposal(f, args), agent);
    assert.equal(outcome.error?.details?.payment, reason, JSON.stringify(outcome.error));
    assert.equal(outcome.execution, 'not_started');
  };
  await refuse({ amountCeiling: '40.00' }, 'exceeds_ceiling');
  await refuse({ currency: 'EUR' }, 'currency_mismatch');
  await refuse({ currency: 'ZZZ' }, 'currency_unknown');
  await refuse({}, 'amount_ambiguous', { total: 'Total: 49.99 (was 59.99)' });
  await refuse({}, 'currency_not_shown', { total: 'Total: 49.99', tax: '4.00', shipping: '5.00' });
  await refuse({}, 'recurrence_mismatch', { total: '$49.99 / month' });
  await refuse({ recurrence: { type: 'recurring', interval: 'month', maxCharges: 12 } }, 'recurrence_not_shown');
  await refuse({ recurrence: { type: 'recurring', interval: 'month', maxCharges: 12 }, checkout: { ...proposal(f).checkout, recurrence: { selector: '#period' } } }, 'recurrence_mismatch', { recurrence: 'Billed yearly' });
  f.page.counts.total = 2;
  await refuse({}, 'checkout_element_ambiguous');
  f.page.counts = {};
  f.page.enabled = false;
  await refuse({}, 'submit_unavailable');
  f.page.enabled = true;
  f.page.topOrigin = 'http://shop.example.com';
  await refuse({}, 'insecure_checkout');
  assert.equal(f.authority.approvals.items.length, 0, 'no approval request was queued for an unreadable or inconsistent checkout');
  assert.equal(f.payments.records.length, 0);
  // A recurring payment needs a cap.
  const uncapped = await f.attempt('payments.propose', proposal(f, { recurrence: { type: 'recurring', interval: 'month' } }), agent);
  assert.equal(uncapped.error.code, 'invalid_arguments');
});

test('recurring approvals bind the period and cap; later charges outside the recurrence need a new approval', async t => {
  const f = setup(t);
  const issuer = await fakeIssuer();
  t.after(() => issuer.close());
  Object.assign(f.page.text, { total: '$15.00', submit: 'Start membership', recurrence: '$15.00 billed monthly' });
  delete f.page.text.tax; delete f.page.text.shipping;
  const args = { amountCeiling: '15.00', recurrence: { type: 'recurring', interval: 'month', maxCharges: 3 },
    checkout: { total: { selector: '#total' }, recurrence: { selector: '#period' }, submit: { selector: '#pay' } } };
  // The billing period changes between approval and submission: refused.
  const first = await f.run('payments.propose', proposal(f, args), agent);
  assert.match(approval(f, first.approval.id).preview.Recurrence, /every month, at most 3 charges/);
  await f.run('approvals.approve', { id: first.approval.id, mode: 'once' });
  f.page.text.recurrence = '$15.00 billed weekly';
  assert.deepEqual((await submit(f, first.id)).error.details.changed, ['recurrence']);
  f.page.text.recurrence = '$15.00 billed monthly';
  const proposed = await proposeApproved(f, args);
  // A person issues a merchant-locked virtual card limited to the ceiling per month.
  assert.equal((await f.attempt('payments.issueCard', { id: proposed.id })).error.details.payment, 'provider_not_configured');
  await f.run('payments.configureProvider', { provider: 'issuer_api', enabled: true, baseUrl: issuer.url, apiKey: ISSUER_KEY });
  const issued = await f.run('payments.issueCard', { id: proposed.id });
  assert.equal(issued.virtualCard.last4, PAN.slice(-4));
  assert.equal(issued.virtualCard.duration, 'MONTHLY');
  assert.equal(issuer.state.requests[0].body.type, 'MERCHANT_LOCKED');
  assert.equal(issuer.state.requests[0].body.spend_limit, 1500);
  const card = (await f.run('credentials.get', { id: issued.credentialId }));
  assert.equal(card.kind, 'payment_card');
  assert.deepEqual(card.origins, ['https://shop.example.com']);
  assert.match(card.account, /Visa •••• 4242/);
  assert.equal((await submit(f, proposed.id)).error, null);
  const token = f.payments.records.find(item => item.id === proposed.id).virtualCard.token;
  const day = 86400000;
  issuer.charge(token, 1500, { at: new Date(Date.now() - 62 * day).toISOString() });
  issuer.charge(token, 1500, { at: new Date(Date.now() - 31 * day).toISOString() });
  let checked = await f.run('payments.checkCharges', { id: proposed.id }, agent);
  assert.equal(checked.withinTerms, 2);
  assert.equal(checked.outsideTerms, 0);
  // A price rise and an early extra charge are outside the approved recurrence.
  issuer.charge(token, 1900, { at: new Date(Date.now() - 20 * day).toISOString() });
  issuer.charge(token, 1500, { at: new Date().toISOString(), status: 'DECLINED' });
  checked = await f.run('payments.checkCharges', { id: proposed.id }, agent);
  assert.equal(checked.outsideTerms, 1);
  assert.deepEqual(checked.charges.find(item => item.amountMinor === 1900).reasons, ['amount_over_ceiling', 'too_soon']);
  assert.equal(checked.charges.at(-1).assessment, 'not_charged');
  assert.equal(checked.attention.kind, 'charge_outside_terms');
  const stored = await f.run('payments.get', { id: proposed.id }, agent);
  assert.equal(stored.needsNewApproval, true);
  assert.equal(stored.virtualCard.token, undefined, 'agents never see the issuer card token');
  assert.ok(activityText(f).includes('charge_outside_terms'));
  // A fourth charge beyond maxCharges is also outside the terms (classification is pure).
  const rows = classifyCharges({ currency: 'USD', ceilingMinor: 1500, recurrence: { type: 'recurring', interval: 'month', intervalCount: 1, maxCharges: 3 } },
    [0, 31, 62, 93].map((days, index) => ({ token: `t${index}`, status: 'settled', amountMinor: 1500, currency: 'USD', createdAt: new Date(Date.UTC(2026, 0, 1) + days * day).toISOString() })));
  assert.deepEqual(rows.map(row => row.assessment), ['within_terms', 'within_terms', 'within_terms', 'outside_terms']);
  assert.deepEqual(rows[3].reasons, ['charge_count']);
  // Card numbers stay in the vault: not in the payment store, activity, approvals or command outcomes.
  for (const text of [readFileSync(join(f.directory, 'payments', 'payments.json'), 'utf8'), activityText(f), JSON.stringify(f.authority.approvals.items), JSON.stringify(f.events)]) {
    // A three-digit code also occurs by chance inside timestamps (".987Z") and hex identifiers, so it is matched as a standalone number.
    const standaloneCode = new RegExp(`(^|[^0-9a-f.:-])${CVC}([^0-9a-f]|$)`, 'i');
    assert.ok(!text.includes(PAN) && !standaloneCode.test(text), 'no card number or security code');
  }
  assert.ok(!readFileSync(join(f.directory, 'credentials', 'vault', 'vault.json'), 'utf8').includes(PAN), 'the vault holds ciphertext');
  // Closing the card at the issuer revokes its vault entry.
  const closed = await f.run('payments.closeCard', { id: proposed.id });
  assert.equal(closed.virtualCard.state, 'CLOSED');
  assert.equal((await f.run('credentials.get', { id: issued.credentialId })).status, 'revoked');
});

test('cancellation voids unsubmitted payments; submitted ones are reported honestly, never as refunded', async t => {
  const f = setup(t);
  const proposed = await f.run('payments.propose', proposal(f), agent);
  const cancelled = await f.run('payments.cancel', { id: proposed.id, reason: 'No longer needed' }, agent);
  assert.equal(cancelled.status, 'voided');
  assert.equal(approval(f, proposed.approval.id).status, 'invalidated');
  assert.equal((await submit(f, proposed.id)).error.details.payment, 'voided');
  assert.equal((await f.attempt('approvals.approve', { id: proposed.approval.id, mode: 'once' })).error.code, 'stale_state', 'a voided request cannot be approved');
  // Cancelling the task voids its unsubmitted payment.
  const task = await f.run('tasks.create', { workspaceId: f.workspaceId, title: 'Buy paper' });
  const linked = await proposeApproved(f, { taskId: task.id });
  await f.run('tasks.transition', { id: task.id, status: 'cancelled' });
  assert.equal((await f.run('payments.get', { id: linked.id })).status, 'voided');
  assert.equal(approval(f, linked.approval.id).status, 'invalidated');
  assert.equal((await submit(f, linked.id)).error.details.payment, 'voided');
  // After submission there is nothing to cancel: the outcome is reported as submitted and not verified.
  const paid = await proposeApproved(f);
  assert.equal((await submit(f, paid.id)).error, null);
  const late = await f.attempt('payments.cancel', { id: paid.id }, agent);
  assert.equal(late.error.code, 'stale_state');
  assert.equal(late.error.details.payment, 'already_submitted');
  assert.match(late.error.message, /cannot cancel or refund/);
  assert.ok(!/\brefunded\b/i.test(JSON.stringify(await f.run('payments.get', { id: paid.id }))));
  assert.equal(f.page.clicks, 1);
});

test('duplicate submission: concurrent submits click once; an uncertain attempt needs a determination or a person accepting the duplicate risk', async t => {
  const f = setup(t, { checkout: { click: 'hang' } });
  const proposed = await proposeApproved(f);
  let started;
  const attempted = new Promise(resolve => { started = resolve; });
  f.page.onAttempt = started;
  const first = submit(f, proposed.id);
  await attempted;
  const second = await submit(f, proposed.id);
  assert.equal(second.error.details.payment, 'submission_in_flight');
  // The click never returns cleanly: the outcome is unknown.
  f.page.release.reject(Object.assign(new Error('Page stopped responding'), { code: 'timeout', paymentStage: 'click_unknown' }));
  const outcome = await first;
  assert.equal(outcome.error.code, 'timeout');
  assert.equal(outcome.execution, 'failed');
  let record = await f.run('payments.get', { id: proposed.id }, agent);
  assert.equal(record.status, 'uncertain');
  assert.equal(approval(f, proposed.approval.id).status, 'consumed', 'an attempted submission spends its approval');
  const blind = await submit(f, proposed.id);
  assert.equal(blind.error.code, 'duplicate_risk');
  assert.equal(blind.error.details.payment, 'externally_uncertain');
  assert.equal((await f.attempt('payments.retry', { id: proposed.id, confirmDuplicateRisk: true }, agent)).error.code, 'permission_required', 'agents never accept duplicate risk');
  assert.equal((await f.attempt('payments.reconcile', { id: proposed.id, determination: 'completed' }, agent)).error.code, 'permission_required');
  // Without a virtual card the lookup cannot tell; the payment stays uncertain.
  const lookup = await f.run('payments.reconcile', { id: proposed.id, determination: 'lookup' });
  assert.equal(lookup.determination.status, 'unknown');
  assert.equal(lookup.status, 'uncertain');
  // The person checked the statement: nothing was charged. A new attempt needs a new approval of the same terms.
  const reopened = await f.run('payments.reconcile', { id: proposed.id, determination: 'not_completed', note: 'Statement shows no charge' });
  assert.equal(reopened.status, 'proposed');
  assert.equal(reopened.attempt, 2);
  const fresh = await submit(f, proposed.id);
  assert.equal(fresh.error.code, 'approval_required');
  assert.notEqual(fresh.error.details.authority.approvalId, proposed.approval.id);
  await f.run('approvals.approve', { id: fresh.error.details.authority.approvalId, mode: 'once' });
  f.page.click = 'fail';
  assert.equal((await submit(f, proposed.id)).error.code, 'command_failed');
  record = await f.run('payments.get', { id: proposed.id }, agent);
  assert.equal(record.status, 'uncertain');
  // The person accepts the risk of paying twice; a third attempt still needs its own approval.
  const retried = await f.run('payments.retry', { id: proposed.id, confirmDuplicateRisk: true, note: 'Merchant support could not confirm' });
  assert.equal(retried.attempt, 3);
  assert.equal(retried.attempts.at(-1).determination.duplicateRiskAccepted, true);
  assert.equal((await submit(f, proposed.id)).error.code, 'approval_required');
  assert.equal(f.page.clicks, 2, 'each click followed its own approval');
  assert.ok(activityText(f).includes('duplicate_risk_accepted'));
});

test('a retry racing an attempt queues no approval that could outlive it', async t => {
  const f = setup(t);
  const proposed = await proposeApproved(f);
  let raced;
  f.page.beforeAttempt = async () => { f.page.beforeAttempt = null; raced = await submit(f, proposed.id); };
  const done = await submit(f, proposed.id);
  assert.equal(done.error, null, JSON.stringify(done.error));
  // The racing call found the approval already consumed and asked for another one for the same terms.
  assert.equal(raced.error.code, 'approval_required');
  assert.equal(approval(f, raced.error.details.authority.approvalId).status, 'invalidated', 'the extra request is void once the attempt starts');
  assert.equal(f.page.clicks, 1);
});

test('a pay control that vanishes after the attempt is recorded is not a submission and spends the approval', async t => {
  const f = setup(t, { checkout: { click: 'missing' } });
  const proposed = await proposeApproved(f);
  const outcome = await submit(f, proposed.id);
  assert.equal(outcome.error.details.payment, 'not_clicked');
  assert.equal(outcome.execution, 'not_started');
  const record = await f.run('payments.get', { id: proposed.id }, agent);
  assert.equal(record.status, 'proposed');
  assert.equal(record.attempt, 2);
  assert.equal(record.attempts[0].status, 'not_clicked');
  assert.equal(approval(f, proposed.approval.id).status, 'invalidated');
});

test('agent connections need the payment class; the gate binds approvals to the proposer', async t => {
  const f = setup(t);
  const plain = await f.run('clients.create', { name: 'Shopper', workspaceIds: [f.workspaceId], scopes: ['read', 'records.write', 'tabs.control'], ttlSeconds: 3600 });
  const plainContext = { actor: `client:${plain.clientId}`, clientId: plain.clientId };
  const denied = await f.attempt('payments.propose', proposal(f), plainContext);
  assert.equal(denied.error.code, 'permission_required');
  assert.equal(denied.error.details.payment, 'payment_class_not_granted');
  const payer = await f.run('clients.create', { name: 'Payer', workspaceIds: [f.workspaceId], scopes: ['read', 'records.write', 'tabs.control'], actionClasses: ['payment'], ttlSeconds: 3600 });
  const payerContext = { actor: `client:${payer.clientId}`, clientId: payer.clientId };
  const proposed = await proposeApproved(f, {}, payerContext);
  // Another identity cannot ride on the approval.
  assert.equal((await submit(f, proposed.id, agent)).error.details.payment, 'not_proposer');
  assert.equal((await submit(f, proposed.id, plainContext)).error.code, 'permission_required');
  assert.equal((await submit(f, proposed.id, payerContext)).error, null);
  // Agents never configure providers or issue cards.
  assert.equal((await f.attempt('payments.configureProvider', { provider: 'issuer_api', enabled: true, baseUrl: 'https://issuer.example' }, agent)).error.code, 'permission_required');
  assert.equal((await f.attempt('payments.issueCard', { id: proposed.id }, payerContext)).error.code, 'permission_required');
});

test('virtual cards are off by default and report clear unsupported outcomes', async t => {
  const f = setup(t);
  const issuer = await fakeIssuer();
  t.after(() => issuer.close());
  const status = await f.run('payments.status', {}, agent);
  assert.equal(status.provider.enabled, false);
  assert.equal(status.provider.available, false);
  assert.match(status.provider.validation, /not validated with a real issuer account/);
  assert.equal(status.provider.baseUrl, undefined, 'agents do not see provider configuration');
  const proposed = await f.run('payments.propose', proposal(f, { currency: 'USD' }), agent);
  const off = await f.attempt('payments.issueCard', { id: proposed.id });
  assert.equal(off.error.code, 'unsupported');
  assert.equal(off.error.details.payment, 'provider_not_configured');
  assert.equal((await f.attempt('payments.checkCharges', { id: proposed.id }, agent)).error.details.payment, 'no_virtual_card');
  assert.equal((await f.attempt('payments.configureProvider', { provider: 'issuer_api', enabled: true, baseUrl: 'http://issuer.example.com' })).error.details.payment, 'invalid_provider_url');
  await f.run('payments.configureProvider', { provider: 'issuer_api', enabled: true, baseUrl: issuer.url, apiKey: ISSUER_KEY });
  // EUR checkout with a USD-only issuer.
  Object.assign(f.page.text, { total: 'Total: 49,99 €', tax: '4,00 €', shipping: '5,00 €', submit: 'Jetzt kaufen' });
  const euro = await f.run('payments.propose', proposal(f, { currency: 'EUR' }), agent);
  const currency = await f.attempt('payments.issueCard', { id: euro.id });
  assert.equal(currency.error.details.payment, 'currency_unsupported');
  // The issuer refuses (for example a merchant category it does not support): unsupported, without echoing its message.
  issuer.state.mode = 'reject';
  const rejected = await f.attempt('payments.issueCard', { id: proposed.id });
  assert.equal(rejected.error.code, 'unsupported');
  assert.equal(rejected.error.details.payment, 'provider_rejected');
  assert.ok(!rejected.error.message.includes('99-1234'));
  issuer.state.mode = 'ok';
  await f.run('payments.configureProvider', { provider: 'issuer_api', enabled: true, baseUrl: issuer.url, apiKey: 'wrong-key' });
  assert.equal((await f.attempt('payments.issueCard', { id: proposed.id })).error.details.payment, 'provider_auth_failed');
  assert.ok(!readFileSync(join(f.directory, 'payments', 'issuer-key.wrapped')).toString('latin1').includes('wrong-key'), 'the issuer key is stored wrapped');
  // Without OS-protected storage no key is stored.
  const bare = new PaymentService({ directory: join(f.directory, 'payments-bare'), protector: testProtector() });
  bare.protector = { status: () => ({ available: true, backend: 'basic_text' }) };
  await assert.rejects(bare.execute('payments.configureProvider', { provider: 'issuer_api', enabled: true, baseUrl: issuer.url, apiKey: ISSUER_KEY }, human), error => error.details.payment === 'unprotected_storage');
  // The adapter on its own: transactions are normalized and limited.
  const provider = new IssuerApiProvider({ baseUrl: issuer.url, apiKey: ISSUER_KEY });
  const created = await provider.createCard({ memo: 'x', spendLimitMinor: 100, currency: 'USD', singleUse: true, duration: 'TRANSACTION' });
  issuer.charge(created.token, 100, { status: 'DECLINED' });
  assert.deepEqual((await provider.listTransactions(created.token)).map(row => [row.status, row.amountMinor]), [['declined', 100]]);
});

test('task runtime: a payment step waits for approval, an interrupted click becomes uncertain and a virtual-card lookup reconciles it', async t => {
  const f = setup(t, { checkout: { click: 'fail' } });
  const issuer = await fakeIssuer();
  t.after(() => issuer.close());
  await f.run('payments.configureProvider', { provider: 'issuer_api', enabled: true, baseUrl: issuer.url, apiKey: ISSUER_KEY });
  const proposed = await f.run('payments.propose', proposal(f), agent);
  await f.run('payments.issueCard', { id: proposed.id });
  const task = await f.run('tasks.create', { workspaceId: f.workspaceId, title: 'Pay for paper', plan: [{ kind: 'command', title: 'Pay', command: 'payments.submit', args: { id: proposed.id, tabId: 1 } }] });
  await f.run('tasks.start', { id: task.id, executor: { type: 'automation' } });
  let record = await f.settle(task.id);
  assert.equal(record.status, 'waiting_on_human');
  assert.equal(record.run.blocker.approvalId, proposed.approval.id, 'the step waits on the approval queued by the proposal');
  await f.run('approvals.approve', { id: proposed.approval.id, mode: 'once' });
  await f.tasks.resumeApprovals();
  record = await f.settle(task.id);
  assert.equal(record.status, 'uncertain');
  assert.equal(record.operations.at(-1).status, 'uncertain');
  assert.equal((await f.run('payments.get', { id: proposed.id })).status, 'uncertain');
  assert.equal((await f.attempt('tasks.continue', { id: task.id })).error.code, 'duplicate_risk');
  // The issuer shows the charge: the recorded lookup settles both the task operation and the payment.
  issuer.charge(f.payments.records[0].virtualCard.token, 4999);
  const reconciled = await f.run('tasks.reconcile', { id: task.id, operationId: record.operations.at(-1).id, determination: 'lookup', continue: true });
  assert.equal(reconciled.determination.status, 'completed', JSON.stringify(reconciled.determination));
  assert.equal(reconciled.determination.source, 'recorded_lookup');
  assert.equal((await f.settle(task.id)).status, 'completed');
  const payment = await f.run('payments.get', { id: proposed.id });
  assert.equal(payment.status, 'submitted');
  assert.equal(payment.attempts[0].determination.source, 'recorded_lookup');
  assert.equal(f.page.clicks, 1, 'reconciliation never repeats the click');
});

test('process interruption: a payment killed mid-click is uncertain after restart and reconciled from the virtual card', { timeout: 40000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-payment-crash-'));
  const issuer = await fakeIssuer();
  const keyHex = randomBytes(32).toString('hex');
  let f;
  t.after(async () => { f?.close(); await issuer.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/payment-crash-child.mjs', import.meta.url)), directory, issuer.url, keyHex], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; const line = buffer.split('\n').find(item => item.startsWith('{')); if (line) resolve(JSON.parse(line)); });
    child.once('exit', code => reject(new Error(`child exited early (${code})`)));
  });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  unlinkSync(join(realpathSync(directory), '.workspace.lock'));
  const protector = testProtector(keyHex);
  f = createRuntimeFixture({ directory, pages: { 1: 'https://shop.example.com/checkout?step=pay' },
    paymentService: ({ workspace, browser }) => new PaymentService({ directory: join(directory, 'payments'), browser, workspace, protector }) });
  const page = scriptedCheckout(f, directory);
  assert.equal(f.payments.records[0].status, 'submitting', 'the attempt was committed before the click was dispatched');
  f.payments.init();
  await f.tasks.init();
  const payment = await f.run('payments.get', { id: ready.paymentId });
  assert.equal(payment.status, 'uncertain');
  assert.equal(payment.attempts[0].status, 'uncertain');
  const task = f.task(ready.taskId);
  assert.equal(task.status, 'uncertain');
  assert.ok(f.authority.activity.entries.some(entry => entry.reason === 'server_restart_uncertain' && entry.targetId === ready.paymentId));
  assert.equal((await submit(f, ready.paymentId)).error.code, 'duplicate_risk', 'restart never repeats the payment');
  // The card issuer reports the charge that the killed process may have caused.
  issuer.charge(ready.cardToken, 4999);
  const reconciled = await f.run('payments.reconcile', { id: ready.paymentId, determination: 'lookup' });
  assert.equal(reconciled.status, 'submitted');
  assert.equal(reconciled.determination.source, 'recorded_lookup');
  assert.equal(f.task(ready.taskId).operations.at(-1).determination.status, 'completed', 'the linked task operation records the same determination');
  assert.equal(f.task(ready.taskId).status, 'paused');
  assert.equal(page.clicks, 0);
  assert.ok(!readFileSync(join(directory, 'payments', 'payments.json'), 'utf8').includes(PAN));
});

test('payment commands are classified, schemas reject card data and errors use fixed words', () => {
  for (const [name, actionClass] of [['payments.submit', 'payment'], ['payments.propose', 'local_write'], ['payments.reconcile', 'administration'], ['payments.issueCard', 'administration'], ['payments.checkCharges', 'external_read']]) {
    assert.equal(commands[name].actionClass, actionClass, name);
  }
  assert.equal(commands['payments.submit'].resource, 'tabs');
  assert.equal(commands['payments.submit'].effect, 'external');
  for (const name of ['payments.reconcile', 'payments.retry', 'payments.issueCard', 'payments.closeCard', 'payments.configureProvider']) assert.equal(commands[name].humanOnly, true, name);
  assert.ok(!Object.keys(commands['payments.propose'].inputSchema.properties).some(key => /card|cvc|cvv|number/i.test(key)));
  const outcome = errorOutcome(Object.assign(new Error('changed'), { code: 'terms_changed', notStarted: true, details: { payment: 'terms_changed', changed: ['total', '$54.99', 'https://evil.example'] } }), 'payments.submit');
  assert.deepEqual(outcome.error.details, { payment: 'terms_changed', changed: ['total'] });
  assert.equal(outcome.error.httpStatus, 409);
});

test('integration: a submit past its deadline never clicks, checkout tabs with open payments are never suspended, and events stay metadata-only', async t => {
  const f = setup(t);
  const proposed = await proposeApproved(f);
  // The tab awaiting this payment's approval must stay loaded.
  assert.ok(f.browser.quickBlockers(f.browser.tabs.get(1)).includes('payment'));
  // A deadline that passes before the attempt is recorded stops the submission: nothing is clicked or attempted.
  f.page.beforeAttempt = () => new Promise(resolve => setTimeout(resolve, 120));
  const late = await f.dispatch('payments.submit', { id: proposed.id, tabId: 1, workspaceId: f.workspaceId, expectedVersion: 1 }, { ...agent, deadlineMs: 50 });
  assert.equal(late.error?.code, 'deadline_exceeded', JSON.stringify(late.error));
  assert.equal(late.error.details.effect, 'not_started');
  assert.equal(f.page.clicks, 0);
  const stored = JSON.parse(readFileSync(join(f.directory, 'payments', 'payments.json'), 'utf8')).records.find(item => item.id === proposed.id);
  assert.notEqual(stored.status, 'submitting');
  assert.ok(!(stored.attempts ?? []).length, 'no attempt was recorded');
  // Payment events carry identifiers and status words only.
  const paymentEvents = f.events.filter(event => event.type === 'payment');
  assert.ok(paymentEvents.some(event => event.paymentId === proposed.id && event.status === 'proposed'), JSON.stringify(paymentEvents));
  assert.equal(JSON.stringify(paymentEvents).includes('shop.example.com'), false);
  assert.equal(JSON.stringify(paymentEvents).includes('49.99'), false);
});
