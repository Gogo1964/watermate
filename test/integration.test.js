import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createMemoryTransport } from '../src/mail/mailer.js';
import { testConfig, logger, makeReadings, toCsv, fakeFetch, berlinSummer } from './helpers.js';

/**
 * End-to-end checks against a real SQLite file, so restart behaviour is
 * exercised the way it happens in production rather than being simulated.
 */

/**
 * Gives a test its own database file and guarantees every app built on it is
 * closed before the file is removed — Windows refuses to unlink an open file.
 */
function harness(t) {
  const file = path.join(os.tmpdir(), `watermate-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const apps = [];

  t.after(async () => {
    for (const app of apps) {
      await app.stop().catch(() => {});
    }
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${file}${suffix}`, { force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  function build({ files, overrides = {}, transport = createMemoryTransport() }) {
    const config = testConfig({
      DATABASE_PATH: file,
      BACKFILL_DAYS: '0',
      HTTP_RETRIES: '0',
      ...overrides,
    });
    const { fetchImpl, calls } = fakeFetch(files);
    const app = createApp({ config, logger, deps: { fetchImpl, transport } });
    apps.push(app);
    return { app, config, calls, transport, messages: transport.messages };
  }

  return { file, build };
}

/** `count` five-minute intervals of uninterrupted flow starting at midnight. */
function leakCsv(count, { day = 10, perInterval = 0.01, start = 100 } = {}) {
  return toCsv(
    makeReadings({
      startTs: berlinSummer(day, 0),
      start,
      deltas: Array.from({ length: count }, () => perInterval),
    }),
  );
}

const flowAlertsIn = (messages) => messages.filter((message) => /continuous water flow/i.test(message.subject));

test('a leak is detected end to end and alerted exactly once', async (t) => {
  const { build } = harness(t);
  const { app, messages } = build({ files: { '2026-08-10': leakCsv(40) } }); // 3 h 20 min of flow

  await app.pollOnce(berlinSummer(10, 4));

  assert.equal(flowAlertsIn(messages).length, 1);
  assert.match(flowAlertsIn(messages)[0].subject, /3 h/);
  assert.match(flowAlertsIn(messages)[0].text, /CONTINUOUS WATER FLOW/);
  assert.match(flowAlertsIn(messages)[0].html, /Continuous water flow detected/);

  // Polling again with the same data must stay silent.
  await app.pollOnce(berlinSummer(10, 4, 15));
  assert.equal(flowAlertsIn(messages).length, 1);
});

test('a restart neither re-imports readings nor re-sends the alert', async (t) => {
  const { build } = harness(t);
  const files = { '2026-08-10': leakCsv(40) };

  const first = build({ files });
  await first.app.pollOnce(berlinSummer(10, 4));
  const readingsAfterFirst = first.app.repository.countReadings('main');
  const flowState = first.app.repository.getFlowState('main');
  await first.app.stop();

  assert.equal(readingsAfterFirst, 41);
  assert.equal(flowState.flowing, true);
  assert.equal(flowState.alerted, true);
  assert.equal(flowAlertsIn(first.messages).length, 1);

  // Same database, brand new process.
  const second = build({ files });
  await second.app.pollOnce(berlinSummer(10, 4, 15));

  assert.equal(second.app.repository.countReadings('main'), 41);
  assert.equal(second.messages.length, 0, 'no alert may be re-sent after a restart');
});

test('the daily report is sent once even if the process restarts repeatedly', async (t) => {
  const { build } = harness(t);
  const files = { '2026-08-10': leakCsv(40) };
  const sentSubjects = [];

  for (let restart = 0; restart < 3; restart += 1) {
    const { app, messages } = build({ files, overrides: { CONTINUOUS_FLOW_ENABLED: 'false' } });
    await app.pollOnce(berlinSummer(10, 12));
    await app.reports.sendDue(berlinSummer(11, 8));
    sentSubjects.push(...messages.map((message) => message.subject));
    await app.stop();
  }

  const reports = sentSubjects.filter((subject) => /Water report/.test(subject));
  assert.equal(reports.length, 1);
  assert.match(reports[0], /2026-08-10/);
});

test('backfilled history from days ago does not fire a stale leak alert', async (t) => {
  const { build } = harness(t);
  const { app, messages } = build({
    files: { '2026-08-10': leakCsv(40) },
    overrides: { ALERT_MAX_AGE_HOURS: '6', BACKFILL_DAYS: '5' },
  });

  // The data is imported three days after the leak happened.
  await app.pollOnce(berlinSummer(13, 12));

  assert.equal(flowAlertsIn(messages).length, 0);
  // The episode is still tracked, it is simply not mailed about.
  assert.equal(app.repository.getFlowState('main').alerted, true);
});

test('a meter decrease is recorded as an anomaly and surfaces in the report', async (t) => {
  const { build } = harness(t);
  const readings = makeReadings({ startTs: berlinSummer(10, 0), start: 500, deltas: [0.01, 0.01] });
  readings.push({ tsUtc: berlinSummer(10, 0, 15), value: 2 }); // meter exchanged
  readings.push({ tsUtc: berlinSummer(10, 0, 20), value: 2.01 });

  const { app } = build({ files: { '2026-08-10': toCsv(readings) } });
  await app.pollOnce(berlinSummer(10, 1));

  const anomalies = app.repository.getAnomaliesForDate('main', '2026-08-10');
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].type, 'meter_decrease');

  const { summary, text } = app.reports.preview('2026-08-10');
  assert.equal(summary.total, 0.03); // 0.02 before the reset plus 0.01 after
  assert.ok(summary.total >= 0);
  assert.match(text, /meter reading decreased/i);
});

test('changing the timezone re-labels stored readings instead of skewing days', async (t) => {
  const { build } = harness(t);
  // 00:30 Berlin on the 10th is still 22:30 UTC on the 9th.
  const csv = '2026-08-10T00:30:00+0200,main,00100.0000,100,100,0,0,no error';

  const berlin = build({ files: { '2026-08-10': csv } });
  await berlin.app.pollOnce(berlinSummer(10, 12));
  assert.equal(berlin.app.repository.getLatestReading('main').localDate, '2026-08-10');
  await berlin.app.stop();

  const utc = build({ files: {}, overrides: { TIMEZONE: 'UTC' } });
  assert.equal(utc.app.repository.getLatestReading('main').localDate, '2026-08-09');
});

test('the meter being unreachable for a whole cycle is survivable', async (t) => {
  const { build } = harness(t);
  const { app, messages } = build({
    files: { '2026-08-10': Object.assign(new Error('network down'), { code: 'EHOSTUNREACH' }) },
  });

  const result = await app.pollOnce(berlinSummer(10, 12));

  assert.equal(result.inserted, 0);
  assert.equal(result.results[0].status, 'error');
  assert.equal(messages.length, 0);
});

test('a high-consumption alert and a flow alert are separate mails', async (t) => {
  const { build } = harness(t);
  // 40 intervals × 0.02 = 0.8 m³ of continuous flow: both conditions trigger.
  const { app, messages } = build({
    files: { '2026-08-10': leakCsv(40, { perInterval: 0.02 }) },
    overrides: { HIGH_CONSUMPTION_THRESHOLD: '0.5' },
  });

  await app.pollOnce(berlinSummer(10, 4));

  assert.equal(flowAlertsIn(messages).length, 1);
  assert.equal(messages.filter((message) => /high water consumption/i.test(message.subject)).length, 1);
  assert.equal(new Set(messages.map((message) => message.subject)).size, 2);
});
