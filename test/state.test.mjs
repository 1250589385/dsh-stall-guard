/**
 * The stall monitor's state machine.
 *
 * The Client renders exactly what this produces, so the two things that must hold are:
 * `mode` never contradicts the facts (alert wins, then watching, then idle), and an
 * acknowledgement silences the animation without erasing the history.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StallMonitor, LEVEL_FAILED, LEVEL_NONE, LEVEL_NOTICE, LEVEL_SWITCHED } from '../lib/state.js';
import { createClock } from './helpers.mjs';

function monitorAt(start = 1_700_000_000_000) {
  const clock = createClock(start);
  return { monitor: new StallMonitor({ now: clock.now }), clock };
}

test('a fresh monitor is idle with zeroed counters', () => {
  const { monitor } = monitorAt();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.supervisor.mode, 'idle');
  assert.equal(snapshot.supervisor.level, LEVEL_NONE);
  assert.deepEqual(snapshot.stats, { stalls: 0, switches: 0, notices: 0, since: snapshot.stats.since });
  assert.deepEqual(snapshot.recent, []);
});

test('an in-flight call moves the posture to watching', () => {
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 30000 });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.supervisor.mode, 'watching');
  assert.equal(snapshot.supervisor.tool, 'bash');
  assert.equal(snapshot.supervisor.kind, 'exec');
  assert.equal(snapshot.supervisor.timeoutMs, 30000);
});

test('elapsed time in the snapshot is derived from the clock', () => {
  const { monitor, clock } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 30000 });
  clock.advance(4200);
  assert.equal(monitor.snapshot().supervisor.elapsedMs, 4200);
});

test('an unnotified stall raises an alert at notice level and counts a notice', () => {
  const { monitor, clock } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 30000 });
  clock.advance(30000);
  monitor.stall({
    callId: 'c1',
    tool: 'bash',
    kind: 'exec',
    elapsedMs: 30000,
    timeoutMs: 30000,
    action: 'notify',
    level: LEVEL_NOTICE,
    message: 'bash has run 30s',
  });

  const snapshot = monitor.snapshot();
  assert.equal(snapshot.supervisor.mode, 'alert');
  assert.equal(snapshot.supervisor.level, LEVEL_NOTICE);
  assert.equal(snapshot.supervisor.action, 'notify');
  assert.equal(snapshot.supervisor.message, 'bash has run 30s');
  assert.equal(snapshot.stats.stalls, 1);
  assert.equal(snapshot.stats.notices, 1);
  assert.equal(snapshot.stats.switches, 0);
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].tool, 'bash');
});

test('a switch raises its own counter and records the fallback', () => {
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', timeoutMs: 15000 });
  monitor.stall({
    callId: 'c1',
    tool: 'web_fetch',
    kind: 'fetch',
    elapsedMs: 15000,
    timeoutMs: 15000,
    action: 'switch',
    level: LEVEL_SWITCHED,
    fallback: 'web_search',
    fallbackOk: true,
  });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.stats.switches, 1);
  assert.equal(snapshot.stats.notices, 0);
  assert.equal(snapshot.supervisor.fallback, 'web_search');
  assert.equal(snapshot.supervisor.fallbackOk, true);
});

test('a new call clears the previous alert: the agent has moved on', () => {
  // Requested behaviour: once the stalled work is over and the agent starts its next call,
  // the notice is stale and must clear by itself instead of waiting for a click.
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 30000 });
  monitor.stall({ callId: 'c1', tool: 'bash', kind: 'exec', elapsedMs: 30000, timeoutMs: 30000, action: 'notify', level: LEVEL_NOTICE });
  monitor.end('c1');
  assert.equal(monitor.snapshot().supervisor.mode, 'alert', 'the alert waits for the user once work stops');

  monitor.begin({ callId: 'c2', tool: 'read', kind: 'read', timeoutMs: 20000 });
  assert.equal(monitor.snapshot().supervisor.mode, 'watching', 'the previous alert must be gone');
});

test('refine keeps the alert level from regressing', () => {
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', timeoutMs: 15000 });
  monitor.stall({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', elapsedMs: 15000, timeoutMs: 15000, action: 'switch', level: LEVEL_SWITCHED, fallback: 'web_search' });
  // A later downgrade attempt must not hide a successful switch.
  monitor.refine({ callId: 'c1', level: LEVEL_NOTICE, message: 'later text' });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.supervisor.level, LEVEL_SWITCHED);
  assert.equal(snapshot.supervisor.message, 'later text');
});

test('refine does not double-count the stall', () => {
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', timeoutMs: 15000 });
  monitor.stall({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', elapsedMs: 15000, timeoutMs: 15000, action: 'switch', level: LEVEL_NOTICE });
  monitor.refine({ callId: 'c1', level: LEVEL_SWITCHED, fallbackOk: true, action: 'switch' });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.stats.stalls, 1, 'the refinement must not count a second stall');
  assert.equal(snapshot.stats.switches, 1, 'the single switch is counted once, at the timeout');
  assert.equal(snapshot.stats.notices, 0);
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].ok, true);
});

test('a failed fallback is recorded as a failure, not a success', () => {
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', timeoutMs: 15000 });
  monitor.stall({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', elapsedMs: 15000, timeoutMs: 15000, action: 'switch', level: LEVEL_NOTICE });
  monitor.refine({ callId: 'c1', level: LEVEL_FAILED, fallbackOk: false, action: 'switch' });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.supervisor.level, LEVEL_FAILED);
  assert.equal(snapshot.supervisor.fallbackOk, false);
  assert.equal(snapshot.recent[0].ok, false);
});

test('acknowledgement silences the alert but keeps the history', () => {
  const { monitor, clock } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 30000 });
  monitor.stall({ callId: 'c1', tool: 'bash', kind: 'exec', elapsedMs: 30000, timeoutMs: 30000, action: 'notify', level: LEVEL_NOTICE });
  monitor.end('c1');

  const afterAck = monitor.acknowledge();
  assert.equal(afterAck.recent.length, 1, 'acknowledging must not erase the history');
  assert.equal(afterAck.stats.stalls, 1);

  // The linger window keeps the posture quiet but not yet idle.
  clock.advance(1000);
  assert.notEqual(monitor.snapshot().supervisor.mode, 'alert', 'an acknowledged alert must stop animating');

  clock.advance(20000);
  assert.equal(monitor.snapshot().supervisor.mode, 'idle', 'after the linger the supervisor returns to idle');
});

test('acknowledging while work continues returns to watching, not idle', () => {
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 30000 });
  monitor.stall({ callId: 'c1', tool: 'bash', kind: 'exec', elapsedMs: 30000, timeoutMs: 30000, action: 'notify', level: LEVEL_NOTICE });
  monitor.begin({ callId: 'c2', tool: 'read', kind: 'read', timeoutMs: 20000 });
  monitor.acknowledge();
  assert.equal(monitor.snapshot().supervisor.mode, 'watching');
});

test('history is capped at ten entries, newest first', () => {
  const { monitor } = monitorAt();
  for (let index = 0; index < 15; index += 1) {
    monitor.stall({
      callId: `c${index}`,
      tool: `tool-${index}`,
      kind: 'other',
      elapsedMs: 1000,
      timeoutMs: 30000,
      action: 'notify',
      level: LEVEL_NOTICE,
    });
  }
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.recent.length, 10);
  assert.equal(snapshot.recent[0].tool, 'tool-14', 'the newest entry must be first');
  assert.equal(snapshot.stats.stalls, 15, 'the counters are not capped');
});

test('the revision advances on every observable change', () => {
  const { monitor } = monitorAt();
  const first = monitor.snapshot().revision;
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 30000 });
  const second = monitor.snapshot().revision;
  monitor.end('c1');
  const third = monitor.snapshot().revision;
  assert.ok(second > first);
  assert.ok(third > second);
});

test('a stall with no matching in-flight call still publishes', () => {
  const { monitor } = monitorAt();
  // The wrapper's timer can fire after `end` on a fast tool that ignored the abort.
  monitor.stall({ callId: 'ghost', tool: 'web_fetch', kind: 'fetch', elapsedMs: 15000, timeoutMs: 15000, action: 'switch', level: LEVEL_SWITCHED });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.supervisor.mode, 'alert');
  assert.equal(snapshot.stats.stalls, 1);
});

test('download flags survive into the snapshot and history', () => {
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 30000, download: true });
  monitor.stall({ callId: 'c1', tool: 'bash', kind: 'exec', elapsedMs: 31000, timeoutMs: 30000, action: 'notify', level: LEVEL_NOTICE, download: true });
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.supervisor.download, true);
  assert.equal(snapshot.recent[0].download, true);
});

test('a message-only refine leaves the level untouched and finite', () => {
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', timeoutMs: 15000 });
  monitor.stall({ callId: 'c1', tool: 'web_fetch', kind: 'fetch', elapsedMs: 15000, timeoutMs: 15000, action: 'notify', level: LEVEL_NOTICE });

  // The supervisor's model sentence arrives later and carries no level of its own.
  monitor.refine({ callId: 'c1', message: 'the model wrote this', source: 'model' });

  const snapshot = monitor.snapshot();
  assert.equal(snapshot.supervisor.level, LEVEL_NOTICE, 'a message-only refine must not erase the level');
  assert.equal(snapshot.supervisor.message, 'the model wrote this');
  assert.equal(snapshot.supervisor.source, 'model');
  assert.equal(snapshot.recent[0].level, LEVEL_NOTICE);
});

test('no published field is ever NaN or undefined', () => {
  const { monitor } = monitorAt();
  monitor.begin({ callId: 'c1', tool: 'ops_bash', kind: 'exec', timeoutMs: 1000 });
  monitor.stall({ callId: 'c1', tool: 'ops_bash', kind: 'exec', elapsedMs: 1008, timeoutMs: 1000, action: 'notify', level: LEVEL_NOTICE });
  monitor.end('c1');

  const snapshot = monitor.snapshot();
  // JSON.stringify turns NaN into null and drops undefined, which is exactly the wire
  // damage this guards against.
  const wire = JSON.parse(JSON.stringify(snapshot));
  assert.equal(wire.supervisor.level, LEVEL_NOTICE);
  assert.equal(wire.recent[0].level, LEVEL_NOTICE);
  for (const key of ['mode', 'level', 'since', 'elapsedMs', 'timeoutMs']) {
    assert.ok(wire.supervisor[key] !== null && wire.supervisor[key] !== undefined, `supervisor.${key} went missing on the wire`);
  }
  for (const key of ['at', 'tool', 'kind', 'elapsedMs', 'timeoutMs', 'action', 'level']) {
    assert.ok(wire.recent[0][key] !== null && wire.recent[0][key] !== undefined, `recent[0].${key} went missing on the wire`);
  }
});

test('an unacknowledged alert expires after its lifetime', () => {
  // Without this the figure stays lit for the rest of the session on a busy machine.
  const clock = createClock(1_700_000_000_000);
  const monitor = new StallMonitor({ now: clock.now, alertSeconds: 5 });
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 1000 });
  monitor.stall({ callId: 'c1', tool: 'bash', kind: 'exec', elapsedMs: 1000, timeoutMs: 1000, action: 'notify', level: LEVEL_NOTICE, message: 'x' });
  monitor.end('c1');
  assert.equal(monitor.snapshot().supervisor.mode, 'alert');

  clock.advance(4_000);
  monitor.settleAlert();
  assert.equal(monitor.snapshot().supervisor.mode, 'alert', 'still inside the lifetime');

  clock.advance(2_000);
  monitor.settleAlert();
  assert.notEqual(monitor.snapshot().supervisor.mode, 'alert', 'expired alerts must clear themselves');
  assert.equal(monitor.snapshot().recent.length, 1, 'expiry must not erase the history');
});

test('a lifetime of zero keeps the alert until acknowledged', () => {
  const clock = createClock(1_700_000_000_000);
  const monitor = new StallMonitor({ now: clock.now, alertSeconds: 0 });
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 1000 });
  monitor.stall({ callId: 'c1', tool: 'bash', kind: 'exec', elapsedMs: 1000, timeoutMs: 1000, action: 'notify', level: LEVEL_NOTICE });
  monitor.end('c1');

  clock.advance(10 * 60 * 1000);
  monitor.settleAlert();
  assert.equal(monitor.snapshot().supervisor.mode, 'alert', '0 disables the timer');

  monitor.acknowledge();
  clock.advance(20_000);
  monitor.settleAlert();
  assert.equal(monitor.snapshot().supervisor.mode, 'idle');
});

test('the alert carries an expiry on the wire', () => {
  const clock = createClock(1_700_000_000_000);
  const monitor = new StallMonitor({ now: clock.now, alertSeconds: 30 });
  monitor.begin({ callId: 'c1', tool: 'bash', kind: 'exec', timeoutMs: 1000 });
  monitor.stall({ callId: 'c1', tool: 'bash', kind: 'exec', elapsedMs: 1000, timeoutMs: 1000, action: 'notify', level: LEVEL_NOTICE });
  const snapshot = monitor.snapshot();
  assert.ok(snapshot.supervisor.expiresAt > clock.now(), 'the expiry must be published');
});

test('setAlertSeconds changes the lifetime at runtime', () => {
  const clock = createClock(1_700_000_000_000);
  const monitor = new StallMonitor({ now: clock.now, alertSeconds: 60 });
  monitor.setAlertSeconds(3);
  assert.equal(monitor.alertSeconds, 3);
  monitor.setAlertSeconds(0);
  assert.equal(monitor.alertSeconds, 0, 'zero is a valid "never expire" value');
});
