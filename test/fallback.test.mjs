/**
 * The alternative routes.
 *
 * These tests use a fake `web` service so they can assert on the exact query derived
 * from a URL and on the synthesized tool result, without any network. The important
 * property is that a fallback never re-enters the tool layer — it calls the service.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { queryFromUrl, switchFromFetch, retrySearch, runFallback, FALLBACK_TIMEOUT_MS } from '../lib/fallback.js';
import { LEVEL_FAILED, LEVEL_SWITCHED } from '../lib/state.js';

/** A web service double: records calls, returns whatever the test queued. */
function fakeWeb(responses = []) {
  const calls = [];
  return {
    calls,
    available: true,
    async search(request, signal) {
      calls.push({ request, aborted: () => signal?.aborted === true });
      const next = responses.shift();
      if (typeof next === 'function') return next(request, signal);
      if (next instanceof Error) throw next;
      return next ?? { sources: [] };
    },
  };
}

const SAMPLE = {
  sources: [
    { url: 'https://example.com/a', title: 'Example A', snippet: 'first hit' },
    { url: 'https://example.com/b', title: 'Example B', snippet: 'second hit' },
  ],
  truncated: false,
};

test('a query is derived from the last meaningful path segment', () => {
  assert.equal(queryFromUrl('https://en.wikipedia.org/wiki/Event_loop'), 'Event loop');
  assert.equal(queryFromUrl('https://example.com/blog/how-to-test'), 'how to test');
  assert.equal(queryFromUrl('https://example.com/docs/api.html'), 'api');
  assert.equal(queryFromUrl('https://example.com/2024/10/'), 'example.com', 'a numeric path carries no subject');
});

test('a URL with no usable path falls back to its hostname', () => {
  assert.equal(queryFromUrl('https://www.example.com/'), 'example.com');
  assert.equal(queryFromUrl('https://example.com'), 'example.com');
});

test('percent-encoded and CJK paths survive decoding', () => {
  assert.equal(queryFromUrl('https://example.com/%E5%8D%A1%E9%A1%BF'), '卡顿');
  assert.equal(queryFromUrl('https://example.com/a%20b'), 'a b');
});

test('an unparseable URL yields no query rather than throwing', () => {
  assert.equal(queryFromUrl('not a url'), '');
  assert.equal(queryFromUrl(''), '');
  assert.equal(queryFromUrl(undefined), '');
});

test('a stalled fetch becomes a successful search result', async () => {
  const web = fakeWeb([SAMPLE]);
  const outcome = await switchFromFetch({ url: 'https://en.wikipedia.org/wiki/Event_loop', timeoutMs: 15000, web });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.level, LEVEL_SWITCHED);
  assert.equal(outcome.fallback, 'web_search');
  assert.equal(web.calls.length, 1);
  assert.equal(web.calls[0].request.query, 'Event loop');
  assert.equal(web.calls[0].request.maxResults, 8);

  const result = outcome.result;
  assert.equal(result.isError, false);
  assert.equal(result.value.switchedFrom, 'web_fetch');
  assert.equal(result.value.query, 'Event loop');
  assert.equal(result.value.timeoutMs, 15000);
  assert.equal(result.value.sources.length, 2);
  assert.equal(result.content.length, 1);
  assert.match(result.content[0].text, /did not respond within 15s/);
  assert.match(result.content[0].text, /Example A/);
  assert.match(result.content[0].text, /https:\/\/example\.com\/b/);
});

test('an empty search result is a failure, not an empty success', async () => {
  const web = fakeWeb([{ sources: [] }]);
  const outcome = await switchFromFetch({ url: 'https://example.com/private-page', timeoutMs: 15000, web });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.level, LEVEL_FAILED);
  assert.equal(outcome.result.isError, true);
  assert.match(outcome.result.content[0].text, /found nothing/);
});

test('a search that throws is reported with the reason', async () => {
  const web = fakeWeb([new Error('provider exploded')]);
  const outcome = await switchFromFetch({ url: 'https://example.com/topic', timeoutMs: 15000, web });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result.isError, true);
  assert.match(outcome.result.content[0].text, /provider exploded/);
});

test('a search that hangs is bounded by the fallback deadline', async () => {
  // The fake provider ignores the abort signal entirely, which is exactly the case the
  // deadline has to survive: an abort alone would hang here forever.
  const web = fakeWeb([() => new Promise(() => {})]);
  const started = Date.now();
  const outcome = await switchFromFetch({ url: 'https://example.com/topic', timeoutMs: 15000, web, deadlineMs: 250 });
  const elapsed = Date.now() - started;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.level, LEVEL_FAILED);
  assert.ok(elapsed < 2000, `the deadline must fire promptly, waited ${elapsed}ms`);
  assert.match(outcome.result.content[0].text, /also failed/);
  assert.match(outcome.result.content[0].text, /did not answer within/);
});

test('the default deadline is a sane bound', () => {
  assert.equal(FALLBACK_TIMEOUT_MS, 15000);
});

test('a fetch fallback without the web service degrades honestly', async () => {
  const outcome = await switchFromFetch({ url: 'https://example.com/x', timeoutMs: 15000, web: undefined });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.fallback, null);
  assert.match(outcome.result.content[0].text, /no web service mounted/);
});

test('a fetch fallback with no derivable query degrades honestly', async () => {
  const outcome = await switchFromFetch({ url: 'https://example.com/2024/10/', timeoutMs: 15000, web: fakeWeb([]) });
  // `/2024/10/` has no usable segment, so the hostname is used — that is a valid query.
  assert.equal(outcome.ok, false, 'the fake service returns no sources, so this still fails');
  assert.equal(outcome.fallback, 'web_search');
});

test('a retried search reuses the query and the requested limit', async () => {
  const web = fakeWeb([SAMPLE]);
  const outcome = await retrySearch({ query: 'cordis plugins', maxResults: 3, timeoutMs: 15000, web });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.fallback, 'retry');
  assert.equal(web.calls[0].request.query, 'cordis plugins');
  assert.equal(web.calls[0].request.maxResults, 3);
  assert.equal(outcome.result.value.switchedFrom, 'web_search');
});

test('a retried search preserves the provider content when it has some', async () => {
  const web = fakeWeb([{ content: 'a written answer', sources: SAMPLE.sources }]);
  const outcome = await retrySearch({ query: 'x', timeoutMs: 15000, web });
  assert.equal(outcome.result.content[0].text, 'a written answer');
});

test('a retried search with no content synthesizes an explanation', async () => {
  const web = fakeWeb([{ sources: SAMPLE.sources }]);
  const outcome = await retrySearch({ query: 'x', timeoutMs: 15000, web });
  assert.match(outcome.result.content[0].text, /one retry returned 2 results/);
});

test('a failed retry reports the reason', async () => {
  const web = fakeWeb([new Error('rate limited')]);
  const outcome = await retrySearch({ query: 'x', timeoutMs: 15000, web });
  assert.equal(outcome.ok, false);
  assert.match(outcome.result.content[0].text, /rate limited/);
});

test('runFallback routes a fetch call to the search alternative', async () => {
  const web = fakeWeb([SAMPLE]);
  const outcome = await runFallback({ tool: 'web_fetch', args: { url: 'https://example.com/topic' }, timeoutMs: 15000, web });
  assert.equal(outcome.fallback, 'web_search');
});

test('runFallback routes a search call to one retry', async () => {
  const web = fakeWeb([SAMPLE]);
  const outcome = await runFallback({ tool: 'web_search', args: { query: 'topic' }, timeoutMs: 15000, web });
  assert.equal(outcome.fallback, 'retry');
});

test('runFallback refuses a tool with no alternative route', async () => {
  const outcome = await runFallback({ tool: 'read', args: {}, timeoutMs: 15000, web: fakeWeb([]) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.fallback, null);
  assert.match(outcome.reason, /no alternative route/);
});

test('runFallback handles a fetch call carrying no URL', async () => {
  const outcome = await runFallback({ tool: 'web_fetch', args: {}, timeoutMs: 15000, web: fakeWeb([]) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.fallback, null);
  assert.match(outcome.result.content[0].text, /carried no URL/);
});

test('runFallback handles a search call carrying no query', async () => {
  const outcome = await runFallback({ tool: 'web_search', args: {}, timeoutMs: 15000, web: fakeWeb([]) });
  assert.equal(outcome.ok, false);
  assert.match(outcome.result.content[0].text, /carried no query/);
});
