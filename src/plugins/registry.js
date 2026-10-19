import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { evaluateAutonomy, registerPluginActionClass } from '../autonomy.js';
import { fileStamp, writeVerifiedJson } from '../storage-safety.js';
import { BUILTIN } from './builtin/index.js';
import { HOOK_POINTS, HOOK_NAMES, describeScope, effectiveActionClass, pluginDataClasses, validateManifest, zodFromJsonInput } from './manifest.js';
import { PluginSandbox, pluginNetworkIsolation } from './sandbox.js';

export { HOOK_POINTS, HOOK_NAMES };
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const human = context => ['human', 'admin'].includes(context?.actor);
const MANIFEST_FILE = 'weft-plugin.json';
const CODE_FILE = 'plugin.js';
// Commands a built-in plugin's capability may call, and the permission each needs.
const CAPABILITY_READS = Object.freeze({ 'context.list': 'workspaceRead', 'materials.list': 'workspaceRead', 'tasks.list': 'workspaceRead', 'artifacts.list': 'workspaceRead', 'activity.list': 'workspaceRead', 'search.query': 'workspaceRead', 'page.readable': 'pageRead' });
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
};

function checkBuiltins(list) {
  const seen = new Set();
  return list.map(({ manifest: raw, implementation = {} }) => {
    const manifest = validateManifest(raw, { builtin: true });
    if (seen.has(manifest.name)) throw new Error(`Duplicate built-in plugin ${manifest.name}`);
    seen.add(manifest.name);
    for (const point of new Set([...Object.keys(manifest.hooks), ...Object.keys(implementation.hooks ?? {})])) {
      const declared = manifest.hooks[point] ?? [];
      const provided = Object.keys(implementation.hooks?.[point] ?? {});
      if (declared.length !== provided.length || declared.some(id => typeof implementation.hooks[point][id] !== 'function')) throw new Error(`Built-in plugin ${manifest.name}: ${point} handlers must match the manifest`);
    }
    const ops = Object.keys(manifest.commands);
    if (ops.length !== Object.keys(implementation.commands ?? {}).length || ops.some(op => typeof implementation.commands[op] !== 'function')) throw new Error(`Built-in plugin ${manifest.name}: commands must match the manifest`);
    return Object.freeze({ manifest, implementation, builtin: true });
  });
}
const builtins = checkBuiltins(BUILTIN);
const workspaceField = z.string().min(1).max(200).optional();

/** Catalog contributions: plugin.<name>.<operation>, merged into the one shared command catalog. */
export const pluginCommandDefinitions = Object.fromEntries(builtins.flatMap(({ manifest }) => Object.entries(manifest.commands).map(([op, spec]) => {
  const name = `plugin.${manifest.name}.${op}`;
  registerPluginActionClass(name, effectiveActionClass(manifest, op), pluginDataClasses(manifest, op));
  return [name, [`${spec.description} (built-in plugin ${manifest.name} ${manifest.version})`, { ...spec.input, workspaceId: workspaceField }]];
})));

const grantSchema = z.strictObject({ name: z.string().max(40), version: z.string().max(20), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), codeSha256: z.string().regex(/^[a-f0-9]{64}$/), allowAutomation: z.boolean(), grantedAt: z.string().max(64), scope: z.array(z.string().max(500)).max(100) });
const stateSchema = z.strictObject({ version: z.literal(1), disabledBuiltins: z.array(z.string().max(40)).max(100), grants: z.array(grantSchema).max(100) });

function readBounded(path, limit) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${path.split(/[\\/]/).pop()} must be a regular file, not a link or directory`);
  const fd = openSync(path, 'r');
  try {
    if (fstatSync(fd).size > limit) throw new Error(`${path.split(/[\\/]/).pop()} exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(limit + 1);
    const length = readSync(fd, buffer, 0, limit + 1, 0);
    if (length > limit) throw new Error(`${path.split(/[\\/]/).pop()} exceeds ${limit} bytes`);
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

/**
 * The only path from core to plugins. Built-ins are reviewed core-adjacent
 * modules; third-party plugins are discovered as data, never imported, and run
 * only in a per-plugin sandbox process after an explicit human grant.
 */
export class PluginRegistry {
  constructor({ pluginsDirectory = null, stateDirectory = null, timeoutMs = 2000 } = {}) {
    this.builtins = new Map(builtins.map(entry => [entry.manifest.name, entry]));
    this.pluginsDirectory = pluginsDirectory;
    this.statePath = stateDirectory ? join(stateDirectory, 'plugin-grants.json') : null;
    this.timeoutMs = timeoutMs;
    this.stores = new Map();
    this.sandboxes = new Map();
    this.observerFailures = 0;
    this.state = { version: 1, disabledBuiltins: [], grants: [] };
    if (this.statePath) {
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      this.stamp = fileStamp(this.statePath);
      if (this.stamp) this.state = stateSchema.parse(JSON.parse(readFileSync(this.statePath, 'utf8')));
    }
  }

  save() {
    if (this.statePath) this.stamp = writeVerifiedJson(this.statePath, JSON.stringify(this.state), this.stamp);
  }

  /** Lists third-party plugins by reading manifests and hashing code. Never imports or executes plugin code. */
  discover() {
    if (!this.pluginsDirectory || !existsSync(this.pluginsDirectory)) return [];
    return readdirSync(this.pluginsDirectory, { withFileTypes: true }).filter(item => item.isDirectory()).slice(0, 100)
      .map(item => /^[a-z][a-z0-9-]{1,39}$/.test(item.name) ? this.discoverOne(item.name) : { name: item.name.slice(0, 40), builtin: false, manifest: null, problems: ['Directory names must be 2-40 lowercase letters, digits or hyphens'] }).filter(Boolean);
  }

  discoverOne(directoryName) {
    if (!this.pluginsDirectory || !/^[a-z][a-z0-9-]{1,39}$/.test(directoryName)) return null;
    const directory = join(this.pluginsDirectory, directoryName);
    try {
      if (!lstatSync(directory).isDirectory()) return null;
      const manifestBytes = readBounded(join(directory, MANIFEST_FILE), 64 * 1024);
      const codeBytes = readBounded(join(directory, CODE_FILE), 1024 * 1024);
      let parsed;
      try { parsed = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error(`${MANIFEST_FILE} is not valid JSON`); }
      const manifest = validateManifest(parsed);
      if (manifest.name !== directoryName) throw new Error(`Directory name ${directoryName} must equal manifest name ${manifest.name}`);
      if (this.builtins.has(manifest.name)) throw new Error(`Name ${manifest.name} is reserved by a built-in plugin`);
      return { name: manifest.name, builtin: false, manifest, directory, manifestSha256: sha256(manifestBytes), codeSha256: sha256(codeBytes), problems: [] };
    } catch (error) {
      if (error.code === 'ENOENT' && !existsSync(directory)) return null;
      return { name: directoryName, builtin: false, manifest: null, directory, problems: error.problems ?? [String(error.message).slice(0, 500)] };
    }
  }

  entry(name) {
    if (this.builtins.has(name)) return this.builtins.get(name);
    const entry = this.discoverOne(name);
    if (!entry) throw failure('not_found', `Plugin ${name} is not installed`);
    return entry;
  }
  grant(name) { return this.state.grants.find(item => item.name === name) ?? null; }
  status(entry) {
    if (entry.builtin) return this.state.disabledBuiltins.includes(entry.manifest.name) ? 'disabled' : 'enabled';
    if (!entry.manifest) return 'invalid';
    const grant = this.grant(entry.name);
    if (!grant) return 'disabled';
    return grant.manifestSha256 === entry.manifestSha256 && grant.codeSha256 === entry.codeSha256 ? 'enabled' : 'changed';
  }
  active(entry, seen = new Set()) {
    if (seen.has(entry.name ?? entry.manifest.name)) return false;
    seen.add(entry.name ?? entry.manifest.name);
    if (this.status(entry) !== 'enabled') return false;
    return entry.manifest.requires.every(name => { try { return this.active(this.entry(name), seen); } catch { return false; } });
  }
  /** Third-party code never runs for automation callers unless a person explicitly allowed it. */
  available(entry, context) {
    return this.active(entry) && (entry.builtin || human(context) || this.grant(entry.name)?.allowAutomation === true);
  }
  entries() { return [...this.builtins.values(), ...this.discover()]; }

  summary(entry) {
    const { manifest } = entry;
    const name = manifest?.name ?? entry.name;
    const grant = entry.builtin ? null : this.grant(name);
    return structuredClone({ name, builtin: entry.builtin, status: this.status(entry), active: manifest ? this.active(entry) : false,
      version: manifest?.version ?? null, description: manifest?.description ?? null, permissions: manifest?.permissions ?? null,
      hooks: manifest?.hooks ?? {}, requires: manifest?.requires ?? [], scope: manifest ? describeScope(manifest) : [],
      commands: manifest ? Object.entries(manifest.commands).map(([op, spec]) => ({ command: entry.builtin ? `plugin.${name}.${op}` : 'plugins.invoke', operation: op, description: spec.description,
        actionClass: effectiveActionClass(manifest, op), ...(entry.builtin ? {} : { input: spec.input, reads: spec.reads }) })) : [],
      ...(entry.builtin ? {} : { manifestSha256: entry.manifestSha256 ?? null, codeSha256: entry.codeSha256 ?? null, allowAutomation: grant?.allowAutomation ?? false,
        grantedAt: grant?.grantedAt ?? null, problems: entry.problems ?? [], runtime: 'Separate sandboxed process: no filesystem, network, process, Electron or credential access; 2 s per call; 64 MiB heap',
        networkIsolation: pluginNetworkIsolation().mode }) });
  }
  list() { return this.entries().map(entry => this.summary(entry)); }

  /** Providers registered at a hook point, filtered to plugins this caller may use. */
  hooks(point, context = {}) {
    if (!Object.hasOwn(HOOK_POINTS, point)) throw failure('invalid_arguments', `Unknown hook point ${point}`);
    // Only granted third-party plugins can be active, so ungranted directories are never read here.
    const candidates = [...this.builtins.values(), ...this.state.grants.map(grant => this.discoverOne(grant.name)).filter(Boolean)];
    return candidates.filter(entry => entry.manifest?.hooks[point] && this.available(entry, context)).flatMap(entry => entry.manifest.hooks[point].map(id => ({
      plugin: entry.manifest.name, version: entry.manifest.version, builtin: entry.builtin, id,
      run: input => this.invoke(entry, point, id, input),
    })));
  }
  first(point, id, context = {}) {
    const providers = this.hooks(point, context);
    const provider = providers.find(item => item.id === id);
    if (!provider) throw failure('unsupported', `No enabled plugin provides ${point} "${id}" for this caller`, { details: { available: providers.map(item => item.id) } });
    return provider;
  }

  async invoke(entry, point, id, input) {
    const spec = HOOK_POINTS[point];
    const data = spec.input.parse(input);
    if (spec.permission && !entry.manifest.permissions[spec.permission]) throw failure('permission_required', `Plugin ${entry.manifest.name} lacks ${spec.permission}`);
    const output = entry.builtin
      ? await entry.implementation.hooks[point][id](deepFreeze(structuredClone(data)), { store: this.store(entry.manifest.name) })
      : await (await this.sandbox(entry)).call('hook', point, id, data);
    if (point === 'after-command') return null;
    const parsed = spec.output.safeParse(output);
    if (!parsed.success) throw failure('command_failed', `Plugin ${entry.manifest.name} returned output outside the ${point} contract`);
    return parsed.data;
  }

  /** Observers never block or change a completed command; failures are counted, not surfaced as command errors. */
  async notify(point, event, context = {}) {
    let delivered = 0;
    for (const provider of this.hooks(point, context)) {
      try { await provider.run(event); delivered++; } catch { this.observerFailures++; }
    }
    return { delivered, failed: this.observerFailures };
  }

  store(name) {
    if (!this.stores.has(name)) this.stores.set(name, {});
    return this.stores.get(name);
  }

  async sandbox(entry) {
    const grant = this.grant(entry.name);
    const current = this.discoverOne(entry.name);
    if (!grant || !current?.manifest || current.manifestSha256 !== grant.manifestSha256 || current.codeSha256 !== grant.codeSha256) {
      this.sandboxes.get(entry.name)?.terminate('plugin files changed after the human grant');
      this.sandboxes.delete(entry.name);
      throw failure('permission_required', `Plugin ${entry.name} changed since a person enabled it; review and enable it again`);
    }
    let sandbox = this.sandboxes.get(entry.name);
    if (!sandbox || sandbox.codeSha256 !== grant.codeSha256 || sandbox.terminated) {
      sandbox?.terminate('replaced');
      sandbox = new PluginSandbox({ name: entry.name, code: readBounded(join(current.directory, CODE_FILE), 1024 * 1024).toString('utf8'), timeoutMs: this.timeoutMs });
      sandbox.codeSha256 = grant.codeSha256;
      this.sandboxes.set(entry.name, sandbox);
    }
    const described = await sandbox.start();
    if (described?.error) throw failure('command_failed', `Plugin ${entry.name}: ${described.error}`);
    const { manifest } = current;
    const missing = [...Object.entries(manifest.hooks).flatMap(([point, ids]) => ids.filter(id => !described.hooks?.[point]?.includes(id)).map(id => `${point}:${id}`)),
      ...Object.keys(manifest.commands).filter(op => !described.commands?.includes(op))];
    const undeclared = [...Object.entries(described.hooks ?? {}).flatMap(([point, ids]) => ids.filter(id => !manifest.hooks[point]?.includes(id)).map(id => `${point}:${id}`)),
      ...(described.commands ?? []).filter(op => !Object.hasOwn(manifest.commands, op))];
    if (missing.length || undeclared.length) {
      sandbox.terminate('code does not match its manifest');
      this.sandboxes.delete(entry.name);
      throw failure('command_failed', `Plugin ${entry.name} code does not match its manifest (missing: ${missing.join(', ') || 'none'}; undeclared: ${undeclared.join(', ') || 'none'})`);
    }
    return sandbox;
  }

  /** Effective authority class and data classes of a plugin operation, for the dispatcher's gate (null when unknown). */
  classify(name, op) {
    let entry;
    try { entry = this.entry(name); } catch { return null; }
    if (!entry?.manifest || !Object.hasOwn(entry.manifest.commands, op)) return null;
    return { actionClass: effectiveActionClass(entry.manifest, op), dataClasses: pluginDataClasses(entry.manifest, op) };
  }

  gate(entry, op, context) {
    if (human(context)) return;
    if (!entry.builtin && this.grant(entry.name)?.allowAutomation !== true) throw failure('permission_required', `Third-party plugin ${entry.name} is available to automation only if a person allows it`);
    // The shared dispatcher already authorized this exact command at the plugin's effective class
    // (including any human approval); only a registry used outside the dispatcher evaluates here.
    const authorized = context.authorityDecision;
    if (authorized && ['auto', 'auto_preapproved'].includes(authorized.decision) && authorized.actionClass === effectiveActionClass(entry.manifest, op)) return;
    const decision = evaluateAutonomy({ actor: context.actor, actionClass: effectiveActionClass(entry.manifest, op), level: context.autonomyLevel ?? 'scoped' });
    if (!['auto', 'auto_preapproved'].includes(decision.decision)) throw failure('permission_required', `Plugin command plugin.${entry.manifest.name}.${op} requires approval (${decision.reason})`);
  }

  capability(entry, workspaceId, context, call) {
    const { permissions } = entry.manifest;
    return Object.freeze({ workspaceId, actor: context.actor, store: this.store(entry.manifest.name),
      read: async (command, input = {}) => {
        const needed = CAPABILITY_READS[command];
        if (!needed) throw failure('permission_required', `Plugin capability does not include ${command}`);
        if (!permissions[needed]) throw failure('permission_required', `Plugin ${entry.manifest.name} did not declare ${needed}`);
        return structuredClone(await call(command, { ...input, workspaceId }));
      } });
  }

  async execute(name, args, context = {}, { call } = {}) {
    if (name === 'plugins.list') return this.list();
    if (name === 'plugins.enable' || name === 'plugins.disable') {
      if (context.actor !== 'human') throw failure('human_required', 'Plugin enablement requires the trusted browser interface');
      const entry = this.entry(args.name);
      return name === 'plugins.enable' ? this.enable(entry, args) : this.disable(entry);
    }
    if (name === 'plugins.invoke') return this.invokeCommand(args, context, call);
    const [, pluginName, op] = name.split('.');
    const entry = this.builtins.get(pluginName);
    if (!entry || !Object.hasOwn(entry.manifest.commands, op)) throw failure('unknown_command', `Unknown plugin command ${name}`);
    if (!this.active(entry)) throw failure('unavailable', `Plugin ${pluginName} is disabled`);
    this.gate(entry, op, context);
    const { workspaceId, ...input } = args;
    return entry.implementation.commands[op](structuredClone(input), this.capability(entry, workspaceId, context, call));
  }

  enable(entry, args) {
    const before = structuredClone(this.state);
    try {
      if (entry.builtin) {
        this.state.disabledBuiltins = this.state.disabledBuiltins.filter(item => item !== entry.manifest.name);
      } else {
        if (!entry.manifest) throw failure('invalid_arguments', `Plugin ${entry.name} is invalid: ${entry.problems.join('; ')}`);
        if (args.manifestSha256 !== entry.manifestSha256 || args.codeSha256 !== entry.codeSha256) throw failure('stale_state', 'Plugin files differ from the reviewed digests; list plugins again and review the current scope');
        const missing = entry.manifest.requires.filter(name => { try { return !this.active(this.entry(name)); } catch { return true; } });
        if (missing.length) throw failure('invalid_arguments', `Enable required plugins first: ${missing.join(', ')}`);
        this.sandboxes.get(entry.name)?.terminate('re-granted');
        this.sandboxes.delete(entry.name);
        this.state.grants = this.state.grants.filter(item => item.name !== entry.name);
        this.state.grants.push({ name: entry.name, version: entry.manifest.version, manifestSha256: entry.manifestSha256, codeSha256: entry.codeSha256,
          allowAutomation: args.allowAutomation === true, grantedAt: new Date().toISOString(), scope: describeScope(entry.manifest) });
      }
      this.save();
    } catch (error) { this.state = before; throw error; }
    return this.summary(entry);
  }

  disable(entry) {
    const before = structuredClone(this.state);
    const name = entry.manifest?.name ?? entry.name;
    try {
      if (entry.builtin) { if (!this.state.disabledBuiltins.includes(name)) this.state.disabledBuiltins.push(name); }
      else this.state.grants = this.state.grants.filter(item => item.name !== name);
      this.save();
    } catch (error) { this.state = before; throw error; }
    // Revocation terminates the process, rejecting in-flight calls.
    this.sandboxes.get(name)?.terminate('disabled by a person');
    this.sandboxes.delete(name);
    return this.summary(entry);
  }

  async invokeCommand(args, context, call) {
    const entry = this.entry(args.name);
    if (entry.builtin) throw failure('invalid_arguments', `Use plugin.${args.name}.${args.operation} for built-in plugin commands`);
    if (!entry.manifest || !Object.hasOwn(entry.manifest.commands, args.operation)) throw failure('unknown_command', `Plugin ${args.name} has no operation ${args.operation}`);
    if (!this.active(entry)) throw failure('unavailable', `Plugin ${args.name} is not enabled (${this.status(entry)})`);
    this.gate(entry, args.operation, context);
    const spec = entry.manifest.commands[args.operation];
    const parsed = zodFromJsonInput(spec.input).safeParse(args.args ?? {});
    if (!parsed.success) throw failure('invalid_arguments', `Arguments do not match ${args.name}.${args.operation}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'args'} ${issue.message}`).join('; ').slice(0, 1000)}`);
    const data = {};
    for (const collection of spec.reads) {
      const value = await call(`${collection}.list`, { workspaceId: args.workspaceId });
      // Durable activity is paginated ({items, nextCursor}); plugins receive the newest page as a plain list.
      data[collection] = collection === 'activity' ? value.items : value;
    }
    const result = await (await this.sandbox(entry)).call('command', null, args.operation, { args: parsed.data, data });
    return { plugin: { name: entry.name, version: entry.manifest.version }, operation: args.operation, workspaceId: args.workspaceId ?? null, untrusted: true, result };
  }

  close() { for (const sandbox of this.sandboxes.values()) sandbox.terminate('Weft is closing'); this.sandboxes.clear(); }
}
