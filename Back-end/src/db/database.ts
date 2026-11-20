import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

export type AppDatabase = Database.Database;

/**
 * Opens a SQLite database connection, configures WAL & foreign keys,
 * and initializes the domain schema idempotently.
 */
export function createDatabase(dbPath: string): AppDatabase {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  return db;
}
