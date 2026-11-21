import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { POST_MIGRATION_INDEXES_SQL, SCHEMA_SQL } from './schema.js';

export type AppDatabase = Database.Database;

const USER_MIGRATION_COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
  { name: 'username', definition: 'TEXT' },
  { name: 'username_normalized', definition: 'TEXT' },
  { name: 'email', definition: 'TEXT' },
  { name: 'email_verified', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'password_hash', definition: 'TEXT' },
  { name: 'display_name', definition: 'TEXT' },
  { name: 'avatar_url', definition: 'TEXT' },
  { name: 'google_sub', definition: 'TEXT' },
];

function migrateUsersTable(db: AppDatabase): void {
  const columns = db.pragma('table_info(users)') as Array<{ name: string }>;
  const existing = new Set(columns.map((col) => col.name));

  for (const col of USER_MIGRATION_COLUMNS) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.definition}`);
    }
  }
}

/**
 * Opens a SQLite database connection, configures WAL & foreign keys,
 * and initializes the domain schema idempotently.
 */
export function createDatabase(dbPath: string): AppDatabase {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const db = new Database(dbPath, { timeout: 5000 });
  if (dbPath !== ':memory:') {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // Ignore chmod failures on filesystems that do not support POSIX permissions
    }
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  migrateUsersTable(db);
  db.exec(POST_MIGRATION_INDEXES_SQL);

  return db;
}
