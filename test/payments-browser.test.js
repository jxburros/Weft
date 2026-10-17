import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { CredentialService } from '../src/credentials.js';
import { PaymentService } from '../src/payments.js';
import { testProtector, PAN, CVC } from './fixtures/payment-fixture.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)).then(() => `http://127.0.0.1:${server.address().port}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Condition timed out') {
  for (let attempt = 0; attempt < 250; attempt++) { if (await check()) return; await delay(20); }
  throw new Error(message);
}
const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

if (process.argv.includes('--payments-smoke')) {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  app.on('window-all-closed', () => {});
  (async () => {
    await app.whenReady();
    const posts = [];
    const record = (origin, request) => new Promise(resolve => { let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => { posts.push({ origin, path: request.url, body }); resolve(body); }); });
    // The card processor hosts the security-code field and, for embedded checkouts, the whole checkout.
    let pspOrigin, merchantOrigin, otherOrigin;
    const frameCheckout = action => html('Hosted checkout', `<p>Total <span id="total">USD 25.00</span></p><form action="${action}" method="post"><button id="pay" type="submit">Pay now</button></form>`);
    const psp = createServer(async (request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.method === 'POST') { await record('psp', request); return response.end(html('Paid', '<p>Paid</p>')); }
      if (request.url.startsWith('/cvc-frame')) return response.end(html('Card security', '<label>Security code <input id="cvc" autocomplete="cc-csc" inputmode="numeric"></label>'));
      if (request.url.startsWith('/hosted-frame')) return response.end(frameCheckout('/pay'));
      response.end(html('PSP', ''));
    });
    pspOrigin = await listen(psp);
    const checkout = (posted = '/pay') => html('Checkout', `<main><h1>Checkout</h1>
<p>Subtotal <span id="subtotal">$40.99</span></p><p>Tax <span id="tax">$4.00</span></p><p>Shipping <span id="shipping">$5.00</span></p>
<p><strong>Total <span id="total">$49.99</span></strong></p>
<label>Card number <input id="number" autocomplete="cc-number" inputmode="numeric"></label>
<label>Expiry <input id="exp" autocomplete="cc-exp" placeholder="MM/YY"></label>
<label>Name on card <input id="holder" autocomplete="cc-name"></label>
<iframe id="cvc-frame" title="Security code" src="${pspOrigin}/cvc-frame" width="320" height="80"></iframe>
<form action="${posted}" method="post"><button id="pay" type="submit">Pay $49.99</button></form></main>`);
    const merchant = createServer(async (request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.method === 'POST') { await record('merchant', request); return response.end(html('Thank you', '<p>Order placed</p>')); }
      if (request.url.startsWith('/hosted')) return response.end(html('Hosted', `<h1>Pay</h1><iframe id="hosted" title="Checkout" src="${pspOrigin}/hosted-frame" width="400" height="200"></iframe>`));
      response.end(checkout());
    });
    merchantOrigin = await listen(merchant);
    // A lookalike checkout on another origin, reached by a redirect after approval.
    const other = createServer(async (request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.method === 'POST') { await record('other', request); return response.end(html('Thanks', '')); }
      if (request.url.startsWith('/hosted-frame')) return response.end(frameCheckout('/pay'));
      response.end(checkout());
    });
    otherOrigin = await listen(other);

    const profile = process.env.WEFT_TEST_PROFILE;
    const workspace = new WorkspaceService({ directory: join(profile, 'workspace-data') });
    const workspaceId = workspace.activeWorkspaceId;
    const window = new BrowserWindow({ show: true, width: 1200, height: 900 });
    const browser = new Browser({ window, workspaceService: workspace, protectedCooldownMs: 700 });
    workspace.attachBrowser(browser);
    const protector = testProtector();
    const secretQueue = [];
    const credentials = new CredentialService({ directory: join(profile, 'credentials'), protector, browser, workspace, promptSecret: async () => secretQueue.shift() });
    const payments = new PaymentService({ directory: join(profile, 'payments'), browser, workspace, credentials, protector });
    const events = [];
    const dispatch = createDispatcher({ workspace, browser, providers: { execute() {}, close() {} }, credentials, payments, admission: new AutomationAdmission(), onEvent: event => events.push(event) });
    const outcomes = [];
    const human = { actor: 'human', source: 'gui' };
    const agent = { actor: 'automation' };
    const run = async (command, args, context) => { const outcome = await dispatch(command, args, context); outcomes.push(outcome); return outcome; };
    // A three-digit code also occurs inside hashes and ports; a leaked code would be a quoted value.
    const leaks = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); return [PAN, PAN.replace(/(\d{4})(?=\d)/g, '$1 '), `"${CVC}"`, `\\"${CVC}\\"`].filter(secret => text.includes(secret)); };
    try {
      await browser.restore();
      const tabId = browser.activeId;
      const tab = browser.tab(tabId);
      const contents = tab.view.webContents;
      const go = async url => {
        await run('page.navigate', { tabId, url }, human);
        await until(() => !contents.isLoading() && !browser.protectedReason(tab) && contents.mainFrame.framesInSubtree.length >= 1, `load ${url}`);
        await delay(150);
      };
      const inspect = async () => (await run('page.inspect', { tabId }, agent)).result.version;
      const approve = async approvalId => assert.equal((await run('approvals.approve', { id: approvalId, mode: 'once' }, human)).error, null);
      const checkoutTargets = { subtotal: { selector: '#subtotal' }, tax: { selector: '#tax' }, shipping: { selector: '#shipping' }, total: { selector: '#total' } };
      const propose = async (extra = {}) => {
        const outcome = await run('payments.propose', { workspaceId, tabId, merchantName: 'Fixture Stationery', purpose: 'Order printer paper', amountCeiling: '50.00', currency: 'USD',
          checkout: { ...checkoutTargets, submit: { selector: '#pay' } }, ...extra }, agent);
        assert.equal(outcome.error, null, JSON.stringify(outcome.error));
        return outcome.result;
      };
      const submit = async id => run('payments.submit', { id, tabId, workspaceId, expectedVersion: await inspect() }, agent);
      const setText = (selector, text) => run('page.evaluate', { tabId, expression: `document.querySelector(${JSON.stringify(selector)}).textContent = ${JSON.stringify(text)}` }, human);

      // 1. A payment card is a vault credential bound to the merchant origin and the processor frame.
      await go(`${merchantOrigin}/checkout`);
      await until(() => contents.mainFrame.framesInSubtree.some(frame => frame.origin === pspOrigin), 'card frame');
      secretQueue.push({ number: PAN, expMonth: 12, expYear: 2031, cvc: CVC, name: 'Ada Lovelace' });
      const created = await run('credentials.create', { workspaceId, kind: 'payment_card', label: 'Office card', purpose: 'Stationery orders', origins: [merchantOrigin], frameOrigins: [pspOrigin] }, human);
      assert.equal(created.error, null, JSON.stringify(created.error));
      const cardId = created.result.id;
      assert.equal(created.result.account, 'Visa •••• 4242');

      // 2. The proposal reads the real page in Chromium; the pay control is chosen by snapshot ref.
      const snapshot = await run('page.snapshot', { tabId }, agent);
      const payRef = snapshot.result.nodes.find(node => node.role === 'button' && node.name === 'Pay $49.99').ref;
      const proposed = await propose({ checkout: { ...checkoutTargets, submit: { ref: payRef } } });
      assert.equal(proposed.merchant.origin, merchantOrigin);
      assert.equal(proposed.observed.totalMinor, 4999);
      assert.equal(proposed.observed.subtotalMinor, 4099);
      assert.equal(proposed.observed.context.total, 'Total $49.99', 'the person sees the label beside each amount');
      assert.equal(proposed.observed.submitLabel, 'Pay $49.99');
      assert.equal(proposed.selectors.submit, '#pay', 'the snapshot ref became a stable selector for the re-read');
      await approve(proposed.approval.id);

      // 3. Card filling is its own once-only authorization, run as a protected operation that blocks observation.
      const realCall = credentials.call.bind(credentials);
      let releasing = null;
      credentials.call = async (type, payload, options) => { if (type === 'release') { releasing?.(); await delay(400); } return realCall(type, payload, options); };
      const entered = new Promise(resolve => { releasing = resolve; });
      assert.equal((await run('credentials.fill', { id: cardId, tabId, workspaceId, submit: true }, human)).error?.details?.credential, 'card_submit_separate', 'card filling never submits');
      const fillArgs = { id: cardId, tabId, workspaceId, expectedVersion: await inspect() };
      const pending = await run('credentials.fill', fillArgs, agent);
      assert.equal(pending.error?.code, 'approval_required');
      await approve(pending.error.details.authority.approvalId);
      const fill = run('credentials.fill', fillArgs, agent);
      await entered;
      for (const [command, args] of Object.entries({ 'page.snapshot': {}, 'page.readable': {}, 'page.screenshot': {}, 'page.content': {}, 'page.evaluate': { expression: '1' } })) {
        const outcome = await run(command, { tabId, ...args }, agent);
        assert.equal(outcome.error?.details?.credential, 'protected_operation', `${command} during the card fill`);
      }
      assert.equal((await run('payments.propose', { workspaceId, tabId, merchantName: 'x', purpose: 'y', amountCeiling: '1.00', currency: 'USD', checkout: { total: { selector: '#total' }, submit: { selector: '#pay' } } }, agent)).error?.details?.credential, 'protected_operation');
      assert.equal((await run('payments.submit', { id: proposed.id, tabId, workspaceId, expectedVersion: tab.version }, agent)).error?.details?.credential, 'protected_operation', 'no purchase click while card details are being filled');
      const filled = await fill;
      credentials.call = realCall;
      assert.equal(filled.error, null, JSON.stringify(filled.error));
      assert.deepEqual(filled.result.fields.sort(), ['cvc', 'expiry', 'name', 'number']);
      assert.equal(filled.result.frames, 2);
      assert.equal(await contents.mainFrame.executeJavaScript('document.getElementById("number").value'), PAN);
      assert.equal(await contents.mainFrame.executeJavaScript('document.getElementById("exp").value'), '12/31');
      const cvcFrame = contents.mainFrame.framesInSubtree.find(frame => frame.origin === pspOrigin);
      assert.equal(await cvcFrame.executeJavaScript('document.getElementById("cvc").value'), CVC, 'only the processor frame received the security code');
      await delay(800);
      const after = await run('page.snapshot', { tabId }, agent);
      assert.equal(after.error, null);
      assert.deepEqual(leaks(after), [], 'snapshots redact filled card fields');
      assert.ok(after.result.nodes.some(node => node.redacted === 'sensitive-field' && node.hasValue));
      assert.equal((await run('page.evaluate', { tabId, expectedVersion: await inspect(), expression: 'document.getElementById("number").value' }, agent)).error?.details?.credential, 'credential_residue');

      // 4. The total changes after approval: the submission is refused before any click and the approval is void.
      await setText('#total', '$54.99');
      const changed = await submit(proposed.id);
      assert.equal(changed.error?.code, 'terms_changed', JSON.stringify(changed.error));
      assert.deepEqual(changed.error.details.changed, ['total', 'exceeds_ceiling']);
      assert.equal(posts.length, 0, 'nothing reached the merchant');
      assert.equal((await submit(proposed.id)).error.details.payment, 'invalidated');

      // 5. Unchanged terms: one approved submission clicks once and lands on the merchant's confirmation.
      await setText('#total', '$49.99');
      const second = await propose();
      await approve(second.approval.id);
      const paid = await submit(second.id);
      assert.equal(paid.error, null, JSON.stringify(paid.error));
      assert.equal(paid.result.status, 'submitted');
      assert.equal(paid.result.navigation, 'committed');
      await until(() => posts.length === 1, 'merchant received the order');
      assert.equal(posts[0].origin, 'merchant');
      assert.equal((await submit(second.id)).error.details.payment, 'already_submitted');
      await delay(200);
      assert.equal(posts.length, 1, 'one approval, one submission');

      // 6. Redirected checkout: the approved merchant page is replaced by a lookalike on another origin.
      await go(`${merchantOrigin}/checkout`);
      const third = await propose();
      await approve(third.approval.id);
      await go(`${otherOrigin}/checkout`);
      const redirected = await submit(third.id);
      assert.equal(redirected.error?.code, 'merchant_changed', JSON.stringify(redirected.error));
      assert.ok(redirected.error.details.changed.includes('merchant_origin'));
      assert.equal(posts.filter(post => post.origin === 'other').length, 0);

      // 7. Embedded checkout: the approved processor frame is swapped for another origin's frame.
      await go(`${merchantOrigin}/hosted`);
      await until(() => contents.mainFrame.framesInSubtree.some(frame => frame.origin === pspOrigin), 'hosted frame');
      const hosted = await propose({ amountCeiling: '30.00', checkout: { frameOrigin: pspOrigin, total: { selector: '#total' }, submit: { selector: '#pay' } } });
      assert.equal(hosted.merchant.frameOrigin, pspOrigin);
      assert.equal(hosted.observed.totalMinor, 2500);
      await approve(hosted.approval.id);
      await run('page.evaluate', { tabId, expression: `document.getElementById('hosted').src = ${JSON.stringify(`${otherOrigin}/hosted-frame`)}` }, human);
      await until(() => contents.mainFrame.framesInSubtree.some(frame => frame.origin === otherOrigin), 'swapped frame');
      await delay(200);
      const reframed = await submit(hosted.id);
      assert.equal(reframed.error?.code, 'merchant_changed', JSON.stringify(reframed.error));
      assert.deepEqual(reframed.error.details.changed, ['checkout_frame']);
      assert.equal(posts.length, 1, 'neither the processor nor the lookalike received a payment');
      // The same embedded checkout, unchanged, submits inside the frame.
      await go(`${merchantOrigin}/hosted`);
      await until(() => contents.mainFrame.framesInSubtree.some(frame => frame.origin === pspOrigin), 'hosted frame again');
      const hostedAgain = await propose({ amountCeiling: '30.00', checkout: { frameOrigin: pspOrigin, total: { selector: '#total' }, submit: { selector: '#pay' } } });
      await approve(hostedAgain.approval.id);
      const framedPaid = await submit(hostedAgain.id);
      assert.equal(framedPaid.error, null, JSON.stringify(framedPaid.error));
      await until(() => posts.some(post => post.origin === 'psp'), 'processor received the frame submission');

      // 8. No card number or security code in outcomes, events, activity, approvals or payment records.
      assert.deepEqual(leaks(outcomes), [], 'command outcomes');
      assert.deepEqual(leaks(events), [], 'events');
      assert.deepEqual(leaks(readFileSync(join(profile, 'payments', 'payments.json'), 'utf8')), [], 'payment records');
      assert.deepEqual(leaks(readFileSync(join(profile, 'workspace-data', 'activity-log.jsonl'), 'utf8')), [], 'activity');
      assert.deepEqual(leaks(readFileSync(join(profile, 'workspace-data', 'approvals.json'), 'utf8')), [], 'approvals');
      assert.deepEqual(leaks(readFileSync(join(profile, 'credentials', 'vault', 'vault.json'), 'utf8')), [], 'vault holds ciphertext');
      console.log('PAYMENTS_BROWSER_OK');
    } finally {
      credentials.close();
      browser.close();
      window.destroy();
      for (const server of [psp, merchant, other]) { server.closeAllConnections(); server.close(); }
      workspace.close();
      app.quit();
    }
  })().catch(error => { console.error(error); app.exit(1); });
} else {
  test('real Chromium checkout: card fill is protected and separate, changed totals, redirects and swapped frames are refused, one approval submits once', {
    timeout: 90000,
    skip: process.platform === 'linux' && !process.env.DISPLAY ? 'Requires a display; run xvfb-run -a npm test on headless Linux' : false,
  }, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'weft-payments-browser-'));
    mkdirSync(profile, { recursive: true });
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', fileURLToPath(import.meta.url), '--payments-smoke'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', WEFT_TEST_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 80000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, output);
      assert.match(output, /PAYMENTS_BROWSER_OK/);
    } finally { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); }
  });
}
