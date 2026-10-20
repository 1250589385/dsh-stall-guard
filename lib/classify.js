/**
 * Tool classification and timeout resolution.
 *
 * The plugin answers one question per tool call — "how long may this run before it
 * counts as stalled?" — and a second one — "when it stalls, may we switch to another
 * approach or may we only report it?".
 *
 * The policy is deliberately conservative. Only `web_fetch` and `web_search` have a
 * real alternative path that the Host can run itself (`ctx.web.search` / one bounded
 * retry), so those two are the only classes that ever auto-switch. Everything else is
 * `notify`: the call keeps running and the supervisor merely reports it. Read-only
 * tools are *classified* as switch-capable for future fallbacks, but `resolveSpec`
 * downgrades them to notify until such a fallback exists — pretending to switch while
 * doing nothing would be a lie in the UI.
 */

/** The seven configurable classes, in display order. */
export const KINDS = ['fetch', 'search', 'read', 'write', 'exec', 'long', 'other'];

/**
 * Accepted timeout range, in seconds. The lower bound keeps a mis-typed `0` from
 * aborting every call instantly; the upper bound is one hour, past which the guard
 * is indistinguishable from no guard at all.
 */
export const MIN_SECONDS = 1;
export const MAX_SECONDS = 3600;

/** Per-class defaults: the short timings are the ones a user notices as "stuck". */
export const DEFAULT_TIMERS = Object.freeze({
  fetch: 15,
  search: 15,
  read: 20,
  write: 30,
  exec: 30,
  long: 120,
  other: 30,
});

/**
 * Classification table. Order matters only within a class list; lookup builds a
 * flat Map once at module load, so a tool name appears in exactly one class (the
 * first list that contains it wins on accidental duplicates).
 */
const TOOL_KINDS = Object.freeze({
  fetch: ['web_fetch'],
  search: ['web_search'],
  read: [
    'read',
    'read_image',
    'grep',
    'glob',
    'session_search',
    'session_event_read',
    'session_event_search',
    'job_output',
    'job_list',
    'list_agents',
    'list_subagent_models',
    'skill',
    'get_goal',
    'get_goal',
    'schedule_list',
    'team_task_list',
    'team_task_get',
    'cordis_inspect_list',
    'cordis_inspect_query',
  ],
  write: [
    'write',
    'edit',
    'present',
    'todo_write',
    'schedule_create',
    'schedule_update',
    'schedule_delete',
    'team_task_create',
    'team_task_update',
    'send_message',
    'create_goal',
    'update_goal',
    'cordis_define',
    'cordis_undefine',
    'cordis_run',
    'cordis_stop',
  ],
  exec: [
    'bash',
    'pwsh',
    'ops_bash',
    'run_tests',
    'job_kill',
    'terminal_open',
    'terminal_read',
    'terminal_signal',
    'terminal_list',
    'terminal_close',
  ],
  long: [
    'subagent',
    'subagent_fork',
    'workflow',
    'spawn_teammate',
    'wait_agent',
    'interrupt_agent',
    'ask_user_question',
  ],
  other: [],
});

const KIND_BY_TOOL = new Map();
for (const kind of KINDS) {
  for (const name of TOOL_KINDS[kind] ?? []) {
    if (!KIND_BY_TOOL.has(name)) KIND_BY_TOOL.set(name, kind);
  }
}

/**
 * Classes whose stall the Host can actually resolve by taking a different route.
 * `read` is intentionally absent: there is no second implementation of a local file
 * read, so claiming a switch there would be fiction.
 */
export const SWITCHABLE_KINDS = Object.freeze(['fetch', 'search']);

/**
 * Classify one tool name.
 *
 * Unknown names — MCP tools, third-party plugin tools, tools added after this build —
 * fall into `other`, which is the conservative middle: a 30s budget and notify-only.
 */
export function classify(toolName) {
  const name = String(toolName ?? '');
  return KIND_BY_TOOL.get(name) ?? 'other';
}

/** True when the plugin may abort this call and take another route. */
export function isSwitchable(toolName) {
  return SWITCHABLE_KINDS.includes(classify(toolName));
}

/** Clamp one raw timeout value to `MIN_SECONDS..MAX_SECONDS`, or undefined when unusable. */
export function clampSeconds(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded < MIN_SECONDS) return undefined;
  return Math.min(rounded, MAX_SECONDS);
}

/**
 * Normalize a whole `timers` map: known classes only, clamped values only, missing
 * classes filled from the defaults. Returns the sanitized map plus the warnings the
 * settings surface should show instead of silently swallowing bad input.
 */
export function normalizeTimers(raw) {
  const warnings = [];
  const timers = {};
  const input = raw && typeof raw === 'object' ? raw : {};
  for (const kind of KINDS) {
    const value = input[kind];
    if (value === undefined || value === null || value === '') {
      timers[kind] = DEFAULT_TIMERS[kind];
      continue;
    }
    const seconds = clampSeconds(value);
    if (seconds === undefined) {
      timers[kind] = DEFAULT_TIMERS[kind];
      warnings.push(`timers.${kind}: "${String(value)}" is not a whole number of seconds in ${MIN_SECONDS}..${MAX_SECONDS}; kept ${DEFAULT_TIMERS[kind]}`);
      continue;
    }
    if (seconds !== Number(value)) {
      warnings.push(`timers.${kind}: adjusted ${String(value)} to ${seconds}`);
    }
    timers[kind] = seconds;
  }
  for (const key of Object.keys(input)) {
    if (!KINDS.includes(key)) warnings.push(`timers.${key}: unknown class ignored`);
  }
  return { timers, warnings };
}

/**
 * Normalize per-tool overrides. Keys are tool names; values are clamped seconds.
 * An override lets a user carve one tool out of its class, e.g. a slower `web_fetch`.
 */
export function normalizeOverrides(raw) {
  const warnings = [];
  const overrides = {};
  const input = raw && typeof raw === 'object' ? raw : {};
  for (const [name, value] of Object.entries(input)) {
    const key = String(name).trim();
    if (!key) {
      warnings.push('overrides: empty tool name ignored');
      continue;
    }
    const seconds = clampSeconds(value);
    if (seconds === undefined) {
      warnings.push(`overrides.${key}: "${String(value)}" is not a whole number of seconds in ${MIN_SECONDS}..${MAX_SECONDS}; ignored`);
      continue;
    }
    overrides[key] = seconds;
  }
  return { overrides, warnings };
}

/**
 * Resolve the effective budget for one dispatched tool call.
 *
 * `autoSwitch` is reported only when a fallback genuinely exists, so the caller can
 * branch on a value that reflects capability rather than the user's wish.
 */
export function resolveSpec(toolName, config) {
  const name = String(toolName ?? '');
  const kind = classify(name);
  const timers = config?.timers ?? DEFAULT_TIMERS;
  const override = config?.overrides?.[name];
  const seconds = override ?? timers[kind] ?? DEFAULT_TIMERS[kind];
  const switchable = SWITCHABLE_KINDS.includes(kind);
  return {
    tool: name,
    kind,
    seconds,
    ms: Math.max(MIN_SECONDS, Number(seconds) || DEFAULT_TIMERS[kind]) * 1000,
    /** The class has a real alternative route. */
    switchable,
    /** This call will actually be switched, not merely reported. */
    autoSwitch: switchable && config?.autoSwitch !== false && config?.enabled !== false,
  };
}

/**
 * Download detection lives in `lib/download.js`, which owns the channel patterns and the
 * advisory text. Re-exported here so a caller that already imports classification has one
 * entry point for "what kind of call is this".
 */
export { detectDownload } from './download.js';
