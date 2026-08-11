/**
 * Ordered, append-only migrations.
 *
 * Each entry runs exactly once inside a transaction and is recorded in
 * `schema_migrations`. Never edit a released migration — add a new one.
 */
export const migrations = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE meta (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      -- One row per accepted meter reading. The primary key makes ingestion
      -- idempotent: re-downloading a CSV can never duplicate data.
      CREATE TABLE readings (
        channel      TEXT    NOT NULL,
        ts_utc       INTEGER NOT NULL,
        value        REAL    NOT NULL,
        local_date   TEXT    NOT NULL,
        raw_ts       TEXT    NOT NULL,
        source_file  TEXT    NOT NULL,
        ingested_at  INTEGER NOT NULL,
        PRIMARY KEY (channel, ts_utc)
      );

      CREATE INDEX readings_local_date_idx ON readings (channel, local_date, ts_utc);
      CREATE INDEX readings_ts_idx ON readings (ts_utc);

      -- Per-day download bookkeeping so unchanged or finished files are skipped.
      CREATE TABLE source_files (
        file_date       TEXT PRIMARY KEY,
        url             TEXT,
        etag            TEXT,
        last_modified   TEXT,
        content_hash    TEXT,
        last_fetch_at   INTEGER,
        last_success_at INTEGER,
        rows_total      INTEGER NOT NULL DEFAULT 0,
        rows_valid      INTEGER NOT NULL DEFAULT 0,
        rows_invalid    INTEGER NOT NULL DEFAULT 0,
        rows_inserted   INTEGER NOT NULL DEFAULT 0,
        finalized       INTEGER NOT NULL DEFAULT 0,
        fail_count      INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT
      );

      -- Data-quality events (meter decrease, spike, gap, conflicting duplicate).
      CREATE TABLE anomalies (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        type           TEXT    NOT NULL,
        channel        TEXT    NOT NULL,
        ts_utc         INTEGER NOT NULL,
        local_date     TEXT    NOT NULL,
        previous_value REAL,
        value          REAL,
        delta          REAL,
        details        TEXT,
        detected_at    INTEGER NOT NULL,
        UNIQUE (type, channel, ts_utc)
      );

      CREATE INDEX anomalies_local_date_idx ON anomalies (channel, local_date);

      -- Suppression state: one row per logical alert, keyed by a dedup key.
      CREATE TABLE alerts (
        dedup_key    TEXT PRIMARY KEY,
        type         TEXT    NOT NULL,
        first_sent_at INTEGER NOT NULL,
        last_sent_at  INTEGER NOT NULL,
        send_count    INTEGER NOT NULL DEFAULT 1,
        payload       TEXT
      );

      CREATE INDEX alerts_type_idx ON alerts (type, last_sent_at);

      -- One row per delivered daily report; guarantees a report is sent once.
      CREATE TABLE daily_reports (
        report_date   TEXT PRIMARY KEY,
        channel       TEXT    NOT NULL,
        sent_at       INTEGER NOT NULL,
        total         REAL,
        start_value   REAL,
        end_value     REAL,
        reading_count INTEGER,
        issue_count   INTEGER,
        payload       TEXT
      );

      -- Resumable state of the continuous-flow detector (one row per channel).
      CREATE TABLE flow_state (
        channel     TEXT PRIMARY KEY,
        flowing     INTEGER NOT NULL DEFAULT 0,
        started_at  INTEGER,
        last_flow_ts INTEGER,
        last_ts     INTEGER,
        last_value  REAL,
        volume      REAL    NOT NULL DEFAULT 0,
        alerted     INTEGER NOT NULL DEFAULT 0,
        alerted_at  INTEGER,
        updated_at  INTEGER
      );

      -- Historical record of finished flow episodes, used by the daily report.
      CREATE TABLE flow_episodes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel     TEXT    NOT NULL,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        volume      REAL    NOT NULL,
        alerted     INTEGER NOT NULL DEFAULT 0,
        end_reason  TEXT,
        local_date  TEXT    NOT NULL,
        UNIQUE (channel, started_at)
      );

      CREATE INDEX flow_episodes_local_date_idx ON flow_episodes (channel, local_date);
    `,
  },
];
