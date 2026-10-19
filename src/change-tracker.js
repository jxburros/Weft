/**
 * Change tracking for one workspace transaction (#108).
 *
 * While a command runs, the workspace state is seen through a thin proxy: the
 * top-level object and each record collection array. Every record read out of a
 * collection is noted, as is every collection touched and every top-level key
 * replaced. A record that was never read during the transaction cannot have been
 * changed through the state, so the store diffs only touched collections and
 * re-serializes only records that were read (or added) instead of every record of
 * every collection.
 *
 * Records themselves are never wrapped, so structuredClone, identity checks and
 * component getters behave exactly as on plain state. Values written through the
 * proxies are unwrapped, so state never stores a proxy. Any use of a proxy after
 * the transaction finished is reported through `onLate`, so the owner can fall back
 * to a full diff on its next write instead of trusting stale hints.
 */
const RAW = Symbol('weft.trackedTarget');

/** The plain object behind a tracking proxy, or the value itself. */
export const untracked = value => (value && typeof value === 'object' && value[RAW]) || value;

const isIndex = key => typeof key === 'string' && key !== '' && String(Number(key) >>> 0) === key;

export function trackChanges(root, { onLate = () => {} } = {}) {
  let open = true;
  /** Collection name → set of record objects read or written during the transaction. */
  const records = new Map();
  /** Top-level keys whose value was replaced, defined or deleted (diffed in full). */
  const replaced = new Set();
  const proxies = new Map();
  const late = () => { if (!open) onLate(); return !open; };
  const seen = name => { let set = records.get(name); if (!set) records.set(name, set = new Set()); return set; };
  const collection = (name, array) => {
    const cached = proxies.get(name);
    if (cached?.target === array) return cached.proxy;
    const noted = seen(name);
    const note = (key, value) => { if (isIndex(key) && value && typeof value === 'object') noted.add(value); };
    const proxy = new Proxy(array, {
      get(target, key, receiver) {
        if (key === RAW) return target;
        late();
        const value = Reflect.get(target, key, receiver);
        note(key, value);
        return value;
      },
      set(target, key, value) { late(); value = untracked(value); note(key, target[key]); note(key, value); return Reflect.set(target, key, value); },
      defineProperty(target, key, descriptor) {
        late();
        if ('value' in descriptor) descriptor = { ...descriptor, value: untracked(descriptor.value) };
        note(key, target[key]); note(key, descriptor.value);
        return Reflect.defineProperty(target, key, descriptor);
      },
      deleteProperty(target, key) { late(); note(key, target[key]); return Reflect.deleteProperty(target, key); },
    });
    proxies.set(name, { target: array, proxy });
    return proxy;
  };
  const proxy = new Proxy(root, {
    get(target, key, receiver) {
      if (key === RAW) return target;
      late();
      const value = Reflect.get(target, key, receiver);
      return typeof key === 'string' && Array.isArray(value) ? collection(key, value) : value;
    },
    set(target, key, value) { late(); replaced.add(key); return Reflect.set(target, key, untracked(value)); },
    defineProperty(target, key, descriptor) {
      late(); replaced.add(key);
      if ('value' in descriptor) descriptor = { ...descriptor, value: untracked(descriptor.value) };
      return Reflect.defineProperty(target, key, descriptor);
    },
    deleteProperty(target, key) { late(); replaced.add(key); return Reflect.deleteProperty(target, key); },
  });
  return {
    proxy,
    /** Stop tracking and return the hints for the store. */
    finish() { open = false; return { records, replaced }; },
  };
}
