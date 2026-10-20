/**
 * Client half of dsh-stall-guard.
 *
 * Two seats, one shared store:
 *
 *  - `conversation.session.header.utilities` (id `stall-guard-supervisor`,
 *    order 100) renders the supervisor itself — the "status bar" shape the
 *    user asked for. Three display forms come from `supervisor.display`:
 *    `dot` (6px, sleeps at 35% opacity, breathes while watching, pulses red
 *    on alert), `icon` (18px shield, bounces and glows on alert) and
 *    `avatar` (28px DeepSeek-blue whale; eyes closed at idle, sways while
 *    watching, big bounce plus a warning bubble on alert).
 *  - `shell.overlay` (id `stall-guard-panel`, order 70) renders the settings
 *    panel in the frame-wide floating layer, top-right, so it can never be
 *    clipped by the transcript scroller and never covers the composer.
 *
 * The seat cannot talk to the panel directly (two different slots), so a
 * module-level store carries the polled `/dsh-stall-guard/state.json`
 * snapshot, the cached `/dsh-stall-guard/config.json` and the open/closed
 * flag. Both seats subscribe through `useSyncExternalStore`.
 *
 * Polling: `setInterval` at 1000ms, dropping to 3000ms while
 * `document.hidden`. Failures are silent — the last good state stays on
 * screen, `console.warn` happens at most once, and the next tick retries.
 *
 * Styling uses the host theme tokens (`--dsw-alias-*`) with an explicit
 * fallback on every `var()`, so both the dark and the light theme stay
 * legible. All animation is pure CSS inside a `<style>` element that the
 * component renders and therefore drops on unmount; nothing drives frames
 * from a timer. All visible copy goes through the locale namespace
 * (`dsh.stallGuard`, zh + en).
 */
window.__ModuleLoader__.load({
  id: 'dsh-stall-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useLayoutEffect = React.useLayoutEffect;
    const useCallback = React.useCallback;
    const useSyncExternalStore = React.useSyncExternalStore;

    const NS = 'dsh.stallGuard';
    const ROUTE = '/dsh-stall-guard/';
    const STATE_URL = ROUTE + 'state.json';
    const CONFIG_URL = ROUTE + 'config.json';
    const ACK_URL = ROUTE + 'ack';
    const TICK_MS = 1000;
    const TICK_HIDDEN_MS = 3000;
    const CONFIG_TTL_MS = 30000;
    const REQUEST_TIMEOUT_MS = 4000;
    const SAVE_TIMEOUT_MS = 8000;

    const KINDS = ['fetch', 'search', 'read', 'write', 'exec', 'long', 'other'];
    const PRESET_SCENES = ['download', 'fetch', 'search'];
    /** Per-scene defaults, mirroring lib/presets.js. */
    const SCENE_DEFAULTS = {
      download: { enabled: true, seconds: 30 },
      fetch: { enabled: true, seconds: 15 },
      search: { enabled: true, seconds: 15 },
    };

    function defaultScenes() {
      const out = {};
      for (const scene of PRESET_SCENES) out[scene] = { ...SCENE_DEFAULTS[scene] };
      return out;
    }

    function normalizeScenes(raw) {
      const out = defaultScenes();
      if (!isObject(raw)) return out;
      for (const scene of PRESET_SCENES) {
        const value = raw[scene];
        if (!isObject(value)) continue;
        out[scene].enabled = value.enabled !== false;
        out[scene].seconds = intWithin(value.seconds, SCENE_DEFAULTS[scene].seconds, 1, 3600);
      }
      return out;
    }
    /** Caps the Host enforces; repeated here so the editor can warn before a round trip. */
    const PRESET_MAX_CHARS = 4000;
    const DISPLAYS = ['dot', 'icon', 'avatar'];
    const MODES = ['idle', 'watching', 'alert'];

    const DEFAULT_TIMERS = {
      fetch: 15,
      search: 15,
      read: 20,
      write: 30,
      exec: 30,
      long: 120,
      other: 30,
    };

    const DEFAULT_CONFIG = {
      version: 1,
      enabled: true,
      timers: DEFAULT_TIMERS,
      overrides: {},
      autoSwitch: true,
      scenes: defaultScenes(),
      supervisor: {
        show: true,
        display: 'avatar',
      },
    };

    /**
     * Appearance of the supervisor icon.
     *
     * Kept in `localStorage`, not the Host config: it is a per-browser ergonomic choice
     * (screen size, eyesight, where the user keeps the header), not a shared guard policy.
     * Storing it locally also means it applies instantly without a round trip.
     */
    const APPEARANCE_KEY = 'dsh-stall-guard.appearance.v1';
    const APPEARANCE_DEFAULTS = {
      size: 28,        // px, the avatar/glyph box
      opacity: 1,      // 0.2..1
      place: 'header', // 'header' | 'float'
      x: -1,           // float only; -1 means "use the default corner"
      y: -1,
    };
    const SIZE_MIN = 14;
    const SIZE_MAX = 64;
    const OPACITY_MIN = 0.2;

    function clampNumber(value, fallback, min, max) {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }

    /** Read the appearance, tolerating a missing or corrupt record. */
    function readAppearance() {
      try {
        const raw = window.localStorage.getItem(APPEARANCE_KEY);
        if (!raw) return { ...APPEARANCE_DEFAULTS };
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object') return { ...APPEARANCE_DEFAULTS };
        return {
          size: Math.round(clampNumber(body.size, APPEARANCE_DEFAULTS.size, SIZE_MIN, SIZE_MAX)),
          opacity: clampNumber(body.opacity, APPEARANCE_DEFAULTS.opacity, OPACITY_MIN, 1),
          place: body.place === 'float' ? 'float' : 'header',
          x: clampNumber(body.x, -1, -1, 100000),
          y: clampNumber(body.y, -1, -1, 100000),
        };
      } catch {
        return { ...APPEARANCE_DEFAULTS };
      }
    }

    function writeAppearance(next) {
      try {
        window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
      } catch {
        /* private mode or a full quota: the in-memory value still applies this session */
      }
    }

    /* ---------------------------------------------------------------- locale */

    const en = {
      title: 'Stall Guard',
      supervisor: 'Stall supervisor',
      openPanel: 'Open Stall Guard settings',
      close: 'Close',
      ack: 'Got it',
      ackSending: 'Acknowledging\u2026',
      ackDone: 'Acknowledged',
      ackFailed: 'Could not acknowledge: {message}',
      modeIdle: 'Idle',
      modeWatching: 'Watching',
      modeAlert: 'Alert',
      levelLabel: 'level {level}',
      noState: 'No state yet',
      sectionTimers: 'Tool timeouts',
      sectionTimersHint: 'Seconds before a tool of this kind counts as stalled (1\u20133600).',
      kindFetch: 'Page fetch',
      kindSearch: 'Web search',
      kindRead: 'Read',
      kindWrite: 'Write',
      kindExec: 'Command',
      kindLong: 'Long task',
      kindOther: 'Other',
      sectionToggles: 'Switches',
      enabled: 'Guard enabled',
      autoSwitch: 'Auto-switch fetch/search on timeout',
      sectionPresets: 'Preset text (sent to the agent)',
      sectionScenes: 'Each feature, configured separately',
      scenesHint: 'Turn one off without affecting the others. Each has its own timeout and its own choice about the supervisor model.',
      sceneSeconds: 'Timeout (s)',
      presetsHint: 'Write the exact text the agent reads when a stall is reported. Placeholders are filled in automatically; an empty box uses the built-in wording.',
      presetSceneDownload: 'Download',
      presetSceneFetch: 'Page fetch',
      presetSceneSearch: 'Search',
      presetChars: '{count} characters',
      presetTooLong: 'over the 4000 limit; the end will be cut',
      presetPlaceholders: 'Insert:',
      presetInsertHint: 'Append this placeholder to the text',
      presetRestore: 'Restore default',
      presetClear: 'Use built-in',
      presetEmptyHint: 'Empty = use the built-in wording. Nothing is generated and no model is called when a preset is set.',
      watchDownloads: 'Treat download commands specially',
      downloadSeconds: 'Download timeout (s)',
      sectionSupervisor: 'Supervisor',
      showSupervisor: 'Show the supervisor',
      showSupervisorHint: 'Off hides the figure but keeps the guard running; a small tab stays in the corner so you can switch it back.',
      supervisorHiddenHint: 'Supervisor hidden — click to open settings',
      appearanceLabel: 'Icon appearance (this browser only)',
      iconSize: 'Size',
      iconOpacity: 'Opacity',
      placeHeader: 'In the header',
      placeFloat: 'Floating',
      placeHeaderHint: 'The header keeps it beside the session title.',
      placeFloatHint: 'Floating: drag the icon anywhere; its position is remembered.',
      displayLabel: 'Display form',
      displayDot: 'Dot',
      displayIcon: 'Icon',
      displayAvatar: 'Avatar',
      sectionStats: 'Statistics',
      statStalls: 'Stalls',
      statSwitches: 'Switches',
      statNotices: 'Notices',
      sectionRecent: 'Recent events',
      recentEmpty: 'Nothing recorded yet.',
      actionSwitch: 'Switched',
      actionNotify: 'Notified',
      actionNone: 'None',
      okTrue: 'OK',
      okFalse: 'Failed',
      okNull: '\u2014',
      sourceModel: 'from model',
      sourceCanned: 'canned',
      sourceNone: '',
      fallbackNone: '\u2014',
      save: 'Save',
      saving: 'Saving\u2026',
      saved: 'Saved',
      unsaved: 'Unsaved changes',
      discardConfirm: 'Discard unsaved changes?',
      discardYes: 'Discard',
      discardNo: 'Keep editing',
      saveFailed: 'Save failed: {message}',
      savedWithWarnings: 'Saved, with {count} adjustment(s): {list}',
      overridesKept: 'Per-tool overrides are kept as they are ({count}).',
      unknownValue: 'unknown',
    };

    const zh = {
      title: '\u5361\u987f\u5b88\u536b',
      supervisor: '\u5361\u987f\u76d1\u7763\u5458',
      openPanel: '\u6253\u5f00\u5361\u987f\u5b88\u536b\u8bbe\u7f6e',
      close: '\u5173\u95ed',
      ack: '\u77e5\u9053\u4e86',
      ackSending: '\u786e\u8ba4\u4e2d\u2026',
      ackDone: '\u5df2\u786e\u8ba4',
      ackFailed: '\u786e\u8ba4\u5931\u8d25\uff1a{message}',
      modeIdle: '\u7a7a\u95f2',
      modeWatching: '\u76d1\u89c6\u4e2d',
      modeAlert: '\u544a\u8b66',
      levelLabel: '\u7b49\u7ea7 {level}',
      noState: '\u6682\u65e0\u72b6\u6001',
      sectionTimers: '\u8d85\u65f6\u65f6\u95f4',
      sectionTimersHint: '\u6b64\u7c7b\u5de5\u5177\u8d85\u8fc7\u591a\u5c11\u79d2\u89c6\u4e3a\u5361\u987f\uff081\u20133600\uff09\u3002',
      kindFetch: '\u6293\u53d6\u7f51\u9875',
      kindSearch: '\u7f51\u7edc\u641c\u7d22',
      kindRead: '\u8bfb\u53d6',
      kindWrite: '\u5199\u5165',
      kindExec: '\u547d\u4ee4\u6267\u884c',
      kindLong: '\u957f\u4efb\u52a1',
      kindOther: '\u5176\u4ed6',
      sectionToggles: '\u5f00\u5173',
      enabled: '\u542f\u7528\u5b88\u62a4',
      autoSwitch: '\u6293\u53d6/\u641c\u7d22\u8d85\u65f6\u540e\u81ea\u52a8\u5207\u6362',
      sectionSupervisor: '\u76d1\u7763\u5458',
      discardYes: '\u653e\u5f03',
      discardNo: '\u7ee7\u7eed\u7f16\u8f91',
      sectionPresets: '\u9884\u8bbe\u6587\u5b57\uff08\u53d1\u7ed9\u667a\u80fd\u4f53\uff09',
      sectionScenes: '\u6bcf\u4e2a\u529f\u80fd\u72ec\u7acb\u914d\u7f6e',
      scenesHint: '\u5173\u6389\u4e00\u4e2a\u4e0d\u5f71\u54cd\u5176\u5b83\u3002\u6bcf\u4e2a\u7c7b\u578b\u6709\u81ea\u5df1\u7684\u8d85\u65f6\uff0c\u4e5f\u80fd\u81ea\u5df1\u51b3\u5b9a\u8981\u4e0d\u8981\u7528\u6a21\u578b\u5199\u63d0\u793a\u3002',
      sceneSeconds: '\u8d85\u65f6\uff08\u79d2\uff09',
      presetsHint: '\u76f4\u63a5\u5199\u4f60\u8981\u53d1\u7ed9\u667a\u80fd\u4f53\u7684\u6587\u5b57\uff0c\u5360\u4f4d\u7b26\u4f1a\u81ea\u52a8\u66ff\u6362\uff1b\u7a7a\u7740 = \u7528\u5185\u7f6e\u6587\u6848\u3002',
      presetSceneDownload: '\u4e0b\u8f7d',
      presetSceneFetch: '\u6293\u53d6\u7f51\u9875',
      presetSceneSearch: '\u641c\u7d22',
      presetChars: '{count} \u5b57',
      presetTooLong: '\uff0c\u8d85\u51fa 4000 \u9650\u5236\uff0c\u5c3e\u90e8\u4f1a\u88ab\u622a\u65ad',
      presetPlaceholders: '\u63d2\u5165\uff1a',
      presetInsertHint: '\u628a\u8fd9\u4e2a\u5360\u4f4d\u7b26\u8ffd\u52a0\u5230\u672b\u5c3e',
      presetRestore: '\u6062\u590d\u9ed8\u8ba4',
      presetClear: '\u7528\u5185\u7f6e\u6587\u6848',
      presetEmptyHint: '\u7a7a\u7740\u5c31\u7528\u5185\u7f6e\u6587\u6848\u3002\u8bbe\u4e86\u9884\u8bbe\u5c31\u4e0d\u4f1a\u53eb\u6a21\u578b\uff0c\u4e5f\u4e0d\u4f1a\u6709\u989d\u5916\u6d88\u8017\u3002',
      watchDownloads: '\u5355\u72ec\u76ef\u4e0b\u8f7d\u7c7b\u547d\u4ee4',
      downloadSeconds: '\u4e0b\u8f7d\u8d85\u65f6\uff08\u79d2\uff09',
      showSupervisor: '\u663e\u793a\u76d1\u7763\u5458',
      showSupervisorHint: '\u5173\u6389\u540e\u4e0d\u518d\u663e\u793a\u5f62\u8c61\uff0c\u4f46\u5b88\u536b\u4ecd\u5728\u8fd0\u884c\uff1b\u53f3\u4e0b\u89d2\u4f1a\u7559\u4e00\u4e2a\u5c0f\u70b9\uff0c\u70b9\u5b83\u53ef\u4ee5\u518d\u6253\u5f00\u3002',
      supervisorHiddenHint: '\u76d1\u7763\u5458\u5df2\u9690\u85cf \u2014 \u70b9\u51fb\u6253\u5f00\u8bbe\u7f6e',
      appearanceLabel: '\u56fe\u6807\u5916\u89c2\uff08\u4ec5\u672c\u6d4f\u89c8\u5668\uff09',
      iconSize: '\u5927\u5c0f',
      iconOpacity: '\u900f\u660e\u5ea6',
      placeHeader: '\u6807\u9898\u680f',
      placeFloat: '\u6d6e\u52a8',
      placeHeaderHint: '\u6807\u9898\u680f\uff1a\u56fa\u5b9a\u5728\u4f1a\u8bdd\u6807\u9898\u65c1\u3002',
      placeFloatHint: '\u6d6e\u52a8\uff1a\u53ef\u4ee5\u62d6\u5230\u4efb\u4f55\u4f4d\u7f6e\uff0c\u4f4d\u7f6e\u4f1a\u8bb0\u4f4f\u3002',
      displayLabel: '\u663e\u793a\u5f62\u6001',
      displayDot: '\u5c0f\u70b9',
      displayIcon: '\u56fe\u6807',
      displayAvatar: '\u89d2\u8272',
      sectionStats: '\u7edf\u8ba1',
      statStalls: '\u5361\u987f',
      statSwitches: '\u81ea\u52a8\u5207\u6362',
      statNotices: '\u63d0\u793a',
      sectionRecent: '\u6700\u8fd1\u4e8b\u4ef6',
      recentEmpty: '\u8fd8\u6ca1\u6709\u8bb0\u5f55\u3002',
      actionSwitch: '\u5df2\u5207\u6362',
      actionNotify: '\u4ec5\u63d0\u793a',
      actionNone: '\u65e0',
      okTrue: '\u6210\u529f',
      okFalse: '\u5931\u8d25',
      okNull: '\u2014',
      sourceModel: '\u6765\u81ea\u6a21\u578b',
      sourceCanned: '\u9884\u8bbe\u6587\u6848',
      sourceNone: '',
      fallbackNone: '\u2014',
      save: '\u4fdd\u5b58',
      saving: '\u4fdd\u5b58\u4e2d\u2026',
      saved: '\u5df2\u4fdd\u5b58',
      unsaved: '\u6709\u672a\u4fdd\u5b58\u7684\u4fee\u6539',
      discardConfirm: '放弃未保存的修改？',
      saveFailed: '\u4fdd\u5b58\u5931\u8d25\uff1a{message}',
      savedWithWarnings: '\u5df2\u4fdd\u5b58\uff0c\u4f46\u6709 {count} \u9879\u88ab\u8c03\u6574\uff1a{list}',
      overridesKept: '\u5355\u5de5\u5177\u8986\u76d6\u4fdd\u6301\u4e0d\u53d8\uff08{count} \u9879\uff09\u3002',
      unknownValue: '\u672a\u77e5',
    };

    /* ----------------------------------------------------------------- utils */

    /** The locale seat, filled in by `apply`; components fall back to it. */
    let boundT = null;

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function text(value, fallback) {
      return typeof value === 'string' ? value : fallback;
    }

    function intWithin(value, fallback, min, max) {
      /* A cleared number input reports '' and Number('') is 0, which would
       * silently clamp to the minimum; fall back to the documented default. */
      if (value === '' || value === null || value === undefined) return fallback;
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return fallback;
      const rounded = Math.round(n);
      if (rounded < min) return min;
      if (rounded > max) return max;
      return rounded;
    }

    function pick(value, allowed, fallback) {
      return allowed.indexOf(value) === -1 ? fallback : value;
    }

    /**
     * The shipped preset text, mirrored from the Host module.
     *
     * The Client needs it for the editor's "restore default" action and to show what is
     * actually being sent while the box is empty. It is duplicated rather than fetched so
     * the panel opens instantly; `test/presets.test.mjs` asserts the two copies agree.
     */
    const DEFAULT_PRESETS = {
      download: {
        zh: '下载卡住了：{{label}} 在 {{seconds}} 秒内没完成（已经跑了 {{elapsed}} 秒，已中止）。\n\n这条命令被终止了。原因多半是到这个源的网络不通，而不是命令本身写错。\n换一个源重试，不要用同一个源继续硬等：\n{{hints}}\n\n注意：被中止的下载会留下半成品（文件或目录），重试前先删掉它，或在新的空目录里重试。\n\n卡住的命令：{{command}}',
        en: 'Download stalled: {{label}} did not finish within {{seconds}}s (stopped after {{elapsed}}s).\n\nThe command was killed. The network path to this source is the likely cause, not the command itself.\nRetry against a different source before trying the same one again:\n{{hints}}\n\nNote: an aborted download leaves a partial file or directory; remove it before retrying, or retry in a fresh directory.\n\nCommand that stalled: {{command}}',
      },
      fetch: {
        zh: '抓取 {{target}} 超过 {{seconds}} 秒没响应，已改用搜索「{{query}}」继续找，拿到 {{sources}} 条结果。\n\n这个页面本身没有取到。如果必须看原文，重新抓取或调高该工具的阈值。',
        en: 'Fetching {{target}} did not respond within {{seconds}}s, so the guard searched for "{{query}}" instead and found {{sources}} results.\n\nThe page itself was not retrieved. Retry the fetch or raise its timeout if the original page is essential.',
      },
      search: {
        zh: '搜索「{{query}}」超过 {{seconds}} 秒没响应，已重试一次。\n\n如果仍然失败，换一个搜索词或稍后再试。',
        en: 'Searching for "{{query}}" did not respond within {{seconds}}s; one retry was attempted.\n\nIf it still fails, try different wording or wait a moment.',
      },
    };

    /** Placeholder names per scene, shown in the editor as insertable chips. */
    const PRESET_PLACEHOLDERS = {
      download: ['label', 'channel', 'target', 'host', 'command', 'seconds', 'elapsed', 'hints'],
      fetch: ['tool', 'target', 'query', 'seconds', 'elapsed', 'sources'],
      search: ['tool', 'query', 'seconds', 'elapsed'],
    };

    function defaultPresets() {
      const out = {};
      for (const scene of PRESET_SCENES) out[scene] = { zh: DEFAULT_PRESETS[scene].zh, en: DEFAULT_PRESETS[scene].en };
      return out;
    }

    function normalizePresets(raw) {
      const out = defaultPresets();
      if (!isObject(raw)) return out;
      for (const scene of PRESET_SCENES) {
        const value = raw[scene];
        if (!isObject(value)) continue;
        for (const locale of ['zh', 'en']) {
          const template = value[locale];
          if (typeof template !== 'string') continue;
          /* '' means "use the shipped text": storing it as-is lets the panel tell
           * "never set" apart from "set to the default wording". */
          out[scene][locale] = template.slice(0, PRESET_MAX_CHARS);
        }
      }
      return out;
    }

    function toSecondsText(value) {
      return String(value);
    }

    /** One `recent` entry, every field defaulted exactly per contract §3. */
    function normalizeRecent(raw) {
      const item = isObject(raw) ? raw : {};
      const ok = item.ok === true ? true : item.ok === false ? false : null;
      return {
        at: Number.isFinite(item.at) ? item.at : 0,
        tool: text(item.tool, ''),
        kind: pick(item.kind, KINDS, 'other'),
        elapsedMs: Number.isFinite(item.elapsedMs) ? item.elapsedMs : 0,
        timeoutMs: Number.isFinite(item.timeoutMs) ? item.timeoutMs : 0,
        action: item.action === 'switch' || item.action === 'notify' ? item.action : null,
        fallback: typeof item.fallback === 'string' ? item.fallback : null,
        ok,
      };
    }

    /** The `state.json` body, reduced to the shape the UI renders. */
    function normalizeState(raw) {
      const body = isObject(raw) ? raw : {};
      const sup = isObject(body.supervisor) ? body.supervisor : {};
      const stats = isObject(body.stats) ? body.stats : {};
      const recent = Array.isArray(body.recent) ? body.recent : [];
      return {
        revision: Number.isFinite(body.revision) ? body.revision : 0,
        now: Number.isFinite(body.now) ? body.now : 0,
        supervisor: {
          mode: pick(sup.mode, MODES, 'idle'),
          since: Number.isFinite(sup.since) ? sup.since : 0,
          level: Number.isFinite(sup.level) ? sup.level : 0,
          tool: typeof sup.tool === 'string' ? sup.tool : null,
          kind: typeof sup.kind === 'string' ? sup.kind : null,
          elapsedMs: Number.isFinite(sup.elapsedMs) ? sup.elapsedMs : 0,
          timeoutMs: Number.isFinite(sup.timeoutMs) ? sup.timeoutMs : 0,
          action: sup.action === 'switch' || sup.action === 'notify' ? sup.action : null,
          fallback: typeof sup.fallback === 'string' ? sup.fallback : null,
          fallbackOk: sup.fallbackOk === true ? true : sup.fallbackOk === false ? false : null,
          message: text(sup.message, ''),
          source: pick(sup.source, ['none', 'model', 'canned'], 'none'),
        },
        stats: {
          stalls: Number.isFinite(stats.stalls) ? stats.stalls : 0,
          switches: Number.isFinite(stats.switches) ? stats.switches : 0,
          notices: Number.isFinite(stats.notices) ? stats.notices : 0,
          since: Number.isFinite(stats.since) ? stats.since : 0,
        },
        recent: recent.slice(0, 10).map(normalizeRecent),
      };
    }

    /** The `config.json` body, clamped to the documented ranges. */
    function normalizeConfig(raw) {
      const body = isObject(raw) ? raw : {};
      const timers = isObject(body.timers) ? body.timers : {};
      const sup = isObject(body.supervisor) ? body.supervisor : {};
      const overrides = {};
      if (isObject(body.overrides)) {
        for (const name of Object.keys(body.overrides)) {
          overrides[name] = intWithin(body.overrides[name], DEFAULT_TIMERS.other, 1, 3600);
        }
      }
      const outTimers = {};
      for (const kind of KINDS) {
        outTimers[kind] = intWithin(timers[kind], DEFAULT_TIMERS[kind], 1, 3600);
      }
      return {
        version: 1,
        enabled: body.enabled !== false,
        timers: outTimers,
        overrides,
        autoSwitch: body.autoSwitch !== false,
        watchDownloads: body.watchDownloads !== false,
        downloadSeconds: intWithin(body.downloadSeconds, 30, 1, 3600),
        scenes: normalizeScenes(body.scenes),
        presets: normalizePresets(body.presets),
        supervisor: {
          show: sup.show !== false,
          display: pick(sup.display, DISPLAYS, 'avatar'),
        },
      };
    }

    /**
     * Compact duration for the recent list. Sub-second keeps ms; under a minute
     * keeps one decimal so an elapsed 15.3s is visibly past a 15s budget; above
     * that rounds to whole seconds or minutes.
     */
    function formatDuration(ms) {
      const value = Number.isFinite(ms) ? ms : 0;
      if (value < 1000) return Math.round(value) + 'ms';
      const seconds = value / 1000;
      if (seconds < 60) {
        const text = seconds.toFixed(1);
        return (text.endsWith('.0') ? text.slice(0, -2) : text) + 's';
      }
      if (seconds < 3600) return Math.round(seconds) + 's';
      return (Math.round(seconds / 60) / 10).toFixed(1) + 'm';
    }

    function formatClock(at) {
      if (!Number.isFinite(at) || at <= 0) return '\u2014';
      try {
        return new Date(at).toLocaleTimeString();
      } catch (error) {
        return '\u2014';
      }
    }

    /**
     * One same-origin JSON request with a hard timeout. Without it a route that
     * hangs (Host half half-loaded, proxy waiting) would leave `stateBusy` true
     * forever and every later tick would silently do nothing.
     */
    async function requestJson(url, options, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init = Object.assign({ cache: 'no-store', redirect: 'error' }, options);
        if (controller !== null) init.signal = controller.signal;
        const response = await fetch(url, init);
        let body = null;
        try {
          body = await response.json();
        } catch (error) {
          body = null;
        }
        if (!response.ok) {
          const detail = isObject(body) && typeof body.error === 'string'
            ? body.error
            : 'HTTP ' + response.status;
          return { ok: false, status: response.status, body, error: detail };
        }
        return { ok: true, status: response.status, body };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          body: null,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (timer !== null) window.clearTimeout(timer);
      }
    }

    /* ------------------------------------------------------------ shared store */

    /**
     * One store for both seats. It owns the polling loop (1000ms, 3000ms while
     * the document is hidden), the cached config (refreshed at most every 30s)
     * and the open/closed flag of the overlay panel.
     */
    const store = (function createStore() {
      let snapshot = {
        state: null,
        config: null,
        open: false,
        /** True while the panel holds edits that have not been saved. */
        dirty: false,
        /** True while the panel is asking whether to discard those edits. */
        confirming: false,
        degraded: false,
      };
      const listeners = new Set();
      /** Appearance subscribers are kept apart from the polled-snapshot subscribers. */
      const appearanceListeners = new Set();
      let appearance = readAppearance();
      let refs = 0;
      let timer = null;
      let stateBusy = false;
      let configBusy = false;
      let configAt = 0;
      let configNextAt = 0;
      let warned = false;

      function emit(next) {
        snapshot = next;
        for (const listener of Array.from(listeners)) listener();
      }

      function patch(partial) {
        emit(Object.assign({}, snapshot, partial));
      }

      function warnOnce(error) {
        if (warned) return;
        warned = true;
        try {
          console.warn('[dsh-stall-guard] state/config request failed; retrying quietly:', error);
        } catch (ignored) {
          /* console unavailable */
        }
      }

      async function pullState() {
        if (stateBusy) return;
        stateBusy = true;
        try {
          const result = await requestJson(STATE_URL, {}, REQUEST_TIMEOUT_MS);
          if (result.ok !== true) throw new Error(result.error);
          if (!isObject(result.body) || result.body.ok !== true) throw new Error('unexpected payload');
          const nextState = normalizeState(result.body);
          emit(Object.assign({}, snapshot, { state: nextState, degraded: false }));
        } catch (error) {
          /* Silent retry: keep whatever the UI is already showing. */
          warnOnce(error);
          if (snapshot.degraded !== true) patch({ degraded: true });
        } finally {
          stateBusy = false;
        }
      }

      async function pullConfig() {
        if (configBusy) return;
        configBusy = true;
        const startedAt = Date.now();
        try {
          const result = await requestJson(CONFIG_URL, {}, REQUEST_TIMEOUT_MS);
          if (result.ok !== true) throw new Error(result.error);
          if (!isObject(result.body) || result.body.ok !== true || !isObject(result.body.config)) {
            throw new Error('unexpected payload');
          }
          configAt = startedAt;
          configNextAt = 0;
          patch({ config: normalizeConfig(result.body.config) });
        } catch (error) {
          /* Back off to the same 30s cadence instead of hammering once a second. */
          warnOnce(error);
          configNextAt = startedAt + CONFIG_TTL_MS;
        } finally {
          configBusy = false;
        }
      }

      function maybePullConfig() {
        const now = Date.now();
        if (configNextAt !== 0 && now < configNextAt) return;
        if (snapshot.config !== null && now - configAt < CONFIG_TTL_MS) return;
        pullConfig();
      }

      function tick() {
        pullState();
        maybePullConfig();
      }

      function schedule() {
        if (timer !== null) window.clearInterval(timer);
        const hidden = typeof document !== 'undefined' && document.hidden === true;
        timer = window.setInterval(tick, hidden ? TICK_HIDDEN_MS : TICK_MS);
      }

      function onVisibility() {
        if (refs > 0) schedule();
      }

      async function acknowledge() {
        const result = await requestJson(ACK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }, REQUEST_TIMEOUT_MS);
        if (result.ok !== true) return { ok: false, error: result.error };
        if (!isObject(result.body) || result.body.ok !== true) {
          const detail = isObject(result.body) && typeof result.body.error === 'string'
            ? result.body.error
            : 'unexpected payload';
          return { ok: false, error: detail };
        }
        /* The route answers with the post-ack snapshot; adopt it immediately so the
         * figure settles on the same press instead of one poll later. Fall back to a
         * normal poll when the Host omits it. */
        if (isObject(result.body.state)) {
          emit(Object.assign({}, snapshot, { state: normalizeState(result.body.state), degraded: false }));
        } else {
          await pullState();
        }
        return { ok: true };
      }

      async function saveConfig(payload) {
        const result = await requestJson(CONFIG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }, SAVE_TIMEOUT_MS);
        if (result.ok !== true) return { ok: false, error: result.error };
        if (!isObject(result.body) || result.body.ok !== true) {
          const detail = isObject(result.body) && typeof result.body.error === 'string'
            ? result.body.error
            : 'unexpected payload';
          return { ok: false, error: detail };
        }
        const saved = normalizeConfig(result.body.config);
        const warnings = Array.isArray(result.body.warnings)
          ? result.body.warnings.filter((item) => typeof item === 'string')
          : [];
        configAt = Date.now();
        configNextAt = 0;
        patch({ config: saved });
        return { ok: true, config: saved, warnings };
      }

      return {
        getSnapshot() {
          return snapshot;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        /**
         * Ref-counted: registering the plugin and mounting either seat all call
         * this, so the poll survives a header unmount without ever running two
         * intervals. Returns an idempotent disposer for `ctx.effect`/`useEffect`.
         */
        start() {
          refs += 1;
          if (refs === 1) {
            schedule();
            document.addEventListener('visibilitychange', onVisibility);
            tick();
          }
          let done = false;
          return () => {
            if (done) return;
            done = true;
            refs -= 1;
            if (refs > 0) return;
            refs = 0;
            if (timer !== null) {
              window.clearInterval(timer);
              timer = null;
            }
            document.removeEventListener('visibilitychange', onVisibility);
          };
        },
        /**
         * The supervisor figure is the panel's only opener, and pressing it
         * again closes the panel. Contract §3 also says the Client acks when
         * the user clicks the figure, so opening it always POSTs ack; the Host
         * keeps `recent`/`stats`, and an ack with nothing pending is a no-op.
         */
        activate() {
          if (snapshot.open === true) {
            patch({ open: false });
            return;
          }
          patch({ open: true });
          acknowledge();
        },
        /**
         * Every close path funnels here: the header button, Escape, and clicking outside.
         * `closePanel` refuses while edits are pending so a stray click cannot discard
         * them; `forceClose` is the explicit "yes, discard" branch.
         */
        closePanel() {
          if (snapshot.open !== true) return false;
          if (snapshot.dirty === true) {
            patch({ confirming: true });
            return false;
          }
          patch({ open: false });
          return true;
        },
        forceClose() {
          if (snapshot.open !== true) return;
          patch({ open: false, dirty: false, confirming: false });
        },
        cancelClose() {
          if (snapshot.confirming !== true) return;
          patch({ confirming: false });
        },
        setDirty(next) {
          if (snapshot.dirty === next) return;
          patch({ dirty: next });
        },
        /**
         * Appearance is separate from the polled snapshot: it lives in `localStorage`
         * and only the supervisor uses it, so broadcasting it through the polling
         * snapshot would re-render the panel on every drag frame.
         */
        subscribeAppearance(listener) {
          appearanceListeners.add(listener);
          listener(appearance);
          return () => {
            appearanceListeners.delete(listener);
          };
        },
        getAppearance() {
          return appearance;
        },
        setAppearance(next) {
          appearance = { ...APPEARANCE_DEFAULTS, ...next };
          writeAppearance(appearance);
          for (const listener of appearanceListeners) {
            try {
              listener(appearance);
            } catch {
              /* a seat that unmounted mid-drag must not break the drag */
            }
          }
        },
        acknowledge,
        saveConfig,
      };
    })();

    function useStore() {
      return useSyncExternalStore(store.subscribe, store.getSnapshot);
    }

    /* ------------------------------------------------------------ draft mapping */

    function draftFrom(config) {
      const source = config === null ? DEFAULT_CONFIG : config;
      const timers = {};
      for (const kind of KINDS) timers[kind] = toSecondsText(source.timers[kind]);
      return {
        enabled: source.enabled !== false,
        autoSwitch: source.autoSwitch !== false,
        watchDownloads: source.watchDownloads !== false,
        downloadSeconds: toSecondsText(source.downloadSeconds),
        scenes: {
          download: { ...source.scenes.download, seconds: toSecondsText(source.scenes.download.seconds) },
          fetch: { ...source.scenes.fetch, seconds: toSecondsText(source.scenes.fetch.seconds) },
          search: { ...source.scenes.search, seconds: toSecondsText(source.scenes.search.seconds) },
        },
        timers,
        overrides: Object.assign({}, source.overrides),
        presets: {
          download: { zh: source.presets.download.zh, en: source.presets.download.en },
          fetch: { zh: source.presets.fetch.zh, en: source.presets.fetch.en },
          search: { zh: source.presets.search.zh, en: source.presets.search.en },
        },
        supervisor: {
          show: source.supervisor.show !== false,
          display: source.supervisor.display,
        },
      };
    }

    /** The complete config object the panel POSTs (contract §3 shape). */
    function payloadFrom(draft) {
      const timers = {};
      for (const kind of KINDS) {
        timers[kind] = intWithin(draft.timers[kind], DEFAULT_TIMERS[kind], 1, 3600);
      }
      const overrides = {};
      if (isObject(draft.overrides)) {
        for (const name of Object.keys(draft.overrides)) {
          overrides[name] = intWithin(draft.overrides[name], DEFAULT_TIMERS.other, 1, 3600);
        }
      }
      return {
        version: 1,
        enabled: draft.enabled === true,
        timers,
        overrides,
        autoSwitch: draft.autoSwitch === true,
        // Missing these two used to mean the panel silently reset them on every save.
        watchDownloads: draft.watchDownloads === true,
        downloadSeconds: intWithin(draft.downloadSeconds, 30, 1, 3600),
        scenes: {
          download: {
            enabled: draft.scenes.download.enabled === true,
            seconds: intWithin(draft.scenes.download.seconds, 30, 1, 3600),
          },
          fetch: {
            enabled: draft.scenes.fetch.enabled === true,
            seconds: intWithin(draft.scenes.fetch.seconds, 15, 1, 3600),
          },
          search: {
            enabled: draft.scenes.search.enabled === true,
            seconds: intWithin(draft.scenes.search.seconds, 15, 1, 3600),
          },
        },
        presets: {
          download: { zh: text(draft.presets.download.zh, ''), en: text(draft.presets.download.en, '') },
          fetch: { zh: text(draft.presets.fetch.zh, ''), en: text(draft.presets.fetch.en, '') },
          search: { zh: text(draft.presets.search.zh, ''), en: text(draft.presets.search.en, '') },
        },
        supervisor: {
          show: draft.supervisor.show !== false,
          display: pick(draft.supervisor.display, DISPLAYS, 'avatar'),
        },
      };
    }

    /* ---------------------------------------------------------------- styling */

    /**
     * Host theme tokens with a hard fallback on every `var()`. `--dsw-alias-*`
     * are the tokens this DSH build actually publishes (verified in the app
     * bundle); the `--dsh-*` names are accepted as a secondary source and only
     * the final literal is dark-ish, so the light theme still reads correctly.
     */
    const CSS = [
      /* ---- supervisor seat ---- */
      '.dsg-seat{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;pointer-events:auto}',
      '.dsg-orb{box-sizing:border-box;display:inline-flex;position:relative;align-items:center;justify-content:center;margin:0;padding:0;border:none;background:transparent;font-family:inherit;cursor:pointer;overflow:visible;border-radius:var(--dsw-radius-sm,6px);pointer-events:auto}',
      '.dsg-orb:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}',
      '.dsg-orb[data-display="dot"]{width:22px;height:22px}',
      '.dsg-orb[data-display="icon"]{width:24px;height:24px}',
      '.dsg-orb[data-display="avatar"]{width:34px;height:34px}',
      '.dsg-dot{display:block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);opacity:1}',
      '.dsg-orb[data-mode="idle"] .dsg-dot{background:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98));opacity:.35;animation:none}',
      '.dsg-orb[data-mode="watching"] .dsg-dot{animation:dsg-breathe 2.4s ease-in-out infinite}',
      '.dsg-orb[data-mode="alert"] .dsg-dot{background:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313));animation:dsg-pulse 1.3s ease-out infinite}',
      '.dsg-glyph{display:block;color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsg-orb[data-mode="idle"] .dsg-glyph{opacity:.6}',
      '.dsg-orb[data-mode="alert"] .dsg-glyph{color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313));animation:dsg-bounce .9s ease-in-out infinite,dsg-glow 1.5s ease-in-out infinite}',
      '.dsg-avatar{display:block;transform-origin:50% 88%}',
      '.dsg-orb[data-mode="idle"] .dsg-avatar{opacity:.72;animation:none}',
      '.dsg-orb[data-mode="watching"] .dsg-avatar{animation:dsg-sway 3.2s ease-in-out infinite}',
      '.dsg-orb[data-mode="alert"] .dsg-avatar{animation:dsg-bounce-big .85s ease-in-out infinite}',
      '.dsg-bubble{position:absolute;right:0;bottom:calc(100% + 7px);z-index:5;box-sizing:border-box;max-width:230px;min-width:64px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.12)));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-overlay,var(--dsh-surface,rgba(20,22,28,.96)));box-shadow:var(--dsw-elevation-soft,0 4px 18px rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font-size:11px;line-height:15px;text-align:left;white-space:normal;word-break:break-word;pointer-events:none;animation:dsg-bubble-in .16s ease-out both}',
      /* The header sits at the very top of the frame, so a bubble above the head
       * would be clipped by the viewport; the seat measures once and flips it
       * below when there is no room. */
      '.dsg-bubble[data-place="below"]{bottom:auto;top:calc(100% + 7px)}',
      /* ---- overlay panel ---- */
      '.dsg-panel{position:fixed;top:56px;right:14px;left:auto;z-index:70;box-sizing:border-box;width:min(430px,calc(100vw - 40px));max-height:min(74vh,660px);overflow:hidden;pointer-events:auto;display:flex;flex-direction:column;gap:0;padding:12px;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.12)));border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-overlay,var(--dsh-surface,rgba(20,22,28,.96)));box-shadow:var(--dsw-elevation-soft,0 8px 28px rgba(0,0,0,.22));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font:inherit;font-size:12px;line-height:18px}',
      '.dsg-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;padding-bottom:8px}',
      /* The title bar holds Save and Close now, so the title must not push them out. */
      '.dsg-title{flex:0 1 auto;min-width:0;margin:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsg-badge{display:inline-flex;flex:none;align-items:center;gap:5px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.12)));border-radius:999px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7))}',
      '.dsg-badge[data-mode="watching"]{color:var(--dsw-alias-state-warn-primary,#f0a020);border-color:var(--dsw-alias-state-warn-primary,#f0a020)}',
      '.dsg-badge[data-mode="alert"]{color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313));border-color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.dsg-spacer{flex:1;min-width:0}',
      '.dsg-btn{box-sizing:border-box;flex:none;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.12)));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,var(--dsh-surface-alt,rgba(255,255,255,.06)));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font-family:inherit;font-size:11px;line-height:16px;padding:3px 9px;cursor:pointer}',
      '.dsg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsh-surface-alt,rgba(255,255,255,.1)))}',
      '.dsg-btn:disabled{opacity:.45;cursor:default}',
      '.dsg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}',
      '.dsg-btn-primary{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      /* The status box is neutral most of the time: a red frame around "watching" reads
       * as a fault and makes the real alert state meaningless by comparison. */
      '.dsg-alert{display:flex;align-items:flex-start;gap:8px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.14)));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--dsh-surface-alt,rgba(255,255,255,.05)))}',
      '.dsg-alert[data-mode="alert"]{border-color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.dsg-alert[data-mode="watching"]{border-color:var(--dsw-alias-brand-primary,var(--dsh-accent,#4d6bfe))}',
      '.dsg-alert-text{flex:1;min-width:0;margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));word-break:break-word}',
      '.dsg-alert-meta{display:block;margin-top:2px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98))}',
      '.dsg-section{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.12)))}',
      '.dsg-section:first-of-type{border-top:none;padding-top:0}',
      '.dsg-section-title{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.dsg-hint{margin:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98))}',
      '.dsg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}',
      '.dsg-field{display:flex;align-items:center;gap:6px;min-width:0}',
      /* A CJK label is wide; without this the number field collapses to one digit. */
      '.dsg-field>.dsg-label{flex:0 1 auto;min-width:0;overflow-wrap:anywhere}',
      '.dsg-field>.dsg-input{flex:1 1 64px;min-width:64px}',
      '.dsg-scene{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.12)));border-radius:var(--dsw-radius-sm,8px)}',
      '.dsg-scene[data-off="yes"]{opacity:.6}',
      '.dsg-scene-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dsg-textarea{box-sizing:border-box;width:100%;min-height:96px;resize:vertical;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.12)));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base,var(--dsh-input-bg,transparent));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font-family:inherit;font-size:12px;line-height:17px;white-space:pre-wrap}',
      '.dsg-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsg-textarea::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#7c8394));opacity:.7}',
      '.dsg-chips{display:flex;flex-wrap:wrap;align-items:center;gap:4px}',
      '.dsg-chipBtn{cursor:pointer;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.14)));background:transparent;color:inherit;font-family:inherit;font-size:11px;padding:1px 6px;border-radius:999px}',
      '.dsg-chipBtn:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsg-btnSm{font-size:11px;padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.14)));background:transparent;color:inherit;font-family:inherit;cursor:pointer}',
      '.dsg-btnSm:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsg-label{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7))}',
      '.dsg-input{box-sizing:border-box;flex:1;min-width:0;width:100%;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.12)));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base,var(--dsh-input-bg,transparent));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));font-family:inherit;font-size:12px;line-height:18px}',
      '.dsg-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsg-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#7c8394));opacity:1}',
      /* The screenshot showed "8000" clipped to "8": number fields need room for 5-6
       * digits, so they get a fixed floor rather than sharing the flexible input rule. */
      '.dsg-field>input[type="number"]{flex:1 1 74px;min-width:74px;text-align:right}',
      '.dsg-check{display:flex;align-items:center;gap:7px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6));cursor:pointer}',
      '.dsg-check input{flex:none;margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsg-choices{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsg-choice{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,var(--dsh-border,rgba(255,255,255,.12)));border-radius:var(--dsw-radius-sm,6px);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7));cursor:pointer}',
      '.dsg-choice[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.dsg-choice input{margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsg-stats{display:flex;flex-wrap:wrap;gap:10px}',
      '.dsg-stat{display:inline-flex;align-items:baseline;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98))}',
      '.dsg-stat b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.dsg-recent{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}',
      '.dsg-item{display:flex;flex-direction:column;gap:1px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.12)));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,var(--dsh-surface-alt,rgba(255,255,255,.04)))}',
      '.dsg-item-top{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary,var(--dsh-text-primary,#e6e6e6))}',
      '.dsg-item-bottom{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8a8f98))}',
      '.dsg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.dsg-chip{display:inline-flex;align-items:center;padding:0 5px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-2,var(--dsh-surface-alt,rgba(255,255,255,.07)));font-size:10px;line-height:15px}',
      '.dsg-ok{color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dsg-bad{color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.dsg-status{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,#b6bcc7))}',
      '.dsg-status[data-kind="err"]{color:var(--dsw-alias-state-error-primary,var(--dsh-danger,#ec1313))}',
      '.dsg-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;padding-right:2px}',
      /* The action bar is pinned: Save used to sit at the very bottom of a long scroll, so
       * a user who changed the timeout table had to hunt for it. */
      '.dsg-foot{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.12)))}',
      '.dsg-foot-wrap{flex:0 0 auto;display:flex;flex-direction:column;gap:4px}',
      '.dsg-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;margin-bottom:6px;border:1px solid var(--dsw-alias-state-warning-primary,var(--dsh-warn,#d89614));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--dsh-surface-alt,rgba(255,255,255,.05)));font-size:12px}',
      /* The overlay layer is click-through; this wrapper must not create a box
       * of its own or it would swallow presses meant for the app underneath. */
      /* ---- appearance controls ---- */
      '.dsg-row{display:flex;align-items:center;gap:8px}',
      '.dsg-shrink{flex:0 0 auto;min-width:56px}',
      '.dsg-range{flex:1 1 auto;min-width:80px;height:16px;accent-color:var(--dsw-alias-brand-primary,var(--dsh-accent,#4d6bfe));cursor:pointer}',
      /* The hidden state keeps a 10px tab: a control that can be hidden with no way
       * back is a trap, so this stays clickable and expands on hover. */
      '.dsg-orb[data-off="yes"]{border-radius:50%;background:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8b93a7));display:flex;align-items:center;justify-content:center;transition:opacity .15s ease,background-color .15s ease}',
      '.dsg-orb[data-off="yes"]:hover,.dsg-orb[data-off="yes"]:focus-visible{opacity:1!important;background:var(--dsw-alias-brand-primary,var(--dsh-accent,#4d6bfe))}',
      '.dsg-offTab{display:block;width:100%;height:100%;border-radius:50%}',
      '.dsg-orb[data-floating="yes"]{box-shadow:0 2px 10px rgba(0,0,0,.28);background:var(--dsw-alias-bg-overlay,var(--dsh-surface,rgba(20,22,28,.9)));border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.12)))}',
      '.dsg-orb[data-dragging="yes"]{transition:none!important;cursor:grabbing}',
      '.dsg-seat[data-floating="yes"]{position:fixed}',
      /* Only visible while the supervisor is hidden: a 14px grab handle in the corner. */
      '.dsg-restoreTab{position:fixed;right:10px;bottom:10px;z-index:67;width:14px;height:14px;padding:0;border:1px solid var(--dsw-alias-border-l1,var(--dsh-border,rgba(255,255,255,.2)));border-radius:50%;background:var(--dsw-alias-label-tertiary,var(--dsh-text-muted,#8b93a7));opacity:.4;cursor:pointer;transition:opacity .15s ease,transform .15s ease}',
      '.dsg-restoreTab:hover,.dsg-restoreTab:focus-visible{opacity:1;transform:scale(1.35);background:var(--dsw-alias-brand-primary,var(--dsh-accent,#4d6bfe))}',
      '.dsg-overlay-root{display:contents}',
      /* ---- keyframes: declaration only, no timer drives a frame ---- */
      '@keyframes dsg-breathe{0%,100%{opacity:.4}50%{opacity:1}}',
      '@keyframes dsg-pulse{0%{box-shadow:0 0 0 0 var(--dsw-alias-state-error-primary,rgba(236,19,19,.55));opacity:1}70%{box-shadow:0 0 0 6px rgba(236,19,19,0);opacity:.85}100%{box-shadow:0 0 0 0 rgba(236,19,19,0);opacity:1}}',
      '@keyframes dsg-bounce{0%,100%{transform:translateY(0)}25%{transform:translateY(-4px)}50%{transform:translateY(0)}75%{transform:translateY(-2px)}}',
      '@keyframes dsg-glow{0%,100%{filter:drop-shadow(0 0 0 rgba(236,19,19,0))}50%{filter:drop-shadow(0 0 5px rgba(236,19,19,.85))}}',
      '@keyframes dsg-sway{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}',
      '@keyframes dsg-bounce-big{0%,100%{transform:translateY(0) scale(1)}30%{transform:translateY(-8px) scale(1.06)}60%{transform:translateY(0) scale(1)}80%{transform:translateY(-3px) scale(1)}}',
      '@keyframes dsg-bubble-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}',
      '@media (prefers-reduced-motion:reduce){.dsg-orb[data-mode] .dsg-dot,.dsg-orb[data-mode] .dsg-glyph,.dsg-orb[data-mode] .dsg-avatar,.dsg-bubble{animation:none}}',
    ].join('\n');

    /* ------------------------------------------------------------- glyphs */

    const BLUE = '#4d6bfe';
    const BLUE_DARK = '#2b46d6';
    const BLUE_LIGHT = '#7f97ff';
    const INK = '#0b1740';

    /** 18px guard shield with a clock face; inherits `color` for alert tinting. */
    function ShieldGlyph(props) {
      const size = props.size || 18;
      return h('svg', {
        className: 'dsg-glyph',
        width: size,
        height: size,
        viewBox: '0 0 18 18',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: 'M9 1.4 15.4 3.6v5c0 4.1-2.7 7.1-6.4 8.4-3.7-1.3-6.4-4.3-6.4-8.4v-5L9 1.4z',
          fill: 'currentColor',
        }),
        h('circle', {
          cx: 9,
          cy: 8.2,
          r: 3.2,
          fill: 'none',
          stroke: 'var(--dsw-alias-bg-overlay, rgba(0,0,0,.35))',
          strokeWidth: 1.3,
        }),
        h('path', {
          d: 'M9 6.2v2.1l1.5 1',
          fill: 'none',
          stroke: 'var(--dsw-alias-bg-overlay, rgba(0,0,0,.35))',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * 28px original DeepSeek-blue whale. Eyes are closed with a line while the
     * supervisor is idle and open dots otherwise; nothing external is loaded.
     */
    function WhaleGlyph(props) {
      const size = props.size || 28;
      const asleep = props.mode === 'idle';
      const alert = props.mode === 'alert';
      const body = alert ? '#e5484d' : BLUE;
      const fin = alert ? '#b3212a' : BLUE_DARK;
      return h('svg', {
        className: 'dsg-avatar',
        width: size,
        height: size,
        viewBox: '0 0 28 28',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        /* tail fluke */
        h('path', {
          d: 'M19.6 12.4c2.9-3.4 5.1-3.1 5.1.5 0 3.3-2.4 3.7-5.1.6z',
          fill: fin,
        }),
        /* top fin */
        h('path', {
          d: 'M11.8 6.4c2.3-2.5 4.4-2.5 4.8 1.1-2.1 1-3.9.6-4.8-1.1z',
          fill: BLUE_LIGHT,
        }),
        /* plump body */
        h('ellipse', {
          cx: 13,
          cy: 15,
          rx: 10.4,
          ry: 8.4,
          fill: body,
        }),
        /* belly highlight */
        h('ellipse', {
          cx: 13.4,
          cy: 18.6,
          rx: 6.6,
          ry: 4.2,
          fill: '#ffffff',
          fillOpacity: 0.16,
        }),
        asleep
          ? h('path', {
            d: 'M7.4 13.6h3.2',
            fill: 'none',
            stroke: INK,
            strokeWidth: 1.5,
            strokeLinecap: 'round',
          })
          : h('circle', { cx: 9, cy: 13.6, r: 1.55, fill: INK }),
        asleep
          ? null
          : h('circle', { cx: 9.4, cy: 13.1, r: 0.5, fill: '#ffffff', fillOpacity: 0.85 }),
        /* mouth */
        h('path', {
          d: asleep ? 'M9.6 18.4c2 0 3.6 0 4.4 0' : 'M9.6 18.2c1.9 1.3 4.6 1.3 6.4-.2',
          fill: 'none',
          stroke: '#ffffff',
          strokeOpacity: asleep ? 0.5 : 0.8,
          strokeWidth: 1.1,
          strokeLinecap: 'round',
        }),
      );
    }

    /* ------------------------------------------------------- the supervisor */

    const MODE_KEY = { idle: 'modeIdle', watching: 'modeWatching', alert: 'modeAlert' };
    const SOURCE_KEY = { none: 'sourceNone', model: 'sourceModel', canned: 'sourceCanned' };

    /**
     * The active UI locale, normalised to the two languages the presets ship in.
     *
     * `boundT` exists only once `apply` ran, so this reads the document language as a
     * fallback; a wrong guess here only picks which half of the preset the editor opens
     * on, never which text is sent.
     */
    function hostLocale() {
      try {
        const tag = String(document.documentElement.lang || navigator.language || 'zh').toLowerCase();
        return tag.startsWith('en') ? 'en' : 'zh';
      } catch {
        return 'zh';
      }
    }

    function useTranslate(props) {
      return props.t !== undefined && typeof props.t === 'function' ? props.t : (boundT || ((key) => key));
    }

    /**
     * The supervisor control.
     *
     * Two deliberate behaviours:
     *  - When the user turns the supervisor off (`show: false`), the control collapses to
     *    a nearly invisible 10px tab in its corner instead of vanishing. A control that
     *    can be hidden with no way back is a trap; the tab is the way back, and it
     *    expands on hover.
     *  - Appearance (size/opacity/place) is local, so it applies without touching the
     *    Host config and survives a reload.
     */
    function SupervisorSeat(props) {
      const t = useTranslate(props);
      const snapshot = useStore();
      const orbRef = useRef(null);
      const [bubbleBelow, setBubbleBelow] = useState(false);
      const [appearance, setAppearance] = useState(readAppearance);
      const [dragging, setDragging] = useState(false);

      useEffect(() => store.start(), []);
      useEffect(() => store.subscribeAppearance(setAppearance), []);

      const config = snapshot.config;
      const supervisorOff = config !== null && config.supervisor.show === false;
      const mode = snapshot.state === null ? 'idle' : snapshot.state.supervisor.mode;
      const display = config === null ? 'avatar' : config.supervisor.display;
      const message = snapshot.state === null ? '' : snapshot.state.supervisor.message;
      const showBubble = !supervisorOff && display === 'avatar' && mode === 'alert' && message !== '';

      /* The seat can live in the top bar or float anywhere; a bubble above the head
       * would be cut off by the viewport when it sits near the top, so measure once
       * per alert and flip it below. No animation frame loop. */
      useLayoutEffect(() => {
        if (!showBubble) {
          setBubbleBelow(false);
          return;
        }
        const node = orbRef.current;
        if (node === null || typeof node.getBoundingClientRect !== 'function') return;
        const rect = node.getBoundingClientRect();
        setBubbleBelow(rect.top < 96);
      }, [showBubble]);

      /* Float placement: drag moves the control, and the position is clamped into the
       * viewport on release so a window resize cannot strand it off-screen. */
      const floating = appearance.place === 'float';
      const startDrag = useCallback((event) => {
        if (!floating) return;
        if (event.button !== undefined && event.button !== 0) return;
        const node = orbRef.current;
        if (node === null) return;
        const rect = node.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        let moved = false;

        const onMove = (moveEvent) => {
          moved = true;
          setDragging(true);
          const nextX = Math.max(0, Math.min(window.innerWidth - rect.width, moveEvent.clientX - offsetX));
          const nextY = Math.max(0, Math.min(window.innerHeight - rect.height, moveEvent.clientY - offsetY));
          store.setAppearance({ ...readAppearance(), x: Math.round(nextX), y: Math.round(nextY) });
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          setDragging(false);
          if (!moved) store.activate();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        event.preventDefault();
      }, [floating]);

      // Hidden: the header renders nothing. A restore tab is drawn by the overlay seat
      // instead, because the header does not exist in a blank session and the user would
      // otherwise have no way back in.
      if (supervisorOff) return null;

      const label = t('supervisor') + ' — ' + t(MODE_KEY[mode]);
      const size = appearance.size;
      const style = floating
        ? {
          position: 'fixed',
          left: appearance.x < 0 ? 'auto' : appearance.x + 'px',
          top: appearance.y < 0 ? 'auto' : appearance.y + 'px',
          right: appearance.x < 0 ? '14px' : 'auto',
          bottom: appearance.y < 0 ? '96px' : 'auto',
          zIndex: 68,
        }
        : undefined;

      return h('div', { className: 'dsg-seat', 'data-floating': floating ? 'yes' : 'no', style },
        h('style', { 'data-stall-guard': 'styles' }, CSS),
        h('button', {
          ref: orbRef,
          type: 'button',
          className: 'dsg-orb',
          'data-display': display,
          'data-mode': mode,
          'data-dragging': dragging ? 'yes' : 'no',
          'data-floating': floating ? 'yes' : 'no',
          style: {
            width: size + 'px',
            height: size + 'px',
            opacity: appearance.opacity,
            cursor: floating ? (dragging ? 'grabbing' : 'grab') : 'pointer',
          },
          title: label,
          'aria-label': t('openPanel'),
          'aria-haspopup': 'dialog',
          onPointerDown: floating ? startDrag : undefined,
          onClick: floating ? undefined : () => store.activate(),
        },
          display === 'dot' ? h('span', { className: 'dsg-dot' }) : null,
          display === 'icon' ? h(ShieldGlyph, { size: Math.round(size * 0.64) }) : null,
          display === 'avatar' ? h(WhaleGlyph, { size: Math.round(size * 0.82), mode }) : null,
          showBubble
            ? h('span', {
              className: 'dsg-bubble',
              'data-place': bubbleBelow ? 'below' : 'above',
              role: 'status',
            }, message)
            : null,
        ),
      );
    }

    /* ------------------------------------------------------------ the panel */

    function StatValue(props) {
      return h('span', { className: 'dsg-stat' }, h('b', null, String(props.value)), props.label);
    }

    function RecentItem(props) {
      const entry = props.entry;
      const t = props.t;
      const actionKey = entry.action === 'switch' ? 'actionSwitch' : entry.action === 'notify' ? 'actionNotify' : 'actionNone';
      const okLabel = entry.ok === true ? t('okTrue') : entry.ok === false ? t('okFalse') : t('okNull');
      const okClass = entry.ok === true ? 'dsg-ok' : entry.ok === false ? 'dsg-bad' : '';
      return h('li', { className: 'dsg-item' },
        h('div', { className: 'dsg-item-top' },
          h('span', { className: 'dsg-mono' }, formatClock(entry.at)),
          h('span', null, entry.tool === '' ? t('unknownValue') : entry.tool),
          h('span', { className: 'dsg-chip' }, t('kind' + entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1))),
          h('span', { className: 'dsg-spacer' }),
          h('span', { className: okClass }, okLabel),
        ),
        h('div', { className: 'dsg-item-bottom' },
          h('span', null, formatDuration(entry.elapsedMs) + ' / ' + formatDuration(entry.timeoutMs)),
          h('span', null, t(actionKey)),
          h('span', null, (entry.fallback === null ? t('fallbackNone') : entry.fallback)),
        ),
      );
    }

    function Panel(props) {
      const t = props.t;
      const snapshot = useStore();
      const config = snapshot.config;

      const [draft, setDraft] = useState(() => draftFrom(snapshot.config));
      /* Which preset is being edited. The locale half follows the Host locale so the
       * editor opens on the text that is actually in use; a user can only edit one
       * language at a time, which keeps the panel short. */
      const [presetScene, setPresetScene] = useState('download');
      const presetLocale = hostLocale() === 'en' ? 'en' : 'zh';
      /* Appearance is browser-local, so the panel mirrors it separately from the
       * Host draft; saving the config must not overwrite it and vice versa. */
      const [localAppearance, setLocalAppearance] = useState(() => store.getAppearance());
      useEffect(() => store.subscribeAppearance(setLocalAppearance), []);
      const [dirty, setDirty] = useState(false);
      const [status, setStatus] = useState({ kind: 'idle', text: '' });

      const [ackBusy, setAckBusy] = useState(false);
      const ackTimer = useRef(null);
      const dirtyRef = useRef(false);

      /* The cached config can land after the panel is already open (the first
       * open usually beats the first GET). Adopt it only while the user has not
       * typed anything yet, so an in-flight edit is never discarded. */
      useEffect(() => {
        dirtyRef.current = dirty;
        // PanelSeat owns Escape/outside-press dismissal, so it needs the same knowledge.
        store.setDirty(dirty);
      }, [dirty]);

      useEffect(() => {
        if (dirtyRef.current) return;
        setDraft(draftFrom(config));
      }, [config]);

      useEffect(() => () => {
        if (ackTimer.current !== null) window.clearTimeout(ackTimer.current);
      }, []);

      const state = snapshot.state;
      const supervisor = state === null ? null : state.supervisor;
      const mode = supervisor === null ? 'idle' : supervisor.mode;
      const message = supervisor !== null && supervisor.message !== '' ? supervisor.message : '';
      const stats = state === null ? { stalls: 0, switches: 0, notices: 0 } : state.stats;
      const recent = state === null ? [] : state.recent;

      const edit = useCallback((mutate) => {
        dirtyRef.current = true;
        setDirty(true);
        setStatus({ kind: 'idle', text: '' });
        setDraft((current) => {
          const next = Object.assign({}, current);
          mutate(next);
          return next;
        });
      }, []);

      /**
       * Close, but never silently throw away edits.
       *
       * The panel is a settings surface; a user who changed three timeout values and then
       * clicked outside it would otherwise lose them with no signal. Discarding is still
       * allowed, it just has to be a decision.
       */
      const requestClose = useCallback(() => {
        // `window.confirm` is not reliable inside this shell, so the confirmation is an
        // in-panel bar: a native dialog that never appears would leave a dirty panel with
        // no way to close it at all.
        if (dirtyRef.current) {
          store.closePanel();
          return;
        }
        store.forceClose();
      }, [t]);

      const confirmDiscard = useCallback(() => {
        dirtyRef.current = false;
        setDirty(false);
        store.forceClose();
      }, []);

      const onSave = useCallback(() => {
        setStatus({ kind: 'busy', text: t('saving') });
        store.saveConfig(payloadFrom(draft)).then((result) => {
          if (result.ok !== true) {
            setStatus({ kind: 'err', text: t('saveFailed', { message: result.error }) });
            return;
          }
          dirtyRef.current = false;
          setDraft(draftFrom(result.config));
          setDirty(false);
          if (result.warnings.length > 0) {
            setStatus({
              kind: 'ok',
              text: t('savedWithWarnings', {
                count: result.warnings.length,
                list: result.warnings.join('; '),
              }),
            });
            return;
          }
          setStatus({ kind: 'ok', text: t('saved') });
        });
      }, [draft, t]);

      const onAck = useCallback(() => {
        setAckBusy(true);
        store.acknowledge().then((result) => {
          setAckBusy(false);
          setStatus(result.ok === true
            ? { kind: 'ok', text: t('ackDone') }
            : { kind: 'err', text: t('ackFailed', { message: result.error }) });
          if (ackTimer.current !== null) window.clearTimeout(ackTimer.current);
          ackTimer.current = window.setTimeout(() => {
            ackTimer.current = null;
            setStatus({ kind: 'idle', text: '' });
          }, 2400);
        });
      }, [t]);

      const timerFields = KINDS.map((kind) => h('label', {
        key: kind,
        className: 'dsg-field',
        title: t('kind' + kind.charAt(0).toUpperCase() + kind.slice(1)),
      },
        h('span', { className: 'dsg-label' }, t('kind' + kind.charAt(0).toUpperCase() + kind.slice(1))),
        h('input', {
          className: 'dsg-input dsg-mono',
          type: 'number',
          min: 1,
          max: 3600,
          step: 1,
          value: draft.timers[kind],
          'aria-label': t('kind' + kind.charAt(0).toUpperCase() + kind.slice(1)),
          onChange: (event) => {
            const value = event.target.value;
            edit((next) => { next.timers = Object.assign({}, next.timers, { [kind]: value }); });
          },
        }),
      ));

      const overridesCount = Object.keys(draft.overrides === null || draft.overrides === undefined ? {} : draft.overrides).length;

      return h('div', {
        className: 'dsg-panel',
        role: 'dialog',
        'aria-label': t('title'),
      },
        h('style', { 'data-stall-guard': 'styles-panel' }, CSS),

        /* head: title + status + the actions, visible the moment the panel opens */
        h('div', { className: 'dsg-head' },
          h('h4', { className: 'dsg-title' }, t('title')),
          h('span', { className: 'dsg-badge', 'data-mode': mode },
            t(MODE_KEY[mode]),
            mode === 'alert' && supervisor !== null && supervisor.level > 0
              ? h('span', null, '\u00b7 ' + t('levelLabel', { level: supervisor.level }))
              : null,
          ),
          dirty
            ? h('span', { className: 'dsg-badge', 'data-mode': 'alert' }, t('unsaved'))
            : null,
          h('span', { className: 'dsg-spacer' }),
          h('button', {
            type: 'button',
            className: 'dsg-btn dsg-btn-primary dsg-btnSm',
            disabled: status.kind === 'busy',
            title: t('save'),
            onClick: onSave,
          }, status.kind === 'busy' ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            className: 'dsg-btn dsg-btnSm',
            title: t('close'),
            'aria-label': t('close'),
            onClick: () => requestClose(),
          }, t('close')),
        ),

        /* everything below scrolls; the action bar stays pinned outside this box */
        h('div', { className: 'dsg-body' },

        /* top: live status + supervisor.message (hidden while empty) + ack */
        h('div', { className: 'dsg-alert', 'data-mode': mode },
          h('p', { className: 'dsg-alert-text' },
            message === '' ? t(MODE_KEY[mode]) : message,
            supervisor !== null && supervisor.tool !== null
              ? h('span', { className: 'dsg-alert-meta' },
                supervisor.tool
                + (supervisor.kind === null ? '' : ' / ' + t('kind' + supervisor.kind.charAt(0).toUpperCase() + supervisor.kind.slice(1)))
                + ' / ' + t('levelLabel', { level: supervisor.level })
                + (supervisor.source === 'none' || supervisor.source === undefined
                  ? ''
                  : ' / ' + t(SOURCE_KEY[supervisor.source])))
              : null,
          ),
          h('button', {
            type: 'button',
            className: 'dsg-btn',
            disabled: ackBusy || mode !== 'alert',
            onClick: onAck,
          }, ackBusy ? t('ackSending') : t('ack')),
        ),

        /* timeouts */
        h('section', { className: 'dsg-section' },
          h('h5', { className: 'dsg-section-title' }, t('sectionTimers')),
          h('p', { className: 'dsg-hint' }, t('sectionTimersHint')),
          h('div', { className: 'dsg-grid' }, timerFields),
          overridesCount === 0 ? null : h('p', { className: 'dsg-hint' }, t('overridesKept', { count: overridesCount })),
        ),

        /* switches */
        h('section', { className: 'dsg-section' },
          h('h5', { className: 'dsg-section-title' }, t('sectionToggles')),
          h('label', { className: 'dsg-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.enabled === true,
              onChange: (event) => {
                const checked = event.target.checked;
                edit((next) => { next.enabled = checked; });
              },
            }),
            h('span', null, t('enabled')),
          ),
          h('label', { className: 'dsg-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.autoSwitch === true,
              onChange: (event) => {
                const checked = event.target.checked;
                edit((next) => { next.autoSwitch = checked; });
              },
            }),
            h('span', null, t('autoSwitch')),
          ),
        ),

        /* per-scene configuration: each of the three features stands alone */
        h('section', { className: 'dsg-section' },
          h('h5', { className: 'dsg-section-title' }, t('sectionScenes')),
          h('p', { className: 'dsg-status' }, t('scenesHint')),
          PRESET_SCENES.map((scene) => h('div', { key: scene, className: 'dsg-scene', 'data-off': draft.scenes[scene].enabled === true ? 'no' : 'yes' },
            h('div', { className: 'dsg-scene-head' },
              h('label', { className: 'dsg-check' },
                h('input', {
                  type: 'checkbox',
                  checked: draft.scenes[scene].enabled === true,
                  onChange: (event) => {
                    const checked = event.target.checked;
                    edit((next) => { next.scenes[scene].enabled = checked; });
                  },
                }),
                h('span', null, t('presetScene' + scene.charAt(0).toUpperCase() + scene.slice(1))),
              ),
            ),
            h('div', { className: 'dsg-grid' },
              h('label', { className: 'dsg-field' },
                h('span', { className: 'dsg-label' }, t('sceneSeconds')),
                h('input', {
                  className: 'dsg-input dsg-mono',
                  type: 'number',
                  min: 1,
                  max: 3600,
                  step: 1,
                  value: draft.scenes[scene].seconds,
                  'aria-label': t('sceneSeconds'),
                  onChange: (event) => {
                    const value = event.target.value;
                    edit((next) => { next.scenes[scene].seconds = value; });
                  },
                }),
              ),
            ),
          )),
        ),

        /* presets: the exact text the agent reads */
        h('section', { className: 'dsg-section' },
          h('h5', { className: 'dsg-section-title' }, t('sectionPresets')),
          h('p', { className: 'dsg-status' }, t('presetsHint')),
          h('div', { className: 'dsg-choices' },
            PRESET_SCENES.map((scene) => h('label', {
              key: scene,
              className: 'dsg-choice',
              'data-active': presetScene === scene ? 'true' : 'false',
            },
              h('input', {
                type: 'radio',
                name: 'dsg-preset-scene',
                checked: presetScene === scene,
                onChange: () => setPresetScene(scene),
              }),
              h('span', null, t('presetScene' + scene.charAt(0).toUpperCase() + scene.slice(1))),
            )),
          ),
          h('textarea', {
            className: 'dsg-textarea',
            rows: 7,
            value: draft.presets[presetScene][presetLocale],
            placeholder: DEFAULT_PRESETS[presetScene][presetLocale],
            'aria-label': t('sectionPresets'),
            onChange: (event) => {
              const value = event.target.value;
              edit((next) => { next.presets[presetScene][presetLocale] = value; });
            },
          }),
          h('p', { className: 'dsg-status' },
            t('presetChars').replace('{count}', String(draft.presets[presetScene][presetLocale].length))
            + (draft.presets[presetScene][presetLocale].length > PRESET_MAX_CHARS ? ' ' + t('presetTooLong') : '')),
          h('div', { className: 'dsg-chips' },
            h('span', { className: 'dsg-status' }, t('presetPlaceholders') + ' '),
            PRESET_PLACEHOLDERS[presetScene].map((name) => h('button', {
              key: name,
              type: 'button',
              className: 'dsg-chip dsg-chipBtn',
              title: t('presetInsertHint'),
              onClick: () => {
                edit((next) => {
                  const current = next.presets[presetScene][presetLocale];
                  next.presets[presetScene][presetLocale] = current + '{{' + name + '}}';
                });
              },
            }, '{{' + name + '}}')),
          ),
          h('div', { className: 'dsg-row' },
            h('button', {
              type: 'button',
              className: 'dsg-btn dsg-btnSm',
              onClick: () => {
                edit((next) => {
                  next.presets[presetScene][presetLocale] = DEFAULT_PRESETS[presetScene][presetLocale];
                });
              },
            }, t('presetRestore')),
            h('button', {
              type: 'button',
              className: 'dsg-btn dsg-btnSm',
              onClick: () => {
                /* Empty means "use the shipped text", which is what a user wants when
                 * they have not formed an opinion: the guard still reports normally. */
                edit((next) => { next.presets[presetScene][presetLocale] = ''; });
              },
            }, t('presetClear')),
          ),
          h('p', { className: 'dsg-status' }, t('presetEmptyHint')),
        ),

        /* supervisor */
        h('section', { className: 'dsg-section' },
          h('h5', { className: 'dsg-section-title' }, t('sectionSupervisor')),
          h('label', { className: 'dsg-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.supervisor.show !== false,
              onChange: (event) => {
                const checked = event.target.checked;
                edit((next) => { next.supervisor = Object.assign({}, next.supervisor, { show: checked }); });
              },
            }),
            h('span', null, t('showSupervisor')),
          ),
          h('p', { className: 'dsg-status' }, t('showSupervisorHint')),
          h('div', { className: 'dsg-label' }, t('displayLabel')),
          h('div', { className: 'dsg-choices' },
            DISPLAYS.map((value) => h('label', {
              key: value,
              className: 'dsg-choice',
              'data-active': draft.supervisor.display === value ? 'true' : 'false',
            },
              h('input', {
                type: 'radio',
                name: 'dsg-display',
                checked: draft.supervisor.display === value,
                onChange: () => edit((next) => {
                  next.supervisor = Object.assign({}, next.supervisor, { display: value });
                }),
              }),
              h('span', null, t('display' + value.charAt(0).toUpperCase() + value.slice(1))),
            )),
          ),
          /* Appearance is local to this browser, so it saves immediately rather than
           * waiting for the panel's Save — and it must not be reverted by a config save. */
          h('div', { className: 'dsg-label' }, t('appearanceLabel')),
          h('div', { className: 'dsg-row' },
            h('span', { className: 'dsg-label dsg-shrink' }, t('iconSize')),
            h('input', {
              className: 'dsg-range',
              type: 'range',
              min: String(SIZE_MIN),
              max: String(SIZE_MAX),
              step: '1',
              value: String(localAppearance.size),
              'aria-label': t('iconSize'),
              onChange: (event) => store.setAppearance({ ...localAppearance, size: Number(event.target.value) }),
            }),
            h('span', { className: 'dsg-mono' }, localAppearance.size + 'px'),
          ),
          h('div', { className: 'dsg-row' },
            h('span', { className: 'dsg-label dsg-shrink' }, t('iconOpacity')),
            h('input', {
              className: 'dsg-range',
              type: 'range',
              min: '20',
              max: '100',
              step: '5',
              value: String(Math.round(localAppearance.opacity * 100)),
              'aria-label': t('iconOpacity'),
              onChange: (event) => store.setAppearance({ ...localAppearance, opacity: Number(event.target.value) / 100 }),
            }),
            h('span', { className: 'dsg-mono' }, Math.round(localAppearance.opacity * 100) + '%'),
          ),
          h('div', { className: 'dsg-choices' },
            h('label', {
              className: 'dsg-choice',
              'data-active': localAppearance.place === 'header' ? 'true' : 'false',
            },
              h('input', {
                type: 'radio',
                name: 'dsg-place',
                checked: localAppearance.place === 'header',
                onChange: () => store.setAppearance({ ...localAppearance, place: 'header', x: -1, y: -1 }),
              }),
              h('span', null, t('placeHeader')),
            ),
            h('label', {
              className: 'dsg-choice',
              'data-active': localAppearance.place === 'float' ? 'true' : 'false',
            },
              h('input', {
                type: 'radio',
                name: 'dsg-place',
                checked: localAppearance.place === 'float',
                onChange: () => store.setAppearance({ ...localAppearance, place: 'float' }),
              }),
              h('span', null, t('placeFloat')),
            ),
          ),
          h('p', { className: 'dsg-status' },
            localAppearance.place === 'float' ? t('placeFloatHint') : t('placeHeaderHint')),

        ),

        /* stats */
        h('section', { className: 'dsg-section' },
          h('h5', { className: 'dsg-section-title' }, t('sectionStats')),
          h('div', { className: 'dsg-stats' },
            h(StatValue, { label: t('statStalls'), value: stats.stalls }),
            h(StatValue, { label: t('statSwitches'), value: stats.switches }),
            h(StatValue, { label: t('statNotices'), value: stats.notices }),
          ),
        ),

        /* recent */
        h('section', { className: 'dsg-section' },
          h('h5', { className: 'dsg-section-title' }, t('sectionRecent')),
          recent.length === 0
            ? h('p', { className: 'dsg-hint' }, t('recentEmpty'))
            : h('ul', { className: 'dsg-recent' }, recent.map((entry, index) => h(RecentItem, {
              key: String(entry.at) + '-' + String(index),
              entry,
              t,
            }))),
        ),

        ),

        /* The footer only carries transient feedback: the actions live in the head now. */
        snapshot.confirming === true || status.text !== ''
          ? h('div', { className: 'dsg-foot-wrap' },
            snapshot.confirming === true
              ? h('div', { className: 'dsg-confirm', role: 'alertdialog' },
                h('span', null, t('discardConfirm')),
                h('button', {
                  type: 'button',
                  className: 'dsg-btn dsg-btnSm',
                  onClick: confirmDiscard,
                }, t('discardYes')),
                h('button', {
                  type: 'button',
                  className: 'dsg-btn dsg-btnSm',
                  onClick: () => store.cancelClose(),
                }, t('discardNo')),
              )
              : null,
            status.text === ''
              ? null
              : h('p', { className: 'dsg-status', 'data-kind': status.kind, role: 'status' }, status.text),
          )
          : null,
      );
    }

    /* ------------------------------------------------------------ overlay seat */

    function PanelSeat(props) {
      const t = useTranslate(props);
      const snapshot = useStore();
      const panelRef = useRef(null);

      useEffect(() => store.start(), []);

      /**
       * Dismissal from outside the panel.
       *
       * Unsaved edits are not thrown away silently: the same confirmation the Close button
       * uses runs here too, so an accidental click next to the panel cannot lose work.
       */
      const requestDismiss = useCallback(() => {
        // The store decides: it either closes, or flags that a confirmation is needed.
        store.closePanel();
      }, []);

      /* Escape and outside-press dismissal, live only while the panel is open. */
      useEffect(() => {
        if (!snapshot.open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') requestDismiss();
        };
        const onPointer = (event) => {
          const panel = panelRef.current;
          if (panel !== null && typeof panel.contains === 'function' && panel.contains(event.target)) return;
          if (event.target instanceof Element && event.target.closest !== undefined) {
            if (event.target.closest('.dsg-seat') !== null) return;
          }
          requestDismiss();
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onPointer, true);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onPointer, true);
        };
      }, [snapshot.open, requestDismiss]);

      if (!snapshot.open) return null;

      return h('div', { ref: panelRef, className: 'dsg-overlay-root' },
        h('style', { 'data-stall-guard': 'styles' }, CSS),
        h(Panel, { t }),
      );
    }

    /**
     * The restore tab, drawn only while the supervisor is hidden.
     *
     * Hiding is a Host setting, so it applies in every session; but the header seat that
     * draws the figure does not exist in a blank session. Without this tab, turning the
     * supervisor off would leave no reachable entry point to turn it back on.
     */
    function RestoreSeat(props) {
      const t = useTranslate(props);
      const snapshot = useStore();
      useEffect(() => store.start(), []);
      if (snapshot.config === null) return null;
      if (snapshot.config.supervisor.show !== false) return null;

      return h('div', { className: 'dsg-overlay-root' },
        h('style', { 'data-stall-guard': 'styles' }, CSS),
        h('button', {
          type: 'button',
          className: 'dsg-restoreTab',
          title: t('supervisorHiddenHint'),
          'aria-label': t('supervisorHiddenHint'),
          onClick: () => store.activate(),
        }),
      );
    }

    /* ------------------------------------------------------------------- apply */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        boundT = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'stall-guard: dictionaries');
        /* The poll belongs to the plugin lifetime, so state stays fresh even
         * when no Session header is mounted; the seats ref-count on top of it. */
        ctx.effect(() => store.start(), 'stall-guard: state polling');

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'stall-guard-supervisor',
          order: 100,
          locale: NS,
          inject: () => ({}),
        }, SupervisorSeat));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'stall-guard-panel',
          order: 70,
          locale: NS,
          inject: () => ({}),
        }, PanelSeat));

        // The way back when the supervisor is hidden.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'stall-guard-restore',
          order: 71,
          locale: NS,
          inject: () => ({}),
        }, RestoreSeat));
      },
    };
  },
});
