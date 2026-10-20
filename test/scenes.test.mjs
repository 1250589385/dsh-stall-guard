/**
 * Per-scene settings: download, fetch, and search each configured independently.
 *
 * The requirement is that configuring one scene must not disturb the others. These tests
 * pin that, plus the two things a user actually asks about: whether a scene's switch stops
 * it from acting, and whether turning a scene's model on costs tokens when the global
 * switch is off.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRESET_SCENES,
  SCENE_DEFAULTS,
  SCENE_SECONDS_MAX,
  SCENE_SECONDS_MIN,
  defaultScenes,
  normalizeScenes,
  sceneBudgetMs,
  sceneEnabled,
} from '../lib/presets.js';
import { defaults, validateConfig } from '../lib/config.js';

test('each scene ships an independent default', () => {
  assert.deepEqual(PRESET_SCENES, ['download', 'fetch', 'search']);
  const scenes = defaultScenes();
  for (const scene of PRESET_SCENES) {
    assert.equal(typeof scenes[scene].enabled, 'boolean', `${scene}.enabled`);
    assert.equal(typeof scenes[scene].seconds, 'number', `${scene}.seconds`);
    assert.equal(scenes[scene].useModel, undefined, 'a scene has no model switch: the plugin never calls one');
  }
  // The download budget differs from the web ones on purpose: a dead mirror and a slow
  // page are different problems.
  assert.equal(scenes.download.seconds, 30);
  assert.equal(scenes.fetch.seconds, 15);
  assert.equal(scenes.search.seconds, 15);
});

test('defaults are a fresh copy, not the shared table', () => {
  const first = defaultScenes();
  first.download.seconds = 999;
  assert.notEqual(defaultScenes().download.seconds, 999);
});

test('configuring one scene leaves the others untouched', () => {
  // normalizeScenes returns the block directly (same shape as defaultScenes()).
  const scenes = normalizeScenes(
    { download: { enabled: false, seconds: 60 } },
    [],
  );
  assert.equal(scenes.download.enabled, false);
  assert.equal(scenes.download.seconds, 60);
  // The other two keep their shipped values.
  assert.equal(scenes.fetch.enabled, SCENE_DEFAULTS.fetch.enabled);
  assert.equal(scenes.fetch.seconds, SCENE_DEFAULTS.fetch.seconds);
  assert.equal(scenes.search.enabled, SCENE_DEFAULTS.search.enabled);
  assert.equal(scenes.search.seconds, SCENE_DEFAULTS.search.seconds);
});

test('turning the download scene off does not turn the web fallbacks off', () => {
  // normalizeScenes returns the block itself, not a wrapper.
  const scenes = normalizeScenes({ download: { enabled: false } }, []);
  assert.equal(sceneEnabled(scenes, 'download'), false);
  assert.equal(sceneEnabled(scenes, 'fetch'), true);
  assert.equal(sceneEnabled(scenes, 'search'), true);
});

test('a scene seconds value is clamped and reported', () => {
  const warnings = [];
  const scenes = normalizeScenes({ fetch: { seconds: 99999 }, search: { seconds: 0 } }, warnings);
  assert.equal(scenes.fetch.seconds, SCENE_SECONDS_MAX);
  assert.equal(scenes.search.seconds, SCENE_SECONDS_MIN);
  assert.ok(warnings.some((line) => line.includes('fetch.seconds')), 'clamping must be reported');
  assert.ok(warnings.some((line) => line.includes('search.seconds')));
});

test('a non-numeric scene seconds keeps the default and warns', () => {
  const warnings = [];
  const scenes = normalizeScenes({ download: { seconds: 'soon' } }, warnings);
  assert.equal(scenes.download.seconds, SCENE_DEFAULTS.download.seconds);
  assert.ok(warnings.some((line) => line.includes('download.seconds')));
});

test('a malformed scene keeps the defaults and warns', () => {
  const warnings = [];
  const scenes = normalizeScenes({ fetch: 'nope', ghost: { enabled: true } }, warnings);
  assert.deepEqual(scenes.fetch, { ...SCENE_DEFAULTS.fetch });
  assert.ok(warnings.some((line) => line.includes('scenes.fetch')));
  assert.ok(warnings.some((line) => line.includes('ghost')));
});

test('sceneBudgetMs converts seconds to a usable budget', () => {
  const scenes = defaultScenes();
  scenes.fetch.seconds = 42;
  assert.equal(sceneBudgetMs(scenes, 'fetch'), 42000);
  assert.equal(sceneBudgetMs({}, 'fetch'), undefined);
});

test('sceneEnabled treats a missing entry as enabled', () => {
  // An older config file has no `scenes` block at all; the guard must keep working.
  assert.equal(sceneEnabled(undefined, 'download'), true);
  assert.equal(sceneEnabled({}, 'download'), true);
  assert.equal(sceneEnabled({ download: {} }, 'download'), true);
  assert.equal(sceneEnabled({ download: { enabled: false } }, 'download'), false);
});

test('the validated config carries all three scenes', () => {
  const config = defaults();
  assert.deepEqual(Object.keys(config.scenes).sort(), [...PRESET_SCENES].sort());
});

test('a legacy config without scenes gains the defaults', () => {
  const legacy = { version: 1, enabled: true, timers: {}, supervisor: { display: 'dot' } };
  const { config } = validateConfig(legacy);
  assert.deepEqual(config.scenes, defaultScenes());
});

test('per-scene settings survive a full round trip', () => {
  const { config } = validateConfig({
    scenes: {
      download: { enabled: true, seconds: 45 },
      fetch: { enabled: false, seconds: 8 },
      search: { enabled: true, seconds: 12 },
    },
  });
  assert.deepEqual(config.scenes.download, { enabled: true, seconds: 45 });
  assert.deepEqual(config.scenes.fetch, { enabled: false, seconds: 8 });
  assert.deepEqual(config.scenes.search, { enabled: true, seconds: 12 });
});
