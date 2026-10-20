/**
 * The timeout wrapper itself.
 *
 * Registered as a `tools/execute` waterfall listener, which runs after approval and
 * guards have accepted the call and before the tool body dispatches. That position is
 * what makes the timing honest: the budget covers the work, not the user's decision.
 *
 * The wrapper is allowed to change exactly one thing about the execution — `exec.signal`
 * — so it hands the tool its own controller and restores the caller's signal afterwards.
 * Aborting that controller cancels the tool without detaching the caller's own
 * cancellation, which still reaches the tool through the listener installed below.
 *
 * Two kinds of work are ever aborted, and both flow back a result the *agent* reads:
 *   - `web_fetch` / `web_search` — replaced by an alternative route (`lib/fallback.js`),
 *   - a detected network download — replaced by a "switch source" advisory
 *     (`lib/download.js`), because GitHub and friends are the usual upstream and the
 *     agent needs to know to try a mirror.
 *
 * Everything else is reported and left running: aborting a file write mid-flight risks
 * corrupt work, and the user chose that safety policy explicitly.
 */

import { resolveSpec, detectDownload } from './classify.js';
import { runFallback } from './fallback.js';
import { buildAdvisory, cleanupHint, downloadTimeoutResult } from './download.js';
import { pickPreset, sceneEnabled } from './presets.js';
import { LEVEL_FAILED, LEVEL_NOTICE } from './state.js';
import { canned, cannedLocale } from './supervisor.js';

/** Tools whose stalled call can be answered by an alternative route. */
const SWITCH_TOOLS = new Set(['web_fetch', 'web_search']);

/**
 * Human-readable subject for one call, used in the supervisor's sentence.
 * Kept tiny on purpose: it is a UI string, not a log line.
 */
function subjectOf(tool, args) {
  if (tool === 'web_fetch') {
    const url = typeof args?.url === 'string' ? args.url : '';
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return url.slice(0, 60);
    }
  }
  if (tool === 'web_search') return typeof args?.query === 'string' ? args.query.slice(0, 60) : '';
  return '';
}

/**
 * The download budget: the per-scene value wins, then the legacy global one.
 *
 * `downloadSeconds` predates per-scene settings; keeping it as the fallback means an
 * existing config file keeps working while a user migrating to `scenes` gets the new
 * behaviour without editing twice.
 */
function downloadSecondsOr(sceneSeconds, legacySeconds) {
  if (Number.isFinite(Number(sceneSeconds)) && Number(sceneSeconds) > 0) return sceneSeconds;
  return legacySeconds;
}

/** A finished tool result counts as a real outcome only when it is not an error. */
function isSuccessfulToolResult(result) {
  return Boolean(result) && result.isError === false;
}

/**
 * Install the guard on one Host context.
 *
 * Returns a disposer that also clears every pending timer, so unloading the plugin
 * cannot leave a stray `setTimeout` firing into a dead monitor.
 */
export function installGuard(ctx, { config, monitor, locale = () => 'zh' }) {
  const timers = new Set();

  const onExecute = async (exec, next) => {
    const current = config.get();
    if (!current.enabled) return next();

    const callId = String(exec?.callId ?? exec?.rootCallId ?? '');
    if (!callId) return next();

    const original = exec.signal;
    const spec = resolveSpec(exec?.name, current);
    const controller = new AbortController();
    const messageLocale = () => cannedLocale(locale());

    // A detected download is watched more aggressively than its class: the whole point
    // is to cut a dead network path early and hand the agent a "switch source" result.
    //
    // Per-scene settings govern each path independently: `scenes.download` decides whether
    // the download guard runs and with what budget, `scenes.fetch` / `scenes.search` decide
    // the same for the two web fallbacks. One scene being off must not disable the others.
    // `scenes.download.enabled` is the single authority. The legacy `watchDownloads` flag
    // is folded into the scene during validation, so consulting it here as well would give
    // the user two switches for one feature — and turning one on would appear not to work.
    const downloadAllowed = sceneEnabled(current.scenes, 'download');
    const download = downloadAllowed
      ? detectDownload(exec, (name) => (name === spec.tool ? spec.kind : undefined))
      : undefined;

    /** The scene this call belongs to, for the per-scene switches. */
    const scene = download
      ? 'download'
      : spec.tool === 'web_fetch'
        ? 'fetch'
        : spec.tool === 'web_search'
          ? 'search'
          : undefined;

    const sceneSeconds = scene ? current.scenes?.[scene]?.seconds : undefined;
    const budgetMs = download
      ? Math.min(spec.ms, Math.max(1000, (Number(downloadSecondsOr(sceneSeconds, current.downloadSeconds)) || 30) * 1000))
      : sceneSeconds !== undefined
        ? Math.max(1000, Number(sceneSeconds) * 1000)
        : spec.ms;

    /** A scene switched off behaves exactly like the old "notify only" posture. */
    const sceneOff = scene !== undefined && !sceneEnabled(current.scenes, scene);

    let timedOut = false;
    let fallbackPromise;
    let fallbackOutcome;
    let thrown;

    // Caller cancellation must still cancel the tool even though the tool now sees ours.
    const forwardAbort = () => {
      try {
        controller.abort(original?.reason);
      } catch {
        /* the controller may already be aborted; nothing to do */
      }
    };
    if (original?.aborted) forwardAbort();
    else original?.addEventListener('abort', forwardAbort, { once: true });

    // Hand the tool OUR signal. Without this assignment the timer can only observe the
    // stall — it could never stop the work, which is the difference between a guard and
    // a progress bar.
    try {
      exec.signal = controller.signal;
    } catch {
      /* a frozen execution object means the Host forbids wrapping; notify-only still works */
    }

    monitor.begin({
      callId,
      tool: spec.tool,
      kind: spec.kind,
      timeoutMs: budgetMs,
      download: Boolean(download),
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      const call = monitor.get(callId);
      const elapsedMs = call ? monitor.now() - call.startedAt : budgetMs;
      const switchable = !sceneOff && spec.autoSwitch && SWITCH_TOOLS.has(spec.tool);
      // A download is aborted so the agent receives the switch-source result. A plain
      // exec command is not: it may be a write or a long build with no safe retry.
      const action = switchable || download ? 'switch' : 'notify';
      const detail = download ? download.label : subjectOf(spec.tool, exec.arguments);

      // Stop stalled work only when doing so is safe: a read-only fetch, or a download
      // whose whole purpose is to be retried elsewhere. A file write is left alone.
      if (switchable || download) {
        try {
          controller.abort(new Error(`stall-guard: ${spec.tool} exceeded ${Math.round(budgetMs / 1000)}s`));
        } catch {
          /* already aborted */
        }
      }

      // Publish the alert immediately with canned copy: the supervisor must react on the
      // timeout, not on the model's response time.
      monitor.stall({
        callId,
        tool: spec.tool,
        kind: spec.kind,
        elapsedMs,
        timeoutMs: budgetMs,
        action,
        level: LEVEL_NOTICE,
        fallback: download
          ? `switch-${download.channel}-source`
          : switchable
            ? (spec.tool === 'web_fetch' ? 'web_search' : 'retry')
            : null,
        fallbackOk: null,
        message: canned({
          locale: messageLocale(),
          kind: spec.kind,
          action,
          level: LEVEL_NOTICE,
          tool: spec.tool,
          elapsedMs,
          seconds: Math.round(budgetMs / 1000),
          detail,
          download: Boolean(download),
        }),
        source: 'canned',
        download: Boolean(download),
      });

      if (switchable) {
        fallbackPromise = runFallback({
          tool: spec.tool,
          args: exec.arguments,
          timeoutMs: budgetMs,
          web: ctx.get('web'),
          presets: current.presets,
          locale: messageLocale(),
          now: monitor.now,
        }).then((outcome) => {
          fallbackOutcome = outcome;
          return outcome;
        });
      }
    }, budgetMs);
    timers.add(timeoutHandle);

    let result;
    try {
      result = await next();
    } catch (error) {
      thrown = error;
    } finally {
      clearTimeout(timeoutHandle);
      timers.delete(timeoutHandle);
      try {
        exec.signal = original;
      } catch {
        /* a frozen execution object is the Host's decision; the timer is still cleared */
      }
      original?.removeEventListener('abort', forwardAbort);
    }

    if (!timedOut) {
      monitor.end(callId);
      if (thrown) throw thrown;
      return result;
    }

    // A detected download that overran its budget is answered with the switch-source
    // advisory, whether the body errored or was killed. The agent must receive this as
    // the tool result: it is the only channel through which it learns to change mirrors.
    if (download) {
      const elapsedMs = budgetMs;
      const preset = pickPreset(current.presets, 'download', messageLocale());
      monitor.refine({
        callId,
        level: LEVEL_FAILED,
        action: 'switch',
        fallback: `switch-${download.channel}-source`,
        fallbackOk: null,
        message: buildAdvisory({
          detection: download,
          timeoutMs: budgetMs,
          elapsedMs,
          locale: messageLocale(),
          leftover: cleanupHint(download.channel, messageLocale()),
          preset,
        }).split('\n')[0],
        source: 'canned',
      });
      monitor.end(callId);
      return downloadTimeoutResult({
        detection: download,
        timeoutMs: budgetMs,
        elapsedMs,
        locale: messageLocale(),
        preset,
      });
    }

    // The call got a real, successful answer anyway — an abort the tool ignored, or a
    // race where the body finished first. Discarding a usable result to substitute the
    // fallback would be worse than the timeout, so the real result wins.
    if (isSuccessfulToolResult(result)) {
      monitor.refine({
        callId,
        // The call did overrun its budget, so the supervisor keeps a notice on screen;
        // it must not claim a failure merely because the alt was not needed.
        level: LEVEL_NOTICE,
        action: 'notify',
        fallback: null,
        fallbackOk: true,
        message: canned({
          locale: messageLocale(),
          kind: spec.kind,
          action: 'notify',
          level: LEVEL_NOTICE,
          tool: spec.tool,
          elapsedMs: spec.ms,
          seconds: spec.seconds,
          detail: subjectOf(spec.tool, exec.arguments),
        }),
        source: 'canned',
      });
      monitor.end(callId);
      return result;
    }

    const outcome = fallbackOutcome ?? (fallbackPromise ? await fallbackPromise : undefined);
    if (outcome) {
      monitor.refine({
        callId,
        level: outcome.ok ? 2 : LEVEL_FAILED,
        action: 'switch',
        fallback: outcome.fallback ?? null,
        fallbackOk: outcome.ok === true,
        message: canned({
          locale: messageLocale(),
          kind: spec.kind,
          action: 'switch',
          level: outcome.ok ? 2 : LEVEL_FAILED,
          tool: spec.tool,
          elapsedMs: spec.ms,
          seconds: spec.seconds,
          detail: subjectOf(spec.tool, exec.arguments),
        }),
        source: 'canned',
      });
      monitor.end(callId);
      if (outcome.result) return outcome.result;
    } else {
      monitor.refine({ callId, level: LEVEL_FAILED, action: 'notify', fallbackOk: false });
      monitor.end(callId);
    }

    if (thrown) throw thrown;
    return result;
  };

  const disposeListener = ctx.on('tools/execute', onExecute);

  return () => {
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
    disposeListener?.();
  };
}
