#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createLogger } from './util/logger.js';
import { createApp } from './app.js';
import { openDatabase } from './db/database.js';
import { toLocalDate, addLocalDays } from './util/time.js';

/**
 * Entry point and small CLI.
 *
 *   node src/index.js               run continuously (default)
 *   node src/index.js --once        poll once, then exit
 *   node src/index.js --report [d]  send the report for a date (default: yesterday)
 *   node src/index.js --migrate     create/upgrade the database and exit
 *   node src/index.js --test-mail   send a test mail and exit
 *   node src/index.js --status      print current state and exit
 */
const USAGE = `WaterMate — water meter monitoring

Usage: node src/index.js [command]

Commands:
  (none)              Run continuously: poll on a schedule, alert and report
  --once              Run a single poll cycle, then exit
  --report [DATE]     Build and send the daily report (default: yesterday)
                      Use --force to resend a report that was already sent
  --migrate           Apply database migrations and exit
  --test-mail         Send a test mail to verify the SMTP settings
  --status            Show stored state and exit
  --help              Show this help
`;

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 78; // EX_CONFIG
  }

  const logger = createLogger({ level: config.log.level, format: config.log.format });

  if (argv.includes('--migrate')) {
    const db = openDatabase(config.database.path, { logger });
    db.close();
    logger.info('Database is up to date', { path: config.database.path });
    return 0;
  }

  const app = createApp({ config, logger });

  try {
    if (argv.includes('--test-mail')) return await testMail(app, logger);
    if (argv.includes('--status')) {
      const code = status(app, logger);
      await app.stop();
      return code;
    }
    if (argv.includes('--report')) return await sendReport(app, argv, logger);

    if (argv.includes('--once')) {
      const result = await app.pollOnce();
      logger.info('Single poll finished', {
        newReadings: result.inserted,
        files: result.dates?.length ?? 0,
      });
      await app.stop();
      return 0;
    }

    await runForever(app, logger);
    return 0;
  } catch (error) {
    logger.error('Fatal error', { error });
    await app.stop().catch(() => {});
    return 1;
  }
}

async function runForever(app, logger) {
  await app.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Received shutdown signal', { signal });
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A crash in a background task must be visible rather than silent.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: reason instanceof Error ? reason : new Error(String(reason)) });
  });
  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught exception, shutting down', { error });
    await app.stop().catch(() => {});
    process.exit(1);
  });

  logger.info('WaterMate is running — press Ctrl+C to stop');
}

async function sendReport(app, argv, logger) {
  const index = argv.indexOf('--report');
  const argument = argv[index + 1];
  const date =
    argument && /^\d{4}-\d{2}-\d{2}$/.test(argument)
      ? argument
      : addLocalDays(toLocalDate(Date.now(), app.config.timezone), -1);

  const result = await app.reports.sendFor(date, { force: argv.includes('--force') });
  if (!result.sent) {
    logger.warn('Report not sent', { date, reason: result.reason });
  }
  await app.stop();
  return result.sent || result.reason === 'already_sent' ? 0 : 1;
}

async function testMail(app, logger) {
  const { config } = app;
  await app.mailer.send({
    to: config.mail.to,
    type: 'test',
    subject: 'Test mail — configuration works',
    text: `WaterMate can reach ${config.mail.smtp.host}:${config.mail.smtp.port}.\nMeter: ${config.meter.baseUrl}\nTimezone: ${config.timezone}`,
    html: `<p style="font-family:sans-serif">WaterMate can reach <code>${config.mail.smtp.host}:${config.mail.smtp.port}</code>.</p>
<ul style="font-family:sans-serif"><li>Meter: <code>${config.meter.baseUrl}</code></li><li>Timezone: ${config.timezone}</li></ul>`,
  });
  logger.info('Test mail dispatched', { to: config.mail.to.join(', ') });
  await app.stop();
  return 0;
}

function status(app, logger) {
  const { config, repository } = app;
  const channel = config.meter.channel;
  const latest = repository.getLatestReading(channel);
  const first = repository.getFirstReading(channel);
  const flow = repository.getFlowState(channel);
  const yesterday = addLocalDays(toLocalDate(Date.now(), config.timezone), -1);

  logger.info('WaterMate status', {
    database: config.database.path,
    channel,
    readings: repository.countReadings(channel),
    firstReading: first?.rawTs ?? null,
    latestReading: latest?.rawTs ?? null,
    latestValue: latest?.value ?? null,
    flowing: flow?.flowing ?? false,
    lastReportSent: repository.getDailyReport(yesterday) ? yesterday : null,
    pendingReports: app.reports.pendingDates(Date.now()),
  });
  return 0;
}

// In continuous mode the scheduler's timers keep the event loop alive; the
// one-shot commands close the database and let the process exit on its own.
process.exitCode = await main(process.argv.slice(2));
