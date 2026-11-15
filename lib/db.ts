import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { getDataDir } from "@/lib/paths";

export type DbPrimitive = string | number | null;

export type DbMeta = {
  changes: number;
  last_row_id: number | string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plays (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  markdown TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  play_id TEXT NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(play_id, name)
);

CREATE TABLE IF NOT EXISTS fragment_assignments (
  id TEXT PRIMARY KEY,
  play_id TEXT NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  selected_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(play_id, start_offset, end_offset)
);

CREATE TABLE IF NOT EXISTS fragment_assignment_actors (
  assignment_id TEXT NOT NULL REFERENCES fragment_assignments(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, actor_id)
);

CREATE TABLE IF NOT EXISTS play_votes (
  play_id TEXT NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  vote_block_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  option_id TEXT NOT NULL,
  option_label TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (play_id, vote_block_id, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_plays_updated_at ON plays(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_plays_active_public ON plays(is_active, published, hidden);
CREATE INDEX IF NOT EXISTS idx_actors_play_id ON actors(play_id);
CREATE INDEX IF NOT EXISTS idx_assignments_play_id ON fragment_assignments(play_id, start_offset);
CREATE INDEX IF NOT EXISTS idx_assignment_actors_assignment_id ON fragment_assignment_actors(assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_actors_actor_id ON fragment_assignment_actors(actor_id);
CREATE INDEX IF NOT EXISTS idx_play_votes_play_block ON play_votes(play_id, vote_block_id);
CREATE INDEX IF NOT EXISTS idx_play_votes_actor_id ON play_votes(actor_id);
`;

const globalForDb = globalThis as unknown as { __obrasDb?: DatabaseSync };

export function getDbPath() {
  return process.env.OBRAS_DB_PATH || path.join(getDataDir(), "obras.sqlite");
}

export function getDb() {
  if (globalForDb.__obrasDb) {
    return globalForDb.__obrasDb;
  }

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -16000;
  `);
  db.exec(SCHEMA);

  globalForDb.__obrasDb = db;
  return db;
}

function normalizeRow<T>(row: unknown): T {
  // node:sqlite returns null-prototype objects; spread them into plain objects.
  return { ...(row as object) } as T;
}

export async function dbQuery<T>(sql: string, params: DbPrimitive[] = []): Promise<T[]> {
  return dbQuerySync<T>(sql, params);
}

export async function dbFirst<T>(sql: string, params: DbPrimitive[] = []): Promise<T | null> {
  return dbFirstSync<T>(sql, params);
}

export async function dbExecute(sql: string, params: DbPrimitive[] = []): Promise<DbMeta> {
  return dbExecuteSync(sql, params);
}

export function dbQuerySync<T>(sql: string, params: DbPrimitive[] = []): T[] {
  return getDb()
    .prepare(sql)
    .all(...(params as SQLInputValue[]))
    .map((row) => normalizeRow<T>(row));
}

export function dbFirstSync<T>(sql: string, params: DbPrimitive[] = []): T | null {
  const row = getDb()
    .prepare(sql)
    .get(...(params as SQLInputValue[]));
  return row ? normalizeRow<T>(row) : null;
}

export function dbExecuteSync(sql: string, params: DbPrimitive[] = []): DbMeta {
  const result = getDb()
    .prepare(sql)
    .run(...(params as SQLInputValue[]));
  return {
    changes: Number(result.changes),
    last_row_id: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
  };
}

/** Runs `fn` inside a single SQLite transaction (synchronous body only). */
export function dbTransaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
