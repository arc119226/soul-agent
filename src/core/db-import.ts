/**
 * One-time migration script — imports JSON/JSONL data into SQLite.
 * Phase 1: users.json + soul/metrics/*.json
 * Phase 2: narrative.jsonl + anomaly.jsonl
 *
 * Usage: npm run db:import
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './database.js';
import { logger } from './logger.js';

/** Generic JSONL → table importer */
export function importJsonlToTable(
  db: Database.Database,
  filePath: string,
  tableName: string,
  columns: string[],
  mapFn: (line: Record<string, unknown>) => Record<string, unknown>,
): number {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const placeholders = columns.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
  );

  const insertAll = db.transaction((rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      stmt.run(...columns.map(k => row[k] ?? null));
    }
  });

  const rows = lines.map(line => {
    try { return mapFn(JSON.parse(line) as Record<string, unknown>); }
    catch { return null; }
  }).filter(Boolean) as Record<string, unknown>[];

  insertAll(rows);
  return rows.length;
}

/** Import users.json → users table */
function importUsers(db: Database.Database): number {
  const usersPath = join(process.cwd(), 'soul', 'users.json');
  let data: { users: Record<string, Record<string, unknown>> };
  try {
    data = JSON.parse(readFileSync(usersPath, 'utf-8')) as typeof data;
  } catch {
    logger.info('db-import', 'No users.json found, skipping');
    return 0;
  }

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO users (id, name, username, first_seen, last_seen, message_count, facts, preferences, activity_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertAll = db.transaction((users: Record<string, unknown>[]) => {
    for (const u of users) {
      stmt.run(
        u.id, u.name, u.username, u.first_seen, u.last_seen,
        u.message_count, u.facts, u.preferences, u.activity_hours,
      );
    }
  });

  const mapped = Object.values(data.users).map((user: Record<string, unknown>) => ({
    id: user.id,
    name: user.name ?? '',
    username: user.username ?? '',
    first_seen: user.firstSeen as string,
    last_seen: user.lastSeen as string,
    message_count: (user.messageCount as number) ?? 0,
    facts: JSON.stringify((user.facts as unknown[]) ?? []),
    preferences: JSON.stringify((user.preferences as Record<string, unknown>) ?? {}),
    activity_hours: JSON.stringify((user.activityHours as unknown[]) ?? []),
  }));

  insertAll(mapped);
  return mapped.length;
}

/** Import soul/metrics/*.json → daily_metrics table */
function importMetrics(db: Database.Database): number {
  const metricsDir = join(process.cwd(), 'soul', 'metrics');
  let files: string[];
  try {
    files = readdirSync(metricsDir).filter(f => f.endsWith('.json'));
  } catch {
    logger.info('db-import', 'No metrics directory found, skipping');
    return 0;
  }

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO daily_metrics (date, messages, agents, evolution, performance, lifecycle, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertAll = db.transaction((rows: Array<{ date: string; messages: string; agents: string; evolution: string; performance: string; lifecycle: string; cost: string }>) => {
    for (const r of rows) {
      stmt.run(r.date, r.messages, r.agents, r.evolution, r.performance, r.lifecycle, r.cost);
    }
  });

  const rows: Array<{ date: string; messages: string; agents: string; evolution: string; performance: string; lifecycle: string; cost: string }> = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(metricsDir, file), 'utf-8');
      const m = JSON.parse(raw) as Record<string, unknown>;
      rows.push({
        date: m.date as string,
        messages: JSON.stringify(m.messages),
        agents: JSON.stringify(m.agents),
        evolution: JSON.stringify(m.evolution),
        performance: JSON.stringify(m.performance),
        lifecycle: JSON.stringify(m.lifecycle),
        cost: JSON.stringify(m.cost),
      });
    } catch {
      logger.warn('db-import', `Failed to parse metrics file: ${file}`);
    }
  }

  insertAll(rows);
  return rows.length;
}

// ── Phase 2: narrative + anomalies ──────────────────────────────────

/** narrative.jsonl → narrative table (spec §6.2) */
function importNarrative(db: Database.Database): number {
  const narrativePath = join(process.cwd(), 'soul', 'narrative.jsonl');
  if (!existsSync(narrativePath)) {
    logger.info('db-import', 'No narrative.jsonl found, skipping');
    return 0;
  }

  const columns = ['timestamp', 'type', 'summary', 'emotion', 'significance', 'related_to', 'data'];

  const narrativeMapper = (entry: Record<string, unknown>) => ({
    timestamp: entry.timestamp as string,
    type: entry.type as string,
    summary: entry.summary as string,
    emotion: (entry.emotion as string) ?? null,
    significance: (entry.significance as number) ?? 3,
    related_to: (entry.related_to as string) ?? null,
    data: entry.data ? JSON.stringify(entry.data) : null,
  });

  return importJsonlToTable(db, narrativePath, 'narrative', columns, narrativeMapper);
}

/**
 * Import archived narrative files (soul/narrative-archive/*.jsonl) → narrative table.
 * These are old entries archived by archiveOldNarrative().
 */
function importNarrativeArchive(db: Database.Database): number {
  const archiveDir = join(process.cwd(), 'soul', 'narrative-archive');
  let files: string[];
  try {
    files = readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    logger.info('db-import', 'No narrative-archive directory found, skipping');
    return 0;
  }

  const columns = ['timestamp', 'type', 'summary', 'emotion', 'significance', 'related_to', 'data'];

  const narrativeMapper = (entry: Record<string, unknown>) => ({
    timestamp: entry.timestamp as string,
    type: entry.type as string,
    summary: entry.summary as string,
    emotion: (entry.emotion as string) ?? null,
    significance: (entry.significance as number) ?? 3,
    related_to: (entry.related_to as string) ?? null,
    data: entry.data ? JSON.stringify(entry.data) : null,
  });

  let total = 0;
  for (const file of files) {
    try {
      const filePath = join(archiveDir, file);
      const count = importJsonlToTable(db, filePath, 'narrative', columns, narrativeMapper);
      total += count;
    } catch {
      logger.warn('db-import', `Failed to import narrative archive: ${file}`);
    }
  }

  return total;
}

/** anomaly.jsonl → anomalies table (spec §3.6) */
function importAnomalies(db: Database.Database): number {
  const anomalyPath = join(process.cwd(), 'soul', 'logs', 'anomaly.jsonl');
  if (!existsSync(anomalyPath)) {
    logger.info('db-import', 'No anomaly.jsonl found, skipping');
    return 0;
  }

  const columns = ['timestamp', 'state', 'anomalies'];

  const anomalyMapper = (entry: Record<string, unknown>) => ({
    timestamp: entry.timestamp as string,
    state: entry.state as string,
    anomalies: JSON.stringify(entry.anomalies),
  });

  return importJsonlToTable(db, anomalyPath, 'anomalies', columns, anomalyMapper);
}

// ── Phase 3b: transitions ────────────────────────────────────────────

/** Import soul/logs/transitions.jsonl → transitions table */
export function importTransitions(db: Database.Database): number {
  const transitionsPath = join(process.cwd(), 'soul', 'logs', 'transitions.jsonl');
  if (!existsSync(transitionsPath)) {
    logger.info('db-import', 'No transitions.jsonl found, skipping');
    return 0;
  }

  const columns = ['idx', 'timestamp', 'from_state', 'to_state', 'reason',
    'duration_ms', 'context', 'prev_hash', 'hash', 'vector_clock'];

  return importJsonlToTable(db, transitionsPath, 'transitions', columns, (entry) => ({
    idx: entry.index as number,
    timestamp: entry.timestamp as string,
    from_state: entry.from as string,
    to_state: entry.to as string,
    reason: entry.reason as string,
    duration_ms: entry.durationMs as number,
    context: JSON.stringify(entry.context),
    prev_hash: entry.prevHash as string,
    hash: entry.hash as string,
    vector_clock: entry.vectorClock ? JSON.stringify(entry.vectorClock) : null,
  }));
}

// ── Phase 3a: agent-tasks + agent-reports ────────────────────────────

/** Import soul/agent-tasks/history.jsonl + queue.json → agent_tasks table */
export function importAgentTasks(db: Database.Database): number {
  const historyPath = join(process.cwd(), 'soul', 'agent-tasks', 'history.jsonl');
  const queuePath = join(process.cwd(), 'soul', 'agent-tasks', 'queue.json');

  const columns = [
    'id', 'agent_name', 'prompt', 'status', 'priority', 'source',
    'created_at', 'started_at', 'completed_at', 'worker_id',
    'result', 'error', 'cost_usd', 'duration', 'confidence', 'trace_summary',
    'pipeline_id', 'stage_id', 'parent_task_id', 'chain_depth',
    'retry_count', 'retry_after', 'depends_on',
    'worktree_path', 'branch_name', 'trace', 'metadata', 'origin_agent',
  ];

  const taskMapper = (entry: Record<string, unknown>) => ({
    id: entry.id as string,
    agent_name: (entry.agentName as string) ?? '',
    prompt: (entry.prompt as string) ?? '',
    status: (entry.status as string) ?? 'completed',
    priority: (entry.priority as number) ?? 5,
    source: (entry.source as string) ?? null,
    created_at: (entry.createdAt as string) ?? new Date().toISOString(),
    started_at: (entry.startedAt as string) ?? null,
    completed_at: (entry.completedAt as string) ?? null,
    worker_id: (entry.workerId as number) ?? null,
    result: (entry.result as string) ?? null,
    error: (entry.error as string) ?? null,
    cost_usd: (entry.costUsd as number) ?? 0,
    duration: (entry.duration as number) ?? 0,
    confidence: (entry.confidence as number) ?? null,
    trace_summary: (entry.traceSummary as string) ?? null,
    pipeline_id: (entry.pipelineRunId as string) ?? null,
    stage_id: null,
    parent_task_id: (entry.parentTaskId as string) ?? null,
    chain_depth: (entry.chainDepth as number) ?? 0,
    retry_count: (entry.retryCount as number) ?? 0,
    retry_after: (entry.retryAfter as string) ?? null,
    depends_on: entry.dependsOn ? JSON.stringify(entry.dependsOn) : null,
    worktree_path: (entry.worktreePath as string) ?? null,
    branch_name: (entry.branchName as string) ?? null,
    trace: entry.trace ? JSON.stringify(entry.trace) : null,
    metadata: null,
    origin_agent: (entry.originAgent as string) ?? null,
  });

  let total = 0;

  // Import history.jsonl (completed/failed tasks)
  if (existsSync(historyPath)) {
    total += importJsonlToTable(db, historyPath, 'agent_tasks', columns, taskMapper);
  }

  // Import queue.json (pending/running tasks)
  if (existsSync(queuePath)) {
    try {
      const raw = readFileSync(queuePath, 'utf-8');
      const queue = JSON.parse(raw) as { tasks?: Record<string, unknown>[] };
      if (queue.tasks?.length) {
        const placeholders = columns.map(() => '?').join(', ');
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO agent_tasks (${columns.join(', ')}) VALUES (${placeholders})`,
        );
        const insertAll = db.transaction((rows: Record<string, unknown>[]) => {
          for (const row of rows) {
            stmt.run(...columns.map(k => row[k] ?? null));
          }
        });
        const rows = queue.tasks.map(t => taskMapper(t));
        insertAll(rows);
        total += rows.length;
      }
    } catch {
      logger.warn('db-import', 'Failed to parse queue.json for import');
    }
  }

  return total;
}

/** Import soul/agent-reports/**\/*.jsonl → agent_reports table */
export function importAgentReports(db: Database.Database): number {
  const reportsDir = join(process.cwd(), 'soul', 'agent-reports');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(reportsDir);
  } catch {
    logger.info('db-import', 'No agent-reports directory found, skipping');
    return 0;
  }

  const columns = ['timestamp', 'agent_name', 'task_id', 'prompt', 'result', 'cost_usd', 'duration', 'confidence', 'trace_summary', 'metadata'];

  const reportMapper = (agentName: string) => (entry: Record<string, unknown>) => ({
    timestamp: (entry.timestamp as string) ?? new Date().toISOString(),
    agent_name: (entry.agentName as string) ?? (entry.agent as string) ?? agentName,
    task_id: (entry.taskId as string) ?? null,
    prompt: (entry.prompt as string) ?? null,
    result: (entry.result as string) ?? null,
    cost_usd: (entry.costUsd as number) ?? 0,
    duration: (entry.duration as number) ?? null,
    confidence: (entry.confidence as number) ?? null,
    trace_summary: (entry.traceSummary as string) ?? null,
    metadata: null,
  });

  let total = 0;
  for (const agentDir of agentDirs) {
    const dirPath = join(reportsDir, agentDir);
    let files: string[];
    try {
      const s = statSync(dirPath);
      if (!s.isDirectory()) continue;
      files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const file of files) {
      try {
        const filePath = join(dirPath, file);
        const count = importJsonlToTable(db, filePath, 'agent_reports', columns, reportMapper(agentDir));
        total += count;
      } catch {
        logger.warn('db-import', `Failed to import agent report: ${agentDir}/${file}`);
      }
    }
  }

  return total;
}

/** Main import entry point */
async function main(): Promise<void> {
  const db = getDb();

  await logger.info('db-import', '=== Starting data import ===');

  // Phase 1
  const userCount = importUsers(db);
  await logger.info('db-import', `Imported ${userCount} users`);

  const metricsCount = importMetrics(db);
  await logger.info('db-import', `Imported ${metricsCount} daily metrics`);

  // Phase 2
  const narrativeArchiveCount = importNarrativeArchive(db);
  await logger.info('db-import', `Imported ${narrativeArchiveCount} archived narrative entries`);

  const narrativeCount = importNarrative(db);
  await logger.info('db-import', `Imported ${narrativeCount} narrative entries`);

  const anomalyCount = importAnomalies(db);
  await logger.info('db-import', `Imported ${anomalyCount} anomaly entries`);

  // Phase 3a
  const taskCount = importAgentTasks(db);
  await logger.info('db-import', `Imported ${taskCount} agent tasks`);

  const reportCount = importAgentReports(db);
  await logger.info('db-import', `Imported ${reportCount} agent reports`);

  // Phase 3b
  const transitionCount = importTransitions(db);
  await logger.info('db-import', `Imported ${transitionCount} transitions`);

  await logger.info('db-import', '=== Import complete ===');
}

main().catch(async (err) => {
  await logger.error('db-import', 'Import failed', err);
  process.exit(1);
});
