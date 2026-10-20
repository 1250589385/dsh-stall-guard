/**
 * The download path, end to end.
 *
 * This is the delivered behaviour: a download command that overruns its budget is killed
 * and the *agent* receives a result telling it to switch source. The assertions are on the
 * result the model would read, because that text is the feature.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installGuard } from '../lib/guard.js';
import { StallMonitor, LEVEL_FAILED } from '../lib/state.js';
import { createFakeContext, dispatch, makeExec, sleep } from './helpers.mjs';

/** Config store double with the download settings in place. */
function store(overrides = {}) {
  const config = {
    enabled: true,
    autoSwitch: true,
    watchDownloads: true,
    downloadSeconds: 1,
    timers: { fetch: 1, search: 1, read: 1, write: 1, exec: 30, long: 1, other: 1 },
    overrides: {},
    supervisor: { display: 'avatar', show: true },
    ...overrides,
  };
  return { get: () => config };
}

/** A body that rejects when its signal aborts, like a killed subprocess. */
function killableBody(exec, { ms }) {
  return () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ isError: false, content: [], value: { finished: true } }), ms);
    exec.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('process killed by abort'));
    }, { once: true });
  });
}

function setup(overrides = {}) {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store(overrides), monitor, locale: () => 'zh' });
  return { ctx, monitor, dispose };
}

test('a stalled git clone is killed and answered with switch-source advice', async () => {
  const { ctx, monitor, dispose } = setup();
  const exec = makeExec('ops_bash', { command: 'git clone https://github.com/user/repo.git' });

  const result = await dispatch(ctx, exec, killableBody(exec, { ms: 5000 }));

  assert.equal(result.isError, true, 'the agent must see an error so it stops waiting');
  assert.equal(result.value.stalled, 'download');
  assert.equal(result.value.channel, 'git');
  assert.equal(result.value.advice, 'switch-source');

  const text = result.content[0].text;
  assert.match(text, /下载卡住/, 'must say the download stalled');
  assert.match(text, /换一个源/, 'must tell the agent to switch source');
  assert.match(text, /github\.com/, 'must name the failing source');
  assert.match(text, /半成品目录/, 'must warn about the partial clone directory');

  // The supervisor sees it too, so the human side is not blind.
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.stats.stalls, 1);
  assert.equal(snapshot.supervisor.download, true);
  assert.equal(snapshot.supervisor.level, LEVEL_FAILED);
  assert.match(snapshot.supervisor.fallback, /switch-git-source/);
  dispose();
});

test('a stalled pnpm install gets npm-registry advice', async () => {
  const { ctx, dispose } = setup();
  const exec = makeExec('ops_bash', { command: 'pnpm install' });
  const result = await dispatch(ctx, exec, killableBody(exec, { ms: 5000 }));

  assert.equal(result.isError, true);
  assert.equal(result.value.channel, 'npm');
  assert.match(result.content[0].text, /--registry/);
  assert.match(result.content[0].text, /npmmirror/);
  assert.match(result.content[0].text, /node_modules/);
  dispose();
});

test('a stalled curl gets direct-download advice', async () => {
  const { ctx, dispose } = setup();
  const exec = makeExec('ops_bash', { command: 'curl -L https://example.com/big.zip -o big.zip' });
  const result = await dispatch(ctx, exec, killableBody(exec, { ms: 5000 }));

  assert.equal(result.isError, true);
  assert.equal(result.value.channel, 'http');
  assert.equal(result.value.host, 'example.com');
  assert.match(result.content[0].text, /断点续传|不完整的文件/);
  dispose();
});

test('a finished download is passed through untouched', async () => {
  const { ctx, monitor, dispose } = setup({ downloadSeconds: 30 });
  const exec = makeExec('ops_bash', { command: 'git clone https://github.com/user/repo.git' });
  const result = await dispatch(ctx, exec, killableBody(exec, { ms: 30 }));

  assert.equal(result.isError, false);
  assert.deepEqual(result.value, { finished: true });
  assert.equal(monitor.snapshot().stats.stalls, 0);
  dispose();
});

test('a non-download exec command is still only notified, not killed', async () => {
  const { ctx, monitor, dispose } = setup({ timers: { fetch: 1, search: 1, read: 1, write: 1, exec: 1, long: 1, other: 1 } });
  const exec = makeExec('ops_bash', { command: 'node build.js' });
  let wasKilled = false;
  exec.signal.addEventListener('abort', () => { wasKilled = true; });

  const result = await dispatch(ctx, exec, async () => {
    await sleep(1300);
    return { isError: false, content: [], value: { built: true } };
  });

  assert.deepEqual(result.value, { built: true }, 'a plain command must finish normally');
  assert.equal(wasKilled, false, 'a non-download command must not be aborted');
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.stats.stalls, 1);
  assert.equal(snapshot.stats.notices, 1);
  assert.equal(snapshot.supervisor.download, false);
  dispose();
});

test('the download scene being off restores the plain exec behaviour', async () => {
  // `scenes.download.enabled` is the single switch for the download guard; the legacy
  // global `watchDownloads` flag is migrated into it, not consulted separately.
  const { ctx, monitor, dispose } = setup({
    scenes: {
      download: { enabled: false, seconds: 30 },
      fetch: { enabled: true, seconds: 15 },
      search: { enabled: true, seconds: 15 },
    },
    timers: { fetch: 1, search: 1, read: 1, write: 1, exec: 1, long: 1, other: 1 },
  });
  const exec = makeExec('ops_bash', { command: 'git clone https://github.com/user/repo.git' });
  const result = await dispatch(ctx, exec, async () => {
    await sleep(1300);
    return { isError: false, content: [], value: { cloned: true } };
  });

  assert.deepEqual(result.value, { cloned: true }, 'with detection off the command is not killed');
  assert.equal(monitor.snapshot().supervisor.download, false);
  dispose();
});

test('the download budget is capped by the configured downloadSeconds', async () => {
  // The exec class budget is generous (30s) but the download budget is 1s, and the
  // download budget must win: waiting 30s on a dead mirror is the bug being fixed.
  const { ctx, dispose } = setup({ downloadSeconds: 1, timers: { fetch: 15, search: 15, read: 20, write: 30, exec: 30, long: 120, other: 30 } });
  const exec = makeExec('ops_bash', { command: 'git clone https://github.com/user/repo.git' });
  const started = Date.now();
  const result = await dispatch(ctx, exec, killableBody(exec, { ms: 20000 }));
  const elapsed = Date.now() - started;

  assert.equal(result.isError, true);
  assert.ok(elapsed < 5000, `the download budget must fire early, waited ${elapsed}ms`);
  assert.equal(result.value.timeoutMs, 1000);
  dispose();
});

test('the advisory appears in an English locale too', async () => {
  const ctx = createFakeContext({});
  const monitor = new StallMonitor();
  const dispose = installGuard(ctx, { config: store({}), monitor, locale: () => 'en-US' });
  const exec = makeExec('ops_bash', { command: 'git clone https://github.com/user/repo.git' });
  const result = await dispatch(ctx, exec, killableBody(exec, { ms: 5000 }));

  assert.match(result.content[0].text, /Download stalled/);
  assert.match(result.content[0].text, /different source/);
  dispose();
});

test('a download that errors for another reason still reaches the caller when not timed out', async () => {
  const { ctx, dispose } = setup({ downloadSeconds: 30 });
  const exec = makeExec('ops_bash', { command: 'git clone https://github.com/user/repo.git' });
  await assert.rejects(
    () => dispatch(ctx, exec, async () => { throw new Error('fatal: repository not found'); }),
    /repository not found/,
  );
  dispose();
});
