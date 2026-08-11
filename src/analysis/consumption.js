import { analyzeSeries } from './series.js';
import { localDayBounds, formatDuration, addLocalDays } from '../util/time.js';

/**
 * Builds the consumption summary for one local calendar day.
 *
 * The day window is derived from the configured timezone, not from the CSV
 * filename, because a file named `data_2026-08-10.csv` may contain timestamps
 * that belong to a neighbouring day once the UTC offset is applied.
 *
 * Consumption for a day is measured from the last reading *before* midnight
 * (the baseline) to the last reading inside the day. Using the day's first
 * reading instead would silently drop whatever was used between midnight and
 * that reading.
 */
export function buildDailySummary({ repository, config, date, channel = config.meter.channel }) {
  const { timezone, analysis } = config;
  const { start, end } = localDayBounds(date, timezone);

  const readings = repository.getReadingsBetween(channel, start, end);
  const baseline = repository.getLastReadingBefore(channel, start);
  const usableBaseline =
    baseline && start - baseline.tsUtc <= analysis.anchorMaxAgeMs ? baseline : null;

  const series = usableBaseline ? [usableBaseline, ...readings] : readings;
  const result = analyzeSeries(series, {
    decreaseTolerance: analysis.decreaseTolerance,
    maxPlausibleDelta: analysis.maxPlausibleDelta,
    maxGapMs: analysis.maxGapMs,
    flowThreshold: config.continuousFlow.detectionThreshold,
    expectedIntervalMs: analysis.expectedIntervalMs,
  });

  const expectedReadings = Math.max(1, Math.round((end - start) / analysis.expectedIntervalMs));
  const sourceFile = repository.getSourceFile(date);
  const episodes = repository.getFlowEpisodesForDate(channel, date);

  const summary = {
    date,
    channel,
    timezone,
    windowStart: start,
    windowEnd: end,
    total: result.total,
    rawDifference: result.rawDifference,
    startValue: usableBaseline ? usableBaseline.value : (readings[0]?.value ?? null),
    endValue: readings.at(-1)?.value ?? null,
    startReadingAt: usableBaseline ? usableBaseline.tsUtc : (readings[0]?.tsUtc ?? null),
    endReadingAt: readings.at(-1)?.tsUtc ?? null,
    readingCount: readings.length,
    expectedReadings,
    baselineFromPreviousDay: Boolean(usableBaseline),
    gaps: result.gaps,
    decreases: result.decreases,
    spikes: result.spikes,
    anomalies: result.anomalies,
    intervals: result.intervals,
    peakInterval: findPeakInterval(result.intervals),
    hourly: bucketByHour(result.intervals, start, end),
    flowEpisodes: episodes.map((episode) => ({
      startedAt: Number(episode.started_at),
      endedAt: Number(episode.ended_at),
      durationMs: Number(episode.duration_ms),
      volume: episode.volume,
      alerted: episode.alerted === 1,
      endReason: episode.end_reason,
    })),
    invalidRows: sourceFile ? Number(sourceFile.rows_invalid) : 0,
    // Only counts as a failure when a download was actually attempted and never
    // succeeded — an absent record simply means the day was never polled.
    fileDownloaded: !sourceFile || Boolean(sourceFile.last_success_at),
    downloadFailures: sourceFile ? Number(sourceFile.fail_count) : 0,
  };

  summary.issues = describeIssues(summary, config);
  return summary;
}

/** Consumption for the current day so far, used by the live threshold check. */
export function consumptionToday({ repository, config, now, channel = config.meter.channel, date }) {
  const summary = buildDailySummary({ repository, config, date, channel });
  return { ...summary, asOf: now };
}

/** Turns raw analysis output into human-readable data-quality notes. */
export function describeIssues(summary, config) {
  const issues = [];

  if (summary.readingCount === 0) {
    issues.push({
      severity: 'error',
      code: 'no_readings',
      message: `No valid readings were recorded for ${summary.date}.`,
    });
    return issues;
  }

  if (!summary.baselineFromPreviousDay) {
    issues.push({
      severity: 'warning',
      code: 'missing_baseline',
      message:
        'No reading was available from before midnight, so consumption is measured from the ' +
        "day's first reading. Water used between midnight and that reading is not included.",
    });
  }

  const missing = summary.expectedReadings - summary.readingCount;
  const missingRatio = missing / summary.expectedReadings;
  if (missingRatio > 0.05) {
    issues.push({
      severity: missingRatio > 0.25 ? 'error' : 'warning',
      code: 'missing_readings',
      message:
        `Only ${summary.readingCount} of about ${summary.expectedReadings} expected readings ` +
        `were recorded (${missing} missing, ${(missingRatio * 100).toFixed(1)}%).`,
    });
  }

  for (const gap of summary.gaps) {
    issues.push({
      severity: 'warning',
      code: 'data_gap',
      message:
        `Gap of ${formatDuration(gap.durationMs)} without readings` +
        (gap.missingReadings ? ` (~${gap.missingReadings} readings missing).` : '.'),
      tsUtc: gap.toTs,
    });
  }

  for (const decrease of summary.decreases) {
    issues.push({
      severity: 'error',
      code: 'meter_decrease',
      message:
        `The meter reading decreased from ${decrease.previousValue} to ${decrease.value} ` +
        `(${decrease.delta.toFixed(4)} ${config.meter.unit}). This period was excluded from the ` +
        'total — it usually means a meter reset, an exchange or corrupted data.',
      tsUtc: decrease.tsUtc,
    });
  }

  for (const spike of summary.spikes) {
    issues.push({
      severity: 'warning',
      code: 'implausible_spike',
      message:
        `An unusually large jump of ${spike.delta.toFixed(4)} ${config.meter.unit} occurred in a ` +
        `single interval (limit ${config.analysis.maxPlausibleDelta} ${config.meter.unit}). ` +
        'It is included in the total but is worth verifying.',
      tsUtc: spike.tsUtc,
    });
  }

  if (summary.invalidRows > 0) {
    issues.push({
      severity: 'warning',
      code: 'invalid_rows',
      message: `${summary.invalidRows} CSV row(s) were rejected (meter error status or malformed data).`,
    });
  }

  if (!summary.fileDownloaded) {
    issues.push({
      severity: 'warning',
      code: 'file_not_downloaded',
      message:
        `The CSV file for ${summary.date} could not be downloaded ` +
        `(${summary.downloadFailures} failed attempt(s)).`,
    });
  }

  return issues;
}

function findPeakInterval(intervals) {
  let peak = null;
  for (const interval of intervals) {
    if (interval.contribution > 0 && (!peak || interval.contribution > peak.contribution)) peak = interval;
  }
  return peak;
}

/** Aggregates interval contributions into 24 hourly buckets for the report. */
export function bucketByHour(intervals, dayStart, dayEnd) {
  const hours = Math.max(1, Math.round((dayEnd - dayStart) / 3_600_000));
  const buckets = Array.from({ length: hours }, (_, index) => ({ hour: index, total: 0 }));

  for (const interval of intervals) {
    if (interval.contribution <= 0) continue;
    // Attribute the volume to the hour the interval ended in; intervals are
    // short compared with an hour, so splitting them adds noise, not accuracy.
    const index = Math.floor((interval.toTs - dayStart) / 3_600_000);
    if (index >= 0 && index < buckets.length) {
      buckets[index].total = Math.round((buckets[index].total + interval.contribution) * 1e6) / 1e6;
    }
  }
  return buckets;
}

/** Compares a day against the same weekday and the trailing average. */
export function buildComparison({ repository, config, date, channel = config.meter.channel, days = 7 }) {
  const totals = [];
  for (let offset = 1; offset <= days; offset += 1) {
    const previousDate = addLocalDays(date, -offset);
    const { start, end } = localDayBounds(previousDate, config.timezone);
    const readings = repository.getReadingsBetween(channel, start, end);
    if (readings.length < 2) continue;
    const baseline = repository.getLastReadingBefore(channel, start);
    const series = baseline && start - baseline.tsUtc <= config.analysis.anchorMaxAgeMs
      ? [baseline, ...readings]
      : readings;
    const { total } = analyzeSeries(series, {
      decreaseTolerance: config.analysis.decreaseTolerance,
      maxPlausibleDelta: config.analysis.maxPlausibleDelta,
      maxGapMs: config.analysis.maxGapMs,
    });
    totals.push({ date: previousDate, total });
  }

  if (totals.length === 0) return null;
  const average = totals.reduce((sum, entry) => sum + entry.total, 0) / totals.length;
  return {
    days: totals.length,
    average: Math.round(average * 1e6) / 1e6,
    previous: totals[0] ?? null,
    history: totals,
  };
}
