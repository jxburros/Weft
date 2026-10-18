'use strict';
// Runs one third-party plugin. Started by sandbox.js with Node's permission
// model (no filesystem, child process, worker or addon access) and an empty
// environment. Plugin code runs in a fresh vm context that has no require,
// process, timers, network or string code generation. Only JSON strings cross
// the context boundary, so no host object or host Function is reachable.
const vm = require('node:vm');

const LIMIT = 8 * 1024 * 1024;
let context;
let buffered = '';
const send = message => {
  const line = JSON.stringify(message);
  if (line.length > LIMIT) process.stdout.write(JSON.stringify({ id: message.id, ok: false, error: 'Plugin output exceeds the 8 MiB limit' }) + '\n');
  else process.stdout.write(line + '\n');
};
const DISPATCH = `(function (kind, point, handler, input) {
  'use strict';
  try {
    const plugin = globalThis.weftPlugin;
    const table = kind === 'hook' ? plugin && plugin.hooks && plugin.hooks[point] : plugin && plugin.commands;
    const fn = table && Object.prototype.hasOwnProperty.call(table, handler) ? table[handler] : undefined;
    if (typeof fn !== 'function') return JSON.stringify({ error: 'Handler is not defined by plugin.js' });
    const parsed = JSON.parse(input);
    const result = kind === 'hook' ? fn(parsed) : fn(parsed.args, parsed.data);
    if (result && typeof result.then === 'function') return JSON.stringify({ error: 'Asynchronous plugin handlers are unsupported; return a value synchronously' });
    const output = JSON.stringify(result === undefined ? null : result);
    return JSON.stringify({ output: output });
  } catch (error) {
    let message = 'Plugin handler threw';
    try { message = String(error && error.message || error).slice(0, 1000); } catch (ignored) {}
    return JSON.stringify({ error: message });
  }
})`;
const DESCRIBE = `JSON.stringify((function () {
  const plugin = globalThis.weftPlugin;
  if (!plugin || typeof plugin !== 'object') return { error: 'plugin.js must assign globalThis.weftPlugin = { hooks, commands }' };
  const hooks = {};
  for (const point of Object.keys(plugin.hooks || {})) hooks[point] = Object.keys(plugin.hooks[point] || {}).filter(id => typeof plugin.hooks[point][id] === 'function');
  return { hooks: hooks, commands: Object.keys(plugin.commands || {}).filter(op => typeof plugin.commands[op] === 'function') };
})())`;

function handle(message) {
  const timeout = Math.min(Math.max(Number(message.timeoutMs) || 2000, 10), 10000);
  if (message.type === 'load') {
    context = vm.createContext(Object.create(null), { name: 'weft-plugin', codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
    try {
      new vm.Script(String(message.code), { filename: 'plugin.js' }).runInContext(context, { timeout });
      send({ id: message.id, ok: true, describe: JSON.parse(new vm.Script(DESCRIBE).runInContext(context, { timeout })) });
    } catch (error) { send({ id: message.id, ok: false, error: `Plugin failed to load: ${String(error && error.message).slice(0, 1000)}` }); }
    return;
  }
  if (!context) { send({ id: message.id, ok: false, error: 'Plugin is not loaded' }); return; }
  const source = `${DISPATCH}(${JSON.stringify(message.kind)}, ${JSON.stringify(message.point || '')}, ${JSON.stringify(message.handler)}, ${JSON.stringify(message.input)})`;
  try {
    const reply = JSON.parse(new vm.Script(source).runInContext(context, { timeout }));
    send(reply.error ? { id: message.id, ok: false, error: reply.error } : { id: message.id, ok: true, output: reply.output });
  } catch (error) {
    send({ id: message.id, ok: false, error: /timed out/i.test(String(error && error.message)) ? 'Plugin handler timed out' : `Plugin handler failed: ${String(error && error.message).slice(0, 1000)}` });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  if (buffered.length > LIMIT * 2) process.exit(3);
  let index;
  while ((index = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    let message;
    try { message = JSON.parse(line); } catch { process.exit(4); }
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
