import fs from 'node:fs';

/**
 * Minimal `.env` loader.
 *
 * Deliberately tiny so the project keeps a single runtime dependency. Values
 * already present in `process.env` always win, which means a systemd unit or a
 * container environment can override the file without editing it.
 */
export function loadEnvFile(filePath, env = process.env) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { loaded: false, keys: [], duplicates: [] };
    throw error;
  }

  const duplicates = [];
  const parsed = parseEnv(content, {
    onDuplicate: (key, line) => duplicates.push({ key, line }),
  });

  const keys = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (Object.prototype.hasOwnProperty.call(env, key)) continue;
    env[key] = value;
    keys.push(key);
  }
  return { loaded: true, keys, duplicates };
}

/**
 * @param {string} content
 * @param {object} [options]
 * @param {(key: string, line: number) => void} [options.onDuplicate] called for
 *   each repeated assignment. A later line silently overwriting an earlier one
 *   is almost always an editing accident, not an intentional override.
 */
export function parseEnv(content, { onDuplicate } = {}) {
  const result = {};
  let lineNumber = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(result, key)) onDuplicate?.(key, lineNumber);
    let value = match[2].trim();

    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      // Strip trailing inline comments only for unquoted values.
      const commentIndex = value.search(/\s#/);
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
    }

    result[key] = value;
  }
  return result;
}
