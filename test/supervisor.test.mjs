/**
 * The supervisor's voice.
 *
 * Two guarantees matter and both are testable without a network: a canned sentence is
 * always available for any situation, and a model that fails, hangs, or returns junk
 * never reaches the UI verbatim and never blocks the alert.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canned, cannedLocale, sanitizeMessage } from '../lib/supervisor.js';
import { LEVEL_FAILED, LEVEL_NOTICE, LEVEL_SWITCHED } from '../lib/state.js';

/** An async iterable that yields the given chunks. */
/** An `llm` double that records the options it was called with. */
test('a canned line exists for every class, action, and level combination used', () => {
  const cases = [
    ['fetch', 'switch', LEVEL_SWITCHED],
    ['fetch', 'switch', LEVEL_FAILED],
    ['search', 'switch', LEVEL_SWITCHED],
    ['search', 'switch', LEVEL_FAILED],
    ['exec', 'notify', LEVEL_NOTICE],
    ['read', 'notify', LEVEL_NOTICE],
    ['write', 'notify', LEVEL_NOTICE],
    ['long', 'notify', LEVEL_NOTICE],
    ['other', 'notify', LEVEL_NOTICE],
    ['other', 'notify', LEVEL_FAILED],
  ];
  for (const [kind, action, level] of cases) {
    const message = canned({ locale: 'zh', kind, action, level, tool: 'some_tool', elapsedMs: 15000, seconds: 15 });
    assert.ok(typeof message === 'string' && message.length > 0, `no canned line for ${kind}/${action}/${level}`);
    assert.ok(!message.includes('undefined'), `canned line for ${kind}/${action}/${level} leaked undefined: ${message}`);
  }
});

test('an unknown situation still yields usable text', () => {
  const message = canned({ locale: 'zh', kind: 'brand-new', action: 'notify', level: LEVEL_NOTICE, tool: 'x', elapsedMs: 1000, seconds: 1 });
  assert.ok(message.includes('x'));
});

test('the Chinese and English tables both cover the fallback cases', () => {
  for (const locale of ['zh', 'en']) {
    const message = canned({ locale, kind: 'fetch', action: 'switch', level: LEVEL_SWITCHED, tool: 'web_fetch', elapsedMs: 15000, seconds: 15, detail: 'example.com' });
    assert.ok(message.includes('web_fetch'), `${locale} line must name the tool`);
  }
});

test('a download notice says slow is expected rather than implying a hang', () => {
  const message = canned({ locale: 'en', kind: 'exec', action: 'notify', level: LEVEL_NOTICE, tool: 'bash', elapsedMs: 45000, seconds: 30, download: true });
  assert.match(message, /download/i);
  assert.match(message, /slow is expected/i);

  const plain = canned({ locale: 'en', kind: 'exec', action: 'notify', level: LEVEL_NOTICE, tool: 'bash', elapsedMs: 45000, seconds: 30, download: false });
  assert.doesNotMatch(plain, /download/i);
});

test('the fetch switch line names the search subject', () => {
  const message = canned({ locale: 'zh', kind: 'fetch', action: 'switch', level: LEVEL_SWITCHED, tool: 'web_fetch', elapsedMs: 15000, seconds: 15, detail: 'Event loop' });
  assert.ok(message.includes('Event loop'));
});

test('cannedLocale treats anything non-English as Chinese', () => {
  assert.equal(cannedLocale('en'), 'en');
  assert.equal(cannedLocale('en-US'), 'en');
  assert.equal(cannedLocale('zh-CN'), 'zh');
  assert.equal(cannedLocale('ja'), 'zh');
  assert.equal(cannedLocale(undefined), 'zh');
});

test('sanitizeMessage flattens to one line and drops markdown', () => {
  assert.equal(sanitizeMessage('  hello\n world  '), 'hello world');
  assert.equal(sanitizeMessage('**bold** and `code`'), 'bold and code');
  assert.equal(sanitizeMessage('```js\nconst x = 1\n```'), '');
  assert.equal(sanitizeMessage('好的，这是建议。'), '这是建议。');
});

test('sanitizeMessage truncates a runaway reply', () => {
  const long = 'x'.repeat(500);
  const result = sanitizeMessage(long);
  assert.ok(result.length <= 120, `expected <=120 chars, got ${result.length}`);
});

test('sanitizeMessage handles non-strings', () => {
  assert.equal(sanitizeMessage(undefined), '');
  assert.equal(sanitizeMessage(null), '');
  assert.equal(sanitizeMessage(42), '');
});

test('a download stall never claims a fallback was attempted', () => {
  // The plugin does not try a mirror itself; it kills the command and tells the agent.
  // Copy that says "the fallback also failed" would describe an attempt that never happened.
  for (const locale of ['zh', 'en']) {
    for (const level of [LEVEL_NOTICE, LEVEL_SWITCHED, LEVEL_FAILED]) {
      const message = canned({
        locale,
        kind: 'exec',
        action: 'switch',
        level,
        tool: 'ops_bash',
        elapsedMs: 30000,
        seconds: 30,
        download: true,
      });
      assert.doesNotMatch(message, /备选.*失败|retry failed|also failed/i, `level ${level} claimed a failed fallback: ${message}`);
      assert.match(message, /中止|停止|stopped/i, `level ${level} must say the command was stopped: ${message}`);
    }
  }
});

test('a download notice differs from a plain exec notice', () => {
  const download = canned({ locale: 'zh', kind: 'exec', action: 'switch', level: LEVEL_SWITCHED, tool: 'ops_bash', elapsedMs: 30000, seconds: 30, download: true });
  const plain = canned({ locale: 'zh', kind: 'exec', action: 'switch', level: LEVEL_SWITCHED, tool: 'ops_bash', elapsedMs: 30000, seconds: 30, download: false });
  assert.notEqual(download, plain);
  assert.match(download, /下载/);
  assert.doesNotMatch(plain, /下载/);
});

