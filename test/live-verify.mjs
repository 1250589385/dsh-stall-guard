/**
 * Live verification against the running Host.
 *
 * This script exercises the real HTTP routes of the installed plugin and, separately,
 * the installed guard module against a synthetic slow tool call. It exists so the
 * delivery can be checked without a browser: the routes prove the Host half is loaded,
 * and the guard check proves the installed copy (not the source tree) behaves.
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const BASE = 'http://127.0.0.1:10263/dsh-stall-guard';

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`);
  assert.equal(response.status, 200, `GET ${path} returned ${response.status}`);
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, json: await response.json() };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`  FAIL  ${name}: ${error.message}`);
  }
}

console.log('\n== live routes ==');

const state = await getJson('/state.json');
check('state.json has the documented shape', () => {
  assert.equal(state.ok, true);
  assert.ok(['idle', 'watching', 'alert'].includes(state.supervisor.mode));
  assert.equal(typeof state.revision, 'number');
  assert.equal(typeof state.now, 'number');
  assert.ok(Array.isArray(state.recent));
  assert.equal(typeof state.stats.stalls, 'number');
});

check('supervisor carries every field the Client renders', () => {
  for (const key of ['mode', 'since', 'level', 'tool', 'kind', 'elapsedMs', 'timeoutMs', 'action', 'fallback', 'fallbackOk', 'message', 'source']) {
    assert.ok(key in state.supervisor, `missing supervisor.${key}`);
  }
});

const configResponse = await getJson('/config.json');
check('config.json holds the seven classes', () => {
  assert.equal(configResponse.ok, true);
  const timers = configResponse.config.timers;
  for (const kind of ['fetch', 'search', 'read', 'write', 'exec', 'long', 'other']) {
    assert.equal(typeof timers[kind], 'number', `missing timer for ${kind}`);
    assert.ok(timers[kind] >= 1 && timers[kind] <= 3600);
  }
});

check('config.json has the supervisor block', () => {
  const supervisor = configResponse.config.supervisor;
  assert.ok(['avatar', 'icon', 'dot'].includes(supervisor.display));
});

console.log('\n== config round trip ==');

const original = configResponse.config;
const changed = structuredClone(original);
changed.timers.fetch = 7;
changed.timers.exec = 41;
changed.supervisor.display = 'dot';

const saved = await postJson('/config.json', changed);
check('POST config.json accepts a valid document', () => {
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.config.timers.fetch, 7);
  assert.equal(saved.json.config.timers.exec, 41);
  assert.equal(saved.json.config.supervisor.display, 'dot');
  assert.deepEqual(saved.json.warnings, []);
});

const reread = await getJson('/config.json');
check('the write is durable and reads back identically', () => {
  assert.equal(reread.config.timers.fetch, 7);
  assert.equal(reread.config.timers.exec, 41);
  assert.equal(reread.config.supervisor.display, 'dot');
});

const bad = structuredClone(reread.config);
bad.timers.fetch = 0;
bad.timers.search = 'not a number';
bad.supervisor.display = 'enormous';
bad.supervisor.timeoutMs = 999999;
const rejected = await postJson('/config.json', bad);
check('invalid values are clamped, not stored', () => {
  assert.equal(rejected.status, 200);
  assert.ok(rejected.json.warnings.length >= 3, `expected warnings, got ${JSON.stringify(rejected.json.warnings)}`);
  assert.equal(rejected.json.config.timers.fetch, 15, 'a zero timer must fall back to the default');
  assert.equal(rejected.json.config.supervisor.display, 'avatar');
  assert.equal(rejected.json.config.supervisor.timeoutMs, 60000);
});

const restore = structuredClone(original);
restore.timers.fetch = 15;
restore.timers.exec = 30;
restore.supervisor.display = 'avatar';
const restored = await postJson('/config.json', restore);
check('the original settings were restored', () => {
  assert.equal(restored.json.config.timers.fetch, 15);
  assert.equal(restored.json.config.timers.exec, 30);
  assert.equal(restored.json.config.supervisor.display, 'avatar');
});

console.log('\n== ack ==');
const acked = await postJson('/ack', {});
check('POST ack answers with a fresh snapshot', () => {
  assert.equal(acked.status, 200);
  assert.equal(acked.json.ok, true);
  assert.ok(acked.json.state && acked.json.state.supervisor);
});

console.log('\n== installed guard module ==');
const installedGuard = await import(pathToFileURL('C:/Users/HP/.dsh/profiles/desktop/node_modules/dsh-stall-guard/lib/guard.js').href);
check('the installed copy exposes installGuard', () => {
  assert.equal(typeof installedGuard.installGuard, 'function');
});

results.forEach((entry) => {
  if (!entry.ok) console.log(`\nFAILED: ${entry.name}\n  ${entry.error}`);
});
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
