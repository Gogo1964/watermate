#!/usr/bin/env node
/**
 * Renders every email template with realistic sample data into
 * `templates/examples/`, so the layouts can be reviewed in a browser without
 * sending anything. Run with `npm run templates:preview`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { createRepository } from '../src/db/repository.js';
import { buildDailySummary, buildComparison } from '../src/analysis/consumption.js';
import {
  renderDailyReport,
  renderHighConsumptionAlert,
  renderContinuousFlowAlert,
} from '../src/mail/templates.js';
import { toLocalDate, localDayBounds } from '../src/util/time.js';

const OUTPUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'examples');

const config = loadConfig({
  skipEnvFile: true,
  env: {
    MAIL_DRY_RUN: 'true',
    TIMEZONE: 'Europe/Berlin',
    DATABASE_PATH: ':memory:',
    HIGH_CONSUMPTION_THRESHOLD: '0.5',
  },
});

const db = openDatabase(':memory:');
const repository = createRepository(db);

const DATE = '2026-08-10';
const { start } = localDayBounds(DATE, config.timezone);

/** A believable household day: quiet night, shower peak, evening cooking. */
function householdProfile(hour) {
  if (hour >= 1 && hour < 6) return 0;
  if (hour === 6) return 0.02;
  if (hour === 7) return 0.09; // showers
  if (hour === 8) return 0.05;
  if (hour >= 9 && hour < 12) return 0.01;
  if (hour === 12) return 0.03;
  if (hour >= 13 && hour < 18) return 0.012;
  if (hour === 18) return 0.04; // cooking
  if (hour === 19) return 0.06;
  if (hour === 20) return 0.03;
  return 0.005;
}

// Seed a week of history plus the reported day, forwards, so the odometer only
// ever increases — exactly as a real meter behaves.
let meter = 408.9;
for (let offset = 7; offset >= 1; offset -= 1) {
  meter = seedDay(shiftDate(DATE, -offset), meter, { scale: 0.85 + (offset % 3) * 0.12 });
}
// The reported day loses its readings between 15:00 and 15:50, so the
// data-quality section of the example has something real to show.
seedDay(DATE, meter, { skip: { fromHour: 15, toHour: 15.85 } });

const summary = buildDailySummary({ repository, config, date: DATE });
const comparison = buildComparison({ repository, config, date: DATE });

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

write('daily-report', renderDailyReport({ summary, config, comparison }));

write(
  'high-consumption-alert',
  renderHighConsumptionAlert({
    config,
    scope: 'daily',
    total: 1.284,
    threshold: config.highConsumption.dailyThreshold,
    periodLabel: DATE,
    from: start,
    to: start + 19 * 3_600_000,
    summary,
  }),
);

write(
  'continuous-flow-alert',
  renderContinuousFlowAlert({
    config,
    event: {
      channel: 'main',
      startedAt: start + 23 * 3_600_000,
      throughTs: start + 26.5 * 3_600_000,
      durationMs: 3.5 * 3_600_000,
      volume: 0.294,
      repeat: false,
    },
  }),
);

db.close();
process.stdout.write(`Rendered example emails into ${path.relative(process.cwd(), OUTPUT_DIR)}\n`);

function write(name, { subject, html, text }) {
  fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.html`), html);
  fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.txt`), `Subject: ${config.mail.subjectPrefix} ${subject}\n\n${text}\n`);
  process.stdout.write(`  ${name}.html / ${name}.txt — ${subject}\n`);
}

/** Seeds one day and returns the closing meter reading. */
function seedDay(date, startValue, { scale = 1, skip = null } = {}) {
  const bounds = localDayBounds(date, config.timezone);
  const readings = [];
  let value = startValue;

  for (let ts = bounds.start; ts < bounds.end; ts += 5 * 60_000) {
    const hourOfDay = (ts - bounds.start) / 3_600_000;
    // Spread the hour's volume over its twelve intervals, with mild jitter.
    const perInterval = (householdProfile(Math.floor(hourOfDay)) * scale) / 12;
    const jitter = perInterval * (Math.sin(ts / 1e7) * 0.4);
    value = Math.round((value + Math.max(0, perInterval + jitter)) * 1e4) / 1e4;

    // The meter keeps counting during an outage — only the readings are lost.
    if (skip && hourOfDay >= skip.fromHour && hourOfDay < skip.toHour) continue;

    readings.push({
      tsUtc: ts,
      channel: 'main',
      value,
      rawTs: new Date(ts).toISOString(),
      localDate: toLocalDate(ts, config.timezone),
    });
  }
  repository.insertReadings(readings, { sourceFile: `example/data_${date}.csv` });
  return value;
}

function shiftDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}
