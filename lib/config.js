/**
 * Configuration: defaults, validation, and durable storage.
 *
 * The file lives under `$DSH_HOME/stall-guard/config.json` rather than in the package
 * directory, because npm may reinstall or clean `node_modules` while the user's
 * settings must survive. Reads are cached in memory; every write goes to disk with a
 * temp-file rename so a crash cannot leave a half-written config behind.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_TIMERS, KINDS, MAX_SECONDS, MIN_SECONDS, clampSeconds, normalizeOverrides, normalizeTimers } from './classify.js';
import { defaultPresets, defaultScenes, normalizePresets, normalizeScenes } from './presets.js';

export const CONFIG_VERSION = 1;

/** Display postures for the supervisor. */
export const DISPLAYS = ['avatar', 'icon', 'dot'];
export const DEFAULT_DISPLAY = 'avatar';

/**
 * The shipped defaults.
 *
 * There are no model settings because this plugin never calls a model. The only text it
 * produces is the switch-source advisory shown to the agent (from a user preset or a fixed
 * template) and the panel's sentence (from a fixed bilingual table); both describe facts
 * the guard already knows exactly, so generating them would cost tokens without improving
 * them.
 */
export function defaults() {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    timers: { ...DEFAULT_TIMERS },
    overrides: {},
    autoSwitch: true,
    // Downloads get their own budget: a dead network path should be cut early and
    // reported as "switch source", not waited out on the generic exec budget.
    watchDownloads: true,
    downloadSeconds: 30,
    // Per-scene behaviour: each of download / fetch / search can be switched, budgeted,
    // and model-answered independently.
    scenes: defaultScenes(),
    // The text the agent reads. Empty means "use the shipped wording" for that scene.
    presets: defaultPresets(),
    supervisor: {
      /** Whether the supervisor is drawn at all. Off still serves the API and the panel. */
      show: true,
      display: DEFAULT_DISPLAY,
    },
  };
}

/** `$DSH_HOME/stall-guard/config.json`, honouring the same home resolution the Host uses. */
export function configPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'stall-guard', 'config.json');
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return { value: fallback, adjusted: false };
  const rounded = Math.round(n);
  const clamped = Math.min(max, Math.max(min, rounded));
  return { value: clamped, adjusted: clamped !== rounded };
}

/**
 * Validate one untrusted config document.
 *
 * Unknown keys are dropped rather than preserved: the shape is fully owned by this
 * plugin, and keeping foreign keys would make future migrations ambiguous. Every
 * adjustment is reported in `warnings` so the settings panel can show what happened.
 */
export function validateConfig(raw) {
  const warnings = [];
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const base = defaults();

  const enabled = input.enabled === undefined ? base.enabled : Boolean(input.enabled);
  const autoSwitch = input.autoSwitch === undefined ? base.autoSwitch : Boolean(input.autoSwitch);

  const watchDownloads = input.watchDownloads === undefined ? base.watchDownloads : Boolean(input.watchDownloads);
  const downloadInput = clampInt(input.downloadSeconds, MIN_SECONDS, MAX_SECONDS, base.downloadSeconds);
  if (downloadInput.adjusted) {
    warnings.push(`downloadSeconds: adjusted to ${downloadInput.value} (allowed ${MIN_SECONDS}..${MAX_SECONDS})`);
  }

  const timerResult = normalizeTimers(input.timers);
  warnings.push(...timerResult.warnings);

  const overrideResult = normalizeOverrides(input.overrides);
  warnings.push(...overrideResult.warnings);

  const presetResult = normalizePresets(input.presets);
  warnings.push(...presetResult.warnings);

  const scenes = normalizeScenes(input.scenes, warnings);

  // Migrate the legacy global download flag into the scene when the scene was not set
  // explicitly. Without this an existing config with `watchDownloads: false` would start
  // guarding downloads again after the upgrade.
  if (input.scenes === undefined || input.scenes?.download === undefined) {
    scenes.download.enabled = watchDownloads;
    const legacySeconds = Number(input.downloadSeconds);
    if (Number.isFinite(legacySeconds) && legacySeconds > 0) {
      scenes.download.seconds = Math.min(3600, Math.max(1, Math.round(legacySeconds)));
    }
  }

  const rawSupervisor = input.supervisor && typeof input.supervisor === 'object' ? input.supervisor : {};

  const show = rawSupervisor.show === undefined ? base.supervisor.show : Boolean(rawSupervisor.show);

  let display = base.supervisor.display;
  if (rawSupervisor.display !== undefined) {
    if (DISPLAYS.includes(rawSupervisor.display)) display = rawSupervisor.display;
    else warnings.push(`supervisor.display: "${String(rawSupervisor.display)}" is not one of ${DISPLAYS.join(' | ')}; kept ${base.supervisor.display}`);
  }

  // Any model settings in an existing file are ignored rather than rejected: a user
  // upgrading must not get warnings for keys this version simply no longer has.

  for (const key of Object.keys(input)) {
    if (!['version', 'enabled', 'timers', 'overrides', 'autoSwitch', 'watchDownloads', 'downloadSeconds', 'scenes', 'presets', 'supervisor'].includes(key)) {
      warnings.push(`unknown key "${key}" ignored`);
    }
  }

  return {
    config: {
      version: CONFIG_VERSION,
      enabled,
      timers: timerResult.timers,
      overrides: overrideResult.overrides,
      autoSwitch,
      watchDownloads,
      downloadSeconds: downloadInput.value,
      scenes,
      presets: presetResult.presets,
      supervisor: {
        show,
        display,
      },
    },
    warnings,
  };
}

/** Read `file` as JSON, or `undefined` when it is missing or unparseable. */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Write `value` through a temp file in the same directory, then rename. A rename on
 * the same volume is atomic enough that a crashed write cannot truncate the config.
 */
function writeJsonFile(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file is already gone; nothing to clean */
    }
    throw error;
  }
}

/**
 * One config owner: an in-memory copy, a path, and the invariant that the copy is
 * what every reader sees. `update` validates before touching disk, so a rejected
 * write never leaves memory and disk disagreeing.
 */
export class ConfigStore {
  constructor(file = configPath()) {
    this.file = file;
    this.config = defaults();
    this.loaded = false;
  }

  /** Load from disk once; a missing or corrupt file is replaced with the defaults. */
  load() {
    if (this.loaded) return this.config;
    this.loaded = true;
    const existing = readJsonFile(this.file);
    if (existing === undefined) {
      this.config = defaults();
      try {
        writeJsonFile(this.file, this.config);
      } catch {
        /* a read-only home directory must not break the plugin; defaults still apply */
      }
      return this.config;
    }
    const { config } = validateConfig(existing);
    this.config = config;
    return config;
  }

  /** The current validated config. */
  get() {
    return this.load();
  }

  /**
   * Validate and persist a new document. Returns the stored config and warnings;
   * throws only when the write itself fails, which the HTTP layer turns into a 400.
   */
  update(raw) {
    const { config, warnings } = validateConfig(raw);
    writeJsonFile(this.file, config);
    this.config = config;
    this.loaded = true;
    return { config, warnings };
  }
}

/** The class list, re-exported for the settings surface so both halves agree. */
export { KINDS, DEFAULT_TIMERS, clampSeconds };
