/**
 * Alternative routes taken after a stall.
 *
 * Scope is deliberately tiny: this module knows how to answer "the fetch stalled,
 * what else can we try?" for exactly two tools, and it says so honestly when it
 * cannot. It never re-enters the tool layer (`ctx.tools.execute`), because that would
 * dispatch through this same guard and recurse; it calls the `web` service directly.
 */

import { LEVEL_FAILED, LEVEL_SWITCHED } from './state.js';
import { pickPreset, renderPreset } from './presets.js';

/** Cap on the alternative route, so a stalled fetch cannot turn into a stalled search. */
export const FALLBACK_TIMEOUT_MS = 15000;

/** How many search hits to surface when a fetch is replaced. */
const MAX_SOURCES = 8;

const FILE_EXTENSIONS = /\.(?:html?|php|aspx?|jsp|md|txt|json|xml|rss|atom)$/i;

/**
 * Derive a search query from a URL.
 *
 * A URL's last path segment is usually the page subject (`/wiki/Event_loop` →
 * "Event loop"). When there is no useful segment we fall back to the hostname, which
 * at least finds the site itself. Returns `''` for input with no usable text.
 */
export function queryFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return '';
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    let segment = segments[index];
    try {
      segment = decodeURIComponent(segment);
    } catch {
      /* a malformed escape is still usable as literal text */
    }
    segment = segment.replace(FILE_EXTENSIONS, '').replace(/[-_+]+/g, ' ').trim();
    // A bare numeric segment (`/2024/10/`) carries no subject. CJK is dense enough that
    // two characters are already a real subject ("卡顿"), while two Latin characters are not.
    const cjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(segment);
    const minLength = cjk ? 2 : 3;
    if (segment.length >= minLength && /[a-z\u4e00-\u9fa5]/i.test(segment)) return segment.slice(0, 120);
  }
  return parsed.hostname.replace(/^www\./i, '');
}

/**
 * Render the synthesized fetch result as the text a model reads in place of the page.
 *
 * A user preset replaces the prose but not the result list: the sources are the actual
 * outcome of the alternative route, and dropping them would leave the agent with an
 * instruction and no data.
 */
function describeSources({ url, query, timeoutMs, sources, preset = '' }) {
  const list = [];
  sources.forEach((source, index) => {
    list.push(`${index + 1}. ${source.title?.trim() || source.url}`);
    list.push(`   ${source.url}`);
    if (source.snippet?.trim()) list.push(`   ${source.snippet.trim().replace(/\s+/g, ' ')}`);
  });

  if (typeof preset === 'string' && preset.trim() !== '') {
    const head = renderPreset(preset, {
      tool: 'web_fetch',
      target: url,
      query,
      seconds: Math.round(timeoutMs / 1000),
      elapsed: Math.round(timeoutMs / 1000),
      sources: sources.length,
    });
    return [head, '', ...list].join('\n');
  }

  const lines = [
    `Fetching ${url} did not respond within ${Math.round(timeoutMs / 1000)}s, so the guard switched to a web search for "${query}" instead.`,
    '',
    `The page itself was not retrieved. These ${sources.length} search results are the alternative:` ,
    '',
  ];
  lines.push(...list);
  lines.push('');
  lines.push('If the page content is essential, retry the fetch or raise its timeout in the stall-guard settings.');
  return lines.join('\n');
}

/**
 * Run one alternative route under its own deadline.
 *
 * The deadline is a `Promise.race`, not just an abort: a provider that ignores the
 * signal would otherwise hang this function forever, and the whole point of this module
 * is that a second stall cannot happen inside the first one's recovery.
 *
 * Resolves to `{ ok, value }` and never throws: the caller is inside an already-failed
 * tool call and needs a decision, not another error path.
 */
async function withinDeadline(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        controller.abort(new Error('stall-guard: fallback timeout'));
      } catch {
        /* already aborted */
      }
      resolve({ ok: false, error: new Error(`the alternative route did not answer within ${Math.round(timeoutMs / 1000)}s`) });
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => operation(controller.signal))
        .then((value) => ({ ok: true, value }))
        .catch((error) => ({ ok: false, error })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `web_fetch` stalled → answer with a search over the page's subject.
 *
 * Returns a normal `ToolExecutionResult`. A successful alternative is a *success*, so
 * the model can keep working; only a failed alternative is reported as an error, and
 * that error names the timeout so the next step knows what happened.
 */
export async function switchFromFetch({ url, timeoutMs, web, deadlineMs = FALLBACK_TIMEOUT_MS, preset = '', now = () => Date.now() }) {
  const query = queryFromUrl(url);
  const startedAt = now();

  if (!web || typeof web.search !== 'function') {
    return {
      ok: false,
      level: LEVEL_FAILED,
      fallback: null,
      reason: 'the web service is unavailable, so no alternative route exists',
      result: {
        isError: true,
        content: [{
          type: 'text',
          text: `Fetching ${url} timed out after ${Math.round(timeoutMs / 1000)}s and the guard could not search instead: this Host has no web service mounted.`,
        }],
        value: { ok: false, switchedFrom: 'web_fetch', url, timeoutMs, reason: 'web service unavailable' },
      },
    };
  }

  if (!query) {
    return {
      ok: false,
      level: LEVEL_FAILED,
      fallback: 'web_search',
      reason: 'the URL has no text to search for',
      result: {
        isError: true,
        content: [{
          type: 'text',
          text: `Fetching ${url} timed out after ${Math.round(timeoutMs / 1000)}s and the URL carries no subject to search for.`,
        }],
        value: { ok: false, switchedFrom: 'web_fetch', url, timeoutMs, reason: 'no query derivable from url' },
      },
    };
  }

  const outcome = await withinDeadline(
    (signal) => web.search({ query, maxResults: MAX_SOURCES }, signal),
    deadlineMs,
  );

  if (!outcome.ok) {
    const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return {
      ok: false,
      level: LEVEL_FAILED,
      fallback: 'web_search',
      reason,
      result: {
        isError: true,
        content: [{
          type: 'text',
          text: `Fetching ${url} timed out after ${Math.round(timeoutMs / 1000)}s; the alternative search for "${query}" also failed: ${reason}`,
        }],
        value: { ok: false, switchedFrom: 'web_fetch', url, timeoutMs, query, reason },
      },
    };
  }

  const sources = Array.isArray(outcome.value?.sources) ? outcome.value.sources : [];
  if (sources.length === 0) {
    return {
      ok: false,
      level: LEVEL_FAILED,
      fallback: 'web_search',
      reason: 'the alternative search returned no results',
      result: {
        isError: true,
        content: [{
          type: 'text',
          text: `Fetching ${url} timed out after ${Math.round(timeoutMs / 1000)}s, and searching for "${query}" found nothing. The page may be private, or the subject may be worded differently.`,
        }],
        value: { ok: false, switchedFrom: 'web_fetch', url, timeoutMs, query, reason: 'no search results' },
      },
    };
  }

  const compact = sources.slice(0, MAX_SOURCES).map((source) => ({
    url: source.url,
    title: source.title ?? null,
    snippet: source.snippet ?? null,
  }));

  return {
    ok: true,
    level: LEVEL_SWITCHED,
    fallback: 'web_search',
    elapsedMs: now() - startedAt,
    result: {
      isError: false,
      content: [{ type: 'text', text: describeSources({ url, query, timeoutMs, sources: compact, preset }) }],
      value: {
        ok: true,
        switchedFrom: 'web_fetch',
        url,
        timeoutMs,
        query,
        sources: compact,
        note: 'The guard replaced a stalled page fetch with a web search over the same subject.',
      },
    },
  };
}

/**
 * `web_search` stalled → run the same query once more, directly against the service.
 *
 * A retry is the only honest alternative for search: there is no second provider to
 * route to (the Host selects one), and swapping providers would change the result set
 * behind the user's back.
 */
export async function retrySearch({ query, maxResults, timeoutMs, web, deadlineMs = FALLBACK_TIMEOUT_MS, preset = '', now = () => Date.now() }) {
  const startedAt = now();
  if (!web || typeof web.search !== 'function') {
    return {
      ok: false,
      level: LEVEL_FAILED,
      fallback: null,
      reason: 'the web service is unavailable, so no alternative route exists',
      result: {
        isError: true,
        content: [{
          type: 'text',
          text: `Searching for "${query}" timed out after ${Math.round(timeoutMs / 1000)}s and the guard could not retry: this Host has no web service mounted.`,
        }],
        value: { ok: false, switchedFrom: 'web_search', query, timeoutMs, reason: 'web service unavailable' },
      },
    };
  }

  const outcome = await withinDeadline(
    (signal) => web.search({ query, maxResults: maxResults ?? MAX_SOURCES }, signal),
    deadlineMs,
  );

  if (!outcome.ok) {
    const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return {
      ok: false,
      level: LEVEL_FAILED,
      fallback: 'retry',
      reason,
      result: {
        isError: true,
        content: [{
          type: 'text',
          text: `Searching for "${query}" timed out after ${Math.round(timeoutMs / 1000)}s, and one retry also failed: ${reason}`,
        }],
        value: { ok: false, switchedFrom: 'web_search', query, timeoutMs, reason },
      },
    };
  }

  const sources = Array.isArray(outcome.value?.sources) ? outcome.value.sources : [];
  // `WebSearchResult.content` is one optional string (a written answer), not a block array.
  const answer = typeof outcome.value?.content === 'string' ? outcome.value.content.trim() : '';
  return {
    ok: true,
    level: LEVEL_SWITCHED,
    fallback: 'retry',
    elapsedMs: now() - startedAt,
    result: {
      isError: false,
      content: [{
        type: 'text',
        text: answer || `The first search for "${query}" stalled; one retry returned ${sources.length} results.`,
      }],
      value: {
        ok: true,
        switchedFrom: 'web_search',
        query,
        timeoutMs,
        sources: sources.map((source) => ({ url: source.url, title: source.title ?? null, snippet: source.snippet ?? null })),
        truncated: Boolean(outcome.value?.truncated),
        note: 'The guard retried a stalled web search once against the same provider.',
      },
    },
  };
}

/** Dispatch one stalled call to its alternative route, or report that none exists. */
export async function runFallback({ tool, args, timeoutMs, web, deadlineMs, presets, locale = 'zh', now }) {
  if (tool === 'web_fetch') {
    const url = typeof args?.url === 'string' ? args.url : '';
    if (!url) {
      return {
        ok: false,
        level: LEVEL_FAILED,
        fallback: null,
        reason: 'the stalled call carried no url',
        result: {
          isError: true,
          content: [{ type: 'text', text: `The page fetch timed out after ${Math.round(timeoutMs / 1000)}s and carried no URL to search for.` }],
          value: { ok: false, switchedFrom: 'web_fetch', timeoutMs, reason: 'no url argument' },
        },
      };
    }
    return switchFromFetch({ url, timeoutMs, web, deadlineMs, preset: pickPreset(presets, 'fetch', locale), now });
  }

  if (tool === 'web_search') {
    const query = typeof args?.query === 'string' ? args.query : '';
    if (!query) {
      return {
        ok: false,
        level: LEVEL_FAILED,
        fallback: null,
        reason: 'the stalled call carried no query',
        result: {
          isError: true,
          content: [{ type: 'text', text: `The search timed out after ${Math.round(timeoutMs / 1000)}s and carried no query to retry.` }],
          value: { ok: false, switchedFrom: 'web_search', timeoutMs, reason: 'no query argument' },
        },
      };
    }
    return retrySearch({ query, maxResults: args?.max_results ?? args?.maxResults, timeoutMs, web, deadlineMs, preset: pickPreset(presets, 'search', locale), now });
  }

  return { ok: false, level: LEVEL_FAILED, fallback: null, reason: `no alternative route for ${tool}`, result: undefined };
}
