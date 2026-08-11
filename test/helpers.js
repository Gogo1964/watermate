import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { createRepository } from '../src/db/repository.js';
import { createNullLogger } from '../src/util/logger.js';
import { createMailer, createMemoryTransport } from '../src/mail/mailer.js';
import { createAlertManager } from '../src/monitor/alertManager.js';
import { toLocalDate } from '../src/util/time.js';

/** Config built from an explicit environment — never touches a real `.env`. */
export function testConfig(overrides = {}) {
  return loadConfig({
    skipEnvFile: true,
    env: {
      WATER_METER_BASE_URL: 'http://meter.test/fileserver/log/data',
      TIMEZONE: 'Europe/Berlin',
      MAIL_TO: 'owner@example.com',
      MAIL_FROM: 'watermate@example.com',
      DATABASE_PATH: ':memory:',
      HIGH_CONSUMPTION_THRESHOLD: '0.5',
      CONTINUOUS_FLOW_DURATION_HOURS: '3',
      FLOW_DETECTION_THRESHOLD: '0.001',
      LOG_LEVEL: 'error',
      ...overrides,
    },
  });
}

/** A repository backed by a throwaway in-memory database. */
export function testRepository() {
  const db = openDatabase(':memory:');
  return { db, repository: createRepository(db) };
}

/** Mailer that records messages instead of sending them. */
export function testMailer(config) {
  const transport = createMemoryTransport();
  const mailer = createMailer({ config, logger: createNullLogger(), transport });
  return { mailer, transport, messages: transport.messages };
}

export function testAlerts({ repository, config, mailer }) {
  return createAlertManager({ repository, mailer, config, logger: createNullLogger() });
}

export const logger = createNullLogger();

/** Epoch millis for a `+02:00` (Berlin summer) wall-clock time. */
export function berlinSummer(day, hour, minute = 0, second = 0) {
  return Date.UTC(2026, 7, day, hour - 2, minute, second);
}

/**
 * Builds a series of readings.
 * `deltas` are the per-interval increments; the first reading carries `start`.
 */
export function makeReadings({ startTs, intervalMs = 5 * 60_000, start = 100, deltas = [] }) {
  const readings = [{ tsUtc: startTs, value: round(start) }];
  let value = start;
  for (let i = 0; i < deltas.length; i += 1) {
    value = round(value + deltas[i]);
    readings.push({ tsUtc: startTs + (i + 1) * intervalMs, value });
  }
  return readings;
}

/** Writes readings straight into the database, as ingestion would. */
export function seedReadings(repository, readings, { channel = 'main', timezone = 'Europe/Berlin' } = {}) {
  return repository.insertReadings(
    readings.map((reading) => ({
      tsUtc: reading.tsUtc,
      channel,
      value: reading.value,
      rawTs: new Date(reading.tsUtc).toISOString(),
      localDate: toLocalDate(reading.tsUtc, timezone),
    })),
    { sourceFile: 'seed' },
  );
}

/** Renders readings as CSV lines exactly as the meter writes them. */
export function toCsv(readings, { channel = 'main', status = 'no error', offset = '+0200' } = {}) {
  return readings
    .map((reading) => {
      const shifted = new Date(reading.tsUtc + offsetMs(offset));
      const stamp = shifted.toISOString().slice(0, 19);
      const value = reading.value.toFixed(4).padStart(10, '0');
      return `${stamp}${offset},${channel},${value},${reading.value.toFixed(4)},${reading.value.toFixed(4)},0.000000,0.0000,${reading.status ?? status},0.2,0.2,0.2,2.1,0.2,6.2,2.9,8.5,6.0`;
    })
    .join('\n');
}

function offsetMs(offset) {
  const sign = offset[0] === '-' ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 3_600_000 + Number(digits.slice(2, 4)) * 60_000);
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Minimal `fetch` stand-in driven by a `{ 'YYYY-MM-DD': body }` map. */
export function fakeFetch(files, { onRequest } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    onRequest?.(url, calls.length);
    const match = /data_(\d{4}-\d{2}-\d{2})\.csv$/.exec(url);
    const key = match?.[1];
    const entry = files[key];

    if (entry === undefined) return response(404, '');
    if (typeof entry === 'function') {
      const produced = entry(calls.length);
      if (produced == null) return response(404, '');
      if (produced instanceof Error) throw produced;
      return response(200, produced);
    }
    if (entry instanceof Error) throw entry;
    return response(200, entry);
  };
  return { fetchImpl, calls };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    headers: new Map([['etag', null]]),
    async text() {
      return body;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}
