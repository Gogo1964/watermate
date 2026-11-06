import { renderMeterStaleAlert, renderMeterRecoveredAlert } from '../mail/templates.js';
import { toLocalDate } from '../util/time.js';

/**
 * Notices when the meter stops delivering usable data.
 *
 * Without this, an outage is invisible: the daily report simply says 0.000 m³
 * and every log line is a warning nobody reads. The trigger is deliberately
 * "no valid reading for METER_STALE_HOURS" rather than "HTTP failed", because
 * the two failure modes seen in practice look very different on the wire but
 * mean the same thing for the user:
 *  - the device is gone from the network (EHOSTUNREACH, timeouts);
 *  - the device answers, but every CSV row carries a meter error (camera
 *    misaligned, digits unreadable), so nothing is stored.
 *
 * The current poll's outcome is only used to explain *why* data is missing.
 * Alert state lives in the alerts table, so a restart neither re-sends the
 * alert nor forgets to send the all-clear.
 */
export function createMeterHealthMonitor({ repository, config, alerts, logger, startedAt = Date.now() }) {
  const log = logger.child({ component: 'meter-health' });
  const settings = config.meterHealth;
  const channel = config.meter.channel;
  const staleKey = `meter-stale:${channel}`;

  async function check(collected, now = Date.now()) {
    if (!settings?.enabled) return { checked: false, reason: 'disabled' };

    const latest = repository.getLatestReading(channel);
    // A fresh database has no reading yet; measure from process start so an
    // installation that never received data still raises the alarm.
    const lastValidAt = latest?.tsUtc ?? null;
    const reference = lastValidAt ?? startedAt;
    const ageMs = now - reference;
    const active = repository.getAlert(staleKey);

    if (ageMs < settings.staleMs) {
      if (active && latest) return recover({ active, latest, now });
      return { checked: true, stale: false, ageMs };
    }

    const cause = diagnose(collected, now);
    const { subject, html, text } = renderMeterStaleAlert({
      config,
      lastValidAt,
      lastValue: latest?.value ?? null,
      ageMs,
      cause,
      repeat: Boolean(active),
      now,
    });

    const outcome = await alerts.dispatch({
      type: 'meter_stale',
      dedupKey: staleKey,
      cooldownMs: settings.reAlertMs,
      subject,
      html,
      text,
      payload: { lastValidAt, cause },
      now,
    });

    if (outcome.sent) {
      log.warn('Meter delivers no valid data', { lastValidAt, ageMinutes: Math.round(ageMs / 60_000), cause });
    }
    return { checked: true, stale: true, ageMs, cause, ...outcome };
  }

  async function recover({ active, latest, now }) {
    if (!settings.recoveryAlerts) {
      alerts.reset(staleKey);
      log.info('Meter delivers data again');
      return { checked: true, stale: false, recovered: true, sent: false };
    }

    const payload = safeParse(active.payload);
    const { subject, html, text } = renderMeterRecoveredAlert({
      config,
      lastValidBefore: payload.lastValidAt ?? null,
      firstAlertAt: Number(active.first_sent_at),
      latestAt: latest.tsUtc,
      latestValue: latest.value,
      lastCause: payload.cause ?? null,
    });

    const outcome = await alerts.dispatch({
      type: 'meter_recovered',
      // One all-clear per outage, keyed by when that outage was first reported.
      dedupKey: `meter-recovered:${channel}:${active.first_sent_at}`,
      cooldownMs: 0,
      subject,
      html,
      text,
      payload: { latestAt: latest.tsUtc },
      now,
    });

    // Keep the outage open if the mail failed, so the next poll retries the
    // all-clear instead of losing it.
    if (outcome.reason !== 'send_failed') {
      alerts.reset(staleKey);
      log.info('Meter delivers data again', { latestAt: latest.tsUtc });
    }
    return { checked: true, stale: false, recovered: true, ...outcome };
  }

  /**
   * Turns the poll result into a cause. Today's file is the one the meter is
   * writing right now, so it decides; older days only fill in when today was
   * not polled at all.
   */
  function diagnose(collected, now) {
    const today = toLocalDate(now, config.timezone);
    const results = collected?.results ?? [];
    const current = results.find((result) => result.date === today) ?? results.at(-1);

    if (!current) return { kind: 'unknown' };

    if (current.status === 'error') {
      const code = current.errorCode ?? null;
      if (code === 'ERR_HTTP_STATUS') {
        return { kind: 'http_error', detail: current.error };
      }
      return { kind: 'unreachable', code, detail: current.error };
    }

    if (current.status === 'not-found') return { kind: 'file_missing', date: current.date };

    // Either freshly parsed, or unchanged since a parse that is on record.
    const record = repository.getSourceFile(current.date);
    const valid = current.validRows ?? record?.rows_valid ?? 0;
    const invalid = current.invalidRows ?? record?.rows_invalid ?? 0;
    if (valid === 0 && invalid > 0) {
      return { kind: 'rows_rejected', date: current.date, rejected: invalid, reasons: current.rejectReasons ?? null };
    }
    return { kind: 'no_new_data', date: current.date };
  }

  return { check, diagnose };
}

function safeParse(json) {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}
