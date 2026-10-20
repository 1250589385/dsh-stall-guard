/**
 * Classification and timeout resolution.
 *
 * These assertions pin the table the user actually configures: seven classes, honest
 * switch capability, and the decode from seconds to milliseconds with clamping.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KINDS,
  DEFAULT_TIMERS,
  MIN_SECONDS,
  MAX_SECONDS,
  classify,
  isSwitchable,
  clampSeconds,
  normalizeTimers,
  normalizeOverrides,
  resolveSpec,
  detectDownload,
} from '../lib/classify.js';

test('every tool name maps to exactly one of the seven classes', () => {
  const samples = ['web_fetch', 'web_search', 'read', 'write', 'bash', 'subagent', 'totally-unknown-tool'];
  for (const name of samples) {
    const kind = classify(name);
    assert.ok(KINDS.includes(kind), `${name} classified as ${kind}, which is not a class`);
  }
});

test('unknown and third-party tools fall into the conservative class', () => {
  assert.equal(classify('mcp__some_server__do_thing'), 'other');
  assert.equal(classify(''), 'other');
  assert.equal(classify(undefined), 'other');
  assert.equal(classify(null), 'other');
});

test('the two switchable classes are exactly the web read-only pair', () => {
  assert.equal(isSwitchable('web_fetch'), true);
  assert.equal(isSwitchable('web_search'), true);
  // A local read has no second implementation, so it must not claim to switch.
  assert.equal(isSwitchable('read'), false);
  assert.equal(isSwitchable('bash'), false);
  assert.equal(isSwitchable('write'), false);
});

test('a read-only class without a fallback resolves to notify, not a fake switch', () => {
  const spec = resolveSpec('read', { timers: DEFAULT_TIMERS, autoSwitch: true, enabled: true });
  assert.equal(spec.kind, 'read');
  assert.equal(spec.switchable, false);
  assert.equal(spec.autoSwitch, false, 'claiming a switch without a fallback would be fiction');
});

test('autoSwitch follows both the class capability and the user setting', () => {
  const base = { timers: DEFAULT_TIMERS, enabled: true };
  assert.equal(resolveSpec('web_fetch', { ...base, autoSwitch: true }).autoSwitch, true);
  assert.equal(resolveSpec('web_fetch', { ...base, autoSwitch: false }).autoSwitch, false);
  assert.equal(resolveSpec('web_fetch', { ...base, autoSwitch: true, enabled: false }).autoSwitch, false);
});

test('seconds become milliseconds with per-class defaults', () => {
  const spec = resolveSpec('web_fetch', { timers: { ...DEFAULT_TIMERS, fetch: 7 } });
  assert.equal(spec.seconds, 7);
  assert.equal(spec.ms, 7000);
});

test('a per-tool override beats its class default', () => {
  const config = { timers: { ...DEFAULT_TIMERS, fetch: 15 }, overrides: { web_fetch: 45 } };
  const spec = resolveSpec('web_fetch', config);
  assert.equal(spec.seconds, 45);
  assert.equal(spec.ms, 45000);
  // A sibling in the same class is untouched.
  assert.equal(resolveSpec('web_fetch', config).kind, 'fetch');
});

test('clamping rejects zero, negatives, and non-numbers', () => {
  assert.equal(clampSeconds(0), undefined);
  assert.equal(clampSeconds(-5), undefined);
  assert.equal(clampSeconds('abc'), undefined);
  assert.equal(clampSeconds(NaN), undefined);
  assert.equal(clampSeconds(Infinity), undefined);
  assert.equal(clampSeconds(MIN_SECONDS), MIN_SECONDS);
});

test('clamping caps at one hour', () => {
  assert.equal(clampSeconds(MAX_SECONDS + 500), MAX_SECONDS);
  assert.equal(clampSeconds(99999), MAX_SECONDS);
});

test('clamping rounds fractional seconds rather than truncating', () => {
  assert.equal(clampSeconds(15.4), 15);
  assert.equal(clampSeconds(15.6), 16);
  assert.equal(clampSeconds('20'), 20);
});

test('normalizeTimers fills every class and reports bad input', () => {
  const { timers, warnings } = normalizeTimers({ fetch: 5, search: 'nope', bogus: 9 });
  assert.equal(timers.fetch, 5);
  assert.equal(timers.search, DEFAULT_TIMERS.search, 'an unusable value must fall back to the default');
  assert.equal(timers.write, DEFAULT_TIMERS.write, 'a missing class must be filled');
  assert.equal(timers.bogus, undefined, 'an unknown class must not be stored');
  assert.equal(Object.keys(timers).length, KINDS.length);
  assert.ok(warnings.some((line) => line.includes('search')), 'the bad search value must be reported');
  assert.ok(warnings.some((line) => line.includes('bogus')), 'the unknown class must be reported');
});

test('normalizeTimers accepts a completely absent map', () => {
  const { timers, warnings } = normalizeTimers(undefined);
  assert.deepEqual(timers, { ...DEFAULT_TIMERS });
  assert.deepEqual(warnings, []);
});

test('normalizeOverrides keeps valid tool names and drops the rest', () => {
  const { overrides, warnings } = normalizeOverrides({ web_fetch: 60, '  ': 10, bad: -1 });
  assert.deepEqual(overrides, { web_fetch: 60 });
  assert.ok(warnings.length >= 2);
});

test('download detection is re-exported from the classification entry point', () => {
  // The detailed behaviour lives in download.test.mjs; this pins the re-export so a
  // caller importing classification alone keeps working.
  const detect = (command) => detectDownload({ name: 'ops_bash', arguments: { command } }, classify);
  assert.equal(detect('curl -L https://example.com/file.zip -o file.zip').channel, 'http');
  assert.equal(detect('pnpm install').channel, 'npm');
  assert.equal(detect('git clone https://github.com/a/b').channel, 'git');
  assert.equal(detect('echo hello'), undefined);
});

