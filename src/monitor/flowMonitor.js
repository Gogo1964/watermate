import { analyzeSeries } from '../analysis/series.js';
import { advanceFlow, createInitialFlowState, FLOW_EVENT } from '../analysis/flow.js';
import { renderContinuousFlowAlert } from '../mail/templates.js';
import { toLocalDate, formatDuration, formatInstant } from '../util/time.js';

/**
 * Incremental analysis pass that runs after every ingest.
 *
 * It walks only the readings newer than the persisted cursor
 * (`flow_state.last_ts`), so restarts resume exactly where the previous run
 * stopped and no interval is ever evaluated twice. The same pass records
 * data-quality anomalies, because both need the identical interval series.
 */
export function createFlowMonitor({ repository, config, alerts, logger }) {
  const log = logger.child({ component: 'flow' });
  const channel = config.meter.channel;

  function analysisOptions() {
    return {
      decreaseTolerance: config.analysis.decreaseTolerance,
      maxPlausibleDelta: config.analysis.maxPlausibleDelta,
      maxGapMs: config.analysis.maxGapMs,
      flowThreshold: config.continuousFlow.detectionThreshold,
      expectedIntervalMs: config.analysis.expectedIntervalMs,
    };
  }

  async function process(now = Date.now()) {
    const state = repository.getFlowState(channel) ?? createInitialFlowState(channel);
    const cursor = state.lastTs ?? -1;
    const fresh = repository.getReadingsAfter(channel, cursor);

    if (fresh.length === 0) {
      log.trace('No new readings to analyse', { cursor });
      return { processed: 0, events: [], alerts: [] };
    }

    // Prepend the cursor reading so the first new interval has a predecessor.
    const anchor =
      state.lastTs != null && state.lastValue != null
        ? [{ tsUtc: state.lastTs, value: state.lastValue }]
        : [];
    const analysis = analyzeSeries([...anchor, ...fresh], analysisOptions());

    recordAnomalies(analysis.anomalies, now);

    if (!config.continuousFlow.enabled) {
      // Still advance the cursor, otherwise the anomaly pass would repeat work.
      persistCursor(state, analysis, now);
      return { processed: fresh.length, events: [], alerts: [], flowDisabled: true };
    }

    const { state: nextState, events } = advanceFlow(state, analysis.intervals, {
      durationMs: config.continuousFlow.durationMs,
      reAlertMs: config.continuousFlow.reAlertMs,
    });

    for (const event of events) {
      if (event.type === FLOW_EVENT.END) {
        repository.recordFlowEpisode({
          channel,
          startedAt: event.startedAt,
          endedAt: event.endedAt,
          durationMs: event.durationMs,
          volume: event.volume,
          alerted: event.alerted,
          endReason: event.reason,
          localDate: toLocalDate(event.startedAt, config.timezone),
        });
        // Normal household use produces dozens of short episodes a day; only
        // the sustained ones are worth an INFO line.
        const notable = event.durationMs >= 3 * config.analysis.expectedIntervalMs;
        log[notable ? 'info' : 'debug']('Flow episode ended', {
          startedAt: formatInstant(event.startedAt, config.timezone, { withZone: false }),
          duration: formatDuration(event.durationMs),
          volume: event.volume,
          reason: event.reason,
        });
      } else if (event.type === FLOW_EVENT.START) {
        log.debug('Flow started', {
          startedAt: formatInstant(event.startedAt, config.timezone, { withZone: false }),
        });
      }
    }

    repository.saveFlowState(nextState, now);

    const dispatched = [];
    for (const event of events.filter((candidate) => candidate.type === FLOW_EVENT.ALERT)) {
      dispatched.push(await maybeAlert(event, now));
    }

    return { processed: fresh.length, events, alerts: dispatched, state: nextState };
  }

  async function maybeAlert(event, now) {
    // Backfilling an old CSV can replay a leak that ended days ago. Alerting on
    // that would be noise, so anything older than ALERT_MAX_AGE_HOURS is only
    // logged.
    const age = now - event.throughTs;
    if (age > config.alerts.maxAgeMs) {
      log.info('Skipping stale continuous-flow alert from backfilled data', {
        startedAt: formatInstant(event.startedAt, config.timezone, { withZone: false }),
        ageHours: (age / 3_600_000).toFixed(1),
      });
      return { sent: false, reason: 'stale' };
    }

    const { subject, html, text } = renderContinuousFlowAlert({ config, event, repeat: event.repeat });

    // The episode start is part of the key, so a new leak alerts immediately
    // while the current one stays suppressed.
    const dedupKey = `flow:${channel}:${event.startedAt}${event.repeat ? `:${event.throughTs}` : ''}`;
    const outcome = await alerts.dispatch({
      type: 'continuous_flow',
      dedupKey,
      cooldownMs: 0,
      subject,
      html,
      text,
      payload: {
        startedAt: event.startedAt,
        throughTs: event.throughTs,
        durationMs: event.durationMs,
        volume: event.volume,
      },
      now,
    });

    if (outcome.sent) {
      log.warn('Continuous flow alert dispatched', {
        startedAt: formatInstant(event.startedAt, config.timezone, { withZone: false }),
        duration: formatDuration(event.durationMs),
        volume: event.volume,
        repeat: event.repeat,
      });
    }
    return outcome;
  }

  function recordAnomalies(anomalies, now) {
    if (anomalies.length === 0) return;
    const enriched = anomalies.map((anomaly) => ({
      ...anomaly,
      channel,
      localDate: toLocalDate(anomaly.tsUtc, config.timezone),
    }));
    const stored = repository.recordAnomalies(enriched, { now });
    if (stored > 0) {
      for (const anomaly of enriched) {
        log.warn('Data-quality anomaly detected', {
          type: anomaly.type,
          at: formatInstant(anomaly.tsUtc, config.timezone, { withZone: false }),
          previousValue: anomaly.previousValue,
          value: anomaly.value,
          delta: anomaly.delta,
        });
      }
    }
  }

  function persistCursor(state, analysis, now) {
    const last = analysis.last;
    if (!last) return;
    repository.saveFlowState({ ...state, lastTs: last.tsUtc, lastValue: last.value }, now);
  }

  return { process, analysisOptions };
}
