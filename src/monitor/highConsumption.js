import { buildDailySummary } from '../analysis/consumption.js';
import { consumptionInWindow } from '../analysis/series.js';
import { renderHighConsumptionAlert } from '../mail/templates.js';
import { toLocalDate, toLocalTime, localDayBounds } from '../util/time.js';

/**
 * Threshold-based high-consumption detection.
 *
 * Two independent checks, both configurable and both optional:
 *  - daily: consumption since local midnight against HIGH_CONSUMPTION_THRESHOLD,
 *    deduplicated per calendar day so a busy day alerts once, not every poll;
 *  - rolling window: consumption over the last HOURLY_WINDOW_MINUTES against
 *    HOURLY_HIGH_CONSUMPTION_THRESHOLD, deduplicated per clock hour with its
 *    own cooldown.
 *
 * Alerting on the running day (rather than waiting for the daily report) is the
 * point: a burst tub-filling is noticed while it still matters.
 */
export function createHighConsumptionMonitor({ repository, config, alerts, logger }) {
  const log = logger.child({ component: 'high-consumption' });
  const { highConsumption: settings, meter } = config;

  async function check(now = Date.now()) {
    if (!settings.enabled) return { checked: false, reason: 'disabled' };

    const outcomes = [];
    outcomes.push(await checkDaily(now));
    if (settings.hourlyThreshold != null) outcomes.push(await checkWindow(now));
    return { checked: true, outcomes: outcomes.filter(Boolean) };
  }

  async function checkDaily(now) {
    const date = toLocalDate(now, config.timezone);
    const summary = buildDailySummary({ repository, config, date });
    if (summary.readingCount === 0) return null;

    if (summary.total < settings.dailyThreshold) {
      log.trace('Daily consumption below threshold', {
        date,
        total: summary.total,
        threshold: settings.dailyThreshold,
      });
      return { scope: 'daily', date, total: summary.total, triggered: false };
    }

    const { subject, html, text } = renderHighConsumptionAlert({
      config,
      scope: 'daily',
      total: summary.total,
      threshold: settings.dailyThreshold,
      periodLabel: date,
      from: summary.windowStart,
      to: summary.endReadingAt ?? now,
      summary,
    });

    const outcome = await alerts.dispatch({
      type: 'high_consumption_daily',
      dedupKey: `high-daily:${meter.channel}:${date}`,
      cooldownMs: settings.cooldownMs,
      subject,
      html,
      text,
      payload: { date, total: summary.total, threshold: settings.dailyThreshold },
      now,
    });

    if (outcome.sent) {
      log.warn('Daily consumption exceeded threshold', {
        date,
        total: summary.total,
        threshold: settings.dailyThreshold,
      });
    }
    return { scope: 'daily', date, total: summary.total, triggered: true, ...outcome };
  }

  async function checkWindow(now) {
    // Anchor the window on the newest reading, not on wall-clock time: a stale
    // meter must not produce a "0 consumption" reading of the last hour.
    const latest = repository.getLatestReading(meter.channel);
    if (!latest) return null;
    if (now - latest.tsUtc > config.analysis.maxGapMs) return null;

    const from = latest.tsUtc - settings.hourlyWindowMs;
    const readings = repository.getReadingsBetween(meter.channel, from, latest.tsUtc + 1);
    const { total } = consumptionInWindow(readings, latest.tsUtc, settings.hourlyWindowMs, {
      decreaseTolerance: config.analysis.decreaseTolerance,
      maxPlausibleDelta: config.analysis.maxPlausibleDelta,
      maxGapMs: config.analysis.maxGapMs,
    });

    if (total < settings.hourlyThreshold) return { scope: 'window', total, triggered: false };

    const hourKey = `${toLocalDate(latest.tsUtc, config.timezone)}T${toLocalTime(latest.tsUtc, config.timezone).slice(0, 2)}`;
    const { subject, html, text } = renderHighConsumptionAlert({
      config,
      scope: 'window',
      total,
      threshold: settings.hourlyThreshold,
      periodLabel: `${settings.hourlyWindowMinutes} min up to ${toLocalTime(latest.tsUtc, config.timezone)}`,
      from,
      to: latest.tsUtc,
    });

    const outcome = await alerts.dispatch({
      type: 'high_consumption_window',
      dedupKey: `high-window:${meter.channel}:${hourKey}`,
      cooldownMs: settings.hourlyCooldownMs,
      subject,
      html,
      text,
      payload: { total, threshold: settings.hourlyThreshold, from, to: latest.tsUtc },
      now,
    });

    if (outcome.sent) {
      log.warn('Rolling window consumption exceeded threshold', {
        total,
        threshold: settings.hourlyThreshold,
        windowMinutes: settings.hourlyWindowMinutes,
      });
    }
    return { scope: 'window', total, triggered: true, ...outcome };
  }

  return { check, checkDaily, checkWindow };
}

/** Pure helper kept separate so the threshold rule itself is trivially testable. */
export function exceedsThreshold(total, threshold) {
  return Number.isFinite(total) && Number.isFinite(threshold) && threshold > 0 && total >= threshold;
}

/** Local-day bounds for a timestamp — used by tests and the CLI. */
export function dayWindowFor(now, timezone) {
  return localDayBounds(toLocalDate(now, timezone), timezone);
}
