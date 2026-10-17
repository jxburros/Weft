// Child process for the payment interruption test: proposes a payment, has it approved, issues a
// virtual card from the fake issuer, starts a task whose payments.submit step reaches the click,
// reports once the attempt is committed, then waits to be killed with SIGKILL.
import { join } from 'node:path';
import { createRuntimeFixture } from './task-runtime-fixture.mjs';
import { scriptedCheckout, testProtector, ISSUER_KEY } from './payment-fixture.mjs';
import { PaymentService } from '../../src/payments.js';
import { CredentialService } from '../../src/credentials.js';

const [directory, issuerUrl, keyHex] = process.argv.slice(2);
// `node --test` also loads files under test/; without arguments this is not the spawned child.
if (!directory) process.exit(0);
const protector = testProtector(keyHex);
const f = createRuntimeFixture({ directory, pages: { 1: 'https://shop.example.com/checkout?step=pay' },
  credentialService: ({ workspace, browser }) => new CredentialService({ directory: join(directory, 'credentials'), protector, browser, workspace }),
  paymentService: ({ workspace, browser, credentials }) => new PaymentService({ directory: join(directory, 'payments'), browser, workspace, credentials, protector }) });
const page = scriptedCheckout(f, directory, { click: 'hang' });
await f.run('payments.configureProvider', { provider: 'issuer_api', enabled: true, baseUrl: issuerUrl, apiKey: ISSUER_KEY });
const proposed = await f.run('payments.propose', { workspaceId: f.workspaceId, tabId: 1, merchantName: 'Example Shop', purpose: 'Printer paper', amountCeiling: '60.00', currency: 'USD',
  checkout: { total: { selector: '#total' }, submit: { selector: '#pay' } } }, { actor: 'automation' });
await f.run('approvals.approve', { id: proposed.approval.id, mode: 'once' });
await f.run('payments.issueCard', { id: proposed.id });
const task = await f.run('tasks.create', { workspaceId: f.workspaceId, title: 'Pay for paper', plan: [{ kind: 'command', title: 'Pay', command: 'payments.submit', args: { id: proposed.id, tabId: 1 } }] });
const attempted = new Promise(resolve => { page.onAttempt = resolve; });
await f.run('tasks.start', { id: task.id, executor: { type: 'automation' } });
await attempted;
const cardToken = f.payments.records[0].virtualCard.token;
process.stdout.write(`${JSON.stringify({ ready: true, paymentId: proposed.id, taskId: task.id, cardToken })}\n`);
setInterval(() => {}, 1000);
