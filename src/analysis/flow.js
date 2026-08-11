/**
 * Continuous-flow detection.
 *
 * Readings arrive every few minutes, so "water is flowing" cannot be observed
 * directly — it is inferred per interval: the meter moved by at least
 * `FLOW_DETECTION_THRESHOLD` between two consecutive readings. An episode is a
 * run of consecutive flowing intervals; once its duration passes
 * `CONTINUOUS_FLOW_DURATION_HOURS` an alert fires exactly once (optionally
 * repeating after `CONTINUOUS_FLOW_REALERT_HOURS`).
 *
 * Missing data is handled conservatively: an interval flagged as a gap ends the
 * episode instead of extending it, because nothing can be said about what
 * happened while readings were missing. That may miss a leak, but it never
 * invents a three-hour flow out of a network outage.
 *
 * The detector is pure — state in, state plus events out — so restarts are just
 * a matter of loading the previous state from SQLite.
 */

export const FLOW_EVENT = {
  START: 'flow_start',
  END: 'flow_end',
  ALERT: 'flow_alert',
};

export function createInitialFlowState(channel) {
  return {
    channel,
    flowing: false,
    startedAt: null,
    lastFlowTs: null,
    lastTs: null,
    lastValue: null,
    volume: 0,
    alerted: false,
    alertedAt: null,
  };
}

/**
 * Advances the detector over a list of intervals from {@link analyzeSeries}.
 *
 * @param {object} state previous state (from the database, or a fresh one)
 * @param {Array} intervals consecutive intervals, oldest first
 * @param {object} options
 * @param {number} options.durationMs how long a flow must last to alert
 * @param {number} [options.reAlertMs] 0 disables repeat alerts
 * @returns {{state: object, events: Array}}
 */
export function advanceFlow(state, intervals, { durationMs, reAlertMs = 0 } = {}) {
  const next = { ...state };
  const events = [];

  for (const interval of intervals) {
    if (interval.gap) {
      // Continuity is unknown across a gap — close any open episode.
      if (next.flowing) {
        events.push(endEpisode(next, interval.fromTs, 'data_gap'));
      }
      reset(next);
      next.lastTs = interval.toTs;
      next.lastValue = interval.toValue;
      continue;
    }

    if (interval.flowing) {
      if (!next.flowing) {
        next.flowing = true;
        next.startedAt = interval.fromTs;
        next.volume = 0;
        next.alerted = false;
        next.alertedAt = null;
        events.push({
          type: FLOW_EVENT.START,
          channel: next.channel,
          startedAt: interval.fromTs,
        });
      }
      next.volume = round(next.volume + interval.contribution);
      next.lastFlowTs = interval.toTs;

      const elapsed = interval.toTs - next.startedAt;
      if (elapsed >= durationMs) {
        const firstAlert = !next.alerted;
        const dueAgain =
          next.alerted && reAlertMs > 0 && interval.toTs - next.alertedAt >= reAlertMs;

        if (firstAlert || dueAgain) {
          next.alerted = true;
          next.alertedAt = interval.toTs;
          events.push({
            type: FLOW_EVENT.ALERT,
            channel: next.channel,
            startedAt: next.startedAt,
            throughTs: interval.toTs,
            durationMs: elapsed,
            volume: next.volume,
            repeat: !firstAlert,
          });
        }
      }
    } else if (next.flowing) {
      // The meter stood still for a whole interval: the flow has stopped.
      events.push(endEpisode(next, interval.fromTs, 'flow_stopped'));
      reset(next);
    }

    next.lastTs = interval.toTs;
    next.lastValue = interval.toValue;
  }

  return { state: next, events };
}

function endEpisode(state, endedAt, reason) {
  const end = state.lastFlowTs ?? endedAt;
  return {
    type: FLOW_EVENT.END,
    channel: state.channel,
    startedAt: state.startedAt,
    endedAt: end,
    durationMs: Math.max(0, end - state.startedAt),
    volume: state.volume,
    alerted: state.alerted,
    reason,
  };
}

function reset(state) {
  state.flowing = false;
  state.startedAt = null;
  state.lastFlowTs = null;
  state.volume = 0;
  state.alerted = false;
  state.alertedAt = null;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** How long the currently open episode has been running at `now`. */
export function currentFlowDuration(state, now) {
  if (!state?.flowing || state.startedAt == null) return 0;
  return Math.max(0, (state.lastFlowTs ?? now) - state.startedAt);
}
