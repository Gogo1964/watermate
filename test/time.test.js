import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toLocalDate,
  localDayBounds,
  addLocalDays,
  nextOccurrence,
  parseTimeOfDay,
  zonedTimeToUtc,
  localDateDiff,
  formatDuration,
} from '../src/util/time.js';

const BERLIN = 'Europe/Berlin';

test('a timestamp is assigned to the local calendar day, not the UTC day', () => {
  // 22:30 UTC on 9 Aug is already 00:30 on 10 Aug in Berlin (UTC+2).
  assert.equal(toLocalDate(Date.UTC(2026, 7, 9, 22, 30), BERLIN), '2026-08-10');
  assert.equal(toLocalDate(Date.UTC(2026, 7, 9, 21, 30), BERLIN), '2026-08-09');
});

test('day bounds follow the configured timezone', () => {
  const { start, end } = localDayBounds('2026-08-10', BERLIN);
  assert.equal(start, Date.UTC(2026, 7, 9, 22, 0, 0));
  assert.equal(end, Date.UTC(2026, 7, 10, 22, 0, 0));
  assert.equal(end - start, 24 * 3_600_000);
});

test('day bounds handle DST transitions', () => {
  // Clocks go forward on 29 March 2026 → a 23 hour day.
  const spring = localDayBounds('2026-03-29', BERLIN);
  assert.equal(spring.end - spring.start, 23 * 3_600_000);

  // Clocks go back on 25 October 2026 → a 25 hour day.
  const autumn = localDayBounds('2026-10-25', BERLIN);
  assert.equal(autumn.end - autumn.start, 25 * 3_600_000);
});

test('UTC and Berlin disagree about which day a reading belongs to', () => {
  const reading = Date.parse('2026-08-10T00:23:52+0200');
  assert.equal(toLocalDate(reading, BERLIN), '2026-08-10');
  assert.equal(toLocalDate(reading, 'UTC'), '2026-08-09');
});

test('addLocalDays crosses month and DST boundaries', () => {
  assert.equal(addLocalDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addLocalDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addLocalDays('2026-03-29', 1), '2026-03-30');
  assert.equal(localDateDiff('2026-08-11', '2026-08-08'), 3);
});

test('nextOccurrence returns today when the time is still ahead, tomorrow otherwise', () => {
  const time = parseTimeOfDay('07:00');
  const beforeReport = zonedTimeToUtc({ year: 2026, month: 8, day: 10, hour: 6 }, BERLIN);
  const afterReport = zonedTimeToUtc({ year: 2026, month: 8, day: 10, hour: 8 }, BERLIN);

  assert.equal(nextOccurrence(beforeReport, time, BERLIN), zonedTimeToUtc({ year: 2026, month: 8, day: 10, hour: 7 }, BERLIN));
  assert.equal(nextOccurrence(afterReport, time, BERLIN), zonedTimeToUtc({ year: 2026, month: 8, day: 11, hour: 7 }, BERLIN));
});

test('the daily report time stays at 07:00 local across a DST change', () => {
  const time = parseTimeOfDay('07:00');
  const beforeSwitch = zonedTimeToUtc({ year: 2026, month: 10, day: 24, hour: 8 }, BERLIN);
  const next = nextOccurrence(beforeSwitch, time, BERLIN);
  assert.equal(toLocalDate(next, BERLIN), '2026-10-25');
  // 07:00 CET is 06:00 UTC, whereas before the switch it would have been 05:00.
  assert.equal(next, Date.UTC(2026, 9, 25, 6, 0, 0));
});

test('parseTimeOfDay rejects nonsense', () => {
  assert.deepEqual(parseTimeOfDay('07:30'), { hour: 7, minute: 30, second: 0 });
  assert.throws(() => parseTimeOfDay('25:00'), /Invalid time of day/);
  assert.throws(() => parseTimeOfDay('7am'), /Invalid time of day/);
});

test('formatDuration is human readable', () => {
  assert.equal(formatDuration(3 * 3_600_000), '3 h');
  assert.equal(formatDuration(3.5 * 3_600_000), '3 h 30 min');
  assert.equal(formatDuration(15 * 60_000), '15 min');
});
