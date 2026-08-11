import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSeries, consumptionInWindow, ANOMALY } from '../src/analysis/series.js';
import { makeReadings, berlinSummer } from './helpers.js';

const OPTIONS = {
  decreaseTolerance: 0.0005,
  maxPlausibleDelta: 1,
  maxGapMs: 30 * 60_000,
  flowThreshold: 0.001,
  expectedIntervalMs: 5 * 60_000,
};

const START = berlinSummer(8, 0);

test('consumption is the difference between readings, not the sum of column 3', () => {
  // Cumulative odometer: 100.0 → 100.6 means 0.6 was consumed, even though the
  // individual readings are large numbers.
  const readings = makeReadings({ startTs: START, start: 100, deltas: [0.2, 0.1, 0.3] });
  const result = analyzeSeries(readings, OPTIONS);

  assert.equal(result.total, 0.6);
  assert.equal(result.first.value, 100);
  assert.equal(result.last.value, 100.6);
  assert.equal(result.rawDifference, 0.6);
});

test('a single reading yields zero consumption rather than a wrong number', () => {
  const result = analyzeSeries([{ tsUtc: START, value: 100 }], OPTIONS);
  assert.equal(result.total, 0);
  assert.equal(result.intervals.length, 0);
});

test('an empty series is handled', () => {
  const result = analyzeSeries([], OPTIONS);
  assert.equal(result.total, 0);
  assert.equal(result.count, 0);
  assert.equal(result.first, null);
});

test('exact duplicate readings are collapsed and do not double-count', () => {
  const readings = [
    { tsUtc: START, value: 100 },
    { tsUtc: START + 300_000, value: 100.2 },
    { tsUtc: START + 300_000, value: 100.2 }, // same file downloaded twice
    { tsUtc: START + 600_000, value: 100.3 },
  ];
  const result = analyzeSeries(readings, OPTIONS);

  assert.equal(result.count, 3);
  assert.equal(result.total, 0.3);
  assert.equal(result.anomalies.length, 0);
});

test('a duplicate timestamp with a different value is flagged, not averaged', () => {
  const readings = [
    { tsUtc: START, value: 100 },
    { tsUtc: START + 300_000, value: 100.2 },
    { tsUtc: START + 300_000, value: 105 },
  ];
  const result = analyzeSeries(readings, OPTIONS);

  assert.equal(result.count, 2);
  assert.equal(result.total, 0.2);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].type, ANOMALY.CONFLICT);
});

test('unsorted input is sorted before analysis', () => {
  const readings = [
    { tsUtc: START + 600_000, value: 100.3 },
    { tsUtc: START, value: 100 },
    { tsUtc: START + 300_000, value: 100.1 },
  ];
  assert.equal(analyzeSeries(readings, OPTIONS).total, 0.3);
});

test('a meter decrease never produces negative consumption and is reported', () => {
  const readings = [
    { tsUtc: START, value: 100 },
    { tsUtc: START + 300_000, value: 100.5 },
    { tsUtc: START + 600_000, value: 5 }, // meter exchanged or reset
    { tsUtc: START + 900_000, value: 5.2 },
  ];
  const result = analyzeSeries(readings, OPTIONS);

  assert.equal(result.total, 0.7); // 0.5 before the reset + 0.2 after it
  assert.ok(result.total >= 0);
  assert.equal(result.decreases.length, 1);
  assert.equal(result.decreases[0].previousValue, 100.5);
  assert.equal(result.decreases[0].value, 5);
  assert.equal(result.anomalies.filter((a) => a.type === ANOMALY.DECREASE).length, 1);
  // The naive end-minus-start calculation would have reported a negative value.
  assert.ok(result.rawDifference < 0);
});

test('floating point noise below the tolerance is not treated as a decrease', () => {
  const readings = [
    { tsUtc: START, value: 100.0002 },
    { tsUtc: START + 300_000, value: 100.0 },
    { tsUtc: START + 600_000, value: 100.1 },
  ];
  const result = analyzeSeries(readings, OPTIONS);

  assert.equal(result.decreases.length, 0);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.total, 0.1);
});

test('an implausible jump is counted but flagged for review', () => {
  const readings = [
    { tsUtc: START, value: 100 },
    { tsUtc: START + 300_000, value: 145 },
  ];
  const result = analyzeSeries(readings, OPTIONS);

  assert.equal(result.total, 45);
  assert.equal(result.spikes.length, 1);
  assert.equal(result.anomalies[0].type, ANOMALY.SPIKE);
});

test('missing readings are reported as a gap but their volume still counts', () => {
  const readings = [
    { tsUtc: START, value: 100 },
    { tsUtc: START + 300_000, value: 100.1 },
    { tsUtc: START + 4 * 3_600_000, value: 100.9 }, // four hour outage
  ];
  const result = analyzeSeries(readings, OPTIONS);

  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].durationMs, 4 * 3_600_000 - 300_000);
  assert.equal(result.gaps[0].missingReadings, 46);
  assert.equal(result.total, 0.9);
  assert.equal(result.intervals.at(-1).gap, true);
});

test('flow is only detected above the configured threshold', () => {
  const readings = makeReadings({
    startTs: START,
    start: 100,
    deltas: [0.0005, 0.001, 0.05, 0],
  });
  const result = analyzeSeries(readings, OPTIONS);

  assert.deepEqual(
    result.intervals.map((interval) => interval.flowing),
    [false, true, true, false],
  );
  assert.equal(result.flowingIntervals, 2);
});

test('with a threshold of zero any forward movement counts as flow', () => {
  const readings = makeReadings({ startTs: START, start: 100, deltas: [0.0001, 0] });
  const result = analyzeSeries(readings, { ...OPTIONS, flowThreshold: 0 });
  assert.deepEqual(
    result.intervals.map((interval) => interval.flowing),
    [true, false],
  );
});

test('hundreds of intervals do not accumulate floating point drift', () => {
  const readings = makeReadings({
    startTs: START,
    start: 0,
    deltas: Array.from({ length: 288 }, () => 0.001),
  });
  assert.equal(analyzeSeries(readings, OPTIONS).total, 0.288);
});

test('non-finite readings are discarded', () => {
  const readings = [
    { tsUtc: START, value: 100 },
    { tsUtc: START + 300_000, value: Number.NaN },
    { tsUtc: START + 600_000, value: 100.4 },
  ];
  const result = analyzeSeries(readings, OPTIONS);
  assert.equal(result.count, 2);
  assert.equal(result.total, 0.4);
});

test('consumptionInWindow measures only the trailing window', () => {
  const readings = makeReadings({
    startTs: START,
    start: 100,
    deltas: Array.from({ length: 24 }, () => 0.05), // two hours at 5 min steps
  });
  const end = readings.at(-1).tsUtc;

  const hour = consumptionInWindow(readings, end, 3_600_000, OPTIONS);
  assert.equal(hour.total, 0.6); // 12 intervals × 0.05

  const everything = consumptionInWindow(readings, end, 24 * 3_600_000, OPTIONS);
  assert.equal(everything.total, 1.2);
});
