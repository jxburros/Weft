import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./sandbox-child.cjs', import.meta.url));
const MAX_LINE = 8 * 1024 * 1024 + 4096;
const failure = (code, message) => Object.assign(new Error(message), { code });

/**
 * One OS process per enabled third-party plugin. The process gets an empty
 * environment, Node's permission model (no fs/child_process/worker/addons),
 * a small heap and per-call wall-clock limits. Termination rejects every
 * in-flight call; nothing is retried automatically.
 */
export class PluginSandbox {
  constructor({ name, code, timeoutMs = 2000, heapMb = 64 }) {
    Object.assign(this, { name, code, timeoutMs, heapMb });
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.ready = null;
    this.terminated = null;
  }

  start() {
    if (this.terminated) return Promise.reject(failure('cancelled', `Plugin ${this.name} was revoked: ${this.terminated}`));
    if (this.ready) return this.ready;
    const args = ['--permission', `--max-old-space-size=${this.heapMb}`, '--disallow-code-generation-from-strings', CHILD];
    // Inside Electron, execPath is the Electron binary; run it as plain Node.
    const env = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    const child = spawn(process.execPath, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffered += chunk;
      if (buffered.length > MAX_LINE) { this.kill('Plugin output exceeded the limit'); return; }
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { this.kill('Plugin sandbox produced invalid output'); return; }
        const call = this.pending.get(message.id);
        if (!call) continue;
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.ok) call.resolve(message);
        else call.reject(failure(/timed out/.test(message.error) ? 'timeout' : 'command_failed', `Plugin ${this.name}: ${String(message.error).slice(0, 1000)}`));
      }
    });
    child.stderr.on('data', () => {}); // Never surface plugin stderr as trusted text.
    child.stdin.on('error', () => {});
    child.once('error', error => this.kill(`Plugin sandbox failed to start (${error.code || error.message})`));
    child.once('exit', code => { if (this.child === child) this.reset(`Plugin sandbox exited (${code})`); });
    this.ready = this.send({ type: 'load', code: this.code }).then(message => message.describe);
    this.ready.catch(() => {});
    return this.ready;
  }

  send(message) {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(failure('command_failed', `Plugin ${this.name} sandbox is not running`)); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => this.kill(`Plugin ${this.name} timed out after ${this.timeoutMs} ms`, 'timeout'), this.timeoutMs + 500);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...message, id, timeoutMs: this.timeoutMs }) + '\n');
    });
  }

  async call(kind, point, handler, input) {
    await this.start();
    const message = await this.send({ type: 'call', kind, point, handler, input: JSON.stringify(input) });
    return JSON.parse(message.output);
  }

  reset(reason, code = 'command_failed') {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(failure(code, reason)); }
    this.pending.clear();
    this.child = null;
    this.ready = null;
  }

  kill(reason, code = 'command_failed') {
    const child = this.child;
    this.reset(reason, code);
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }

  /** Revocation: rejects in-flight calls and refuses future ones. */
  terminate(reason = 'revoked by a person') {
    this.terminated = reason;
    this.kill(`Plugin ${this.name} was revoked: ${reason}`, 'cancelled');
  }
}
