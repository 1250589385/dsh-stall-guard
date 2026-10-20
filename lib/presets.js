/**
 * User-authored presets: the exact text the agent reads.
 *
 * The whole point of a preset is to remove the model from the loop. A stall produces a
 * tool result the agent must act on; that text is either generated (costs tokens, varies
 * run to run) or written once by the user and replayed verbatim (free, stable, and
 * reviewable before it is ever sent). This module holds the second kind.
 *
 * Design rules, in order of importance:
 *
 *  1. A preset is plain text with `{{placeholders}}`. Nothing is evaluated; a stray
 *     placeholder that has no value is left as-is so the user can see their typo instead
 *     of silently getting an empty string.
 *  2. The shipped defaults are byte-identical to the built-in copy, so switching a preset
 *     on and off cannot change behaviour unexpectedly.
 *  3. Length is capped. A preset is injected into the context of a running agent; a
 *     4000-character essay would be paid for on every stall.
 */

/** The channel keys a download preset can be written for, plus a catch-all. */
export const PRESET_SCENES = ['download', 'fetch', 'search'];

/**
 * Per-scene defaults.
 *
 * Each scene is an independent feature: a user may want the download guard on with a 60s
 * budget and its own wording, while the fetch fallback is off entirely. Keeping the switch
 * and the budget per scene is what makes that possible without a second round of global
 * settings fighting the per-scene ones.
 */
export const SCENE_DEFAULTS = {
  download: { enabled: true, seconds: 30 },
  fetch: { enabled: true, seconds: 15 },
  search: { enabled: true, seconds: 15 },
};

/** A fresh copy of the per-scene defaults. */
export function defaultScenes() {
  const out = {};
  for (const scene of PRESET_SCENES) out[scene] = { ...SCENE_DEFAULTS[scene] };
  return out;
}

export const SCENE_SECONDS_MIN = 1;
export const SCENE_SECONDS_MAX = 3600;

/** Every placeholder a preset may use, for documentation and the panel's insert menu. */
export const PLACEHOLDERS = {
  download: ['label', 'channel', 'target', 'host', 'command', 'seconds', 'elapsed', 'hints'],
  fetch: ['tool', 'target', 'query', 'seconds', 'elapsed', 'sources'],
  search: ['tool', 'query', 'seconds', 'elapsed'],
};

/** A preset this long is almost certainly a mistake, not a preference. */
export const PRESET_MAX_CHARS = 4000;

/**
 * The shipped text, per scene and per channel.
 *
 * These mirror the built-in advisory wording. `{en}` and `{zh}` are kept side by side
 * because the guard reports in the Host's locale, and a user who never opens the panel
 * must get sensible copy in whichever language they read.
 */
export const DEFAULT_PRESETS = {
  download: {
    zh: [
      '下载卡住了：{{label}} 在 {{seconds}} 秒内没完成（已经跑了 {{elapsed}} 秒，已中止）。',
      '',
      '这条命令被终止了。原因多半是到这个源的网络不通，而不是命令本身写错。',
      '换一个源重试，不要用同一个源继续硬等：',
      '{{hints}}',
      '',
      '注意：被中止的下载会留下半成品（文件或目录），重试前先删掉它，或在新的空目录里重试。',
      '',
      '卡住的命令：{{command}}',
    ].join('\n'),
    en: [
      'Download stalled: {{label}} did not finish within {{seconds}}s (stopped after {{elapsed}}s).',
      '',
      'The command was killed. The network path to this source is the likely cause, not the command itself.',
      'Retry against a different source before trying the same one again:',
      '{{hints}}',
      '',
      'Note: an aborted download leaves a partial file or directory; remove it before retrying, or retry in a fresh directory.',
      '',
      'Command that stalled: {{command}}',
    ].join('\n'),
  },
  fetch: {
    zh: [
      '抓取 {{target}} 超过 {{seconds}} 秒没响应，已改用搜索「{{query}}」继续找，拿到 {{sources}} 条结果。',
      '',
      '这个页面本身没有取到。如果必须看原文，重新抓取或调高该工具的阈值。',
    ].join('\n'),
    en: [
      'Fetching {{target}} did not respond within {{seconds}}s, so the guard searched for "{{query}}" instead and found {{sources}} results.',
      '',
      'The page itself was not retrieved. Retry the fetch or raise its timeout if the original page is essential.',
    ].join('\n'),
  },
  search: {
    zh: [
      '搜索「{{query}}」超过 {{seconds}} 秒没响应，已重试一次。',
      '',
      '如果仍然失败，换一个搜索词或稍后再试。',
    ].join('\n'),
    en: [
      'Searching for "{{query}}" did not respond within {{seconds}}s; one retry was attempted.',
      '',
      'If it still fails, try different wording or wait a moment.',
    ].join('\n'),
  },
};

/** A fresh copy of the shipped presets, safe to hand to a caller that may mutate it. */
export function defaultPresets() {
  const out = {};
  for (const scene of PRESET_SCENES) {
    out[scene] = { ...DEFAULT_PRESETS[scene] };
  }
  return out;
}

/**
 * Validate the per-scene behaviour block.
 *
 * `scenes.download.enabled = false` turns the download guard off without touching the
 * fetch/search fallbacks, which is the whole point of per-scene settings. The budget and
 * the model choice travel with the scene for the same reason.
 */
export function normalizeScenes(raw, warnings) {
  const output = defaultScenes();
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  for (const scene of PRESET_SCENES) {
    const sceneInput = input[scene];
    if (sceneInput === undefined || sceneInput === null) continue;
    if (typeof sceneInput !== 'object' || Array.isArray(sceneInput)) {
      warnings.push(`scenes.${scene}: expected an object; kept the defaults`);
      continue;
    }
    if (sceneInput.enabled !== undefined) output[scene].enabled = Boolean(sceneInput.enabled);
    if (sceneInput.seconds !== undefined) {
      const n = Number(sceneInput.seconds);
      if (!Number.isFinite(n)) {
        warnings.push(`scenes.${scene}.seconds: expected a number; kept ${output[scene].seconds}`);
      } else {
        const rounded = Math.round(n);
        const clamped = Math.min(SCENE_SECONDS_MAX, Math.max(SCENE_SECONDS_MIN, rounded));
        if (clamped !== rounded) {
          warnings.push(`scenes.${scene}.seconds: adjusted ${rounded} to ${clamped}`);
        }
        output[scene].seconds = clamped;
      }
    }
  }

  for (const key of Object.keys(input)) {
    if (!PRESET_SCENES.includes(key)) warnings.push(`scenes.${key}: unknown scene ignored`);
  }
  return output;
}

/** True when the scene's own switch allows it to act. */
export function sceneEnabled(scenes, scene) {
  const entry = scenes?.[scene];
  return entry === undefined ? true : entry.enabled !== false;
}

/** The scene's own budget in milliseconds, or undefined when it has none. */
export function sceneBudgetMs(scenes, scene) {
  const entry = scenes?.[scene];
  if (!entry || !Number.isFinite(entry.seconds)) return undefined;
  return Math.max(SCENE_SECONDS_MIN, Number(entry.seconds)) * 1000;
}

/**
 * Render one preset.
 *
 * `{{name}}` is replaced when `values` has a value for it. An unknown placeholder is left
 * untouched on purpose: it is the user's own text, and silently deleting it would hide the
 * typo that produced it. `{{hints}}` is special — it carries the mirror list, which is
 * itself multi-line.
 */
export function renderPreset(template, values) {
  if (typeof template !== 'string' || template === '') return '';
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (whole, name) => {
    const value = values?.[name];
    if (value === undefined || value === null) return whole;
    return String(value);
  });
}

/** Placeholders a template uses that `scene` does not document. Used for panel warnings. */
export function unknownPlaceholders(template, scene) {
  if (typeof template !== 'string') return [];
  const allowed = new Set(PLACEHOLDERS[scene] ?? []);
  const found = new Set();
  for (const match of template.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g)) {
    if (!allowed.has(match[1])) found.add(match[1]);
  }
  return [...found];
}

/** True when the preset is indistinguishable from "no preset". */
export function isEmptyPreset(template) {
  return typeof template !== 'string' || template.trim() === '';
}

/**
 * Validate the whole `presets` block.
 *
 * An empty string means "use the shipped text for that scene and language", which is why
 * an empty value is stored as `''` rather than being replaced by the default: the panel
 * needs to tell "I never set this" apart from "I set it to the default text".
 */
export function normalizePresets(raw) {
  const warnings = [];
  const output = defaultPresets();
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  for (const scene of PRESET_SCENES) {
    const sceneInput = input[scene];
    if (sceneInput === undefined || sceneInput === null) continue;
    if (typeof sceneInput !== 'object' || Array.isArray(sceneInput)) {
      warnings.push(`presets.${scene}: expected an object with zh/en strings; kept the shipped text`);
      continue;
    }
    for (const locale of ['zh', 'en']) {
      const value = sceneInput[locale];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') {
        warnings.push(`presets.${scene}.${locale}: expected text; kept the shipped text`);
        continue;
      }
      const text = value.replace(/\r\n/g, '\n');
      if (text.length > PRESET_MAX_CHARS) {
        warnings.push(`presets.${scene}.${locale}: truncated to ${PRESET_MAX_CHARS} characters`);
        output[scene][locale] = text.slice(0, PRESET_MAX_CHARS);
        continue;
      }
      // An empty string is a real value: "revert to the shipped text".
      output[scene][locale] = text === '' ? DEFAULT_PRESETS[scene][locale] : text;
    }
  }

  for (const key of Object.keys(input)) {
    if (!PRESET_SCENES.includes(key)) warnings.push(`presets.${key}: unknown scene ignored`);
  }

  return { presets: output, warnings };
}

/**
 * Pick the template for one report.
 *
 * A user preset always wins over the generated sentence. `locale` is the Host's locale,
 * which arrives as a full tag (`en`, `en-US`, `zh-CN`), so the match is a prefix test
 * rather than equality: an `en-US` Host must not silently receive the Chinese text.
 */
export function pickPreset(presets, scene, locale) {
  if (!PRESET_SCENES.includes(scene)) return '';
  const table = presets?.[scene];
  if (!table || typeof table !== 'object') return '';
  const tag = String(locale ?? '').toLowerCase();
  const wanted = tag === 'en' || tag.startsWith('en-') ? 'en' : 'zh';
  return typeof table[wanted] === 'string' ? table[wanted] : '';
}
