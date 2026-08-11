import path from 'node:path';
import { openDatabase } from './db/database.js';
import { createRepository } from './db/repository.js';
import { createMeterClient } from './meter/client.js';
import { createCollector } from './meter/collector.js';
import { createFlowMonitor } from './monitor/flowMonitor.js';
import { createHighConsumptionMonitor } from './monitor/highConsumption.js';
import { createAlertManager } from './monitor/alertManager.js';
import { createDailyReportService } from './reports/dailyReport.js';
import { createMailer } from './mail/mailer.js';
import { createScheduler } from './scheduler.js';
import { toLocalDate, formatInstant } from './util/time.js';

// This module only exports a factory, so running it directly would silently do
// nothing at all. Say so instead of leaving the user staring at a blank prompt.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.stderr.write(
    'app.js is the composition root, not the entry point — running it does nothing.\n' +
      'Start WaterMate with:\n\n' +
      '  npm start                 (from the project root)\n' +
      '  node src/index.js --help  (all commands)\n',
  );
  process.exit(64); // EX_USAGE
}

/**
 * Composition root: builds every service, wires them together and owns the
 * process lifecycle. Each dependency can be overridden, which is what the
 * integration tests use to swap in a fake meter and an in-memory mailbox.
 */
export function createApp({ config, logger, deps = {} }) {
  const log = logger.child({ component: 'app' });
  const abortController = new AbortController();

  const db = deps.db ?? openDatabase(config.database.path, { logger });
  const repository = deps.repository ?? createRepository(db);
  const mailer = deps.mailer ?? createMailer({ config, logger, transport: deps.transport });
  const client = deps.client ?? createMeterClient({ config, logger, fetchImpl: deps.fetchImpl });
  const alerts = deps.alerts ?? createAlertManager({ repository, mailer, config, logger });
  const flowMonitor = deps.flowMonitor ?? createFlowMonitor({ repository, config, alerts, logger });
  const highConsumption =
    deps.highConsumption ?? createHighConsumptionMonitor({ repository, config, alerts, logger });
  const reports = deps.reports ?? createDailyReportService({ repository, config, mailer, logger });
  const collector =
    deps.collector ?? createCollector({ repository, client, config, logger, flowMonitor });
  const scheduler = deps.scheduler ?? createScheduler({ config, logger });

  reconcileTimezone();

  /** One complete cycle: download, analyse, then evaluate the thresholds. */
  async function pollOnce(now = Date.now()) {
    const collected = await collector.collect({ now, signal: abortController.signal });
    if (collected.skipped) return collected;

    const thresholds = await highConsumption.check(now);
    return { ...collected, thresholds };
  }

  async function start() {
    log.info('WaterMate starting', {
      meter: config.meter.baseUrl,
      channel: config.meter.channel,
      timezone: config.timezone,
      pollIntervalMinutes: config.poll.intervalMinutes,
      dailyReportTime: config.report.timeRaw,
      dryRun: config.mail.dryRun,
      database: config.database.path,
    });
    logState();

    if (config.mail.verifyOnStart) {
      try {
        await mailer.verify();
      } catch (error) {
        log.error('SMTP verification failed — mails will likely not be delivered', { error });
      }
    }

    scheduler.every(config.poll.intervalMs, 'poll', () => pollOnce());

    if (config.report.enabled) {
      scheduler.dailyAt(config.report.time, 'daily-report', () => reports.sendDue());
    } else {
      log.info('Daily report disabled (DAILY_REPORT_ENABLED=false)');
    }

    if (config.poll.onStart) {
      await scheduler.run('poll', () => pollOnce());
    }

    // Catch up on reports that were missed while the process was down.
    if (config.report.enabled) {
      await scheduler.run('daily-report-catchup', () => reports.sendDue());
    }

    if (config.database.retentionDays > 0) {
      scheduler.every(24 * 3_600_000, 'prune', () => prune());
      await scheduler.run('prune', () => prune());
    }
  }

  async function prune() {
    const cutoff = Date.now() - config.database.retentionDays * 86_400_000;
    const removed = repository.pruneBefore(cutoff);
    if (removed.readings > 0 || removed.anomalies > 0) {
      log.info('Pruned old data', { ...removed, olderThan: formatInstant(cutoff, config.timezone) });
    }
  }

  function logState() {
    const latest = repository.getLatestReading(config.meter.channel);
    const flow = repository.getFlowState(config.meter.channel);
    log.info('Restored state from database', {
      storedReadings: repository.countReadings(config.meter.channel),
      latestReading: latest ? formatInstant(latest.tsUtc, config.timezone) : 'none',
      latestValue: latest?.value ?? null,
      flowing: flow?.flowing ?? false,
      flowSince: flow?.flowing ? formatInstant(flow.startedAt, config.timezone) : null,
    });
  }

  /**
   * `local_date` caches the calendar day of each reading in the configured
   * timezone. If TIMEZONE changes, that cache is stale and daily totals would
   * silently use the old day boundaries — so it is rebuilt once.
   */
  function reconcileTimezone() {
    const stored = repository.getMeta('timezone');
    if (stored === config.timezone) return;
    if (stored) {
      const updated = repository.relabelLocalDates(config.meter.channel, (ts) =>
        toLocalDate(ts, config.timezone),
      );
      log.warn('Timezone changed, re-labelled stored readings', {
        from: stored,
        to: config.timezone,
        updatedReadings: updated,
      });
    }
    repository.setMeta('timezone', config.timezone);
  }

  async function stop() {
    log.info('WaterMate shutting down');
    abortController.abort(new Error('Shutting down'));
    scheduler.stop();
    mailer.close?.();
    try {
      db.close();
    } catch (error) {
      log.warn('Failed to close database cleanly', { error });
    }
  }

  return {
    start,
    stop,
    pollOnce,
    prune,
    config,
    db,
    repository,
    mailer,
    collector,
    reports,
    alerts,
    flowMonitor,
    highConsumption,
    scheduler,
  };
}
