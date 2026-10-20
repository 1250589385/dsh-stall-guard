/**
 * A minimal stand-in for the Cordis Host context.
 *
 * The guard only touches four Host surfaces — `on`, `get`, `inject`, `effect` — so a
 * real Context is not needed to test it, and a fake keeps the tests honest about which
 * parts of the Host contract the plugin actually depends on.
 */

/** One registered listener, kept so a test can fire it and count disposals. */
class ListenerTable {
  constructor() {
    this.entries = [];
  }

  on(name, handler) {
    const entry = { name, handler, disposed: false };
    this.entries.push(entry);
    return () => {
      entry.disposed = true;
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    };
  }

  find(name) {
    return this.entries.filter((entry) => entry.name === name && !entry.disposed);
  }
}

export function createFakeContext({ services = {}, locale = 'zh' } = {}) {
  const listeners = new ListenerTable();
  const effects = [];
  const serviceTable = { locale: localeService(locale), ...services };

  const ctx = {
    listeners,
    effects,
    on(name, handler) {
      return listeners.on(name, handler);
    },
    get(name) {
      return serviceTable[name];
    },
    inject(names, callback) {
      const scoped = createFakeContext({ services: serviceTable, locale });
      callback(scoped);
      return () => {};
    },
    effect(factory, label) {
      const dispose = factory();
      const entry = { label, dispose, disposed: false };
      effects.push(entry);
      return () => {
        if (entry.disposed) return;
        entry.disposed = true;
        if (typeof dispose === 'function') dispose();
      };
    },
  };

  return ctx;
}

function localeService(id) {
  const subscribers = [];
  return {
    getLocale: () => ({ id }),
    getSnapshot: () => ({ id }),
    subscribe: (fn) => {
      subscribers.push(fn);
      return () => {
        const index = subscribers.indexOf(fn);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
    setLocale: (next) => {
      id = next;
      for (const fn of subscribers) fn();
    },
  };
}

/**
 * A `tools/execute` dispatcher: runs the single registered listener and hands it the
 * same `next()` protocol the Host uses.
 */
export async function dispatch(fake, exec, body) {
  const listeners = fake.listeners.find('tools/execute');
  if (listeners.length !== 1) throw new Error(`expected exactly one tools/execute listener, found ${listeners.length}`);
  return listeners[0].handler(exec, body);
}

/** Build one dispatch execution object with the fields the guard reads. */
export function makeExec(name, args, { callId = 'call-1', signal } = {}) {
  return {
    callId,
    name,
    arguments: args,
    signal: signal ?? new AbortController().signal,
  };
}

/** Resolve after `ms` of real time; used only where a test needs an actual delay. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A controllable clock so tests can assert on elapsed time without waiting. */
export function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
  };
}
