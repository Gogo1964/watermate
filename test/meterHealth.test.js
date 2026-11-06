import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeterHealthMonitor } from '../src/monitor/meterHealth.js';
import { createAlertManager } from '../src/monitor/alertManager.js';
import { createNullLogger } from '../src/util/logger.js';

const H = 3_600_000;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const TODAY = '2026-11-06';

const config = {
  timezone: 'Europe/Berlin',
  meter: { channel: 'main', unit: 'm³', litersPerUnit: 1000, baseUrl: 'http://192.168.178.62/fileserver/log/data' },
  poll: { backfillDays: 7 },
  meterHealth: { enabled: true, staleHours: 2, staleMs: 2 * H, reAlertHours: 24, reAlertMs: 24 * H, recoveryAlerts: true },
  mail: { alertTo: ['me@example.com'] },
};

/** Just enough repository for the monitor and the real alert manager. */
function fakeRepository({ latest = null, sourceFiles = {} } = {}) {
  const alerts = new Map();
  return {
    latest,
    getLatestReading: function () {
      return this.latest;
    },
    getSourceFile: (date) => sourceFiles[date] ?? null,
    getAlert: (key) => alerts.get(key) ?? null,
    shouldSendAlert(key, cooldownMs, now) {
      const existing = alerts.get(key);
      if (!existing) return true;
      if (cooldownMs <= 0) return false;
      return now - existing.last_sent_at >= cooldownMs;
    },
    recordAlertSent(key, type, payload, now) {
      const existing = alerts.get(key);
      alerts.set(key, {
        dedup_key: key,
        type,
        first_sent_at: existing?.first_sent_at ?? now,
        last_sent_at: now,
        send_count: (existing?.send_count ?? 0) + 1,
        payload: payload ? JSON.stringify(payload) : null,
      });
    },
    clearAlert: (key) => alerts.delete(key),
    clearAlertsWithPrefix() {},
    alerts,
  };
}

function setup(repoOptions, { failMail = false } = {}) {
  const repository = fakeRepository(repoOptions);
  const sent = [];
  const mailer = {
    async send(mail) {
      if (failMail) throw new Error('SMTP down');
      sent.push(mail);
      return { messageId: String(sent.length) };
    },
  };
  const logger = createNullLogger();
  const alerts = createAlertManager({ repository, mailer, config, logger });
  const monitor = createMeterHealthMonitor({ repository, config, alerts, logger, startedAt: NOW - 10 * H });
  return { repository, sent, monitor };
}

const unreachable = {
  results: [{ date: TODAY, status: 'error', error: 'fetch failed', errorCode: 'EHOSTUNREACH', inserted: 0 }],
};

test('fresh data raises nothing', async () => {
  const { monitor, sent } = setup({ latest: { tsUtc: NOW - 10 * 60_000, value: 100 } });
  const result = await monitor.check(unreachable, NOW);
  assert.equal(result.stale, false);
  assert.equal(sent.length, 0);
});

test('unreachable meter alerts once, then only after the re-alert interval', async () => {
  const { monitor, sent } = setup({ latest: { tsUtc: NOW - 3 * H, value: 100 } });

  const first = await monitor.check(unreachable, NOW);
  assert.equal(first.sent, true);
  assert.equal(first.cause.kind, 'unreachable');
  assert.equal(first.cause.code, 'EHOSTUNREACH');
  assert.match(sent[0].subject, /^ALERT: no meter data for 3 h — meter not reachable/);
  assert.match(sent[0].text, /EHOSTUNREACH/);

  await monitor.check(unreachable, NOW + 15 * 60_000);
  assert.equal(sent.length, 1, 'suppressed within cooldown');

  await monitor.check(unreachable, NOW + 25 * H);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /^REMINDER/);
});

test('reachable meter whose rows are all rejected is reported as such', async () => {
  const { monitor, sent } = setup({ latest: { tsUtc: NOW - 30 * H, value: 100 } });
  const collected = {
    results: [{ date: TODAY, status: 'ok', inserted: 0, validRows: 0, invalidRows: 97, rejectReasons: { meter_error: 97 } }],
  };
  const result = await monitor.check(collected, NOW);
  assert.equal(result.cause.kind, 'rows_rejected');
  assert.match(sent[0].subject, /error for every reading/);
  assert.match(sent[0].text, /meter_error: 97/);
});

test('unchanged file falls back to the stored row counts for the diagnosis', async () => {
  const { monitor } = setup({
    latest: { tsUtc: NOW - 5 * H, value: 100 },
    sourceFiles: { [TODAY]: { rows_valid: 0, rows_invalid: 40 } },
  });
  const result = await monitor.check({ results: [{ date: TODAY, status: 'unchanged', inserted: 0 }] }, NOW);
  assert.equal(result.cause.kind, 'rows_rejected');
});

test('missing file and HTTP errors get their own cause', async () => {
  const a = setup({ latest: { tsUtc: NOW - 5 * H, value: 1 } });
  assert.equal((await a.monitor.check({ results: [{ date: TODAY, status: 'not-found' }] }, NOW)).cause.kind, 'file_missing');

  const b = setup({ latest: { tsUtc: NOW - 5 * H, value: 1 } });
  const http = { results: [{ date: TODAY, status: 'error', error: 'HTTP 500 Internal', errorCode: 'ERR_HTTP_STATUS' }] };
  assert.equal((await b.monitor.check(http, NOW)).cause.kind, 'http_error');
});

test('an empty database alerts once the process has run for the stale period', async () => {
  const { monitor, sent } = setup({ latest: null });
  const result = await monitor.check(unreachable, NOW);
  assert.equal(result.sent, true);
  assert.match(sent[0].text, /none yet/);
});

test('recovery sends one all-clear and re-arms the alert', async () => {
  const { monitor, sent, repository } = setup({ latest: { tsUtc: NOW - 3 * H, value: 100 } });
  await monitor.check(unreachable, NOW);

  repository.latest = { tsUtc: NOW + H, value: 100.5 };
  const recovered = await monitor.check({ results: [{ date: TODAY, status: 'ok', inserted: 12 }] }, NOW + H);
  assert.equal(recovered.recovered, true);
  assert.match(sent[1].subject, /^OK: water meter delivers data again after 4 h/);
  assert.match(sent[1].text, /Meter not reachable/);
  assert.equal(repository.getAlert('meter-stale:main'), null);

  await monitor.check({ results: [] }, NOW + H + 60_000);
  assert.equal(sent.length, 2, 'no second all-clear');

  // A new outage alerts again.
  await monitor.check(unreachable, NOW + 4 * H);
  assert.equal(sent.length, 3);
  assert.match(sent[2].subject, /^ALERT/);
});

test('a failed all-clear keeps the outage open so it is retried', async () => {
  const ok = setup({ latest: { tsUtc: NOW - 3 * H, value: 100 } });
  await ok.monitor.check(unreachable, NOW);
  const stored = ok.repository.alerts;

  const failing = setup({ latest: { tsUtc: NOW + H, value: 101 } }, { failMail: true });
  for (const [key, row] of stored) failing.repository.alerts.set(key, row);

  const result = await failing.monitor.check({ results: [] }, NOW + H);
  assert.equal(result.reason, 'send_failed');
  assert.notEqual(failing.repository.getAlert('meter-stale:main'), null);
});

test('disabled monitor does nothing', async () => {
  const repository = fakeRepository({ latest: null });
  const monitor = createMeterHealthMonitor({
    repository,
    config: { ...config, meterHealth: { ...config.meterHealth, enabled: false } },
    alerts: { dispatch: () => assert.fail('must not dispatch') },
    logger: createNullLogger(),
  });
  assert.equal((await monitor.check(unreachable, NOW)).checked, false);
});
