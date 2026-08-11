import { nextOccurrence, formatInstant } from './util/time.js';

/**
 * Timers for the two recurring jobs.
 *
 * The daily job re-computes its next run after every fire instead of using a
 * fixed 24 h interval, so DST changes and clock drift cannot move the report
 * time. Both jobs swallow errors — a failing cycle must never kill the process.
 */
export function createScheduler({ config, logger }) {
  const log = logger.child({ component: 'scheduler' });
  const timers = new Set();
  let stopped = false;

  function every(intervalMs, name, task) {
    const timer = setInterval(() => {
      run(name, task);
    }, intervalMs);
    timers.add(timer);
    log.info('Scheduled recurring job', { job: name, everyMinutes: +(intervalMs / 60_000).toFixed(2) });
    return timer;
  }

  function dailyAt(timeOfDay, name, task) {
    function schedule() {
      if (stopped) return;
      const now = Date.now();
      const next = nextOccurrence(now, timeOfDay, config.timezone);
      const delay = Math.max(1000, next - now);

      const timer = setTimeout(async () => {
        timers.delete(timer);
        await run(name, task);
        schedule();
      }, delay);
      timers.add(timer);

      log.info('Next daily job scheduled', {
        job: name,
        at: formatInstant(next, config.timezone),
        inMinutes: Math.round(delay / 60_000),
      });
    }
    schedule();
  }

  async function run(name, task) {
    if (stopped) return;
    try {
      await task();
    } catch (error) {
      log.error('Scheduled job failed', { job: name, error });
    }
  }

  function stop() {
    stopped = true;
    for (const timer of timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    timers.clear();
    log.debug('Scheduler stopped');
  }

  return { every, dailyAt, stop, run };
}
