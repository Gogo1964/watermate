# WaterMate

Monitors a water meter through its HTTP CSV interface, stores every reading in
SQLite, and emails a daily consumption report plus alerts for unusually high
consumption and continuously running water.

Built to run for years unattended on a Raspberry Pi: **one runtime dependency**
(`nodemailer`), no native compilation, and a database that makes restarts and
repeated downloads harmless.

```
┌────────────┐  CSV over HTTP   ┌───────────┐   readings    ┌──────────┐
│ Water meter│ ───────────────► │ Collector │ ────────────► │  SQLite  │
└────────────┘  data_<date>.csv └───────────┘               └────┬─────┘
                                                                 │
                              ┌──────────────────────────────────┤
                              ▼                  ▼               ▼
                     consumption analysis   flow detector   daily report
                              └──────────┬───────┘               │
                                         ▼                       ▼
                                   alert manager  ──────────►  SMTP
                                  (dedup + cooldown)
```

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running](#running)
- [Emails](#emails)
- [Testing](#testing)
- [Deployment](#deployment)
- [Database](#database)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)

## How it works

### The meter's data

The meter serves one CSV file per calendar day:

```
http://192.168.1.50/fileserver/log/data/data_2026-08-10.csv
```

```csv
2026-08-08T00:23:52+0200,main,00020.6286,20.6286,20.6286,0.000000,0.0000,no error,0.2,...
2026-08-08T00:28:52+0200,main,00020.6286,20.6286,20.6286,0.000000,0.0000,no error,0.2,...
```

| Column | Meaning |
| ------ | ------- |
| 1 | Timestamp with an explicit UTC offset |
| 2 | Meter / channel identifier |
| 3 | **Cumulative** meter reading (an odometer, *not* the volume used in that interval) |
| 8 | Status — the row is used only when this is exactly `no error` |

### Consumption is a difference, never a sum

Column 3 only ever counts upwards, so consumption for any period is the
difference between readings. WaterMate accumulates the difference of each
consecutive pair rather than doing `last − first`, because that naive form
breaks the moment a meter is reset or exchanged:

```
readings:  100.0   100.5     5.0     5.2      ← meter exchanged mid-day
naive:     5.2 − 100.0 = −94.8   ✗ negative consumption
WaterMate: 0.5 + (skipped) + 0.2 = 0.7  ✓ and the decrease is reported
```

Negative consumption is never reported. A decrease beyond
`METER_DECREASE_TOLERANCE` contributes nothing to the total, is written to the
`anomalies` table, is logged, and appears in the daily report as a data-quality
issue.

The same pass also handles duplicate readings (identical timestamps collapse;
identical timestamps with *different* values are flagged), missing readings
(gaps are reported, and their volume still counts), and implausible spikes
(counted but flagged for review).

### Days, timezones and file names

The file name is a calendar date, but the timestamps inside carry an offset —
so `data_2026-08-10.csv` can contain readings that belong to the 9th or the
11th. Every reading is stored as a UTC instant and assigned to a local calendar
day using `TIMEZONE`. Day boundaries, "yesterday", and the report time are all
derived from that same setting, and DST transitions are handled (a 23- or
25-hour day is measured correctly).

Consumption for a day is measured from **the last reading before local
midnight** to the last reading inside the day. Using the day's first reading
instead would silently drop whatever ran between midnight and it.

### Continuous-flow detection

Readings arrive every few minutes, so flow is inferred per interval: the meter
moved by at least `FLOW_DETECTION_THRESHOLD` between two consecutive readings.
An *episode* is a run of consecutive flowing intervals. Once one lasts longer
than `CONTINUOUS_FLOW_DURATION_HOURS`, exactly one alert is sent.

- A single interval with no movement ends the episode and re-arms the alert.
- A data gap (`MAX_GAP_MINUTES`) also ends the episode. Nothing can be known
  about what happened while readings were missing, so WaterMate will not claim
  a three-hour flow it did not observe. This is deliberately conservative: it
  may miss a leak, but it will not invent one out of a network outage.
- Detector state lives in SQLite, so an episode that starts before a restart
  still alerts after it.

### Alert suppression

Polling runs every few minutes while a condition can persist for hours. Every
alert carries a dedup key and a cooldown, both stored in the `alerts` table:

| Alert | Dedup key | Repeats |
| ----- | --------- | ------- |
| High consumption (daily) | channel + calendar day | `HIGH_CONSUMPTION_COOLDOWN_HOURS` (default: once per day) |
| High consumption (window) | channel + clock hour | `HOURLY_HIGH_CONSUMPTION_COOLDOWN_HOURS` |
| Continuous flow | channel + episode start | Once, or every `CONTINUOUS_FLOW_REALERT_HOURS` |
| Daily report | report date (`daily_reports` table) | Never |

The key is written **after** a successful send, so an SMTP outage retries on the
next cycle instead of losing the alert.

## Requirements

- **Node.js ≥ 22.5** — uses the built-in `node:sqlite`, so nothing compiles
  during install. Check with `node --version`.
- Network access to the meter and to an SMTP server.

### Raspberry Pi on a 32-bit OS (armhf)

NodeSource no longer builds for 32-bit ARM and will fail with
`Unsupported architecture: armhf`. nodejs.org still ships official `armv7l`
tarballs, so install from there instead:

```bash
uname -m                       # armv7l expected
VER=v22.23.2
curl -fsSLO https://nodejs.org/dist/$VER/node-$VER-linux-armv7l.tar.xz
sudo mkdir -p /usr/local/lib/nodejs
sudo tar -xJf node-$VER-linux-armv7l.tar.xz -C /usr/local/lib/nodejs
for b in node npm npx; do
  sudo ln -sf /usr/local/lib/nodejs/node-$VER-linux-armv7l/bin/$b /usr/local/bin/$b
done

# Verify the one feature everything depends on:
node -e "const s=require('node:sqlite'); new s.DatabaseSync(':memory:').exec('create table t(a int)'); console.log('sqlite OK')"
```

This lands node in `/usr/local/bin`, so `deploy/watermate.service` uses that
path — run `which node` and adjust `ExecStart` if yours differs.

On an ARMv6 device (Pi 1, Pi Zero/Zero W) the `armv7l` build will not run;
those need the community builds at
[unofficial-builds.nodejs.org](https://unofficial-builds.nodejs.org/download/release/).

## Installation

```bash
git clone <repository-url> watermate
cd watermate
npm install            # installs a single dependency
cp .env.example .env    # then edit .env
npm run migrate        # creates data/watermate.db
```

Try it without touching SMTP at all:

```bash
MAIL_DRY_RUN=true npm run poll     # one poll cycle, mails printed to stdout
```

## Configuration

Everything is configured through environment variables, optionally seeded from
a `.env` file in the project root. **Real environment variables always win**, so
a systemd unit or container can override the file without editing it. Secrets
are never hard-coded and never logged — `redactConfig()` masks them.

`.env.example` documents every option with its default. The ones you are most
likely to change:

### Meter and polling

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `WATER_METER_BASE_URL` | `http://192.168.1.50/fileserver/log/data` | Base URL of the file server |
| `WATER_METER_FILE_PATTERN` | `data_{date}.csv` | File name; `{date}` becomes the local date |
| `METER_CHANNEL` | `main` | Which channel (CSV column 2) is monitored |
| `METER_UNIT` / `METER_LITERS_PER_UNIT` | `m³` / `1000` | Display units |
| `POLL_INTERVAL_MINUTES` | `15` | How often the meter is polled |
| `POLL_ON_START` | `true` | Poll immediately at startup |
| `BACKFILL_DAYS` | `7` | How far back to look so downtime loses no data |
| `HTTP_TIMEOUT_MS` / `HTTP_RETRIES` | `15000` / `3` | Per-request timeout and retries |
| `HTTP_USERNAME` / `HTTP_PASSWORD` | — | Optional basic auth for the file server |

### Time and reporting

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `TIMEZONE` | `Europe/Berlin` | IANA zone for day boundaries and scheduling |
| `DAILY_REPORT_ENABLED` | `true` | Turn the daily report off entirely |
| `DAILY_REPORT_TIME` | `07:00` | Local time yesterday's report is sent |
| `DAILY_REPORT_CATCHUP_DAYS` | `3` | Missed reports caught up after downtime |

### Alerts

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `HIGH_CONSUMPTION_THRESHOLD` | `0.5` | Daily total that triggers an alert (m³) |
| `HIGH_CONSUMPTION_COOLDOWN_HOURS` | `24` | Minimum spacing between daily alerts |
| `HOURLY_HIGH_CONSUMPTION_THRESHOLD` | *(unset)* | Optional short-window threshold |
| `HOURLY_WINDOW_MINUTES` | `60` | Length of that rolling window |
| `CONTINUOUS_FLOW_ENABLED` | `true` | Turn leak detection off |
| `CONTINUOUS_FLOW_DURATION_HOURS` | `3` | Flow longer than this alerts |
| `FLOW_DETECTION_THRESHOLD` | `0.001` | Minimum increase per interval counting as flow |
| `CONTINUOUS_FLOW_REALERT_HOURS` | `0` | Reminder interval; `0` = alert only once |
| `ALERT_MAX_AGE_HOURS` | `24` | Suppress alerts derived from older readings |

### Data quality

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `EXPECTED_READING_INTERVAL_MINUTES` | `5` | How often the meter writes a reading |
| `MAX_GAP_MINUTES` | `30` | Longer pauses count as a data gap |
| `METER_DECREASE_TOLERANCE` | `0.0005` | Negative noise band before a decrease is real |
| `MAX_PLAUSIBLE_DELTA` | `1` | Larger single-interval jumps are flagged |

### Email

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `SMTP_HOST` / `SMTP_PORT` | `localhost` / `587` | SMTP server |
| `SMTP_USER` / `SMTP_PASSWORD` | — | Credentials (omit for an open relay) |
| `SMTP_TLS` | `starttls` | `starttls` (587), `implicit` (465) or `none` |
| `SMTP_REJECT_UNAUTHORIZED` | `true` | Set `false` only for a self-signed server |
| `MAIL_FROM` | `watermate@localhost` | Sender address |
| `MAIL_TO` | — | Recipients, comma or semicolon separated |
| `MAIL_ALERT_TO` | = `MAIL_TO` | Different recipients for alerts |
| `MAIL_SUBJECT_PREFIX` | `[WaterMate]` | Prefix on every subject |
| `MAIL_DRY_RUN` | `false` | Print mails instead of sending them |

### Storage and logging

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `DATABASE_PATH` | `./data/watermate.db` | SQLite file |
| `DATA_RETENTION_DAYS` | `0` | `0` keeps everything (a year is only a few MB) |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`, `trace` |
| `LOG_FORMAT` | `pretty` | `pretty` for a terminal, `json` for journald/Loki |

Invalid configuration aborts at startup with **all** problems listed at once and
exit code `78`, rather than failing hours later.

### Choosing thresholds

Run for a week with `MAIL_DRY_RUN=true`, then look at the daily reports:

- **`HIGH_CONSUMPTION_THRESHOLD`** — roughly 1.5× your normal day. A typical
  two-person household uses 0.25–0.4 m³/day.
- **`FLOW_DETECTION_THRESHOLD`** — the smallest movement that means something.
  The default `0.001 m³` per 5-minute interval is about 12 L/h. A dripping tap
  can sit below that; a running toilet will not. Lower it to catch smaller
  leaks, raise it if a slow drip causes false alarms.
- **`CONTINUOUS_FLOW_DURATION_HOURS`** — must exceed your longest legitimate
  continuous draw. Garden irrigation may run for hours; a shower will not.

## Running

```bash
npm start                       # run continuously (this is the service)
npm run poll                    # one poll cycle, then exit
npm run report                  # send yesterday's report now
npm run migrate                 # create/upgrade the database, then exit
npm run mail:test               # send a test mail to verify SMTP
node src/index.js --status      # print stored state
node src/index.js --report 2026-08-10 --force   # re-send a specific day
node src/index.js --help
```

In continuous mode WaterMate polls on `POLL_INTERVAL_MINUTES`, evaluates the
thresholds after each poll, and sends the daily report at `DAILY_REPORT_TIME`.
The daily timer recomputes its next run after every fire, so DST changes cannot
shift the report time. `SIGINT`/`SIGTERM` shut it down cleanly.

At startup it also catches up on any reports missed while it was down.

## Emails

Three distinct subjects, each as HTML with a plain-text alternative:

| Type | Subject |
| ---- | ------- |
| Daily report | `[WaterMate] Water report 2026-08-10 — 0.453 m³ (453 L)` |
| High consumption | `[WaterMate] ALERT: high water consumption — 1.284 m³ (1284 L) on 2026-08-10` |
| Continuous flow | `[WaterMate] ALERT: continuous water flow for 3 h 30 min — 0.294 m³ (294 L)` |

The daily report contains the date, total consumption, start and end meter
readings, the number of valid readings against the number expected, an hourly
bar chart, a comparison with the trailing average, and a data-quality section
listing gaps, meter decreases, spikes and rejected rows.

Rendered examples live in [`templates/examples/`](templates/examples/) — open
the `.html` files in a browser. Regenerate them after changing a template:

```bash
npm run templates:preview
```

Templates are plain functions in [`src/mail/templates.js`](src/mail/templates.js)
returning `{ subject, html, text }`. They use inline styles and table layouts,
which is what mail clients actually render.

## Testing

```bash
npm test          # 109 tests
npm run test:watch
```

Uses the built-in Node test runner — no test framework dependency. Coverage
focuses on the logic that is easy to get quietly wrong:

| File | What it covers |
| ---- | -------------- |
| `series.test.js` | Consumption from cumulative readings; duplicates, conflicts, decreases, spikes, gaps, float drift |
| `flow.test.js` | Continuous-flow detection: alert exactly once, reset after the flow stops, batch-by-batch processing, gap conservatism, restart mid-episode |
| `highConsumption.test.js` | Threshold triggering, no repeat alerts, new day re-arms, rolling window, retry after a failed send |
| `dailyReport.test.js` | Sent once per day and across restarts, catch-up bounds, report contents, baseline before midnight |
| `collector.test.js` | Idempotent ingestion, growing files, backfill, 404s, network failures with retry, corrupt CSV |
| `csv.test.js` | Column semantics, `no error` filtering, malformed rows, timestamp offsets |
| `time.test.js` | Local day assignment, DST-length days, report time across a DST switch |
| `config.test.js` | Defaults, validation, TLS modes, `.env` parsing, secret redaction |
| `integration.test.js` | End-to-end against a real SQLite file, including restarts |

## Deployment

### systemd (recommended for a Raspberry Pi)

```bash
sudo useradd --system --home /opt/watermate --shell /usr/sbin/nologin watermate
sudo mkdir -p /opt/watermate /var/lib/watermate
sudo cp -r src scripts package.json package-lock.json /opt/watermate/
cd /opt/watermate && sudo npm ci --omit=dev

# Secrets: root-owned, readable only by the service user.
sudo install -o watermate -g watermate -m 600 .env /etc/watermate.env
sudo sed -i 's|^DATABASE_PATH=.*|DATABASE_PATH=/var/lib/watermate/watermate.db|' /etc/watermate.env

sudo chown -R watermate:watermate /opt/watermate /var/lib/watermate
sudo cp deploy/watermate.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now watermate
```

```bash
systemctl status watermate
journalctl -u watermate -f          # follow the log
journalctl -u watermate -p warning  # warnings and errors only
```

The unit restarts on failure, runs with `LOG_FORMAT=json` for journald, and is
hardened (`ProtectSystem=strict`, `NoNewPrivileges`, writable access limited to
`/var/lib/watermate`).

### Docker

```bash
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f
```

The image is `node:22-bookworm-slim` with no build step — the same Dockerfile
works on armv7, arm64 and amd64. The database lives in a named volume.

[`deploy/DOCKER.md`](deploy/DOCKER.md) covers the Raspberry Pi side: starting and
updating the container by hand, and the two ways to bring it back after a reboot
(the `restart: unless-stopped` policy, or a systemd unit that runs Compose at
boot).

### Backups

The whole state is one SQLite file. Back it up online with:

```bash
sqlite3 /var/lib/watermate/watermate.db ".backup '/backup/watermate-$(date +%F).db'"
```

### Resource use

At the default 15-minute interval WaterMate downloads roughly 30 KB per cycle
and idles at a few MB of RSS. A year of 5-minute readings is about 10 MB of
database. It is comfortable on a Pi Zero.

## Database

SQLite via the built-in `node:sqlite`, in WAL mode. Migrations in
[`src/db/migrations.js`](src/db/migrations.js) run automatically at startup and
are recorded in `schema_migrations`; each runs exactly once, inside a
transaction. Add new ones by appending to the array — never edit a released
migration.

| Table | Purpose |
| ----- | ------- |
| `readings` | One row per accepted reading, `PRIMARY KEY (channel, ts_utc)` — this is what makes ingestion idempotent |
| `source_files` | Per-day download state: ETag, hash, row counts, whether the day is final |
| `anomalies` | Meter decreases, spikes, gaps, conflicting duplicates |
| `alerts` | Suppression state: dedup key, first/last sent, send count |
| `daily_reports` | One row per delivered report — the guard against duplicates |
| `flow_state` | Resumable continuous-flow detector state and its cursor |
| `flow_episodes` | Completed flow episodes, shown in the daily report |
| `meta` | Small key/value state, e.g. the timezone the data was labelled with |

Everything is idempotent: restarting the process or re-downloading the same CSV
adds no duplicate rows and sends no duplicate mail. Changing `TIMEZONE` rewrites
the cached local dates on the next start rather than silently skewing day
totals.

Useful queries:

```sql
-- Consumption per day
SELECT local_date, ROUND(MAX(value) - MIN(value), 4) AS m3
FROM readings WHERE channel = 'main' GROUP BY local_date ORDER BY local_date DESC LIMIT 14;

-- Recent data-quality events
SELECT datetime(ts_utc/1000, 'unixepoch') AS at, type, previous_value, value, delta
FROM anomalies ORDER BY ts_utc DESC LIMIT 20;

-- What has been alerted about
SELECT dedup_key, type, datetime(last_sent_at/1000, 'unixepoch') AS last_sent, send_count FROM alerts;
```

## Troubleshooting

**No mail arrives.** Run `npm run mail:test`. Set `SMTP_VERIFY_ON_START=true` to
check the login at startup. For Gmail and similar, use an app password, not the
account password.

**`Meter file not available` for today.** Normal before the meter has written
its first reading of the day; it is logged at `debug` for today and `warn` for
past days.

**A daily report is missing.** `node src/index.js --status` lists
`pendingReports`. A report is only sent after `DAILY_REPORT_TIME` on the
following day, and never twice. Force one with
`node src/index.js --report 2026-08-10 --force`.

**Too many continuous-flow alerts.** Raise `FLOW_DETECTION_THRESHOLD` — a slow
drip is being counted as flow — or raise
`CONTINUOUS_FLOW_DURATION_HOURS` above your longest legitimate draw.

**No continuous-flow alert although water ran for hours.** Check for gaps: a
missing reading ends the episode by design. `MAX_GAP_MINUTES` must be
comfortably above the meter's real interval. `LOG_LEVEL=debug` shows every
episode start and end.

**Consumption looks wrong after a meter exchange.** Expected — check
`anomalies` for a `meter_decrease`. The affected period contributes nothing;
totals stay correct from the new reading onwards.

**`SQLITE_BUSY`.** Two processes are using the same database file. Only one
instance may run per database.

## Project layout

```
src/
  index.js              CLI, signal handling, exit codes
  app.js                composition root — builds and wires every service
  config.js             environment parsing, validation, defaults
  scheduler.js          polling interval and DST-safe daily timer
  analysis/
    series.js           consumption from cumulative readings (pure)
    flow.js             continuous-flow state machine (pure)
    consumption.js      daily summaries and data-quality issues
  meter/
    client.js           HTTP with timeouts, retries, conditional GET
    csv.js              parsing and row validation
    collector.js        which days to fetch, ingest, idempotency
  monitor/
    flowMonitor.js      incremental analysis pass after each ingest
    highConsumption.js  threshold checks
    alertManager.js     dedup, cooldown, dispatch
  reports/dailyReport.js  build, send, record; catch-up
  mail/
    mailer.js           SMTP transport and dry-run mode
    templates.js        HTML + text bodies
  db/
    database.js         connection, pragmas, migration runner
    migrations.js       ordered, append-only schema
    repository.js       all SQL
  util/                 time (timezone/DST), logger, retry, .env loader
test/                   unit and integration tests
templates/examples/     rendered example emails
deploy/                 systemd unit, Dockerfile, compose file
```

`analysis/series.js` and `analysis/flow.js` are pure — no clock, no database,
no I/O — which is what makes the detection logic straightforward to test.

## License

MIT
