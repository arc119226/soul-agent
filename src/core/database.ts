import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { logger } from './logger.js';

const DB_PATH = join(process.cwd(), 'data', 'bot.db');

let db: Database.Database | null = null;

/** Get or initialize the database connection */
export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -8000');

  runMigrations(db);
  logger.info('Database', `SQLite opened: ${DB_PATH}`);
  return db;
}

/** Close the database (call on shutdown) */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database', 'SQLite closed');
  }
}

/** Run pending migrations */
function runMigrations(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS _schema_version (
    version    INTEGER NOT NULL,
    applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  const current = database.prepare('SELECT MAX(version) as v FROM _schema_version').get() as { v: number | null };
  const currentVersion = current?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      database.exec(migration.sql);
      database.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(migration.version);
      logger.info('Database', `Migration v${migration.version} applied`);
    }
  }
}

/** TTL cleanup — call daily from heartbeat */
export function runDailyCleanup(): { deleted: Record<string, number> } {
  const d = getDb();
  const result: Record<string, number> = {};

  const tables = [
    { name: 'witness', ttl: '-365 days', col: 'timestamp' },
    { name: 'anomalies', ttl: '-90 days', col: 'timestamp' },
    { name: 'agent_tasks', ttl: '-365 days', col: 'completed_at' },
    { name: 'agent_reports', ttl: '-180 days', col: 'timestamp' },
  ];

  for (const { name, ttl, col } of tables) {
    const r = d.prepare(`DELETE FROM ${name} WHERE ${col} < datetime('now', ?)`).run(ttl);
    result[name] = r.changes;
  }

  // Rebuild FTS index after TTL deletes to reclaim space
  try {
    d.exec("INSERT INTO agent_reports_fts(agent_reports_fts) VALUES ('rebuild')");
  } catch {
    // FTS table may not exist yet (pre-migration V3)
  }

  return { deleted: result };
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS narrative (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  summary       TEXT    NOT NULL,
  emotion       TEXT,
  significance  INTEGER NOT NULL DEFAULT 3,
  related_to    TEXT,
  data          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_narrative_ts ON narrative(timestamp);
CREATE INDEX IF NOT EXISTS idx_narrative_type ON narrative(type);
CREATE INDEX IF NOT EXISTS idx_narrative_significance ON narrative(significance);

CREATE TABLE IF NOT EXISTS audit_chain (
  idx         INTEGER PRIMARY KEY,
  timestamp   TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  prev_hash   TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  merkle_root TEXT,
  hash        TEXT    NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_chain(type);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_chain(timestamp);

CREATE TABLE IF NOT EXISTS witness (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp      TEXT    NOT NULL,
  merkle_root    TEXT    NOT NULL,
  chain_tip      TEXT    NOT NULL,
  chain_length   INTEGER NOT NULL,
  state          TEXT    NOT NULL,
  audit_log_hash TEXT,
  narrative_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_witness_ts ON witness(timestamp);

CREATE TABLE IF NOT EXISTS transitions (
  idx          INTEGER PRIMARY KEY,
  timestamp    TEXT    NOT NULL,
  from_state   TEXT    NOT NULL,
  to_state     TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  duration_ms  INTEGER NOT NULL,
  context      TEXT    NOT NULL,
  prev_hash    TEXT    NOT NULL,
  hash         TEXT    NOT NULL UNIQUE,
  vector_clock TEXT
);
CREATE INDEX IF NOT EXISTS idx_transitions_ts ON transitions(timestamp);
CREATE INDEX IF NOT EXISTS idx_transitions_states ON transitions(from_state, to_state);
CREATE INDEX IF NOT EXISTS idx_transitions_ts_state ON transitions(timestamp, from_state);

CREATE TABLE IF NOT EXISTS anomalies (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT    NOT NULL,
  state     TEXT    NOT NULL,
  anomalies TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anomalies_ts ON anomalies(timestamp);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id              TEXT    PRIMARY KEY,
  agent_name      TEXT    NOT NULL,
  prompt          TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 5,
  source          TEXT,
  created_at      TEXT    NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  worker_id       INTEGER,
  result          TEXT,
  error           TEXT,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  duration        INTEGER,
  confidence      REAL,
  trace_summary   TEXT,
  pipeline_id     TEXT,
  stage_id        TEXT,
  parent_task_id  TEXT,
  chain_depth     INTEGER DEFAULT 0,
  retry_count     INTEGER DEFAULT 0,
  retry_after     TEXT,
  depends_on      TEXT,
  worktree_path   TEXT,
  branch_name     TEXT,
  trace           TEXT,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON agent_tasks(agent_name);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON agent_tasks(completed_at);
CREATE INDEX IF NOT EXISTS idx_tasks_pipeline ON agent_tasks(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_completed ON agent_tasks(agent_name, completed_at);

CREATE TABLE IF NOT EXISTS agent_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT    NOT NULL,
  agent_name    TEXT    NOT NULL,
  task_id       TEXT,
  prompt        TEXT,
  result        TEXT,
  cost_usd      REAL    DEFAULT 0,
  duration      INTEGER,
  confidence    REAL,
  trace_summary TEXT,
  metadata      TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_agent ON agent_reports(agent_name);
CREATE INDEX IF NOT EXISTS idx_reports_ts ON agent_reports(timestamp);
CREATE INDEX IF NOT EXISTS idx_reports_task ON agent_reports(task_id);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL DEFAULT '',
  username       TEXT    NOT NULL DEFAULT '',
  first_seen     TEXT    NOT NULL,
  last_seen      TEXT    NOT NULL,
  message_count  INTEGER NOT NULL DEFAULT 0,
  facts          TEXT    NOT NULL DEFAULT '[]',
  preferences    TEXT    NOT NULL DEFAULT '{}',
  activity_hours TEXT    NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  date        TEXT PRIMARY KEY,
  messages    TEXT NOT NULL,
  agents      TEXT NOT NULL,
  evolution   TEXT NOT NULL,
  performance TEXT NOT NULL,
  lifecycle   TEXT NOT NULL,
  cost        TEXT NOT NULL
);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: `ALTER TABLE agent_tasks ADD COLUMN origin_agent TEXT;` },
  {
    version: 3,
    sql: `
-- FTS5 full-text search index for agent_reports (trigram tokenizer for CJK support)
CREATE VIRTUAL TABLE IF NOT EXISTS agent_reports_fts USING fts5(
  prompt,
  result,
  trace_summary,
  content = agent_reports,
  content_rowid = id,
  tokenize = 'trigram case_sensitive 0'
);

-- Sync triggers
CREATE TRIGGER IF NOT EXISTS agent_reports_ai AFTER INSERT ON agent_reports BEGIN
  INSERT INTO agent_reports_fts(rowid, prompt, result, trace_summary)
  VALUES (new.id, new.prompt, new.result, new.trace_summary);
END;

CREATE TRIGGER IF NOT EXISTS agent_reports_ad AFTER DELETE ON agent_reports BEGIN
  INSERT INTO agent_reports_fts(agent_reports_fts, rowid, prompt, result, trace_summary)
  VALUES ('delete', old.id, old.prompt, old.result, old.trace_summary);
END;

CREATE TRIGGER IF NOT EXISTS agent_reports_au AFTER UPDATE ON agent_reports BEGIN
  INSERT INTO agent_reports_fts(agent_reports_fts, rowid, prompt, result, trace_summary)
  VALUES ('delete', old.id, old.prompt, old.result, old.trace_summary);
  INSERT INTO agent_reports_fts(rowid, prompt, result, trace_summary)
  VALUES (new.id, new.prompt, new.result, new.trace_summary);
END;

-- Backfill existing data
INSERT INTO agent_reports_fts(rowid, prompt, result, trace_summary)
  SELECT id, prompt, result, trace_summary FROM agent_reports;
    `,
  },
  {
    version: 4,
    sql: `
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_status
  ON agent_tasks(agent_name, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_created
  ON agent_tasks(status, created_at);
    `,
  },
  {
    version: 5,
    sql: `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON agent_tasks(parent_task_id);`,
  },
];
