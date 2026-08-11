/**
 * Consumption analysis over a series of *cumulative* meter readings.
 *
 * Column 3 of the CSV is an odometer, not a per-interval volume. Consumption is
 * therefore the difference between readings — but the naive
 * `last.value - first.value` is wrong as soon as the meter is exchanged or
 * reset, so this module accumulates per-interval deltas and treats implausible
 * ones as data-quality events instead of silently folding them into the total.
 *
 * The module is intentionally pure: no clock, no database, no I/O.
 */

export const ANOMALY = {
  DECREASE: 'meter_decrease',
  SPIKE: 'implausible_spike',
  GAP: 'data_gap',
  CONFLICT: 'duplicate_conflict',
};

/**
 * @param {Array<{tsUtc:number, value:number}>} readings ascending; the first
 *   entry acts as the baseline and contributes no consumption of its own.
 * @param {object} options
 * @param {number} [options.decreaseTolerance] negative deltas within this are
 *   treated as floating-point noise rather than a real meter decrease.
 * @param {number} [options.maxPlausibleDelta] a jump larger than this is
 *   counted but flagged as a spike.
 * @param {number} [options.maxGapMs] intervals longer than this are flagged as
 *   a gap; the volume still counts but continuity cannot be assumed.
 * @param {number} [options.flowThreshold] minimum delta that counts as "water
 *   is flowing" during an interval.
 * @param {number} [options.expectedIntervalMs] used to estimate how many
 *   readings a gap swallowed.
 */
export function analyzeSeries(readings, options = {}) {
  const {
    decreaseTolerance = 0,
    maxPlausibleDelta = Number.POSITIVE_INFINITY,
    maxGapMs = Number.POSITIVE_INFINITY,
    flowThreshold = 0,
    expectedIntervalMs = null,
  } = options;

  const { points, anomalies } = normalize(readings);

  const result = {
    points,
    count: points.length,
    first: points[0] ?? null,
    last: points.at(-1) ?? null,
    total: 0,
    rawDifference: points.length >= 2 ? points.at(-1).value - points[0].value : 0,
    intervals: [],
    anomalies,
    gaps: [],
    decreases: [],
    spikes: [],
    flowVolume: 0,
    flowingIntervals: 0,
  };

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    const durationMs = to.tsUtc - from.tsUtc;
    // Rounded to the meter's practical resolution: subtracting two large
    // odometer values leaves binary noise (0.0009999999999) that would
    // otherwise sit just below a configured threshold and never trigger.
    const delta = round(to.value - from.value);

    const interval = {
      fromTs: from.tsUtc,
      toTs: to.tsUtc,
      fromValue: from.value,
      toValue: to.value,
      durationMs,
      delta,
      contribution: 0,
      flowing: false,
      gap: false,
      decrease: false,
      spike: false,
    };

    if (durationMs > maxGapMs) {
      interval.gap = true;
      const missing = expectedIntervalMs ? Math.max(0, Math.round(durationMs / expectedIntervalMs) - 1) : null;
      const gap = { fromTs: from.tsUtc, toTs: to.tsUtc, durationMs, missingReadings: missing };
      result.gaps.push(gap);
      anomalies.push({
        type: ANOMALY.GAP,
        tsUtc: to.tsUtc,
        previousValue: from.value,
        value: to.value,
        delta,
        details: { durationMs, missingReadings: missing },
      });
    }

    if (delta < -decreaseTolerance) {
      // A decreasing odometer means a reset, an exchange or corrupt data.
      // Counting it would produce negative consumption, so it contributes
      // nothing and is surfaced instead.
      interval.decrease = true;
      const decrease = { tsUtc: to.tsUtc, previousValue: from.value, value: to.value, delta };
      result.decreases.push(decrease);
      anomalies.push({
        type: ANOMALY.DECREASE,
        tsUtc: to.tsUtc,
        previousValue: from.value,
        value: to.value,
        delta,
        details: { durationMs },
      });
    } else if (delta > 0) {
      // A positive delta is real consumption: the odometer only moves forward
      // when water passes the meter, so even a tenth of a litre counts.
      interval.contribution = delta;
      if (delta > maxPlausibleDelta) {
        interval.spike = true;
        result.spikes.push({ tsUtc: to.tsUtc, previousValue: from.value, value: to.value, delta });
        anomalies.push({
          type: ANOMALY.SPIKE,
          tsUtc: to.tsUtc,
          previousValue: from.value,
          value: to.value,
          delta,
          details: { durationMs, maxPlausibleDelta },
        });
      }
      result.total += delta;
      // With a threshold of 0 every forward movement counts as flow; otherwise
      // the delta has to reach the configured minimum before it is meaningful.
      if (flowThreshold > 0 ? delta >= flowThreshold : delta > 0) {
        interval.flowing = true;
        result.flowingIntervals += 1;
        result.flowVolume += delta;
      }
    }

    result.intervals.push(interval);
  }

  // Guard against floating point drift accumulating over hundreds of intervals.
  result.total = round(result.total);
  result.flowVolume = round(result.flowVolume);
  result.rawDifference = round(result.rawDifference);
  return result;
}

/**
 * Sorts, de-duplicates and validates raw readings.
 * Identical timestamps with identical values are silently collapsed; identical
 * timestamps with *different* values are a real problem and get flagged.
 */
function normalize(readings) {
  const anomalies = [];
  const sorted = [...readings]
    .filter((r) => r && Number.isFinite(r.tsUtc) && Number.isFinite(r.value))
    .sort((a, b) => a.tsUtc - b.tsUtc);

  const points = [];
  for (const reading of sorted) {
    const previous = points.at(-1);
    if (previous && previous.tsUtc === reading.tsUtc) {
      if (Math.abs(previous.value - reading.value) > 1e-9) {
        anomalies.push({
          type: ANOMALY.CONFLICT,
          tsUtc: reading.tsUtc,
          previousValue: previous.value,
          value: reading.value,
          delta: reading.value - previous.value,
          details: { kept: previous.value },
        });
      }
      continue;
    }
    points.push({ tsUtc: reading.tsUtc, value: reading.value, localDate: reading.localDate });
  }
  return { points, anomalies };
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Consumption over the trailing `windowMs`, used by the hourly threshold. */
export function consumptionInWindow(readings, endTs, windowMs, options = {}) {
  const startTs = endTs - windowMs;
  const within = readings.filter((r) => r.tsUtc >= startTs && r.tsUtc <= endTs);
  if (within.length < 2) return { total: 0, count: within.length, from: startTs, to: endTs };
  const analysis = analyzeSeries(within, options);
  return { total: analysis.total, count: analysis.count, from: within[0].tsUtc, to: within.at(-1).tsUtc };
}
