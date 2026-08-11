import { withRetry } from '../util/retry.js';

/**
 * HTTP client for the meter's file server.
 *
 * The meter is an embedded device on a home network: it goes away during router
 * reboots, answers slowly and sometimes 404s the current day's file before the
 * first reading has been written. All of that is normal, so it is reported as a
 * status rather than thrown.
 */
export function createMeterClient({ config, logger, fetchImpl = globalThis.fetch }) {
  const { meter, http } = config;

  function urlFor(date) {
    return `${meter.baseUrl}/${meter.filePattern.replace('{date}', date)}`;
  }

  async function fetchDayFile(date, { etag, lastModified, signal } = {}) {
    const url = urlFor(date);
    const headers = {
      'user-agent': http.userAgent,
      accept: 'text/csv, text/plain, */*',
    };
    // Conditional GET: a finished day answers 304 and costs almost nothing.
    if (etag) headers['if-none-match'] = etag;
    else if (lastModified) headers['if-modified-since'] = lastModified;
    if (http.username) {
      headers.authorization = `Basic ${Buffer.from(`${http.username}:${http.password ?? ''}`).toString('base64')}`;
    }

    return withRetry(
      async (attempt) => {
        const timeoutSignal = AbortSignal.timeout(http.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

        logger.trace('Requesting meter file', { url, attempt });
        const response = await fetchImpl(url, { headers, signal: combined, redirect: 'follow' });

        if (response.status === 304) {
          return { status: 'not-modified', url, date };
        }
        if (response.status === 404) {
          // Consume the body so the socket can be reused.
          await response.arrayBuffer().catch(() => {});
          return { status: 'not-found', url, date, httpStatus: 404 };
        }
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
          error.code = 'ERR_HTTP_STATUS';
          error.httpStatus = response.status;
          await response.arrayBuffer().catch(() => {});
          throw error;
        }

        const text = await response.text();
        return {
          status: 'ok',
          url,
          date,
          text,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          bytes: Buffer.byteLength(text),
        };
      },
      {
        retries: http.retries,
        baseDelayMs: http.retryBaseDelayMs,
        signal,
        shouldRetry: isTransient,
        onRetry: ({ error, attempt, delay }) => {
          logger.warn('Meter request failed, retrying', {
            url,
            attempt,
            retryInMs: delay,
            error: error.message,
          });
        },
      },
    );
  }

  return { urlFor, fetchDayFile };
}

/** Timeouts, socket errors, 429 and 5xx are worth retrying; 4xx is not. */
export function isTransient(error) {
  if (error?.httpStatus) return error.httpStatus === 429 || error.httpStatus >= 500;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  const code = error?.code ?? error?.cause?.code;
  return [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ].includes(code);
}
