/**
 * The supervisor's voice.
 *
 * This module writes one short sentence describing a stall, using a fixed bilingual
 * template table. It deliberately contains no model call.
 *
 * Why: the sentence is read by the human watching the panel, and the facts it needs to
 * convey — which tool, how long, which budget, what the guard did — are already known
 * exactly. A model cannot improve on them; it can only rephrase them, and doing so costs
 * real tokens on the user's account for every stall. Templating is both cheaper and more
 * accurate, so there is no model path here to accidentally enable.
 */

import { LEVEL_FAILED, LEVEL_NOTICE, LEVEL_SWITCHED } from './state.js';

/** Longest sentence the panel can show without truncating. */
const MAX_MESSAGE_CHARS = 120;

/**
 * Fixed lines, keyed by the situation.
 *
 * Keys are `kind:action:level`, with `*` wildcards resolved in `canned()`. Chinese is the
 * primary audience; English keeps the plugin usable outside it.
 */
const CANNED = {
  zh: {
    'fetch:switch:2': (ctx) => `${ctx.tool} 超过 ${ctx.seconds}s 没响应，已改用搜索找「${ctx.detail}」。`,
    'fetch:switch:3': (ctx) => `${ctx.tool} 超过 ${ctx.seconds}s 没响应，改用搜索也没能找到结果。`,
    'search:switch:2': (ctx) => `${ctx.tool} 超过 ${ctx.seconds}s 没响应，重试一次已拿到结果。`,
    'search:switch:3': (ctx) => `${ctx.tool} 超过 ${ctx.seconds}s 没响应，重试仍然失败。`,
    // A download is not "switched" by the plugin — it is killed and the agent is told to
    // pick another source. Saying the fallback failed would be wrong: none was attempted.
    'exec:switch:1': (ctx) => ctx.download
      ? `下载 ${ctx.seconds}s 没完成，已中止，并让智能体换一个源重试。`
      : `${ctx.tool} 超过 ${ctx.seconds}s 没响应，已中止。`,
    'exec:switch:2': (ctx) => ctx.download
      ? `下载 ${ctx.seconds}s 没完成，已中止，换源提示已交给智能体。`
      : `${ctx.tool} 超过 ${ctx.seconds}s 没响应，已换备选方式。`,
    'exec:switch:3': (ctx) => ctx.download
      ? `下载 ${ctx.seconds}s 没完成，已中止，换源提示已交给智能体。`
      : `${ctx.tool} 超过 ${ctx.seconds}s 没响应。`,
    'exec:notify:1': (ctx) => ctx.download
      ? `${ctx.tool} 已跑 ${ctx.elapsed}s，看着像是在下载，慢一点属正常。`
      : `${ctx.tool} 已跑 ${ctx.elapsed}s，超过 ${ctx.seconds}s 的预期，可能卡住了。`,
    'read:notify:1': (ctx) => `${ctx.tool} 已跑 ${ctx.elapsed}s 还没返回，可能卡在磁盘或大文件上。`,
    'write:notify:1': (ctx) => `${ctx.tool} 已跑 ${ctx.elapsed}s 还没写完，已保留不打断以免数据损坏。`,
    'long:notify:1': (ctx) => `${ctx.tool} 是长任务，已跑 ${ctx.elapsed}s，先继续等。`,
    '*:notify:1': (ctx) => `${ctx.tool} 已跑 ${ctx.elapsed}s，超过 ${ctx.seconds}s 的预期。`,
    '*:notify:3': (ctx) => `${ctx.tool} 卡住了，最终以超时结束。`,
  },
  en: {
    'fetch:switch:2': (ctx) => `${ctx.tool} passed ${ctx.seconds}s, so the guard searched for "${ctx.detail}" instead.`,
    'fetch:switch:3': (ctx) => `${ctx.tool} passed ${ctx.seconds}s and the alternative search found nothing.`,
    'search:switch:2': (ctx) => `${ctx.tool} passed ${ctx.seconds}s; one retry returned results.`,
    'search:switch:3': (ctx) => `${ctx.tool} passed ${ctx.seconds}s and the retry failed too.`,
    'exec:switch:1': (ctx) => ctx.download
      ? `Download did not finish in ${ctx.seconds}s; it was stopped and the agent was told to try another source.`
      : `${ctx.tool} passed ${ctx.seconds}s and was stopped.`,
    'exec:switch:2': (ctx) => ctx.download
      ? `Download did not finish in ${ctx.seconds}s; it was stopped and the agent got switch-source advice.`
      : `${ctx.tool} passed ${ctx.seconds}s; an alternative route was used.`,
    'exec:switch:3': (ctx) => ctx.download
      ? `Download did not finish in ${ctx.seconds}s; it was stopped and the agent got switch-source advice.`
      : `${ctx.tool} passed ${ctx.seconds}s.`,
    'exec:notify:1': (ctx) => ctx.download
      ? `${ctx.tool} has run ${ctx.elapsed}s; this looks like a download, so slow is expected.`
      : `${ctx.tool} has run ${ctx.elapsed}s against a ${ctx.seconds}s budget and may be stuck.`,
    'read:notify:1': (ctx) => `${ctx.tool} has run ${ctx.elapsed}s without returning; a slow disk or a large file is likely.`,
    'write:notify:1': (ctx) => `${ctx.tool} has run ${ctx.elapsed}s; it was left alone so data cannot be corrupted.`,
    'long:notify:1': (ctx) => `${ctx.tool} is a long-running task and has run ${ctx.elapsed}s; still waiting.`,
    '*:notify:1': (ctx) => `${ctx.tool} has run ${ctx.elapsed}s against a ${ctx.seconds}s budget.`,
    '*:notify:3': (ctx) => `${ctx.tool} was stuck and ended in a timeout.`,
  },
};

/**
 * First matching line, from most specific to least.
 *
 * Order: exact `kind:action:level`, then `kind:action:1`, then `*:action:level`, then
 * `*:notify:1`. The last always exists, so this cannot return an empty message.
 */
export function canned({ locale = 'zh', kind, action, level, tool, elapsedMs, seconds, detail = '', download = false }) {
  const table = CANNED[locale] ?? CANNED.zh;
  const template = level === LEVEL_NOTICE ? '1' : level === LEVEL_SWITCHED ? '2' : level === LEVEL_FAILED ? '3' : '1';
  const keys = [
    `${kind}:${action}:${template}`,
    `${kind}:${action}:1`,
    `*:${action}:${template}`,
    `*:${action}:1`,
    '*:notify:1',
  ];
  const context = {
    tool: String(tool ?? 'tool'),
    /** Whole seconds, matching the wording of every template. */
    elapsed: Math.round((Number(elapsedMs) || 0) / 1000),
    seconds: Math.round((Number(seconds) || 0)),
    detail: String(detail ?? '').slice(0, 60),
    download: Boolean(download),
  };
  for (const key of keys) {
    const build = table[key];
    if (typeof build === 'function') {
      try {
        return build(context);
      } catch {
        /* a template failure must not break the alert; try the next key */
      }
    }
  }
  return `${context.tool} timed out after ${context.seconds}s.`;
}

/** Strip anything that should not appear on one line of UI text. */
export function sanitizeMessage(text) {
  let value = typeof text === 'string' ? text : '';
  value = value.replace(/```[\s\S]*?```/g, ' ');   // fenced blocks
  value = value.replace(/[`*_#>]+/g, ' ');         // inline markdown markers
  value = value.replace(/\s+/g, ' ').trim();       // one line
  value = value.replace(/^(?:好的|当然|Sure|Okay|Ok)[，,。.\s]*/i, '');
  if (value.length > MAX_MESSAGE_CHARS) value = `${value.slice(0, MAX_MESSAGE_CHARS - 1)}\u2026`;
  return value;
}

/** Locale id for the template table: anything not English is treated as Chinese. */
export function cannedLocale(locale) {
  return String(locale ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}
