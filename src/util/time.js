/**
 * Timezone helpers built on `Intl` so the project stays dependency free.
 *
 * The meter writes one CSV file per *calendar date* while the timestamps inside
 * carry an explicit UTC offset. Everything in the database is stored as epoch
 * milliseconds; these helpers are the only place that converts between an
 * instant and a wall-clock date in the configured timezone.
 */

const partsCache = new Map();

function formatterFor(timeZone) {
  let formatter = partsCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in the given timezone. */
export function zonedParts(timestamp, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(timestamp));
  const out = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset of the timezone from UTC, in milliseconds, at the given instant. */
export function zoneOffsetMs(timestamp, timeZone) {
  const p = zonedParts(timestamp, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(timestamp / 1000) * 1000;
}

/** `YYYY-MM-DD` calendar date of an instant in the given timezone. */
export function toLocalDate(timestamp, timeZone) {
  const p = zonedParts(timestamp, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** `HH:MM` wall-clock time of an instant in the given timezone. */
export function toLocalTime(timestamp, timeZone) {
  const p = zonedParts(timestamp, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Convert a wall-clock time in `timeZone` to an epoch timestamp.
 *
 * Uses the standard two-pass offset refinement so DST transitions resolve
 * correctly. Times that do not exist (spring-forward gap) resolve to the
 * instant the clock jumps to; ambiguous times (fall-back) resolve to the first
 * of the two occurrences.
 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = naive - zoneOffsetMs(naive, timeZone);
  timestamp = naive - zoneOffsetMs(timestamp, timeZone);
  return timestamp;
}

/** Parse `YYYY-MM-DD` into its numeric components. */
export function parseLocalDate(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) throw new Error(`Invalid date string: ${dateString}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Half-open `[start, end)` epoch bounds of a local calendar date. */
export function localDayBounds(dateString, timeZone) {
  const { year, month, day } = parseLocalDate(dateString);
  const start = zonedTimeToUtc({ year, month, day }, timeZone);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const end = zonedTimeToUtc(
    {
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
    },
    timeZone,
  );
  return { start, end };
}

/** Shift a `YYYY-MM-DD` string by whole days, staying in the calendar domain. */
export function addLocalDays(dateString, days) {
  const { year, month, day } = parseLocalDate(dateString);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Inclusive list of local dates from `from` to `to`. */
export function localDateRange(from, to) {
  const dates = [];
  let current = from;
  // Guard against pathological ranges caused by misconfiguration.
  for (let i = 0; i < 3660 && current <= to; i += 1) {
    dates.push(current);
    current = addLocalDays(current, 1);
  }
  return dates;
}

/** Difference in whole days between two `YYYY-MM-DD` strings (`a - b`). */
export function localDateDiff(a, b) {
  const pa = parseLocalDate(a);
  const pb = parseLocalDate(b);
  const ua = Date.UTC(pa.year, pa.month - 1, pa.day);
  const ub = Date.UTC(pb.year, pb.month - 1, pb.day);
  return Math.round((ua - ub) / 86_400_000);
}

/** Parse `HH:MM` (or `HH:MM:SS`) into components. */
export function parseTimeOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!match) throw new Error(`Invalid time of day: ${value} (expected HH:MM)`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`Invalid time of day: ${value}`);
  return { hour, minute, second };
}

/** The instant at which `HH:MM` occurs on a given local date. */
export function localTimeOnDate(dateString, timeOfDay, timeZone) {
  const { year, month, day } = parseLocalDate(dateString);
  return zonedTimeToUtc({ year, month, day, ...timeOfDay }, timeZone);
}

/** Next occurrence of `HH:MM` strictly after `now`, in the given timezone. */
export function nextOccurrence(now, timeOfDay, timeZone) {
  const today = toLocalDate(now, timeZone);
  const candidate = localTimeOnDate(today, timeOfDay, timeZone);
  if (candidate > now) return candidate;
  return localTimeOnDate(addLocalDays(today, 1), timeOfDay, timeZone);
}

/** Format an instant for humans, e.g. `2026-08-10 07:00:00 (Europe/Berlin)`. */
export function formatInstant(timestamp, timeZone, { withZone = true } = {}) {
  if (timestamp == null) return '—';
  const p = zonedParts(timestamp, timeZone);
  const stamp =
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ` +
    `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  return withZone ? `${stamp} (${timeZone})` : stamp;
}

/** Human readable duration, e.g. `3 h 12 min`. */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const totalMinutes = Math.round(Math.abs(ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}
