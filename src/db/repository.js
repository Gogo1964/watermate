import { transaction } from './database.js';

/**
 * All SQL lives here. The rest of the application talks to plain objects, which
 * keeps the domain logic pure and easy to unit test.
 */
export function createRepository(db) {
  const statements = {
    insertReading: db.prepare(`
      INSERT OR IGNORE INTO readings
        (channel, ts_utc, value, local_date, raw_ts, source_file, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    readingAt: db.prepare('SELECT * FROM readings WHERE channel = ? AND ts_utc = ?'),
    readingsBetween: db.prepare(`
      SELECT ts_utc, value, local_date, raw_ts FROM readings
      WHERE channel = ? AND ts_utc >= ? AND ts_utc < ?
      ORDER BY ts_utc ASC
    `),
    readingsAfter: db.prepare(`
      SELECT ts_utc, value, local_date, raw_ts FROM readings
      WHERE channel = ? AND ts_utc > ?
      ORDER BY ts_utc ASC
      LIMIT ?
    `),
    lastReadingBefore: db.prepare(`
      SELECT ts_utc, value, local_date, raw_ts FROM readings
      WHERE channel = ? AND ts_utc < ?
      ORDER BY ts_utc DESC
      LIMIT 1
    `),
    latestReading: db.prepare(`
      SELECT ts_utc, value, local_date, raw_ts FROM readings
      WHERE channel = ? ORDER BY ts_utc DESC LIMIT 1
    `),
    firstReading: db.prepare(`
      SELECT ts_utc, value, local_date, raw_ts FROM readings
      WHERE channel = ? ORDER BY ts_utc ASC LIMIT 1
    `),
    countReadings: db.prepare('SELECT COUNT(*) AS n FROM readings WHERE channel = ?'),
    deleteReadingsBefore: db.prepare('DELETE FROM readings WHERE ts_utc < ?'),

    getSourceFile: db.prepare('SELECT * FROM source_files WHERE file_date = ?'),
    listSourceFiles: db.prepare('SELECT * FROM source_files WHERE file_date >= ? ORDER BY file_date ASC'),
    upsertSourceFile: db.prepare(`
      INSERT INTO source_files
        (file_date, url, etag, last_modified, content_hash, last_fetch_at, last_success_at,
         rows_total, rows_valid, rows_invalid, rows_inserted, finalized, fail_count, last_error)
      VALUES (@file_date, @url, @etag, @last_modified, @content_hash, @last_fetch_at, @last_success_at,
              @rows_total, @rows_valid, @rows_invalid, @rows_inserted, @finalized, @fail_count, @last_error)
      ON CONFLICT (file_date) DO UPDATE SET
        url             = excluded.url,
        etag            = COALESCE(excluded.etag, source_files.etag),
        last_modified   = COALESCE(excluded.last_modified, source_files.last_modified),
        content_hash    = COALESCE(excluded.content_hash, source_files.content_hash),
        last_fetch_at   = excluded.last_fetch_at,
        last_success_at = COALESCE(excluded.last_success_at, source_files.last_success_at),
        rows_total      = excluded.rows_total,
        rows_valid      = excluded.rows_valid,
        rows_invalid    = excluded.rows_invalid,
        rows_inserted   = source_files.rows_inserted + excluded.rows_inserted,
        finalized       = MAX(source_files.finalized, excluded.finalized),
        fail_count      = excluded.fail_count,
        last_error      = excluded.last_error
    `),

    insertAnomaly: db.prepare(`
      INSERT OR IGNORE INTO anomalies
        (type, channel, ts_utc, local_date, previous_value, value, delta, details, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    anomaliesForDate: db.prepare(`
      SELECT * FROM anomalies WHERE channel = ? AND local_date = ? ORDER BY ts_utc ASC
    `),
    deleteAnomaliesBefore: db.prepare('DELETE FROM anomalies WHERE ts_utc < ?'),

    getAlert: db.prepare('SELECT * FROM alerts WHERE dedup_key = ?'),
    upsertAlert: db.prepare(`
      INSERT INTO alerts (dedup_key, type, first_sent_at, last_sent_at, send_count, payload)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT (dedup_key) DO UPDATE SET
        last_sent_at = excluded.last_sent_at,
        send_count   = alerts.send_count + 1,
        payload      = excluded.payload
    `),
    clearAlert: db.prepare('DELETE FROM alerts WHERE dedup_key = ?'),
    clearAlertsByPrefix: db.prepare("DELETE FROM alerts WHERE dedup_key LIKE ? || '%'"),

    getDailyReport: db.prepare('SELECT * FROM daily_reports WHERE report_date = ?'),
    insertDailyReport: db.prepare(`
      INSERT OR IGNORE INTO daily_reports
        (report_date, channel, sent_at, total, start_value, end_value, reading_count, issue_count, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listDailyReports: db.prepare('SELECT report_date FROM daily_reports WHERE report_date >= ?'),

    getFlowState: db.prepare('SELECT * FROM flow_state WHERE channel = ?'),
    upsertFlowState: db.prepare(`
      INSERT INTO flow_state
        (channel, flowing, started_at, last_flow_ts, last_ts, last_value, volume, alerted, alerted_at, updated_at)
      VALUES (@channel, @flowing, @started_at, @last_flow_ts, @last_ts, @last_value, @volume, @alerted, @alerted_at, @updated_at)
      ON CONFLICT (channel) DO UPDATE SET
        flowing      = excluded.flowing,
        started_at   = excluded.started_at,
        last_flow_ts = excluded.last_flow_ts,
        last_ts      = excluded.last_ts,
        last_value   = excluded.last_value,
        volume       = excluded.volume,
        alerted      = excluded.alerted,
        alerted_at   = excluded.alerted_at,
        updated_at   = excluded.updated_at
    `),
    insertFlowEpisode: db.prepare(`
      INSERT OR IGNORE INTO flow_episodes
        (channel, started_at, ended_at, duration_ms, volume, alerted, end_reason, local_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    flowEpisodesForDate: db.prepare(`
      SELECT * FROM flow_episodes WHERE channel = ? AND local_date = ? ORDER BY started_at ASC
    `),

    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(`
      INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    relabelLocalDates: db.prepare('UPDATE readings SET local_date = ? WHERE channel = ? AND ts_utc = ?'),
  };

  return {
    db,

    /** Insert readings idempotently. Returns how many rows were actually new. */
    insertReadings(readings, { sourceFile, now = Date.now() } = {}) {
      return transaction(db, () => {
        let inserted = 0;
        const conflicts = [];
        for (const reading of readings) {
          const existing = statements.readingAt.get(reading.channel, reading.tsUtc);
          if (existing) {
            if (Math.abs(existing.value - reading.value) > 1e-9) {
              conflicts.push({ ...reading, existingValue: existing.value });
            }
            continue;
          }
          const result = statements.insertReading.run(
            reading.channel,
            reading.tsUtc,
            reading.value,
            reading.localDate,
            reading.rawTs,
            sourceFile ?? reading.sourceFile ?? '',
            now,
          );
          inserted += Number(result.changes);
        }
        return { inserted, conflicts };
      });
    },

    getReadingsBetween(channel, start, end) {
      return statements.readingsBetween.all(channel, start, end).map(toReading);
    },

    getReadingsAfter(channel, tsUtc, limit = 100_000) {
      return statements.readingsAfter.all(channel, tsUtc, limit).map(toReading);
    },

    getLastReadingBefore(channel, tsUtc) {
      const row = statements.lastReadingBefore.get(channel, tsUtc);
      return row ? toReading(row) : null;
    },

    getLatestReading(channel) {
      const row = statements.latestReading.get(channel);
      return row ? toReading(row) : null;
    },

    getFirstReading(channel) {
      const row = statements.firstReading.get(channel);
      return row ? toReading(row) : null;
    },

    countReadings(channel) {
      return Number(statements.countReadings.get(channel).n);
    },

    getSourceFile(fileDate) {
      return statements.getSourceFile.get(fileDate) ?? null;
    },

    listSourceFiles(fromDate) {
      return statements.listSourceFiles.all(fromDate);
    },

    saveSourceFile(record) {
      statements.upsertSourceFile.run({
        file_date: record.fileDate,
        url: record.url ?? null,
        etag: record.etag ?? null,
        last_modified: record.lastModified ?? null,
        content_hash: record.contentHash ?? null,
        last_fetch_at: record.lastFetchAt ?? null,
        last_success_at: record.lastSuccessAt ?? null,
        rows_total: record.rowsTotal ?? 0,
        rows_valid: record.rowsValid ?? 0,
        rows_invalid: record.rowsInvalid ?? 0,
        rows_inserted: record.rowsInserted ?? 0,
        finalized: record.finalized ? 1 : 0,
        fail_count: record.failCount ?? 0,
        last_error: record.lastError ?? null,
      });
    },

    recordAnomalies(anomalies, { now = Date.now() } = {}) {
      if (anomalies.length === 0) return 0;
      return transaction(db, () => {
        let count = 0;
        for (const anomaly of anomalies) {
          const result = statements.insertAnomaly.run(
            anomaly.type,
            anomaly.channel,
            anomaly.tsUtc,
            anomaly.localDate,
            anomaly.previousValue ?? null,
            anomaly.value ?? null,
            anomaly.delta ?? null,
            anomaly.details ? JSON.stringify(anomaly.details) : null,
            now,
          );
          count += Number(result.changes);
        }
        return count;
      });
    },

    getAnomaliesForDate(channel, localDate) {
      return statements.anomaliesForDate.all(channel, localDate).map((row) => ({
        ...row,
        details: row.details ? JSON.parse(row.details) : null,
      }));
    },

    getAlert(dedupKey) {
      return statements.getAlert.get(dedupKey) ?? null;
    },

    /** True when the alert has never been sent or its cooldown has expired. */
    shouldSendAlert(dedupKey, cooldownMs, now = Date.now()) {
      const existing = statements.getAlert.get(dedupKey);
      if (!existing) return true;
      if (cooldownMs <= 0) return false;
      return now - Number(existing.last_sent_at) >= cooldownMs;
    },

    recordAlertSent(dedupKey, type, payload, now = Date.now()) {
      statements.upsertAlert.run(dedupKey, type, now, now, payload ? JSON.stringify(payload) : null);
    },

    clearAlert(dedupKey) {
      statements.clearAlert.run(dedupKey);
    },

    clearAlertsWithPrefix(prefix) {
      statements.clearAlertsByPrefix.run(prefix);
    },

    getDailyReport(reportDate) {
      return statements.getDailyReport.get(reportDate) ?? null;
    },

    /** Records a sent report. Returns false if one was already recorded. */
    recordDailyReport(report, now = Date.now()) {
      const result = statements.insertDailyReport.run(
        report.date,
        report.channel,
        now,
        report.total ?? null,
        report.startValue ?? null,
        report.endValue ?? null,
        report.readingCount ?? null,
        report.issueCount ?? null,
        report.payload ? JSON.stringify(report.payload) : null,
      );
      return Number(result.changes) > 0;
    },

    getSentReportDates(fromDate) {
      return new Set(statements.listDailyReports.all(fromDate).map((row) => row.report_date));
    },

    getFlowState(channel) {
      const row = statements.getFlowState.get(channel);
      if (!row) return null;
      return {
        channel: row.channel,
        flowing: row.flowing === 1,
        startedAt: row.started_at,
        lastFlowTs: row.last_flow_ts,
        lastTs: row.last_ts,
        lastValue: row.last_value,
        volume: row.volume,
        alerted: row.alerted === 1,
        alertedAt: row.alerted_at,
      };
    },

    saveFlowState(state, now = Date.now()) {
      statements.upsertFlowState.run({
        channel: state.channel,
        flowing: state.flowing ? 1 : 0,
        started_at: state.startedAt ?? null,
        last_flow_ts: state.lastFlowTs ?? null,
        last_ts: state.lastTs ?? null,
        last_value: state.lastValue ?? null,
        volume: state.volume ?? 0,
        alerted: state.alerted ? 1 : 0,
        alerted_at: state.alertedAt ?? null,
        updated_at: now,
      });
    },

    recordFlowEpisode(episode) {
      statements.insertFlowEpisode.run(
        episode.channel,
        episode.startedAt,
        episode.endedAt,
        episode.durationMs,
        episode.volume,
        episode.alerted ? 1 : 0,
        episode.endReason ?? null,
        episode.localDate,
      );
    },

    getFlowEpisodesForDate(channel, localDate) {
      return statements.flowEpisodesForDate.all(channel, localDate);
    },

    getMeta(key) {
      return statements.getMeta.get(key)?.value ?? null;
    },

    setMeta(key, value, now = Date.now()) {
      statements.setMeta.run(key, String(value), now);
    },

    /**
     * Rewrites the cached `local_date` of every reading. Needed when TIMEZONE
     * changes, because that column is a denormalised view of `ts_utc`.
     */
    relabelLocalDates(channel, toLocalDate) {
      return transaction(db, () => {
        const rows = db
          .prepare('SELECT ts_utc, local_date FROM readings WHERE channel = ?')
          .all(channel);
        let updated = 0;
        for (const row of rows) {
          const expected = toLocalDate(Number(row.ts_utc));
          if (expected !== row.local_date) {
            statements.relabelLocalDates.run(expected, channel, row.ts_utc);
            updated += 1;
          }
        }
        return updated;
      });
    },

    /** Drops readings and anomalies older than the retention window. */
    pruneBefore(tsUtc) {
      return transaction(db, () => {
        const readings = Number(statements.deleteReadingsBefore.run(tsUtc).changes);
        const anomalies = Number(statements.deleteAnomaliesBefore.run(tsUtc).changes);
        return { readings, anomalies };
      });
    },
  };
}

function toReading(row) {
  return {
    tsUtc: Number(row.ts_utc),
    value: row.value,
    localDate: row.local_date,
    rawTs: row.raw_ts,
  };
}
