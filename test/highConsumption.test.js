import test from 'node:test';
import assert from 'node:assert/strict';
import { createHighConsumptionMonitor, exceedsThreshold } from '../src/monitor/highConsumption.js';
import {
  testConfig,
  testRepository,
  testMailer,
  testAlerts,
  logger,
  makeReadings,
  seedReadings,
  berlinSummer,
} from './helpers.js';

function setup(overrides = {}) {
  const config = testConfig(overrides);
  const { repository } = testRepository();
  const { mailer, messages } = testMailer(config);
  const alerts = testAlerts({ repository, config, mailer });
  const monitor = createHighConsumptionMonitor({ repository, config, alerts, logger });
  return { config, repository, monitor, messages, alerts };
}

/** Seeds exactly `total` cubic metres, spread over 08:00–18:00 of that day. */
function seedDay(repository, day, total, { steps = 20, start = 100 } = {}) {
  seedReadings(
    repository,
    makeReadings({
      startTs: berlinSummer(day, 8),
      intervalMs: 30 * 60_000,
      start,
      deltas: Array.from({ length: steps }, () => total / steps),
    }),
  );
}

test('no alert while consumption stays below the threshold', async () => {
  const { repository, monitor, messages } = setup();
  seedDay(repository, 10, 0.3);

  await monitor.check(berlinSummer(10, 23));

  assert.equal(messages.length, 0);
});

test('an alert is sent once the daily threshold is exceeded', async () => {
  const { repository, monitor, messages } = setup();
  seedDay(repository, 10, 0.8);

  await monitor.check(berlinSummer(10, 23));

  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /high water consumption/i);
  assert.match(messages[0].text, /0\.800 m³/);
  assert.match(messages[0].text, /Threshold:\s+0\.500 m³/);
});

test('the alert is not repeated on every polling cycle', async () => {
  const { repository, monitor, messages } = setup();
  seedDay(repository, 10, 0.8);

  // Twelve polls across the rest of the day, consumption stays above the limit.
  for (let i = 0; i < 12; i += 1) {
    await monitor.check(berlinSummer(10, 12) + i * 15 * 60_000);
  }

  assert.equal(messages.length, 1);
});

test('a new day alerts again', async () => {
  const { repository, monitor, messages } = setup();
  seedDay(repository, 10, 0.8, { start: 100 });
  await monitor.check(berlinSummer(10, 23));

  // The meter keeps counting, so the next day continues from 100.8.
  seedDay(repository, 11, 0.9, { start: 100.8 });
  await monitor.check(berlinSummer(11, 23));

  assert.equal(messages.length, 2);
  assert.match(messages[0].subject, /2026-08-10/);
  assert.match(messages[1].subject, /2026-08-11/);
});

test('the threshold is configurable without touching code', async () => {
  const { repository, monitor, messages } = setup({ HIGH_CONSUMPTION_THRESHOLD: '2.0' });
  seedDay(repository, 10, 1.5);

  await monitor.check(berlinSummer(10, 23));
  assert.equal(messages.length, 0);
});

test('high-consumption alerting can be switched off entirely', async () => {
  const { repository, monitor, messages } = setup({ HIGH_CONSUMPTION_ALERTS_ENABLED: 'false' });
  seedDay(repository, 10, 5);

  const result = await monitor.check(berlinSummer(10, 23));

  assert.equal(result.checked, false);
  assert.equal(messages.length, 0);
});

test('the optional rolling-window threshold catches a short burst', async () => {
  const { repository, monitor, messages } = setup({
    HIGH_CONSUMPTION_THRESHOLD: '10',
    HOURLY_HIGH_CONSUMPTION_THRESHOLD: '0.2',
  });

  // 0.3 m³ within one hour — far below any daily limit, but a burst.
  seedReadings(
    repository,
    makeReadings({
      startTs: berlinSummer(10, 12),
      intervalMs: 5 * 60_000,
      start: 100,
      deltas: Array.from({ length: 12 }, () => 0.025),
    }),
  );

  await monitor.check(berlinSummer(10, 13));

  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /high water consumption/i);
  assert.match(messages[0].text, /60 min up to/);
});

test('the rolling window is ignored when the meter has gone silent', async () => {
  const { repository, monitor, messages } = setup({
    HIGH_CONSUMPTION_THRESHOLD: '10',
    HOURLY_HIGH_CONSUMPTION_THRESHOLD: '0.2',
  });
  seedReadings(
    repository,
    makeReadings({
      startTs: berlinSummer(10, 12),
      intervalMs: 5 * 60_000,
      start: 100,
      deltas: Array.from({ length: 12 }, () => 0.025),
    }),
  );

  // Six hours later the readings are stale; no fresh alert may be produced.
  await monitor.check(berlinSummer(10, 19));

  assert.equal(messages.length, 0);
});

test('a meter reset does not trigger a false high-consumption alert', async () => {
  const { repository, monitor, messages } = setup();
  seedReadings(repository, [
    { tsUtc: berlinSummer(10, 1), value: 5000 },
    { tsUtc: berlinSummer(10, 2), value: 5000.1 },
    { tsUtc: berlinSummer(10, 3), value: 0 }, // meter exchanged
    { tsUtc: berlinSummer(10, 4), value: 0.1 },
  ]);

  await monitor.check(berlinSummer(10, 23));

  assert.equal(messages.length, 0);
});

test('an alert that fails to send is retried on the next cycle', async () => {
  const config = testConfig();
  const { repository } = testRepository();
  let attempts = 0;
  const failingMailer = {
    async send() {
      attempts += 1;
      if (attempts === 1) throw new Error('SMTP unavailable');
      return { messageId: 'ok' };
    },
  };
  const alerts = testAlerts({ repository, config, mailer: failingMailer });
  const monitor = createHighConsumptionMonitor({ repository, config, alerts, logger });
  seedDay(repository, 10, 0.8);

  await monitor.check(berlinSummer(10, 22));
  await monitor.check(berlinSummer(10, 23));

  assert.equal(attempts, 2);
  // A third cycle must stay quiet now that the alert got through.
  await monitor.check(berlinSummer(10, 23) + 60_000);
  assert.equal(attempts, 2);
});

test('exceedsThreshold is inclusive and rejects nonsense', () => {
  assert.equal(exceedsThreshold(0.5, 0.5), true);
  assert.equal(exceedsThreshold(0.49, 0.5), false);
  assert.equal(exceedsThreshold(Number.NaN, 0.5), false);
  assert.equal(exceedsThreshold(1, 0), false);
});
