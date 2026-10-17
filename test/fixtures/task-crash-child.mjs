// Child process for the process-interruption test: it starts two runtime tasks whose
// current steps never return (one external page click, one local text capture),
// reports when both steps are in flight, then waits to be killed with SIGKILL.
import { createRuntimeFixture } from './task-runtime-fixture.mjs';

const directory = process.argv[2];
const f = createRuntimeFixture({ directory, pages: { 1: 'https://shop.example.com/cart', 2: 'https://docs.example.com/guide' } });
const create = (title, step) => f.run('tasks.create', { workspaceId: f.workspaceId, title, plan: [step, { kind: 'command', title: 'Note result', command: 'context.create', args: { title: `${title} done`, category: 'findings' } }] });
const external = await create('Submit order', { kind: 'command', title: 'Click place order', command: 'page.click', args: { tabId: 1, selector: '#place-order' } });
const local = await create('Capture guide', { kind: 'command', title: 'Capture guide text', command: 'artifacts.capture', args: { tabId: 2, kind: 'text' } });
const clickHold = f.page.hold(1);
await f.run('tasks.start', { id: external.id, executor: { type: 'runner', autonomy: 'autonomous' } });
await clickHold.started;
const captureHold = f.page.hold(2);
await f.run('tasks.start', { id: local.id, executor: { type: 'runner', autonomy: 'autonomous' } });
await captureHold.started;
process.stdout.write(`${JSON.stringify({ ready: true, external: external.id, local: local.id })}\n`);
setInterval(() => {}, 1000);
