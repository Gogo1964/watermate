import { zonedTimeToUtc, toLocalDate } from '../util/time.js';

/**
 * Parsing and validation of the meter's daily CSV files.
 *
 * Sample row:
 *   2026-08-08T00:23:52+0200,main,00020.6286,20.6286,20.6286,0.000000,0.0000,no error,...
 *
 * Column 1 is the timestamp (with an explicit UTC offset), column 2 the
 * channel, column 3 the *cumulative* meter reading and column 8 the status.
 * A row counts only when the status is exactly `no error`.
 */

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Splits a single CSV line, honouring double-quoted fields. */
export function splitCsvLine(line, delimiter = ',') {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"' && current.trim() === '') {
      inQuotes = true;
      current = '';
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

/**
 * Parses a meter timestamp into epoch milliseconds.
 *
 * Offsets may be written as `+0200` or `+02:00`. When a row carries no offset
 * at all the configured timezone is used, which keeps day boundaries correct.
 */
export function parseMeterTimestamp(value, timeZone) {
  const match = TIMESTAMP_PATTERN.exec(String(value).trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second = '0', fraction = '0', offset] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return null;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 60) return null;

  const millis = Number(fraction.padEnd(3, '0').slice(0, 3));

  if (!offset) {
    return zonedTimeToUtc(parts, timeZone) + millis;
  }
  if (offset.toUpperCase() === 'Z') {
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, millis);
  }

  const sign = offset[0] === '-' ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  const offsetMs = sign * (Number(digits.slice(0, 2)) * 3_600_000 + Number(digits.slice(2, 4)) * 60_000);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, millis) - offsetMs
  );
}

/** Parses the meter reading, tolerating leading zeros and comma decimals. */
export function parseMeterValue(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  const normalized = text.includes(',') && !text.includes('.') ? text.replace(',', '.') : text;
  if (!/^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses a whole CSV file.
 *
 * Never throws on bad input: malformed lines are collected in `invalid` with a
 * reason so the collector can log and report them instead of losing the file.
 */
export function parseCsv(text, options) {
  const {
    timezone,
    okStatus = 'no error',
    delimiter = ',',
    timestampColumn = 1,
    channelColumn = 2,
    valueColumn = 3,
    statusColumn = 8,
    channel = null,
    sourceFile = '',
  } = options;

  const rows = [];
  const invalid = [];
  const expectedColumns = Math.max(timestampColumn, channelColumn, valueColumn, statusColumn);
  const normalizedOk = okStatus.trim().toLowerCase();
  let total = 0;
  let skippedOtherChannel = 0;

  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    total += 1;

    const lineNumber = index + 1;
    const fields = splitCsvLine(line, delimiter);

    if (fields.length < expectedColumns) {
      invalid.push({ lineNumber, reason: 'too_few_columns', detail: `${fields.length} columns`, line });
      continue;
    }

    const tsUtc = parseMeterTimestamp(fields[timestampColumn - 1], timezone);
    if (tsUtc === null) {
      // A header line lands here too — that is fine, it is simply not a reading.
      invalid.push({ lineNumber, reason: 'bad_timestamp', detail: fields[timestampColumn - 1], line });
      continue;
    }

    const status = fields[statusColumn - 1] ?? '';
    if (status.trim().toLowerCase() !== normalizedOk) {
      invalid.push({ lineNumber, reason: 'meter_error', detail: status, line });
      continue;
    }

    const rowChannel = fields[channelColumn - 1] || 'unknown';
    if (channel && rowChannel !== channel) {
      skippedOtherChannel += 1;
      continue;
    }

    const value = parseMeterValue(fields[valueColumn - 1]);
    if (value === null) {
      invalid.push({ lineNumber, reason: 'bad_value', detail: fields[valueColumn - 1], line });
      continue;
    }
    if (value < 0) {
      invalid.push({ lineNumber, reason: 'negative_value', detail: String(value), line });
      continue;
    }

    rows.push({
      tsUtc,
      channel: rowChannel,
      value,
      rawTs: fields[timestampColumn - 1],
      localDate: toLocalDate(tsUtc, timezone),
      sourceFile,
      lineNumber,
    });
  }

  rows.sort((a, b) => a.tsUtc - b.tsUtc || a.lineNumber - b.lineNumber);
  return { rows, invalid, total, skippedOtherChannel };
}
