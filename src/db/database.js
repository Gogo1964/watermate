import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.js';

/**
 * Opens the SQLite database and brings the schema up to date.
 *
 * `node:sqlite` ships with Node itself, so a Raspberry Pi install needs no
 * native compilation. WAL mode keeps the single writer from blocking readers
 * and survives an unclean shutdown.
 */
export function openDatabase(filePath, { logger } = {}) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const applied = migrate(db);
  if (applied.length > 0) {
    logger?.info('Applied database migrations', { file: filePath, migrations: applied });
  }
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id));
  const applied = [];

  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        Date.now(),
      );
      db.exec('COMMIT');
      applied.push(`${migration.id}-${migration.name}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.id} (${migration.name}) failed: ${error.message}`, { cause: error });
    }
  }
  return applied;
}

/** Runs `fn` inside a transaction, rolling back on any error. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction was already rolled back by SQLite.
    }
    throw error;
  }
}
