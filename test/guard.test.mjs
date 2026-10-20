/**
 * The timeout wrapper, end to end.
 *
 * These tests exercise the real `tools/execute` listener through a fake Host context:
 * a slow body, a real `setTimeout`, and a real abort. That combination is what broke in
 * earlier iterations, so it is tested with actual elapsed time rather than a fake clock.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installGuard } from '../lib/guard.js';
import { StallMonitor, LEVEL_FAILED, LEVEL_NOTICE, LEVEL_SWITCHED } from '../lib/state.js';
import { createFakeContext, dispatch, makeExec, sleep } from './helpers.mjs';

/** A config store double that always returns `config`. */
function store(config) {
  const merged = {
    enabled: true,
    autoSwitch: true,
    timers: { fetch: 1, search: 1, read: 1, write: 1, exec: 1, long: 1, other: 1 },
    overrides: {},
    supervisor: { display: 'avatar', show: true },
    ...config,
  };
  return { get: () => merged };
}

/**
 * A tool body that resolves after `ms`, or rejects when the execution's signal aborts.
 *
 * The Host calls `next()` with no arguments, so the body closes over `exec` instead of
 * receiving it: that mirrors a real tool, which is handed its execution once.
 */
function body(exec, { ms, value = { isError: false, content: [], value: null }, honourAbort = true } = {}) {
  return () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    if (honourAbort) {
      exec.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(exec.signal.reason ?? new Error('aborted'));
      }, { once: true });
    }
  });
}

/** A `web` double. */
function fakeWeb(responses = []) {
  return {
    async search() {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? { sources: [{ url: 'https://example.com/r', title: 'R', snippet: 'hit' }] };
    },
  };
}

test('a fast call is untouched and leaves no trace', async () => {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({}), monitor, locale: () => 'zh' });

  const exec = makeExec('bash', { command: 'echo hi' });
  const result = await dispatch(ctx, exec, body(exec, { ms: 10 }));
  assert.equal(result.isError, false);
  assert.equal(monitor.snapshot().stats.stalls, 0);
  assert.equal(monitor.snapshot().supervisor.mode, 'idle');
  dispose();
});

test('a notify-class call that exceeds its budget raises an alert and keeps running', async () => {
  const monitor = new StallMonitor();
  const ctx = createFakeContext({});
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, exec: 1 } }), monitor, locale: () => 'zh' });

  const exec = makeExec('bash', { command: 'sleep 10' });
  // Deliberately longer than the 1s budget, and the body ignores nothing: it finishes.
  const result = await dispatch(ctx, exec, body(exec, { ms: 1400 }));

  // The default policy for `exec` is notify: the body completed, the result is real.
  assert.equal(result.isError, false);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.stats.stalls, 1, 'the stall must be recorded even though the body finished');
  assert.equal(snapshot.stats.notices, 1);
  assert.equal(snapshot.stats.switches, 0);
  assert.equal(snapshot.supervisor.level, LEVEL_NOTICE, 'an overrun that still succeeded stays a notice, not a failure');
  assert.equal(snapshot.supervisor.action, 'notify');
  assert.ok(snapshot.supervisor.message.length > 0, 'the notified alert must carry a sentence');
  dispose();
});

test('a notify-class call is never aborted', async () => {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, exec: 1 } }), monitor, locale: () => 'zh' });
  let sawAbort = false;
  const exec = makeExec('bash', { command: 'long job' });
  const originalSignal = exec.signal;
  originalSignal.addEventListener('abort', () => { sawAbort = true; });

  const result = await dispatch(ctx, exec, async (inner) => {
    await sleep(250);
    return { isError: false, content: [], value: 'done' };
  });

  assert.equal(result.value, 'done');
  assert.equal(sawAbort, false, 'the write/exec policy must not abort the caller signal');
  assert.equal(exec.signal, originalSignal, 'the original signal must be restored');
  dispose();
});

test('a stalled fetch is aborted and answered by the search alternative', async () => {
  const web = fakeWeb([{ sources: [{ url: 'https://example.com/x', title: 'X', snippet: 'hit' }] }]);
  const ctx = createFakeContext({ services: { web } });
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, fetch: 1 } }), monitor, locale: () => 'zh' });

  const exec = makeExec('web_fetch', { url: 'https://example.com/some-topic' });
  let aborted = false;
  const result = await dispatch(ctx, exec, () => new Promise((resolve, reject) => {
    exec.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted by guard'));
    }, { once: true });
  }));

  assert.equal(aborted, true, 'the stalled fetch must be aborted');
  assert.equal(result.isError, false, 'the alternative route succeeded, so the call is a success');
  assert.equal(result.value.switchedFrom, 'web_fetch');
  assert.equal(result.value.sources.length, 1);

  const snapshot = monitor.snapshot();
  assert.equal(snapshot.stats.stalls, 1);
  assert.equal(snapshot.stats.switches, 1);
  assert.equal(snapshot.supervisor.level, LEVEL_SWITCHED);
  assert.equal(snapshot.supervisor.action, 'switch');
  assert.equal(snapshot.supervisor.fallback, 'web_search');
  assert.equal(snapshot.supervisor.fallbackOk, true);
  dispose();
});

test('a failed alternative is reported as a failed switch, and the original error surfaces', async () => {
  const web = fakeWeb([new Error('provider down')]);
  const ctx = createFakeContext({ services: { web } });
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, fetch: 1 } }), monitor, locale: () => 'zh' });

  const exec = makeExec('web_fetch', { url: 'https://example.com/topic' });
  const result = await dispatch(ctx, exec, () => new Promise((resolve, reject) => {
    exec.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
  }));

  assert.equal(result.isError, true, 'a failed alternative must be an error result');
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.stats.switches, 1);
  assert.equal(snapshot.supervisor.level, LEVEL_FAILED);
  assert.equal(snapshot.supervisor.fallbackOk, false);
  dispose();
});

test('a real result that beats the abort wins over the fallback', async () => {
  const web = fakeWeb([{ sources: [{ url: 'https://example.com/x', title: 'X' }] }]);
  const ctx = createFakeContext({ services: { web } });
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, fetch: 1 } }), monitor, locale: () => 'zh' });

  const exec = makeExec('web_fetch', { url: 'https://example.com/topic' });
  // The body ignores the abort (no signal listener at all) and answers successfully
  // just after the budget, which is the race the "real result wins" rule exists for.
  const result = await dispatch(ctx, exec, async () => {
    await sleep(1100);
    return { isError: false, content: [{ type: 'text', text: 'the real page' }], value: { real: true } };
  });

  assert.deepEqual(result.value, { real: true }, 'a usable result must not be discarded for a substitute');
  assert.equal(result.content[0].text, 'the real page');
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.stats.stalls, 1);
  assert.equal(snapshot.supervisor.level, LEVEL_NOTICE, 'a successful real result is a notice, never a failure');
  dispose();
});

test('an error result from the body is not mistaken for success', async () => {
  const web = fakeWeb([{ sources: [{ url: 'https://example.com/x', title: 'X' }] }]);
  const ctx = createFakeContext({ services: { web } });
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, fetch: 1 } }), monitor, locale: () => 'zh' });

  const exec = makeExec('web_fetch', { url: 'https://example.com/topic' });
  const result = await dispatch(ctx, exec, async () => {
    await sleep(1100);
    return { isError: true, content: [{ type: 'text', text: 'the body failed' }] };
  });

  // The body failed, so the guard's alternative replaces it.
  assert.equal(result.isError, false);
  assert.equal(result.value.switchedFrom, 'web_fetch');
  dispose();
});

test('autoSwitch off turns a stalled fetch into a notify instead of a switch', async () => {
  const web = fakeWeb([{ sources: [{ url: 'https://example.com/x', title: 'X' }] }]);
  const ctx = createFakeContext({ services: { web } });
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, {
    config: store({ autoSwitch: false, timers: { ...store({}).get().timers, fetch: 1 } }),
    monitor,
    locale: () => 'zh',
  });

  const exec = makeExec('web_fetch', { url: 'https://example.com/topic' });
  const result = await dispatch(ctx, exec, body(exec, { ms: 1300, value: { isError: false, content: [], value: { real: true } } }));

  assert.deepEqual(result.value, { real: true });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.stats.switches, 0);
  assert.equal(snapshot.stats.notices, 1);
  assert.equal(snapshot.supervisor.action, 'notify');
  dispose();
});

test('a disabled plugin adds no timeout at all', async () => {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ enabled: false, timers: { ...store({}).get().timers, exec: 1 } }), monitor, locale: () => 'zh' });

  const exec = makeExec('bash', { command: 'x' });
  const result = await dispatch(ctx, exec, body(exec, { ms: 400 }));
  assert.equal(result.isError, false);
  assert.equal(monitor.snapshot().stats.stalls, 0);
  // No begin() happened, so nothing is in flight.
  assert.equal(monitor.snapshot().supervisor.mode, 'idle');
  dispose();
});

test('caller cancellation still propagates through the wrapper', async () => {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, exec: 30 } }), monitor, locale: () => 'zh' });

  const callerController = new AbortController();
  const exec = makeExec('bash', { command: 'x' }, { signal: callerController.signal });
  setTimeout(() => callerController.abort(new Error('user pressed stop')), 50);

  await assert.rejects(
    () => dispatch(ctx, exec, body(exec, { ms: 5000 })),
    /user pressed stop/,
  );
  dispose();
});

test('the original signal is restored after a switch', async () => {
  const web = fakeWeb([{ sources: [{ url: 'https://example.com/x', title: 'X' }] }]);
  const ctx = createFakeContext({ services: { web } });
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, fetch: 1 } }), monitor, locale: () => 'zh' });

  const exec = makeExec('web_fetch', { url: 'https://example.com/topic' });
  const original = exec.signal;
  await dispatch(ctx, exec, () => new Promise((resolve, reject) => {
    exec.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  assert.equal(exec.signal, original, 'the caller signal must be restored even on the switch path');
  dispose();
});

test('a per-tool override shortens one tool without touching its class', async () => {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, {
    config: store({ timers: { ...store({}).get().timers, exec: 30 }, overrides: { bash: 1 } }),
    monitor,
    locale: () => 'zh',
  });

  const exec = makeExec('bash', { command: 'echo' });
  await dispatch(ctx, exec, body(exec, { ms: 1400 }));
  assert.equal(monitor.snapshot().stats.stalls, 1, 'the override must apply to bash');
  dispose();
});

test('the disposer clears pending timers and removes the listener', async () => {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({}), monitor, locale: () => 'zh' });
  assert.equal(ctx.listeners.find('tools/execute').length, 1);
  dispose();
  assert.equal(ctx.listeners.find('tools/execute').length, 0, 'the listener must be removed');
});

test('a download-shaped command is flagged for a gentler message', async () => {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, exec: 1 } }), monitor, locale: () => 'zh' });

  const exec = makeExec('bash', { command: 'curl -L https://example.com/big.zip -o big.zip' });
  await dispatch(ctx, exec, body(exec, { ms: 1300 }));
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.supervisor.download, true);
  assert.equal(snapshot.recent[0].download, true);
  dispose();
});

test('an English locale produces English copy', async () => {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({ timers: { ...store({}).get().timers, exec: 1 } }), monitor, locale: () => 'en-US' });

  const exec = makeExec('bash', { command: 'x' });
  await dispatch(ctx, exec, body(exec, { ms: 1300 }));
  const message = monitor.snapshot().supervisor.message;
  assert.match(message, /has run|budget|stuck|download/i, `expected English copy, got: ${message}`);
  dispose();
});
