import { buildDailySummary, buildComparison } from '../analysis/consumption.js';
import { renderDailyReport } from '../mail/templates.js';
import { toLocalDate, addLocalDays, localTimeOnDate, localDateRange } from '../util/time.js';

/**
 * Daily report delivery.
 *
 * A report covers *yesterday* in the configured timezone and is sent once per
 * calendar day. The `daily_reports` table is the guard: the row is written only
 * after a successful send, and its primary key makes a second send for the same
 * date impossible — including after a restart, which is exactly when a naive
 * timer-based implementation would send a duplicate.
 *
 * Missed days (machine switched off, SMTP outage) are caught up on the next
 * run, bounded by DAILY_REPORT_CATCHUP_DAYS.
 */
export function createDailyReportService({ repository, config, mailer, logger }) {
  const log = logger.child({ component: 'report' });
  const channel = config.meter.channel;

  /** Report dates that are due at `now` and have not been sent yet. */
  function pendingDates(now) {
    const today = toLocalDate(now, config.timezone);
    const yesterday = addLocalDays(today, -1);
    const oldest = addLocalDays(today, -(config.report.catchupDays + 1));
    const alreadySent = repository.getSentReportDates(oldest);

    // Days before the very first stored reading predate this installation.
    // Reporting on them would mean mailing empty summaries for history that
    // never existed — a fresh install would otherwise send several at once.
    const firstReading = repository.getFirstReading(channel);
    const firstDate = firstReading ? toLocalDate(firstReading.tsUtc, config.timezone) : null;

    return localDateRange(oldest, yesterday).filter((date) => {
      if (alreadySent.has(date)) return false;
      // The report for date D is due at DAILY_REPORT_TIME on D+1.
      const dueAt = localTimeOnDate(addLocalDays(date, 1), config.report.time, config.timezone);
      if (now < dueAt) return false;
      // Yesterday is always reported, even with no data: silence from the meter
      // is exactly the kind of thing the report should surface.
      if (date === yesterday) return true;
      return firstDate !== null && date >= firstDate;
    });
  }

  /** Builds and sends one report. Returns `{sent:false}` when already recorded. */
  async function sendFor(date, { now = Date.now(), force = false } = {}) {
    if (!force && repository.getDailyReport(date)) {
      log.debug('Report already sent for this date', { date });
      return { date, sent: false, reason: 'already_sent' };
    }

    const summary = buildDailySummary({ repository, config, date, channel });
    const comparison = buildComparison({ repository, config, date, channel });
    const { subject, html, text } = renderDailyReport({ summary, config, comparison });

    try {
      const result = await mailer.send({ to: config.mail.to, subject, html, text, type: 'daily_report' });
      if (result.skipped) return { date, sent: false, reason: result.reason };

      const recorded = repository.recordDailyReport({
        date,
        channel,
        total: summary.total,
        startValue: summary.startValue,
        endValue: summary.endValue,
        readingCount: summary.readingCount,
        issueCount: summary.issues.length,
        payload: {
          total: summary.total,
          issues: summary.issues.map((issue) => issue.code),
          gaps: summary.gaps.length,
          decreases: summary.decreases.length,
        },
      }, now);

      log.info('Daily report sent', {
        date,
        total: summary.total,
        readings: summary.readingCount,
        issues: summary.issues.length,
        recorded,
      });
      return { date, sent: true, summary, recorded };
    } catch (error) {
      // No row is written, so the next cycle retries this date.
      log.error('Failed to send daily report', { date, error });
      return { date, sent: false, reason: 'send_failed', error };
    }
  }

  /** Sends every report that is due, oldest first. */
  async function sendDue(now = Date.now()) {
    if (!config.report.enabled) return { sent: [], skipped: 'disabled' };

    const dates = pendingDates(now);
    if (dates.length === 0) return { sent: [] };

    log.debug('Daily reports due', { dates });
    const outcomes = [];
    for (const date of dates) {
      outcomes.push(await sendFor(date, { now }));
    }
    return { sent: outcomes.filter((outcome) => outcome.sent), outcomes };
  }

  /** Renders without sending — used by the preview script and tests. */
  function preview(date) {
    const summary = buildDailySummary({ repository, config, date, channel });
    const comparison = buildComparison({ repository, config, date, channel });
    return { summary, ...renderDailyReport({ summary, config, comparison }) };
  }

  return { sendDue, sendFor, pendingDates, preview };
}
