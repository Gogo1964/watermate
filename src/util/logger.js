const LEVELS = { error: 10, warn: 20, info: 30, debug: 40, trace: 50 };

const COLORS = {
  error: '[31m',
  warn: '[33m',
  info: '[36m',
  debug: '[90m',
  trace: '[90m',
};
const RESET = '[0m';

export const LOG_LEVELS = Object.keys(LEVELS);

/**
 * Small structured logger: JSON for log shippers, `pretty` for a terminal.
 * Every call takes a message plus an optional object of fields, so operational
 * context stays machine readable instead of being baked into strings.
 */
export function createLogger({
  level = 'info',
  format = 'pretty',
  bindings = {},
  write = (line) => process.stdout.write(`${line}\n`),
  colors = format === 'pretty' && process.stdout.isTTY,
  now = () => Date.now(),
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(levelName, message, fields) {
    if (LEVELS[levelName] > threshold) return;

    const payload = { ...bindings, ...serializeFields(fields) };
    if (format === 'json') {
      write(JSON.stringify({ time: new Date(now()).toISOString(), level: levelName, msg: message, ...payload }));
      return;
    }

    const component = payload.component ? ` [${payload.component}]` : '';
    const { component: _omit, ...rest } = payload;
    const extras = Object.keys(rest).length > 0 ? ` ${formatFields(rest)}` : '';
    const label = levelName.toUpperCase().padEnd(5);
    const colored = colors ? `${COLORS[levelName]}${label}${RESET}` : label;
    write(`${new Date(now()).toISOString()} ${colored}${component} ${message}${extras}`);
  }

  const logger = {
    level,
    child(extra) {
      return createLogger({ level, format, bindings: { ...bindings, ...extra }, write, colors, now });
    },
  };
  for (const name of LOG_LEVELS) {
    logger[name] = (message, fields) => emit(name, message, fields);
  }
  return logger;
}

function serializeFields(fields) {
  if (!fields) return {};
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.cause ? { cause: String(error.cause.message ?? error.cause) } : {}),
    stack: error.stack,
  };
}

function formatFields(fields) {
  return Object.entries(fields)
    .map(([key, value]) => {
      if (value && typeof value === 'object' && value.message) {
        return `${key}=${JSON.stringify(value.message)}`;
      }
      if (typeof value === 'object') return `${key}=${JSON.stringify(value)}`;
      return `${key}=${typeof value === 'string' && /\s/.test(value) ? JSON.stringify(value) : value}`;
    })
    .join(' ');
}

/** A logger that discards everything — handy in tests. */
export function createNullLogger() {
  const noop = () => {};
  const logger = { level: 'silent', child: () => logger };
  for (const name of LOG_LEVELS) logger[name] = noop;
  return logger;
}
