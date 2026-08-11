/** Sleep that can be cancelled through an AbortSignal. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    // Deliberately not unref'ed: a pending retry must keep the process alive
    // until it resolves, otherwise the event loop can drain mid-backoff and
    // leave the caller's promise hanging forever.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry with exponential backoff and full jitter.
 *
 * `shouldRetry(error, attempt)` decides whether an error is transient. The
 * meter is a small embedded device on a home network, so timeouts and refused
 * connections are expected rather than exceptional.
 */
export async function withRetry(fn, {
  retries = 3,
  baseDelayMs = 1000,
  maxDelayMs = 30_000,
  shouldRetry = () => true,
  onRetry = () => {},
  signal,
  random = Math.random,
  sleepFn = sleep,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt > retries;
      if (isLast || !shouldRetry(error, attempt)) throw error;

      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(backoff / 2 + random() * (backoff / 2));
      onRetry({ error, attempt, delay });
      await sleepFn(delay, signal);
    }
  }
  throw lastError;
}
