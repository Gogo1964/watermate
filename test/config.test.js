import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redactConfig } from '../src/config.js';
import { parseEnv } from '../src/util/env.js';

const MINIMAL = { MAIL_TO: 'owner@example.com' };

function load(env) {
  return loadConfig({ skipEnvFile: true, env: { ...MINIMAL, ...env } });
}

test('sensible defaults are applied when nothing is configured', () => {
  const config = load({});

  assert.equal(config.poll.intervalMinutes, 15);
  assert.equal(config.poll.intervalMs, 900_000);
  assert.equal(config.continuousFlow.durationHours, 3);
  assert.equal(config.continuousFlow.durationMs, 10_800_000);
  assert.equal(config.continuousFlow.detectionThreshold, 0.001);
  assert.equal(config.report.timeRaw, '07:00');
  assert.deepEqual(config.report.time, { hour: 7, minute: 0, second: 0 });
  assert.equal(config.timezone, 'Europe/Berlin');
  assert.equal(config.meter.channel, 'main');
});

test('every documented setting can be overridden', () => {
  const config = load({
    POLL_INTERVAL_MINUTES: '5',
    CONTINUOUS_FLOW_DURATION_HOURS: '1.5',
    FLOW_DETECTION_THRESHOLD: '0.005',
    HIGH_CONSUMPTION_THRESHOLD: '1.25',
    DAILY_REPORT_TIME: '21:45',
    TIMEZONE: 'America/New_York',
    METER_CHANNEL: 'garden',
  });

  assert.equal(config.poll.intervalMs, 300_000);
  assert.equal(config.continuousFlow.durationMs, 5_400_000);
  assert.equal(config.continuousFlow.detectionThreshold, 0.005);
  assert.equal(config.highConsumption.dailyThreshold, 1.25);
  assert.deepEqual(config.report.time, { hour: 21, minute: 45, second: 0 });
  assert.equal(config.timezone, 'America/New_York');
  assert.equal(config.meter.channel, 'garden');
});

test('invalid values are rejected with an explanatory message', () => {
  assert.throws(() => load({ POLL_INTERVAL_MINUTES: 'soon' }), /POLL_INTERVAL_MINUTES must be a number/);
  assert.throws(() => load({ TIMEZONE: 'Mars/Olympus' }), /not a valid IANA timezone/);
  assert.throws(() => load({ DAILY_REPORT_TIME: '25:00' }), /Invalid time of day/);
  assert.throws(() => load({ SMTP_PORT: '70000' }), /SMTP_PORT must be <= 65535/);
  assert.throws(() => load({ HIGH_CONSUMPTION_THRESHOLD: '0' }), /must be > 0/);
  assert.throws(() => load({ MAIL_TO: '' }), /MAIL_TO is required/);
  assert.throws(() => load({ WATER_METER_BASE_URL: 'meter.local' }), /must start with http/);
  assert.throws(() => load({ LOG_LEVEL: 'chatty' }), /LOG_LEVEL must be one of/);
});

test('all configuration problems are reported at once', () => {
  try {
    load({ TIMEZONE: 'Nowhere', POLL_INTERVAL_MINUTES: 'x', SMTP_PORT: '-1' });
    assert.fail('expected the configuration to be rejected');
  } catch (error) {
    assert.equal(error.code, 'ERR_INVALID_CONFIG');
    assert.equal(error.details.length, 3);
  }
});

test('a gap threshold below the reading interval is caught', () => {
  assert.throws(
    () => load({ EXPECTED_READING_INTERVAL_MINUTES: '15', MAX_GAP_MINUTES: '10' }),
    /MAX_GAP_MINUTES must be greater than/,
  );
});

test('dry-run mode makes recipients optional', () => {
  const config = loadConfig({ skipEnvFile: true, env: { MAIL_DRY_RUN: 'true' } });
  assert.equal(config.mail.dryRun, true);
  assert.deepEqual(config.mail.to, []);
});

test('recipient lists accept commas and semicolons', () => {
  const config = load({ MAIL_TO: 'a@x.de, b@x.de; c@x.de' });
  assert.deepEqual(config.mail.to, ['a@x.de', 'b@x.de', 'c@x.de']);
});

test('alert recipients fall back to the report recipients', () => {
  assert.deepEqual(load({ MAIL_TO: 'a@x.de' }).mail.alertTo, ['a@x.de']);
  assert.deepEqual(load({ MAIL_TO: 'a@x.de', MAIL_ALERT_TO: 'sms@x.de' }).mail.alertTo, ['sms@x.de']);
});

test('SMTP_TLS accepts the documented modes and the usual aliases', () => {
  assert.equal(load({ SMTP_TLS: 'implicit' }).mail.smtp.tls, 'implicit');
  assert.equal(load({ SMTP_TLS: 'starttls' }).mail.smtp.tls, 'starttls');
  assert.equal(load({ SMTP_TLS: 'none' }).mail.smtp.tls, 'none');
  assert.equal(load({ SMTP_TLS: 'true' }).mail.smtp.tls, 'implicit');
  assert.equal(load({ SMTP_TLS: 'false' }).mail.smtp.tls, 'none');
  assert.throws(() => load({ SMTP_TLS: 'maybe' }), /SMTP_TLS must be one of/);
});

test('booleans accept the common spellings', () => {
  assert.equal(load({ POLL_ON_START: 'yes' }).poll.onStart, true);
  assert.equal(load({ POLL_ON_START: 'off' }).poll.onStart, false);
  assert.equal(load({ POLL_ON_START: '1' }).poll.onStart, true);
  assert.throws(() => load({ POLL_ON_START: 'perhaps' }), /must be a boolean/);
});

test('the optional hourly threshold stays disabled unless it is set', () => {
  assert.equal(load({}).highConsumption.hourlyThreshold, null);
  assert.equal(load({ HOURLY_HIGH_CONSUMPTION_THRESHOLD: '0.15' }).highConsumption.hourlyThreshold, 0.15);
});

test('the SMTP password is never exposed by the redacted view', () => {
  const config = load({ SMTP_USER: 'bot', SMTP_PASSWORD: 'sup3rsecret' });
  const redacted = redactConfig(config);

  assert.equal(redacted.mail.smtp.password, '***');
  assert.ok(!JSON.stringify(redacted).includes('sup3rsecret'));
  assert.equal(config.mail.smtp.password, 'sup3rsecret');
});

test('the .env parser handles quotes, comments and exports', () => {
  const parsed = parseEnv(
    [
      '# a comment',
      '',
      'SMTP_HOST=smtp.example.com',
      'SMTP_PASSWORD="pa#ss word"',
      "MAIL_FROM='water@example.com'",
      'POLL_INTERVAL_MINUTES=15 # inline comment',
      'export TIMEZONE=Europe/Berlin',
      'MULTILINE="line1\\nline2"',
      'not a valid line',
    ].join('\n'),
  );

  assert.deepEqual(parsed, {
    SMTP_HOST: 'smtp.example.com',
    SMTP_PASSWORD: 'pa#ss word',
    MAIL_FROM: 'water@example.com',
    POLL_INTERVAL_MINUTES: '15',
    TIMEZONE: 'Europe/Berlin',
    MULTILINE: 'line1\nline2',
  });
});

test('a value already in the environment wins over the .env file', async () => {
  const { loadEnvFile } = await import('../src/util/env.js');
  const env = { SMTP_HOST: 'from-environment' };
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const file = path.join(os.tmpdir(), `watermate-env-${Date.now()}`);
  fs.writeFileSync(file, 'SMTP_HOST=from-file\nSMTP_PORT=2525\n');
  try {
    loadEnvFile(file, env);
    assert.equal(env.SMTP_HOST, 'from-environment');
    assert.equal(env.SMTP_PORT, '2525');
  } finally {
    fs.unlinkSync(file);
  }
});

test('a repeated key in .env is reported instead of silently winning', async () => {
  const { loadEnvFile } = await import('../src/util/env.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const file = path.join(os.tmpdir(), `watermate-dup-${Date.now()}`);
  fs.writeFileSync(
    file,
    ['MAIL_FROM=me@real.com', 'SMTP_HOST=smtp.real.com', '', 'MAIL_FROM=watermate@example.com'].join('\n'),
  );

  try {
    const env = {};
    const { duplicates } = loadEnvFile(file, env);

    assert.deepEqual(duplicates, [{ key: 'MAIL_FROM', line: 4 }]);
    // Last assignment still wins, which is exactly why it must be reported.
    assert.equal(env.MAIL_FROM, 'watermate@example.com');

    assert.throws(
      () => loadConfig({ env: {}, envFile: file }),
      /MAIL_FROM is assigned more than once.*line 4/s,
    );
  } finally {
    fs.unlinkSync(file);
  }
});

test('a missing .env file is not an error', async () => {
  const { loadEnvFile } = await import('../src/util/env.js');
  assert.deepEqual(loadEnvFile('/definitely/not/here/.env', {}), { loaded: false, keys: [], duplicates: [] });
});
