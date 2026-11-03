import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// WAL lets readers run beside the single writer; busy_timeout makes a second process wait for the
// write lock instead of failing at once.
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_hash TEXT NOT NULL,
      ts INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_tenant_ts ON usage (tenant_hash, ts);
    CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts);
  `);
  return db;
}
