/**
 * The HTTP routes the Client half polls.
 *
 * These run against a real `node:http` server with the real handlers, because the
 * contract the browser depends on is transport-level: status codes, `Content-Type`, and
 * the exact JSON shape on both the success and failure paths.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { registerRoutes, PREFIX } from '../lib/routes.js';
import { ConfigStore, defaults } from '../lib/config.js';
import { StallMonitor, LEVEL_NOTICE } from '../lib/state.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Start a throwaway server with the plugin's routes mounted on a fake ctx. */
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-guard-routes-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  store.load();
  const monitor = new StallMonitor();

  const routes = new Map();
  const fakeCtx = {
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };

  const dispose = registerRoutes(fakeCtx, { config: store, monitor, locale: () => 'zh' });

  const server = http.createServer((req, res) => {
    const route = routes.get((req.url ?? '').split('?')[0]);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    void route.handler(req, res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    store,
    monitor,
    base: `http://127.0.0.1:${port}${PREFIX}`,
    routes,
    async close() {
      dispose();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** One request, returning status, headers, and parsed JSON (or raw text). */
async function call(base, path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

test('the route prefix is plugin-owned', () => {
  assert.equal(PREFIX, '/dsh-stall-guard');
});

test('GET config.json returns the full validated document', async () => {
  const server = await startServer();
  try {
    const { status, headers, json } = await call(server.base, '/config.json');
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /application\/json/);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.equal(json.ok, true);
    assert.deepEqual(json.config, defaults());
    assert.equal(json.config.timers.fetch, 15);
    assert.equal(json.config.supervisor.display, 'avatar');
  } finally {
    await server.close();
  }
});

test('POST config.json persists and returns the stored document', async () => {
  const server = await startServer();
  try {
    const { status, json } = await call(server.base, '/config.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timers: { fetch: 3, search: 4 }, supervisor: { display: 'dot' } }),
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.config.timers.fetch, 3);
    assert.equal(json.config.timers.search, 4);
    assert.equal(json.config.supervisor.display, 'dot');
    assert.deepEqual(json.warnings, []);

    // The read path must agree with the write path.
    const reread = await call(server.base, '/config.json');
    assert.deepEqual(reread.json.config, json.config);
    assert.equal(server.store.get().timers.fetch, 3);
  } finally {
    await server.close();
  }
});

test('POST config.json reports clamped and rejected values as warnings', async () => {
  const server = await startServer();
  try {
    const { json } = await call(server.base, '/config.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timers: { fetch: 0, search: 'abc' }, supervisor: { display: 'huge' }, scenes: { download: { seconds: 99999 } } }),
    });
    assert.equal(json.ok, true, 'a partially bad document still saves its valid parts');
    assert.ok(json.warnings.length >= 3, `expected warnings, got ${JSON.stringify(json.warnings)}`);
    assert.equal(json.config.timers.fetch, 15, 'a rejected value falls back to the default');
    assert.equal(json.config.supervisor.display, 'avatar');
    assert.equal(json.config.scenes.download.seconds, 3600, 'a scene budget is clamped too');
  } finally {
    await server.close();
  }
});

test('a malformed JSON body is a 400, never a crash', async () => {
  const server = await startServer();
  try {
    const { status, json } = await call(server.base, '/config.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.match(json.error, /not valid JSON/);
    // The server must still answer afterwards.
    const after = await call(server.base, '/config.json');
    assert.equal(after.status, 200);
  } finally {
    await server.close();
  }
});

test('an oversized body is rejected rather than buffered', async () => {
  const server = await startServer();
  try {
    const huge = JSON.stringify({ padding: 'x'.repeat(70 * 1024) });
    const response = await fetch(`${server.base}/config.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge,
    }).catch(() => undefined);
    // The handler destroys the socket, so either a 400 or a closed connection is correct;
    // what must not happen is the server accepting 70KB of settings.
    if (response) {
      assert.ok(response.status === 400 || response.status === 200, `unexpected status ${response.status}`);
      if (response.status === 200) {
        const json = await response.json();
        assert.deepEqual(json.config, defaults(), 'an oversized body must not have been applied');
      }
    }
    assert.equal(server.store.get().timers.fetch, 15);
  } finally {
    await server.close();
  }
});

test('an unsupported method on config.json is a 405', async () => {
  const server = await startServer();
  try {
    const { status, json } = await call(server.base, '/config.json', { method: 'DELETE' });
    assert.equal(status, 405);
    assert.equal(json.ok, false);
    assert.match(json.error, /not allowed/);
  } finally {
    await server.close();
  }
});

test('GET state.json returns an idle snapshot by default', async () => {
  const server = await startServer();
  try {
    const { status, json } = await call(server.base, '/state.json');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.supervisor.mode, 'idle');
    assert.equal(json.supervisor.level, 0);
    assert.deepEqual(json.recent, []);
    assert.equal(typeof json.revision, 'number');
    assert.equal(typeof json.now, 'number');
  } finally {
    await server.close();
  }
});

test('state.json reflects a published stall', async () => {
  const server = await startServer();
  try {
    server.monitor.begin({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', timeoutMs: 15000 });
    server.monitor.stall({
      callId: 'c1',
      tool: 'web_fetch',
      kind: 'fetch',
      elapsedMs: 15000,
      timeoutMs: 15000,
      action: 'switch',
      level: 2,
      fallback: 'web_search',
      fallbackOk: true,
      message: 'switched to search',
    });

    const { json } = await call(server.base, '/state.json');
    assert.equal(json.supervisor.mode, 'alert');
    assert.equal(json.supervisor.level, 2);
    assert.equal(json.supervisor.tool, 'web_fetch');
    assert.equal(json.supervisor.fallback, 'web_search');
    assert.equal(json.supervisor.message, 'switched to search');
    assert.equal(json.stats.stalls, 1);
    assert.equal(json.stats.switches, 1);
    assert.equal(json.recent.length, 1);
    assert.equal(json.recent[0].tool, 'web_fetch');
  } finally {
    await server.close();
  }
});

test('POST ack silences the alert and keeps the history', async () => {
  const server = await startServer();
  try {
    server.monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 30000 });
    server.monitor.stall({ callId: 'c1', tool: 'bash', kind: 'exec', elapsedMs: 30000, timeoutMs: 30000, action: 'notify', level: LEVEL_NOTICE });
    server.monitor.end('c1');

    const { status, json } = await call(server.base, '/ack', { method: 'POST', body: '{}' });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.notEqual(json.state.supervisor.mode, 'alert');
    assert.equal(json.state.recent.length, 1, 'acknowledging must not erase the history');
    assert.equal(json.state.stats.stalls, 1);
  } finally {
    await server.close();
  }
});

test('ack requires POST', async () => {
  const server = await startServer();
  try {
    const { status } = await call(server.base, '/ack');
    assert.equal(status, 405);
  } finally {
    await server.close();
  }
});

test('ack tolerates an empty body', async () => {
  const server = await startServer();
  try {
    const { status, json } = await call(server.base, '/ack', { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  } finally {
    await server.close();
  }
});

test('an unknown path under the prefix is not claimed', async () => {
  const server = await startServer();
  try {
    // Only the three declared paths register, so the route table must have exactly them.
    const paths = [...server.routes.keys()].sort();
    assert.deepEqual(paths, [
      '/dsh-stall-guard/ack',
      '/dsh-stall-guard/config.json',
      '/dsh-stall-guard/state.json',
    ]);
  } finally {
    await server.close();
  }
});

test('disposing removes every route', async () => {
  const server = await startServer();
  assert.equal(server.routes.size, 3);
  await server.close();
  assert.equal(server.routes.size, 0);
});
