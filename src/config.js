import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './util/env.js';
import { isValidTimeZone, parseTimeOfDay } from './util/time.js';
import { LOG_LEVELS } from './util/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Loads and validates configuration.
 *
 * All settings come from the environment (optionally seeded from a `.env`
 * file). Nothing here reads a hard-coded credential; secrets only ever arrive
 * through the environment.
 */
export function loadConfig({ env = process.env, envFile = path.join(ROOT, '.env'), skipEnvFile = false } = {}) {
  const errors = [];

  if (!skipEnvFile) {
    const { duplicates } = loadEnvFile(envFile, env);
    // A repeated key is silently won by the last one, which is maddening to
    // debug — the file looks correct at the line you are reading. Refuse to
    // start instead.
    for (const { key, line } of duplicates) {
      errors.push(
        `${key} is assigned more than once in ${envFile} (line ${line} overrides an earlier one) — ` +
          'remove the duplicate',
      );
    }
  }

  const read = createReader(env, errors);

  const config = {
    root: ROOT,

    meter: {
      baseUrl: read.string('WATER_METER_BASE_URL', 'http://192.168.1.50/fileserver/log/data'),
      filePattern: read.string('WATER_METER_FILE_PATTERN', 'data_{date}.csv'),
      channel: read.string('METER_CHANNEL', 'main'),
      unit: read.string('METER_UNIT', 'm³'),
      litersPerUnit: read.number('METER_LITERS_PER_UNIT', 1000, { min: 0, exclusiveMin: true }),
      okStatus: read.string('CSV_OK_STATUS', 'no error'),
      valueColumn: read.integer('CSV_VALUE_COLUMN', 3, { min: 1 }),
      timestampColumn: read.integer('CSV_TIMESTAMP_COLUMN', 1, { min: 1 }),
      channelColumn: read.integer('CSV_CHANNEL_COLUMN', 2, { min: 1 }),
      statusColumn: read.integer('CSV_STATUS_COLUMN', 8, { min: 1 }),
      delimiter: read.string('CSV_DELIMITER', ','),
    },

    poll: {
      intervalMinutes: read.number('POLL_INTERVAL_MINUTES', 15, { min: 0.25 }),
      onStart: read.boolean('POLL_ON_START', true),
      backfillDays: read.integer('BACKFILL_DAYS', 7, { min: 0, max: 365 }),
      finalizeGraceMinutes: read.number('FILE_FINALIZE_GRACE_MINUTES', 60, { min: 0 }),
    },

    http: {
      timeoutMs: read.integer('HTTP_TIMEOUT_MS', 15_000, { min: 500 }),
      retries: read.integer('HTTP_RETRIES', 3, { min: 0, max: 10 }),
      retryBaseDelayMs: read.integer('HTTP_RETRY_BASE_DELAY_MS', 1000, { min: 10 }),
      userAgent: read.string('HTTP_USER_AGENT', 'WaterMate/1.0'),
      username: read.optionalString('HTTP_USERNAME'),
      password: read.optionalString('HTTP_PASSWORD'),
    },

    timezone: read.timezone('TIMEZONE', 'Europe/Berlin'),

    analysis: {
      expectedIntervalMinutes: read.number('EXPECTED_READING_INTERVAL_MINUTES', 5, { min: 0.1 }),
      maxGapMinutes: read.number('MAX_GAP_MINUTES', 30, { min: 0.1 }),
      decreaseTolerance: read.number('METER_DECREASE_TOLERANCE', 0.0005, { min: 0 }),
      maxPlausibleDelta: read.number('MAX_PLAUSIBLE_DELTA', 1, { min: 0, exclusiveMin: true }),
      anchorMaxAgeHours: read.number('BASELINE_MAX_AGE_HOURS', 24, { min: 0, exclusiveMin: true }),
    },

    report: {
      enabled: read.boolean('DAILY_REPORT_ENABLED', true),
      time: read.timeOfDay('DAILY_REPORT_TIME', '07:00'),
      timeRaw: read.string('DAILY_REPORT_TIME', '07:00'),
      catchupDays: read.integer('DAILY_REPORT_CATCHUP_DAYS', 3, { min: 0, max: 30 }),
    },

    highConsumption: {
      enabled: read.boolean('HIGH_CONSUMPTION_ALERTS_ENABLED', true),
      dailyThreshold: read.number('HIGH_CONSUMPTION_THRESHOLD', 0.5, { min: 0, exclusiveMin: true }),
      hourlyThreshold: read.optionalNumber('HOURLY_HIGH_CONSUMPTION_THRESHOLD', { min: 0, exclusiveMin: true }),
      hourlyWindowMinutes: read.number('HOURLY_WINDOW_MINUTES', 60, { min: 1 }),
      cooldownHours: read.number('HIGH_CONSUMPTION_COOLDOWN_HOURS', 24, { min: 0 }),
      hourlyCooldownHours: read.number('HOURLY_HIGH_CONSUMPTION_COOLDOWN_HOURS', 3, { min: 0 }),
    },

    continuousFlow: {
      enabled: read.boolean('CONTINUOUS_FLOW_ENABLED', true),
      durationHours: read.number('CONTINUOUS_FLOW_DURATION_HOURS', 3, { min: 0, exclusiveMin: true }),
      detectionThreshold: read.number('FLOW_DETECTION_THRESHOLD', 0.001, { min: 0 }),
      reAlertHours: read.number('CONTINUOUS_FLOW_REALERT_HOURS', 0, { min: 0 }),
    },

    alerts: {
      maxAgeHours: read.number('ALERT_MAX_AGE_HOURS', 24, { min: 0, exclusiveMin: true }),
    },

    mail: {
      dryRun: read.boolean('MAIL_DRY_RUN', false),
      from: read.string('MAIL_FROM', 'watermate@localhost'),
      to: read.list('MAIL_TO', []),
      alertTo: read.list('MAIL_ALERT_TO', null),
      subjectPrefix: read.string('MAIL_SUBJECT_PREFIX', '[WaterMate]'),
      verifyOnStart: read.boolean('SMTP_VERIFY_ON_START', false),
      smtp: {
        host: read.string('SMTP_HOST', 'localhost'),
        port: read.integer('SMTP_PORT', 587, { min: 1, max: 65_535 }),
        user: read.optionalString('SMTP_USER'),
        password: read.optionalString('SMTP_PASSWORD'),
        tls: read.tlsMode('SMTP_TLS', 'starttls'),
        rejectUnauthorized: read.boolean('SMTP_REJECT_UNAUTHORIZED', true),
        name: read.optionalString('SMTP_CLIENT_NAME'),
      },
    },

    database: {
      path: read.string('DATABASE_PATH', path.join(ROOT, 'data', 'watermate.db')),
      retentionDays: read.integer('DATA_RETENTION_DAYS', 0, { min: 0 }),
    },

    log: {
      level: read.enum('LOG_LEVEL', 'info', LOG_LEVELS),
      format: read.enum('LOG_FORMAT', 'pretty', ['pretty', 'json']),
    },
  };

  // Derived values, computed once so the rest of the app never repeats the math.
  config.poll.intervalMs = Math.round(config.poll.intervalMinutes * 60_000);
  config.analysis.expectedIntervalMs = Math.round(config.analysis.expectedIntervalMinutes * 60_000);
  config.analysis.maxGapMs = Math.round(config.analysis.maxGapMinutes * 60_000);
  config.analysis.anchorMaxAgeMs = Math.round(config.analysis.anchorMaxAgeHours * 3_600_000);
  config.continuousFlow.durationMs = Math.round(config.continuousFlow.durationHours * 3_600_000);
  config.continuousFlow.reAlertMs = Math.round(config.continuousFlow.reAlertHours * 3_600_000);
  config.highConsumption.cooldownMs = Math.round(config.highConsumption.cooldownHours * 3_600_000);
  config.highConsumption.hourlyCooldownMs = Math.round(config.highConsumption.hourlyCooldownHours * 3_600_000);
  config.highConsumption.hourlyWindowMs = Math.round(config.highConsumption.hourlyWindowMinutes * 60_000);
  config.alerts.maxAgeMs = Math.round(config.alerts.maxAgeHours * 3_600_000);
  config.mail.alertTo = config.mail.alertTo ?? config.mail.to;

  if (config.analysis.maxGapMs <= config.analysis.expectedIntervalMs) {
    errors.push(
      'MAX_GAP_MINUTES must be greater than EXPECTED_READING_INTERVAL_MINUTES, ' +
        'otherwise every normal interval counts as a data gap',
    );
  }
  if (!config.mail.dryRun && config.mail.to.length === 0) {
    errors.push('MAIL_TO is required (or set MAIL_DRY_RUN=true to log mails instead of sending them)');
  }
  if (!config.meter.baseUrl.startsWith('http://') && !config.meter.baseUrl.startsWith('https://')) {
    errors.push('WATER_METER_BASE_URL must start with http:// or https://');
  }
  if (!config.meter.filePattern.includes('{date}')) {
    errors.push('WATER_METER_FILE_PATTERN must contain the {date} placeholder');
  }

  if (errors.length > 0) {
    const error = new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
    error.code = 'ERR_INVALID_CONFIG';
    error.details = errors;
    throw error;
  }

  config.meter.baseUrl = config.meter.baseUrl.replace(/\/+$/, '');
  return config;
}

/** Config view that is safe to log — secrets replaced by a marker. */
export function redactConfig(config) {
  const clone = structuredClone(config);
  clone.mail.smtp.password = config.mail.smtp.password ? '***' : null;
  clone.http.password = config.http.password ? '***' : null;
  return clone;
}

function createReader(env, errors) {
  const raw = (key) => {
    const value = env[key];
    return value == null || value.trim() === '' ? undefined : value.trim();
  };

  return {
    string(key, fallback) {
      return raw(key) ?? fallback;
    },
    optionalString(key) {
      return raw(key) ?? null;
    },
    number(key, fallback, { min, max, exclusiveMin } = {}) {
      const value = raw(key);
      if (value === undefined) return fallback;
      const parsed = Number(value.replace(',', '.'));
      if (!Number.isFinite(parsed)) {
        errors.push(`${key} must be a number (got "${value}")`);
        return fallback;
      }
      if (min !== undefined && (exclusiveMin ? parsed <= min : parsed < min)) {
        errors.push(`${key} must be ${exclusiveMin ? '>' : '>='} ${min} (got ${parsed})`);
        return fallback;
      }
      if (max !== undefined && parsed > max) {
        errors.push(`${key} must be <= ${max} (got ${parsed})`);
        return fallback;
      }
      return parsed;
    },
    optionalNumber(key, options) {
      if (raw(key) === undefined) return null;
      return this.number(key, null, options);
    },
    integer(key, fallback, options) {
      const value = this.number(key, fallback, options);
      if (!Number.isInteger(value)) {
        errors.push(`${key} must be a whole number (got ${value})`);
        return fallback;
      }
      return value;
    },
    boolean(key, fallback) {
      const value = raw(key);
      if (value === undefined) return fallback;
      const normalized = value.toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
      errors.push(`${key} must be a boolean (true/false, got "${value}")`);
      return fallback;
    },
    enum(key, fallback, allowed) {
      const value = raw(key);
      if (value === undefined) return fallback;
      if (!allowed.includes(value)) {
        errors.push(`${key} must be one of ${allowed.join(', ')} (got "${value}")`);
        return fallback;
      }
      return value;
    },
    list(key, fallback) {
      const value = raw(key);
      if (value === undefined) return fallback;
      return value
        .split(/[,;]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    timezone(key, fallback) {
      const value = raw(key) ?? fallback;
      if (!isValidTimeZone(value)) {
        errors.push(`${key} is not a valid IANA timezone (got "${value}")`);
        return fallback;
      }
      return value;
    },
    timeOfDay(key, fallback) {
      const value = raw(key) ?? fallback;
      try {
        return parseTimeOfDay(value);
      } catch (error) {
        errors.push(`${key}: ${error.message}`);
        return parseTimeOfDay(fallback);
      }
    },
    tlsMode(key, fallback) {
      const value = raw(key);
      if (value === undefined) return fallback;
      const normalized = value.toLowerCase();
      if (['starttls', 'implicit', 'none'].includes(normalized)) return normalized;
      // Convenience aliases so SMTP_TLS=true/false behaves as people expect.
      if (['1', 'true', 'yes', 'ssl', 'tls'].includes(normalized)) return 'implicit';
      if (['0', 'false', 'no'].includes(normalized)) return 'none';
      errors.push(`${key} must be one of starttls, implicit, none (got "${value}")`);
      return fallback;
    },
  };
}
