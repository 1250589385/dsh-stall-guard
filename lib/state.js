/**
 * Live stall state: what is running, what timed out, and what the supervisor shows.
 *
 * The Client polls a snapshot every second, so this module keeps everything in memory
 * and never blocks. Two invariants matter:
 *
 *  - `mode` is derived, not assigned, from "are calls in flight?" and "is an alert
 *    unacknowledged?". Deriving it keeps the three transitions (start / timeout / ack)
 *    from being able to contradict each other.
 *  - The alert survives until the user acknowledges it, even if the underlying call
 *    finishes, because a supervisor that goes quiet by itself is easy to miss.
 */

const MAX_RECENT = 10;
/** After the alert is acknowledged, the supervisor keeps reporting for this long. */
const ALERT_LINGER_MS = 12000;

/**
 * How long an alert stays on screen without being acknowledged.
 *
 * An alert that waits for a click never goes away on a busy machine, so the figure stays lit
 * for the rest of the session. A bounded lifetime makes it an actual notification. `0` means
 * "stay until acknowledged", which is the old behaviour and remains available.
 */
export const DEFAULT_ALERT_SECONDS = 30;

export const LEVEL_NONE = 0;
export const LEVEL_NOTICE = 1;
export const LEVEL_SWITCHED = 2;
export const LEVEL_FAILED = 3;

/**
 * One process-wide stall monitor.
 *
 * `revision` increments on every observable change so a polling client can cheaply
 * detect staleness, and so tests can assert that a state change was published.
 */
export class StallMonitor {
  constructor({ now = () => Date.now(), alertSeconds = DEFAULT_ALERT_SECONDS } = {}) {
    this.now = now;
    this.alertSeconds = Number.isFinite(alertSeconds) && alertSeconds > 0 ? Math.round(alertSeconds) : 0;
    this.startedAt = now();
    this.inFlight = new Map();
    this.alert = null;
    this.recent = [];
    this.stats = { stalls: 0, switches: 0, notices: 0 };
    this.revision = 0;
  }

  bump() {
    this.revision += 1;
  }

  /** Register one dispatched call. Called before `next()`, so the timer can find it. */
  begin({ callId, tool, kind, timeoutMs, download = false }) {
    // A new call starting means the agent recovered and moved on. Any alert from the
    // previous call has been read by then, so it is cleared here rather than waiting for a
    // click or a timer.
    if (this.alert) {
      this.alert.acknowledged = true;
      this.alert.acknowledgedAt = this.now();
      this.alert.resolvedBy = 'next-call';
    }

    this.inFlight.set(callId, {
      callId,
      tool,
      kind,
      timeoutMs,
      download,
      startedAt: this.now(),
      timedOut: false,
      action: null,
      fallback: null,
      fallbackOk: null,
      level: LEVEL_NONE,
    });
    this.bump();
    this.settleAlert();
    return this.inFlight.get(callId);
  }

  /** Look up a call that may already be gone if the wrapper threw before `end`. */
  get(callId) {
    return this.inFlight.get(callId);
  }

  /** Remove one call from the in-flight table and settle any alert it produced. */
  end(callId) {
    this.inFlight.delete(callId);
    this.bump();
    this.settleAlert();
  }

  /**
   * Publish one stall.
   *
   * `action` is what actually happened: `switch` only when a fallback was attempted,
   * `notify` otherwise. `level` drives the visual intensity and is decided by the
   * caller from the fallback outcome.
   */
  stall({ callId, tool, kind, elapsedMs, timeoutMs, action, level, fallback = null, fallbackOk = null, message = '', source = 'none', download = false }) {
    const at = this.now();
    // `level` belongs on the record from the start: a notify-only stall never goes through
    // `refine`, so leaving it out here would publish an undefined level to the Client.
    const record = { at, tool, kind, elapsedMs: Math.round(elapsedMs), timeoutMs, action, fallback, ok: fallbackOk, download, level };
    this.recent.unshift(record);
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;

    this.stats.stalls += 1;
    if (action === 'switch') this.stats.switches += 1;
    else this.stats.notices += 1;

    // A strong fallback verdict outranks a weak one: if two calls stall at once, the
    // supervisor must not downgrade a "switched successfully" alert to "switched and failed".
    const previousLevel = Number.isFinite(this.alert?.level) ? this.alert.level : LEVEL_NONE;
    const effectiveLevel = Math.max(previousLevel, Number.isFinite(level) ? level : LEVEL_NOTICE);

    this.alert = {
      since: this.alert?.since ?? at,
      /* Expiry is published on the wire so the Client can show a countdown if it wants. */
      expiresAt: this.alertSeconds > 0 ? at + this.alertSeconds * 1000 : 0,
      updatedAt: at,
      level: effectiveLevel,
      tool,
      kind,
      elapsedMs: Math.round(elapsedMs),
      timeoutMs,
      action,
      fallback,
      fallbackOk,
      message,
      source,
      download,
      acknowledged: false,
    };

    const call = this.inFlight.get(callId);
    if (call) {
      call.timedOut = true;
      call.action = action;
      call.fallback = fallback;
      call.fallbackOk = fallbackOk;
      call.level = effectiveLevel;
    }

    this.bump();
  }

  /**
   * Refine an alert that is already published: the fallback resolved, or the model
   * produced a sentence.
   *
   * Separate from `stall` because the stall itself was counted once, at the timeout.
   * Publishing the refinement through `stall` would count the same event a second time
   * and would also re-apply the "previous level wins" rule against the alert's own
   * level, which would make a failed fallback look like a success.
   */
  refine({ callId, level, fallback, fallbackOk, message, source, action }) {
    const at = this.now();
    if (!this.alert) return;

    // `level` is optional: a message-only refinement (the supervisor's model sentence
    // arriving after the alert) must not touch it. `Math.max(x, undefined)` is NaN, so
    // an absent level has to be skipped rather than defaulted.
    if (Number.isFinite(level)) this.alert.level = Math.max(this.alert.level ?? LEVEL_NONE, level);
    this.alert.updatedAt = at;
    if (fallback !== undefined) this.alert.fallback = fallback;
    if (fallbackOk !== undefined) this.alert.fallbackOk = fallbackOk;
    if (action !== undefined) this.alert.action = action;
    if (message !== undefined) {
      this.alert.message = message;
      this.alert.source = source ?? this.alert.source;
    }

    // The newest record is this event's; keep it in step with the alert so the history
    // row and the badge never disagree.
    const head = this.recent[0];
    if (head) {
      head.ok = this.alert.fallbackOk;
      head.action = this.alert.action;
      head.fallback = this.alert.fallback;
      head.level = this.alert.level;
    }

    const call = callId === undefined ? undefined : this.inFlight.get(callId);
    if (call) {
      call.level = this.alert.level;
      call.fallback = this.alert.fallback;
      call.fallbackOk = this.alert.fallbackOk;
      call.action = this.alert.action;
    }

    this.bump();
  }

  /**
   * Acknowledge the current alert.
   *
   * The record stays in `recent` and the counters stay put: acknowledging silences the
   * animation, it does not erase the history the user may still want to read.
   */
  acknowledge() {
    if (this.alert) {
      this.alert.acknowledged = true;
      this.alert.acknowledgedAt = this.now();
    }
    this.bump();
    this.settleAlert();
    return this.snapshot();
  }

  /**
   * Drop the alert when it has served its purpose.
   *
   * Two ways out, so the figure cannot stay lit forever:
   *   - it was acknowledged and both the linger window and any in-flight work are done,
   *   - its lifetime elapsed (`alertSeconds`); an unacknowledged alert then simply expires.
   *
   * An expired alert is marked acknowledged on the way out so `mode()` stops reporting it
   * without needing a separate flag.
   */
  settleAlert() {
    if (!this.alert) return;

    if (!this.alert.acknowledged) {
      const expiresAt = this.alert.expiresAt ?? 0;
      if (expiresAt === 0) return; // lifetime disabled: wait for the user
      if (this.now() < expiresAt) return;
      this.alert.acknowledged = true;
      this.alert.acknowledgedAt = expiresAt;
      this.alert.expired = true;
    }

    // Recovery is not a dismissal: when the agent has already started its next call, the
    // notice is stale and must go at once. A manual acknowledge keeps the short linger so the
    // figure does not look like it reset the problem.
    if (this.alert.resolvedBy === 'next-call') {
      this.alert = null;
      this.bump();
      return;
    }

    const lingering = this.inFlight.size > 0 || this.now() - (this.alert.acknowledgedAt ?? 0) < ALERT_LINGER_MS;
    if (lingering) return;
    this.alert = null;
    this.bump();
  }

  /** Configure the alert lifetime; 0 keeps the old "until acknowledged" behaviour. */
  setAlertSeconds(seconds) {
    const value = Number(seconds);
    this.alertSeconds = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    this.bump();
  }

  /** Derived posture: an unacknowledged alert wins, then any in-flight work, then idle. */
  mode() {
    if (this.alert && !this.alert.acknowledged) return 'alert';
    return this.inFlight.size > 0 ? 'watching' : 'idle';
  }

  /** The wire shape documented in CONTRACT.md §3. */
  snapshot() {
    const at = this.now();
    const mode = this.mode();
    const longest = [...this.inFlight.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
    const alert = this.alert;

    return {
      ok: true,
      revision: this.revision,
      now: at,
      supervisor: {
        mode,
        since: alert?.since ?? 0,
        /* 0 means "no expiry": the alert waits for an acknowledgement. */
        expiresAt: alert?.expiresAt ?? 0,
        level: mode === 'alert' ? (alert?.level ?? LEVEL_NONE) : alert?.acknowledged ? (alert.level ?? LEVEL_NONE) : LEVEL_NONE,
        tool: mode === 'alert' ? alert.tool : (longest?.tool ?? null),
        kind: mode === 'alert' ? alert.kind : (longest?.kind ?? null),
        elapsedMs: mode === 'alert' ? alert.elapsedMs : longest ? at - longest.startedAt : 0,
        timeoutMs: mode === 'alert' ? alert.timeoutMs : (longest?.timeoutMs ?? 0),
        action: mode === 'alert' ? alert.action : null,
        fallback: mode === 'alert' ? alert.fallback : null,
        fallbackOk: mode === 'alert' ? alert.fallbackOk : null,
        message: alert?.message ?? '',
        source: alert?.source ?? 'none',
        download: mode === 'alert' ? Boolean(alert.download) : Boolean(longest?.download),
      },
      stats: { ...this.stats, since: this.startedAt },
      recent: this.recent.map((entry) => ({ ...entry })),
    };
  }
}
