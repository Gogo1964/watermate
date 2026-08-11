import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyReportService } from '../src/reports/dailyReport.js';
import { buildDailySummary } from '../src/analysis/consumption.js';
import {
  testConfig,
  testRepository,
  testMailer,
  logger,
  makeReadings,
  seedReadings,
  berlinSummer,
} from './helpers.js';

// 2026-08-11 07:00 Berlin — the moment the report for the 10th is due.
const REPORT_TIME = berlinSummer(11, 7);

function setup(overrides = {}) {
  const config = testConfig({ DAILY_REPORT_TIME: '07:00', ...overrides });
  const { repository } = testRepository();
  const { mailer, messages } = testMailer(config);
  const reports = createDailyReportService({ repository, config, mailer, logger });
  return { config, repository, reports, messages };
}

/** A full day of readings at 5 minute intervals. */
function seedFullDay(repository, day, { start = 100, perInterval = 0.002, count = 288 } = {}) {
  seedReadings(
    repository,
    makeReadings({
      startTs: berlinSummer(day, 0),
      intervalMs: 5 * 60_000,
      start,
      deltas: Array.from({ length: count - 1 }, () => perInterval),
    }),
  );
}

test('the report covers yesterday and is sent once the report time has passed', async () => {
  const { repository, reports, messages } = setup();
  seedFullDay(repository, 10);

  assert.deepEqual(reports.pendingDates(REPORT_TIME), ['2026-08-10']);
  const result = await reports.sendDue(REPORT_TIME);

  assert.equal(result.sent.length, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /Water report 2026-08-10/);
});

test('nothing is sent before the configured report time', async () => {
  const { repository, reports, messages } = setup({ DAILY_REPORT_TIME: '07:00' });
  seedFullDay(repository, 10);

  await reports.sendDue(berlinSummer(11, 6, 30));

  assert.equal(messages.length, 0);
});

test('the report is not sent twice, even across restarts', async () => {
  const { repository, reports, messages } = setup();
  seedFullDay(repository, 10);

  await reports.sendDue(REPORT_TIME);
  // Every poll for the rest of the day tries again.
  for (let i = 0; i < 20; i += 1) {
    await reports.sendDue(REPORT_TIME + i * 15 * 60_000);
  }

  assert.equal(messages.length, 1);
});

test('a restart with a fresh service instance still does not resend', async () => {
  const config = testConfig({ DAILY_REPORT_TIME: '07:00' });
  const { repository } = testRepository();
  const { mailer, messages } = testMailer(config);
  seedFullDay(repository, 10);

  // First "process".
  await createDailyReportService({ repository, config, mailer, logger }).sendDue(REPORT_TIME);
  // Second "process", same database.
  await createDailyReportService({ repository, config, mailer, logger }).sendDue(REPORT_TIME + 3_600_000);

  assert.equal(messages.length, 1);
});

test('reports missed during downtime are caught up, oldest first', async () => {
  const { repository, reports, messages } = setup({ DAILY_REPORT_CATCHUP_DAYS: '3' });
  seedFullDay(repository, 8, { start: 100 });
  seedFullDay(repository, 9, { start: 100.6 });
  seedFullDay(repository, 10, { start: 101.2 });

  await reports.sendDue(REPORT_TIME);

  assert.equal(messages.length, 3);
  assert.match(messages[0].subject, /2026-08-08/);
  assert.match(messages[1].subject, /2026-08-09/);
  assert.match(messages[2].subject, /2026-08-10/);
});

test('catch-up is bounded by DAILY_REPORT_CATCHUP_DAYS', async () => {
  const { repository, reports } = setup({ DAILY_REPORT_CATCHUP_DAYS: '1' });
  seedFullDay(repository, 7, { start: 100 });
  seedFullDay(repository, 8, { start: 100.6 });
  seedFullDay(repository, 9, { start: 101.2 });
  seedFullDay(repository, 10, { start: 101.8 });

  // Data exists for four days, but only yesterday plus one catch-up day is due.
  assert.deepEqual(reports.pendingDates(REPORT_TIME), ['2026-08-09', '2026-08-10']);
});

test('a fresh install does not mail a stack of empty historical reports', async () => {
  const { repository, reports, messages } = setup({ DAILY_REPORT_CATCHUP_DAYS: '3' });
  // Nothing was ever collected before yesterday.
  seedFullDay(repository, 10);

  await reports.sendDue(REPORT_TIME);

  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /2026-08-10/);
  assert.equal(repository.getDailyReport('2026-08-08'), null);
});

test('a failed send is retried on the next cycle instead of being lost', async () => {
  const config = testConfig();
  const { repository } = testRepository();
  seedFullDay(repository, 10);
  let attempts = 0;
  const flakyMailer = {
    async send() {
      attempts += 1;
      if (attempts === 1) throw new Error('SMTP down');
      return { messageId: 'ok' };
    },
  };
  const reports = createDailyReportService({ repository, config, mailer: flakyMailer, logger });

  await reports.sendDue(REPORT_TIME);
  await reports.sendDue(REPORT_TIME + 900_000);
  await reports.sendDue(REPORT_TIME + 1_800_000);

  assert.equal(attempts, 2);
});

test('the report contains date, total, start and end reading and the count', async () => {
  const { repository, reports } = setup();
  seedFullDay(repository, 10, { start: 100, perInterval: 0.002, count: 288 });

  const { summary, text, html } = reports.preview('2026-08-10');

  assert.equal(summary.date, '2026-08-10');
  assert.equal(summary.readingCount, 288);
  assert.equal(summary.startValue, 100);
  assert.equal(summary.total, 0.574); // 287 intervals × 0.002
  assert.match(text, /Total consumption:\s+0\.574 m³/);
  assert.match(text, /Start meter reading:\s+100\.0000 m³/);
  assert.match(text, /End meter reading:\s+100\.5740 m³/);
  assert.match(text, /Valid readings:\s+288/);
  assert.match(html, /Daily water report/);
  assert.match(html, /<table/);
});

test('consumption is measured from the last reading before midnight', () => {
  const { config, repository } = setup();
  // 23:55 on the 9th, then the whole of the 10th.
  seedReadings(repository, [{ tsUtc: berlinSummer(9, 23, 55), value: 99.9 }]);
  seedFullDay(repository, 10, { start: 100, perInterval: 0.002, count: 288 });

  const summary = buildDailySummary({ repository, config, date: '2026-08-10' });

  assert.equal(summary.baselineFromPreviousDay, true);
  assert.equal(summary.startValue, 99.9);
  // 0.1 used between 23:55 and midnight plus 0.574 during the day.
  assert.equal(summary.total, 0.674);
});

test('a day without readings reports zero and says so', async () => {
  const { repository, reports, messages } = setup();

  await reports.sendDue(REPORT_TIME);

  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /No valid readings were recorded/);
  assert.match(messages[0].text, /Total consumption:\s+0\.000 m³/);
  assert.equal(repository.getDailyReport('2026-08-10').total, 0);
});

test('gaps and meter decreases are listed as data-quality issues', () => {
  const { config, repository } = setup();
  seedReadings(repository, [
    { tsUtc: berlinSummer(10, 0), value: 100 },
    { tsUtc: berlinSummer(10, 1), value: 100.2 }, // one hour gap
    { tsUtc: berlinSummer(10, 1, 5), value: 5 }, // meter reset
    { tsUtc: berlinSummer(10, 1, 10), value: 5.1 },
  ]);

  const summary = buildDailySummary({ repository, config, date: '2026-08-10' });
  const codes = summary.issues.map((issue) => issue.code);

  assert.ok(codes.includes('data_gap'));
  assert.ok(codes.includes('meter_decrease'));
  assert.ok(codes.includes('missing_readings'));
  assert.equal(summary.total, 0.3);
  assert.ok(summary.total >= 0);
});

test('a clean day reports no data-quality issues', () => {
  const { config, repository } = setup();
  seedReadings(repository, [{ tsUtc: berlinSummer(9, 23, 55), value: 99.9 }]);
  seedFullDay(repository, 10, { start: 99.9, perInterval: 0.002, count: 288 });

  const summary = buildDailySummary({ repository, config, date: '2026-08-10' });
  assert.deepEqual(summary.issues, []);
});

test('the disabled flag suppresses the daily report', async () => {
  const { repository, reports, messages } = setup({ DAILY_REPORT_ENABLED: 'false' });
  seedFullDay(repository, 10);

  const result = await reports.sendDue(REPORT_TIME);

  assert.equal(result.skipped, 'disabled');
  assert.equal(messages.length, 0);
});

test('the report time is configurable', async () => {
  const { repository, reports, messages } = setup({ DAILY_REPORT_TIME: '20:30' });
  seedFullDay(repository, 10);

  await reports.sendDue(berlinSummer(11, 20));
  assert.equal(messages.length, 0);

  await reports.sendDue(berlinSummer(11, 20, 30));
  assert.equal(messages.length, 1);
});
