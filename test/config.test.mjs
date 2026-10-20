/**
 * Config validation and durable storage.
 *
 * The settings file is edited by a browser form, so every value arrives untrusted. The
 * contract these tests hold: bad input never corrupts the file, always produces a
 * warning, and never leaves memory disagreeing with what was written.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULT_DISPLAY, DISPLAYS, ConfigStore, defaults, validateConfig } from '../lib/config.js';
import { DEFAULT_TIMERS, KINDS } from '../lib/classify.js';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-guard-test-'));
  return { dir, file: path.join(dir, 'nested', 'config.json') };
}

test('defaults cover every class and contain no model settings', () => {
  const config = defaults();
  assert.deepEqual(Object.keys(config.timers).sort(), [...KINDS].sort());
  // Not "off by default": absent. There is no model call to switch on.
  assert.equal(config.supervisor.useModel, undefined);
  assert.equal(config.supervisor.provider, undefined, 'the plugin has no model configuration');
  assert.equal(config.supervisor.model, undefined);
  assert.equal(config.supervisor.display, DEFAULT_DISPLAY);
});

test('an empty document validates to the defaults', () => {
  const { config, warnings } = validateConfig({});
  assert.deepEqual(config, defaults());
  assert.deepEqual(warnings, []);
});

test('a null or array document is treated as empty rather than throwing', () => {
  assert.deepEqual(validateConfig(null).config, defaults());
  assert.deepEqual(validateConfig([]).config, defaults());
  assert.deepEqual(validateConfig('nonsense').config, defaults());
});

test('every display posture is accepted and a bad one keeps the default', () => {
  for (const display of DISPLAYS) {
    assert.equal(validateConfig({ supervisor: { display } }).config.supervisor.display, display);
  }
  const { config, warnings } = validateConfig({ supervisor: { display: 'giant' } });
  assert.equal(config.supervisor.display, DEFAULT_DISPLAY);
  assert.ok(warnings.some((line) => line.includes('supervisor.display')));
});

test('unknown top-level keys are dropped and reported', () => {
  const { config, warnings } = validateConfig({ mystery: true, enabled: false });
  assert.equal(config.mystery, undefined);
  assert.equal(config.enabled, false);
  assert.ok(warnings.some((line) => line.includes('mystery')));
});

test('a store writes the defaults on first load and reads them back', () => {
  const { file } = tempFile();
  const store = new ConfigStore(file);
  const loaded = store.load();
  assert.deepEqual(loaded, defaults());
  assert.ok(fs.existsSync(file), 'the defaults must be persisted so the file is discoverable');

  const reread = new ConfigStore(file);
  assert.deepEqual(reread.load(), defaults());
});

test('a corrupt file is replaced with the defaults instead of breaking the plugin', () => {
  const { file } = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json', 'utf8');

  const store = new ConfigStore(file);
  assert.deepEqual(store.load(), defaults());
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1, 'the corrupt file must be rewritten');
});

test('update persists a validated document and memory agrees with disk', () => {
  const { file } = tempFile();
  const store = new ConfigStore(file);
  store.load();

  const { config } = store.update({ timers: { fetch: 3 }, supervisor: { display: 'dot' } });
  assert.equal(config.timers.fetch, 3);
  assert.equal(config.timers.search, DEFAULT_TIMERS.search, 'unspecified classes keep their defaults');
  assert.equal(config.supervisor.display, 'dot');

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, config);
  assert.deepEqual(store.get(), config);
});

test('update returns the warnings the panel must display', () => {
  const { file } = tempFile();
  const store = new ConfigStore(file);
  store.load();
  const { warnings } = store.update({ timers: { fetch: -1 } });
  assert.ok(warnings.length > 0);
  assert.equal(store.get().timers.fetch, DEFAULT_TIMERS.fetch);
});

test('a failed write does not leave the in-memory config ahead of disk', () => {
  const { dir } = tempFile();
  // A file where a directory is required makes mkdirSync fail deterministically.
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const store = new ConfigStore(path.join(blocker, 'config.json'));
  store.load();

  assert.throws(() => store.update({ enabled: false }));
  assert.equal(store.get().enabled, true, 'a rejected write must not change the live config');
});

test('a relative-looking configFile still resolves through the constructor', () => {
  const { dir } = tempFile();
  const file = path.join(dir, 'relative-name.json');
  const store = new ConfigStore(file);
  store.update({ timers: { read: 5 } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).timers.read, 5);
});

test('the supervisor is visible by default and a legacy file stays visible', () => {
  assert.equal(defaults().supervisor.show, true);
  // A settings file written before the switch existed must not turn the figure off.
  const legacy = {
    version: 1,
    enabled: true,
    timers: {},
    overrides: {},
    autoSwitch: true,
    supervisor: { display: 'dot', useModel: true, provider: '', model: '', timeoutMs: 8000, cooldownMs: 30000 },
  };
  assert.equal(validateConfig(legacy).config.supervisor.show, true);
});

test('hiding the supervisor round-trips through the store', () => {
  const { file } = tempFile();
  const store = new ConfigStore(file);
  store.load();

  const { config } = store.update({ supervisor: { show: false } });
  assert.equal(config.supervisor.show, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).supervisor.show, false);

  const shown = store.update({ supervisor: { show: true } }).config;
  assert.equal(shown.supervisor.show, true);
});

test('hiding the supervisor does not disturb the guard settings', () => {
  const { config } = validateConfig({ supervisor: { show: false }, timers: { fetch: 9 }, enabled: true });
  assert.equal(config.supervisor.show, false);
  assert.equal(config.timers.fetch, 9);
  assert.equal(config.enabled, true);
});

