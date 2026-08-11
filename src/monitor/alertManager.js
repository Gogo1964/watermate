/**
 * Central alert dispatch with suppression.
 *
 * Polling runs every few minutes while an alert condition can persist for
 * hours, so every alert carries a `dedupKey` and a cooldown. The key is
 * recorded in SQLite only after a successful send, which means a failed SMTP
 * attempt is retried on the next cycle instead of being silently swallowed.
 */
export function createAlertManager({ repository, mailer, config, logger }) {
  const log = logger.child({ component: 'alerts' });

  async function dispatch({ type, dedupKey, cooldownMs, subject, html, text, payload, to, now = Date.now() }) {
    if (!repository.shouldSendAlert(dedupKey, cooldownMs, now)) {
      const existing = repository.getAlert(dedupKey);
      log.debug('Alert suppressed', {
        type,
        dedupKey,
        lastSentAt: existing ? new Date(Number(existing.last_sent_at)).toISOString() : null,
        sendCount: existing?.send_count,
      });
      return { sent: false, reason: 'suppressed' };
    }

    try {
      const result = await mailer.send({ to: to ?? config.mail.alertTo, subject, html, text, type });
      if (result.skipped) return { sent: false, reason: result.reason };

      repository.recordAlertSent(dedupKey, type, payload, now);
      log.warn('Alert sent', { type, dedupKey, subject });
      return { sent: true, result };
    } catch (error) {
      // Not recording the key means the next poll will try again.
      log.error('Failed to send alert', { type, dedupKey, error });
      return { sent: false, reason: 'send_failed', error };
    }
  }

  return {
    dispatch,
    /** Called when a condition clears, so the next occurrence alerts again. */
    reset(dedupKey) {
      repository.clearAlert(dedupKey);
      log.debug('Alert state cleared', { dedupKey });
    },
    resetPrefix(prefix) {
      repository.clearAlertsWithPrefix(prefix);
    },
  };
}
