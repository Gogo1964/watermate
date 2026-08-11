import crypto from 'node:crypto';
import { parseCsv } from './csv.js';
import { toLocalDate, addLocalDays, localDateRange, localDayBounds, localDateDiff } from '../util/time.js';

/**
 * Downloads the meter's daily CSV files and stores every new reading.
 *
 * Design notes:
 *  - The current day's file grows all day, so it is re-fetched every cycle and
 *    the database primary key absorbs the rows already seen. That is far more
 *    robust than tracking byte offsets against an embedded file server.
 *  - Previous days are re-fetched too (up to BACKFILL_DAYS) so an outage does
 *    not lose data. Once a day is over and has been downloaded successfully it
 *    is marked `finalized` and never requested again.
 *  - Conditional GETs (ETag / Last-Modified) keep the traffic negligible.
 */
export function createCollector({ repository, client, config, logger, flowMonitor }) {
  const log = logger.child({ component: 'collector' });
  const channel = config.meter.channel;
  let running = false;

  /** Which calendar dates are worth downloading right now. */
  function datesToFetch(now) {
    const today = toLocalDate(now, config.timezone);
    const earliest = addLocalDays(today, -config.poll.backfillDays);
    const candidates = localDateRange(earliest, today);

    return candidates.filter((date) => {
      const record = repository.getSourceFile(date);
      if (!record) return true;
      if (record.finalized === 1) return false;
      // Give up on files that never appeared and can no longer be produced.
      if (record.fail_count >= 10 && !record.last_success_at && localDateDiff(today, date) > 1) return false;
      return true;
    });
  }

  async function collect({ now = Date.now(), signal } = {}) {
    if (running) {
      log.warn('Skipping poll, previous cycle is still running');
      return { skipped: true };
    }
    running = true;
    const startedAt = Date.now();

    try {
      const dates = datesToFetch(now);
      log.debug('Polling meter', { dates, baseUrl: config.meter.baseUrl });

      const results = [];
      let insertedTotal = 0;

      for (const date of dates) {
        if (signal?.aborted) break;
        const result = await collectDate(date, now, signal);
        results.push(result);
        insertedTotal += result.inserted ?? 0;
      }

      // A single analysis pass over everything that was just added keeps the
      // interval series continuous across day boundaries.
      const analysis = insertedTotal > 0 ? await flowMonitor.process(now) : { processed: 0, events: [] };

      const summary = {
        dates: results.map((result) => result.date),
        inserted: insertedTotal,
        analysed: analysis.processed,
        flowEvents: analysis.events?.length ?? 0,
        durationMs: Date.now() - startedAt,
        results,
      };

      if (insertedTotal > 0) {
        log.info('Poll complete', {
          newReadings: insertedTotal,
          files: results.length,
          durationMs: summary.durationMs,
        });
      } else {
        log.debug('Poll complete, no new readings', { files: results.length, durationMs: summary.durationMs });
      }
      return summary;
    } finally {
      running = false;
    }
  }

  async function collectDate(date, now, signal) {
    const existing = repository.getSourceFile(date);
    let response;

    try {
      response = await client.fetchDayFile(date, {
        etag: existing?.etag,
        lastModified: existing?.last_modified,
        signal,
      });
    } catch (error) {
      const failCount = (existing?.fail_count ?? 0) + 1;
      repository.saveSourceFile({
        fileDate: date,
        url: client.urlFor(date),
        lastFetchAt: now,
        rowsTotal: existing?.rows_total ?? 0,
        rowsValid: existing?.rows_valid ?? 0,
        rowsInvalid: existing?.rows_invalid ?? 0,
        failCount,
        lastError: error.message,
      });
      log.error('Failed to download meter file', { date, failCount, error });
      return { date, status: 'error', error: error.message, inserted: 0 };
    }

    if (response.status === 'not-modified') {
      log.trace('File unchanged since last poll', { date });
      repository.saveSourceFile({
        fileDate: date,
        url: response.url,
        lastFetchAt: now,
        lastSuccessAt: now,
        rowsTotal: existing?.rows_total ?? 0,
        rowsValid: existing?.rows_valid ?? 0,
        rowsInvalid: existing?.rows_invalid ?? 0,
        failCount: 0,
        finalized: shouldFinalize(date, now),
      });
      return { date, status: 'not-modified', inserted: 0 };
    }

    if (response.status === 'not-found') {
      // Perfectly normal for today before the first reading is written.
      const isToday = date === toLocalDate(now, config.timezone);
      const level = isToday ? 'debug' : 'warn';
      log[level]('Meter file not available', { date, url: response.url });
      repository.saveSourceFile({
        fileDate: date,
        url: response.url,
        lastFetchAt: now,
        rowsTotal: existing?.rows_total ?? 0,
        rowsValid: existing?.rows_valid ?? 0,
        rowsInvalid: existing?.rows_invalid ?? 0,
        failCount: (existing?.fail_count ?? 0) + 1,
        lastError: 'HTTP 404',
      });
      return { date, status: 'not-found', inserted: 0 };
    }

    const contentHash = crypto.createHash('sha1').update(response.text).digest('hex');
    if (existing?.content_hash === contentHash) {
      log.trace('File content identical to last poll', { date });
      repository.saveSourceFile({
        fileDate: date,
        url: response.url,
        etag: response.etag,
        lastModified: response.lastModified,
        contentHash,
        lastFetchAt: now,
        lastSuccessAt: now,
        rowsTotal: existing.rows_total,
        rowsValid: existing.rows_valid,
        rowsInvalid: existing.rows_invalid,
        failCount: 0,
        finalized: shouldFinalize(date, now),
      });
      return { date, status: 'unchanged', inserted: 0 };
    }

    const parsed = parseCsv(response.text, {
      timezone: config.timezone,
      okStatus: config.meter.okStatus,
      delimiter: config.meter.delimiter,
      timestampColumn: config.meter.timestampColumn,
      channelColumn: config.meter.channelColumn,
      valueColumn: config.meter.valueColumn,
      statusColumn: config.meter.statusColumn,
      channel,
      sourceFile: response.url,
    });

    logInvalidRows(date, parsed);

    const { inserted, conflicts } = repository.insertReadings(parsed.rows, {
      sourceFile: response.url,
      now,
    });

    for (const conflict of conflicts) {
      log.warn('Reading conflicts with stored value, keeping the stored one', {
        date,
        ts: conflict.rawTs,
        stored: conflict.existingValue,
        incoming: conflict.value,
      });
    }

    repository.saveSourceFile({
      fileDate: date,
      url: response.url,
      etag: response.etag,
      lastModified: response.lastModified,
      contentHash,
      lastFetchAt: now,
      lastSuccessAt: now,
      rowsTotal: parsed.total,
      rowsValid: parsed.rows.length,
      rowsInvalid: parsed.invalid.length,
      rowsInserted: inserted,
      failCount: 0,
      finalized: shouldFinalize(date, now),
    });

    if (inserted > 0) {
      log.info('Stored new readings', {
        date,
        inserted,
        validRows: parsed.rows.length,
        invalidRows: parsed.invalid.length,
        bytes: response.bytes,
      });
    }

    return {
      date,
      status: 'ok',
      inserted,
      validRows: parsed.rows.length,
      invalidRows: parsed.invalid.length,
      conflicts: conflicts.length,
    };
  }

  /** A past day whose file has been read after it ended will not change again. */
  function shouldFinalize(date, now) {
    const { end } = localDayBounds(date, config.timezone);
    return now >= end + config.poll.finalizeGraceMinutes * 60_000;
  }

  function logInvalidRows(date, parsed) {
    if (parsed.invalid.length === 0) return;
    const byReason = {};
    for (const row of parsed.invalid) {
      byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
    }
    log.warn('Rejected CSV rows', { date, count: parsed.invalid.length, reasons: byReason });
    for (const row of parsed.invalid.slice(0, 3)) {
      log.debug('Rejected row', { date, line: row.lineNumber, reason: row.reason, detail: row.detail });
    }
  }

  return { collect, collectDate, datesToFetch };
}
