/**
 * User presets: the exact text the agent reads, authored by the user.
 *
 * The contract these tests hold is narrow and strict, because a preset goes straight into
 * a running agent's context:
 *
 *  - rendering substitutes only known placeholders and never evaluates anything,
 *  - an unknown placeholder is left visible rather than silently blanked,
 *  - the shipped defaults are byte-identical to the built-in copy,
 *  - a preset cannot be used to inject unbounded text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PRESETS,
  PLACEHOLDERS,
  PRESET_MAX_CHARS,
  PRESET_SCENES,
  defaultPresets,
  isEmptyPreset,
  normalizePresets,
  pickPreset,
  renderPreset,
  unknownPlaceholders,
} from '../lib/presets.js';
import { buildAdvisory, detectDownload, downloadTimeoutResult } from '../lib/download.js';
import { switchFromFetch } from '../lib/fallback.js';

const classifyKind = () => 'exec';
const gitClone = () => ({ name: 'ops_bash', arguments: { command: 'git clone https://github.com/user/repo.git' } });

test('every scene has shipped text in both languages', () => {
  assert.deepEqual(PRESET_SCENES, ['download', 'fetch', 'search']);
  for (const scene of PRESET_SCENES) {
    for (const locale of ['zh', 'en']) {
      const text = DEFAULT_PRESETS[scene][locale];
      assert.ok(typeof text === 'string' && text.trim().length > 20, `${scene}.${locale} has no shipped text`);
    }
  }
});

test('the shipped defaults only use documented placeholders', () => {
  for (const scene of PRESET_SCENES) {
    for (const locale of ['zh', 'en']) {
      const unknown = unknownPlaceholders(DEFAULT_PRESETS[scene][locale], scene);
      assert.deepEqual(unknown, [], `${scene}.${locale} uses undocumented placeholders: ${unknown.join(', ')}`);
    }
  }
});

test('rendering substitutes known placeholders', () => {
  const out = renderPreset('{{label}} in {{seconds}}s on {{channel}}', {
    label: 'the repo',
    seconds: 15,
    channel: 'git',
  });
  assert.equal(out, 'the repo in 15s on git');
});

test('an unknown placeholder survives so the user can see their typo', () => {
  // Silently blanking it would hide the mistake and change the sentence's meaning.
  assert.equal(renderPreset('retry {{labl}} now', { label: 'x' }), 'retry {{labl}} now');
  assert.deepEqual(unknownPlaceholders('retry {{labl}} {{label}}', 'download'), ['labl']);
});

test('nothing is evaluated: a template is inert text', () => {
  // A preset is not a script. `${}` and function-call shapes must come out unchanged.
  const hostile = 'x ${process.exit(1)} y {{label}} z';
  assert.equal(renderPreset(hostile, { label: 'L' }), 'x ${process.exit(1)} y L z');
});

test('an empty or missing template renders as empty', () => {
  assert.equal(renderPreset('', { label: 'x' }), '');
  assert.equal(renderPreset(undefined, { label: 'x' }), '');
  assert.equal(renderPreset(null, {}), '');
  assert.equal(isEmptyPreset(''), true);
  assert.equal(isEmptyPreset('   '), true);
  assert.equal(isEmptyPreset('x'), false);
});

test('defaults are a fresh copy, not the shared table', () => {
  const first = defaultPresets();
  first.download.zh = 'mutated';
  assert.notEqual(defaultPresets().download.zh, 'mutated');
});

test('pickPreset selects by scene and locale, and falls back to Chinese', () => {
  const presets = { download: { zh: 'ZH', en: 'EN' } };
  assert.equal(pickPreset(presets, 'download', 'zh'), 'ZH');
  assert.equal(pickPreset(presets, 'download', 'en-US'), 'EN');
  assert.equal(pickPreset(presets, 'download', 'ja'), 'ZH');
  assert.equal(pickPreset(presets, 'unknown', 'zh'), '');
  assert.equal(pickPreset(undefined, 'download', 'zh'), '');
});

test('normalizePresets keeps custom text and reports bad shapes', () => {
  const { presets, warnings } = normalizePresets({
    download: { zh: '自定义 {{label}}', en: 'custom {{label}}' },
    fetch: 'not an object',
    bogus: { zh: 'x' },
  });
  assert.equal(presets.download.zh, '自定义 {{label}}');
  assert.equal(presets.download.en, 'custom {{label}}');
  assert.equal(presets.fetch.zh, DEFAULT_PRESETS.fetch.zh, 'a bad shape keeps the shipped text');
  assert.ok(warnings.some((line) => line.includes('fetch')));
  assert.ok(warnings.some((line) => line.includes('bogus')));
});

test('an empty string means "use the shipped text", not "send nothing"', () => {
  // Otherwise clearing the box would silently stop reporting the stall to the agent.
  const { presets } = normalizePresets({ download: { zh: '' } });
  assert.equal(presets.download.zh, DEFAULT_PRESETS.download.zh);
});

test('a preset longer than the cap is truncated with a warning', () => {
  const huge = 'x'.repeat(PRESET_MAX_CHARS + 500);
  const { presets, warnings } = normalizePresets({ download: { zh: huge } });
  assert.equal(presets.download.zh.length, PRESET_MAX_CHARS);
  assert.ok(warnings.some((line) => line.includes('truncated')));
});

test('CRLF is normalized so a Windows paste does not double-space the output', () => {
  const { presets } = normalizePresets({ download: { zh: 'a\r\nb' } });
  assert.equal(presets.download.zh, 'a\nb');
});

test('a custom download preset replaces the built-in prose', () => {
  const detection = detectDownload(gitClone(), classifyKind);
  const text = buildAdvisory({
    detection,
    timeoutMs: 30000,
    elapsedMs: 30000,
    locale: 'zh',
    preset: '自定义：{{label}} 超时 {{seconds}}s，渠道 {{channel}}，主机 {{host}}',
  });
  assert.match(text, /自定义/);
  assert.match(text, /github\.com\/user\/repo\.git/);
  assert.match(text, /30s/);
  assert.match(text, /渠道 git/);
  // The built-in framing words must be gone: the user replaced them.
  assert.doesNotMatch(text, /换一个源重试，不要用同一个源继续硬等/);
});

test('a custom preset still receives the cleanup warning', () => {
  // The cleanup note is what makes a retry succeed; dropping it because the user wrote
  // their own sentence would trade a wording preference for a failed retry.
  const detection = detectDownload(gitClone(), classifyKind);
  const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 30000, locale: 'zh', preset: '自定义文本' });
  assert.match(text, /半成品/);
});

test('the {{hints}} placeholder carries the numbered mirror list', () => {
  const detection = detectDownload(gitClone(), classifyKind);
  const text = buildAdvisory({
    detection,
    timeoutMs: 30000,
    elapsedMs: 30000,
    locale: 'zh',
    preset: '备选：\n{{hints}}',
  });
  assert.match(text, /1\. /, 'the list must be numbered');
  assert.match(text, /gh-proxy|ghfast|kkgithub|gitclone/);
});

test('the result value still names the channel and advice with a custom preset', () => {
  const detection = detectDownload(gitClone(), classifyKind);
  const result = downloadTimeoutResult({
    detection,
    timeoutMs: 30000,
    elapsedMs: 30000,
    locale: 'zh',
    preset: '自定义',
  });
  assert.equal(result.isError, true);
  assert.equal(result.value.channel, 'git');
  assert.equal(result.value.advice, 'switch-source');
  assert.match(result.content[0].text, /自定义/);
});

test('a fetch preset replaces the head but keeps the result list', () => {
  const web = {
    async search() {
      return {
        sources: [
          { url: 'https://example.com/a', title: 'A', snippet: 'first' },
          { url: 'https://example.com/b', title: 'B' },
        ],
      };
    },
  };
  return switchFromFetch({
    url: 'https://example.com/topic',
    timeoutMs: 15000,
    web,
    preset: '我自己的提示：{{target}} 超时了，改用搜索「{{query}}」拿到 {{sources}} 条',
  }).then((outcome) => {
    const text = outcome.result.content[0].text;
    assert.match(text, /我自己的提示/);
    assert.match(text, /2 条/);
    // The data the alternative route actually produced must survive.
    assert.match(text, /https:\/\/example\.com\/a/);
    assert.match(text, /https:\/\/example\.com\/b/);
    assert.doesNotMatch(text, /Fetching https/);
  });
});

test('an empty preset falls back to the built-in wording', () => {
  const detection = detectDownload(gitClone(), classifyKind);
  const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 30000, locale: 'zh', preset: '' });
  assert.match(text, /下载卡住了/);
});

test('the documented placeholders cover what the renderer supplies', () => {
  // A placeholder the renderer fills but does not document would be invisible to users.
  const detection = detectDownload(gitClone(), classifyKind);
  const supplied = Object.keys({
    label: detection.label,
    channel: detection.channel,
    target: detection.target,
    host: detection.host,
    command: detection.command,
    seconds: 30,
    elapsed: 30,
    hints: '',
  });
  for (const key of supplied) {
    assert.ok(PLACEHOLDERS.download.includes(key), `${key} is supplied but not documented`);
  }
});

test('the Client copy of the shipped presets matches the Host copy', async () => {
  // The panel keeps its own copy so it opens without a round trip. If the two drift, the
  // editor shows one thing and the guard sends another.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const BACKSLASH = String.fromCharCode(92);

  function objectAfter(marker) {
    const at = src.indexOf(marker);
    const open = src.indexOf('{', at);
    let depth = 0;
    let inString = null;
    for (let i = open; i < src.length; i += 1) {
      const ch = src[i];
      if (inString !== null) {
        if (ch === BACKSLASH) { i += 1; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1); }
    }
    throw new Error(`unbalanced after ${marker}`);
  }

  /* eslint-disable no-eval */
  const clientDefaults = eval(`(${objectAfter('const DEFAULT_PRESETS = {')})`);
  for (const scene of PRESET_SCENES) {
    assert.equal(clientDefaults[scene].zh, DEFAULT_PRESETS[scene].zh, `${scene}.zh drifted between client.js and lib/presets.js`);
    assert.equal(clientDefaults[scene].en, DEFAULT_PRESETS[scene].en, `${scene}.en drifted`);
  }
});
