/**
 * Host half of dsh-stall-guard.
 *
 * Three responsibilities, all of them Host-side:
 *
 *  1. wrap tool dispatch with a per-class timeout (`lib/guard.js`),
 *  2. switch only the read-only web calls that have a real alternative (`lib/fallback.js`),
 *  3. serve the supervisor's state and settings to the Client half (`lib/routes.js`).
 *
 * The supervisor's model call lives in `lib/supervisor.js` and is started lazily on the
 * first stall, so an idle session never spends a token on it.
 */

import { ConfigStore } from './lib/config.js';
import { StallMonitor } from './lib/state.js';
import { installGuard } from './lib/guard.js';
import { registerRoutes } from './lib/routes.js';
import { canned, cannedLocale } from './lib/supervisor.js';

/** Matches an `en-*` locale id; anything else is treated as the Chinese default. */
function localeId(ctx) {
  try {
    const snapshot = ctx.get('locale')?.getLocale?.() ?? ctx.get('locale')?.getSnapshot?.();
    return typeof snapshot?.id === 'string' ? snapshot.id : 'zh';
  } catch {
    return 'zh';
  }
}

export function apply(ctx) {
  // The settings file is the only configuration surface; the row declares no `config`,
  // so the store always resolves its own default path.
  const store = new ConfigStore();
  store.load();

  const monitor = new StallMonitor();
  const locale = () => localeId(ctx);

  ctx.effect(() => installGuard(ctx, { config: store, monitor, locale }), 'stall-guard: timeout wrapper');

  // Routes need the HTTP carrier; wait for it so a Host without a web server (CLI-only
  // composition) simply has no settings surface instead of failing to activate.
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => registerRoutes(scoped, { config: store, monitor, locale }),
      'stall-guard: settings routes',
    );
  });

  // The panel's sentence is templated, never generated.
  //
  // It is re-rendered when the UI locale changes, so a language switch rewrites an alert
  // that is already on screen instead of leaving stale text in the old language. There is
  // no model call anywhere in this plugin: the sentence describes facts the guard already
  // knows exactly, so a model could only rephrase them for a per-stall token cost.
  ctx.effect(() => {
    const unsubscribe = ctx.get('locale')?.subscribe?.(() => {
      const snapshot = monitor.snapshot();
      if (snapshot.supervisor.mode !== 'alert') return;
      monitor.refine({
        message: canned({
          locale: cannedLocale(locale()),
          kind: snapshot.supervisor.kind ?? 'other',
          action: snapshot.supervisor.action ?? 'notify',
          level: snapshot.supervisor.level,
          tool: snapshot.supervisor.tool ?? 'tool',
          elapsedMs: snapshot.supervisor.elapsedMs,
          seconds: Math.round((snapshot.supervisor.timeoutMs ?? 0) / 1000),
          download: snapshot.supervisor.download,
        }),
        source: 'canned',
      });
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, 'stall-guard: localized alert copy');
}

/**
 * No `Config` export: the row carries no configuration.
 *
 * Everything the user can change lives in the settings file that the Client half edits
 * through the plugin's own HTTP routes, so there is nothing for the Loader to validate.
 * Exporting a plain JSON shape here would be wrong — the Loader calls `Config.validate`,
 * which only a zod schema provides.
 */
