import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/meter/collector.js';
import { createMeterClient } from '../src/meter/client.js';
import { createFlowMonitor } from '../src/monitor/flowMonitor.js';
import {
  testConfig,
  testRepository,
  testMailer,
  testAlerts,
  logger,
  makeReadings,
  toCsv,
  fakeFetch,
  berlinSummer,
} from './helpers.js';

const NOW = berlinSummer(10, 12); // 2026-08-10 12:00 Berlin

function setup({ files, overrides = {} } = {}) {
  const config = testConfig({ BACKFILL_DAYS: '2', HTTP_RETRIES: '0', ...overrides });
  const { db, repository } = testRepository();
  const { mailer, messages } = testMailer(config);
  const alerts = testAlerts({ repository, config, mailer });
  const flowMonitor = createFlowMonitor({ repository, config, alerts, logger });
  const { fetchImpl, calls } = fakeFetch(files ?? {});
  const client = createMeterClient({ config, logger, fetchImpl });
  const collector = createCollector({ repository, client, config, logger, flowMonitor });

  return { config, db, repository, collector, calls, messages, flowMonitor };
}

/** A day of readings as the meter would serve it. */
function dayCsv(day, { count = 12, delta = 0.01, start = 100 } = {}) {
  return toCsv(
    makeReadings({
      startTs: berlinSummer(day, 0),
      start,
      deltas: Array.from({ length: count - 1 }, () => delta),
    }),
  );
}

test('readings from a downloaded file are stored', async () => {
  const { collector, repository } = setup({ files: { '2026-08-10': dayCsv(10) } });

  const result = await collector.collect({ now: NOW });

  assert.equal(result.inserted, 12);
  assert.equal(repository.countReadings('main'), 12);
  assert.equal(repository.getLatestReading('main').value, 100.11);
});

test('polling the same unchanged file twice inserts nothing the second time', async () => {
  const { collector, repository } = setup({ files: { '2026-08-10': dayCsv(10) } });

  const first = await collector.collect({ now: NOW });
  const second = await collector.collect({ now: NOW });

  assert.equal(first.inserted, 12);
  assert.equal(second.inserted, 0);
  assert.equal(repository.countReadings('main'), 12);
});

test('a growing file contributes only its new rows', async () => {
  let rowCount = 6;
  const { collector, repository } = setup({
    files: { '2026-08-10': () => dayCsv(10, { count: rowCount }) },
  });

  await collector.collect({ now: NOW });
  assert.equal(repository.countReadings('main'), 6);

  rowCount = 18; // the meter appended twelve more readings
  const second = await collector.collect({ now: NOW });

  assert.equal(second.inserted, 12);
  assert.equal(repository.countReadings('main'), 18);
});

test('previous days are backfilled after downtime, without duplicating anything', async () => {
  const { collector, repository } = setup({
    files: {
      '2026-08-08': dayCsv(8, { start: 100 }),
      '2026-08-09': dayCsv(9, { start: 101 }),
      '2026-08-10': dayCsv(10, { start: 102 }),
    },
  });

  const first = await collector.collect({ now: NOW });
  assert.equal(first.inserted, 36);

  const second = await collector.collect({ now: NOW });
  assert.equal(second.inserted, 0);
  assert.equal(repository.countReadings('main'), 36);
});

test('a finished day is not requested again once it has been read', async () => {
  const { collector, calls } = setup({
    files: { '2026-08-08': dayCsv(8), '2026-08-09': dayCsv(9), '2026-08-10': dayCsv(10) },
  });

  await collector.collect({ now: NOW });
  const afterFirst = calls.length;
  await collector.collect({ now: NOW });

  // Only the current day is fetched on the second cycle.
  assert.equal(calls.length - afterFirst, 1);
  assert.ok(calls.at(-1).endsWith('data_2026-08-10.csv'));
});

test("a missing file for today is not an error and does not stop other days", async () => {
  const { collector, repository } = setup({
    files: { '2026-08-09': dayCsv(9) }, // today's file does not exist yet
  });

  const result = await collector.collect({ now: NOW });

  assert.equal(result.results.find((entry) => entry.date === '2026-08-10').status, 'not-found');
  assert.equal(repository.countReadings('main'), 12);
});

test('a network failure on one day leaves the others intact and is recorded', async () => {
  const { collector, repository } = setup({
    files: {
      '2026-08-09': Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      '2026-08-10': dayCsv(10),
    },
  });

  const result = await collector.collect({ now: NOW });

  const failed = result.results.find((entry) => entry.date === '2026-08-09');
  assert.equal(failed.status, 'error');
  assert.equal(repository.countReadings('main'), 12);
  assert.equal(repository.getSourceFile('2026-08-09').fail_count, 1);
});

test('a transient failure is retried and then succeeds', async () => {
  let attempts = 0;
  const config = testConfig({ BACKFILL_DAYS: '0', HTTP_RETRIES: '2', HTTP_RETRY_BASE_DELAY_MS: '10' });
  const { repository } = testRepository();
  const { mailer } = testMailer(config);
  const alerts = testAlerts({ repository, config, mailer });
  const flowMonitor = createFlowMonitor({ repository, config, alerts, logger });
  const { fetchImpl } = fakeFetch({
    '2026-08-10': () => {
      attempts += 1;
      if (attempts < 3) return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return dayCsv(10);
    },
  });
  const client = createMeterClient({ config, logger, fetchImpl });
  const collector = createCollector({ repository, client, config, logger, flowMonitor });

  await collector.collect({ now: NOW });

  assert.equal(attempts, 3);
  assert.equal(repository.countReadings('main'), 12);
});

test('rows with a meter error are skipped while the good ones are kept', async () => {
  const readings = makeReadings({
    startTs: berlinSummer(10, 0),
    start: 100,
    deltas: [0.01, 0.01, 0.01],
  });
  readings[2].status = 'sensor error';

  const { collector, repository } = setup({ files: { '2026-08-10': toCsv(readings) } });
  await collector.collect({ now: NOW });

  assert.equal(repository.countReadings('main'), 3);
  assert.equal(repository.getSourceFile('2026-08-10').rows_invalid, 1);
});

test('a corrupt file does not lose the valid rows around it', async () => {
  const csv = [
    '2026-08-10T00:00:00+0200,main,00100.0000,100,100,0,0,no error',
    '###CORRUPT###',
    '2026-08-10T00:05:00+0200,main,00100.0100,100,100,0,0,no error',
  ].join('\n');

  const { collector, repository } = setup({ files: { '2026-08-10': csv } });
  await collector.collect({ now: NOW });

  assert.equal(repository.countReadings('main'), 2);
});

test('an entirely empty file is handled without error', async () => {
  const { collector, repository } = setup({ files: { '2026-08-10': '' } });
  const result = await collector.collect({ now: NOW });

  assert.equal(result.inserted, 0);
  assert.equal(repository.countReadings('main'), 0);
});

test('readings after midnight land in the following calendar day', async () => {
  // The meter writes 00:02 of the 10th into the file named for the 10th; the
  // local_date must follow the timestamp, not the filename.
  const csv = '2026-08-10T00:02:00+0200,main,00100.0000,100,100,0,0,no error';
  const { collector, repository } = setup({ files: { '2026-08-10': csv } });

  await collector.collect({ now: NOW });
  const reading = repository.getLatestReading('main');

  assert.equal(reading.localDate, '2026-08-10');
  assert.equal(reading.tsUtc, Date.UTC(2026, 7, 9, 22, 2, 0));
});

test('concurrent polls do not overlap', async () => {
  const { collector } = setup({ files: { '2026-08-10': dayCsv(10) } });

  const [first, second] = await Promise.all([
    collector.collect({ now: NOW }),
    collector.collect({ now: NOW }),
  ]);

  assert.ok(first.skipped || second.skipped, 'one of the two cycles must be skipped');
});
