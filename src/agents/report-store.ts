/**
 * Report Store — manages agent execution reports (read/write/cleanup).
 *
 * Extracted from worker-scheduler.ts to reduce module size.
 * Dual-write: SQLite (primary) + JSONL (backup).
 */

import { readFile, mkdir, readdir, stat, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { getDb } from '../core/database.js';
import { getTodayString } from '../core/timezone.js';
import type { AgentReportRow } from '../core/db-types.js';
import type { AgentReport } from './task-types.js';

// ── Constants ────────────────────────────────────────────────────────

const REPORTS_DIR = join(process.cwd(), 'soul', 'agent-reports');
const REPORTS_CACHE_TTL = 60_000; // 60 seconds
const REPORT_TTL_DAYS = 30;

// ── Cache ────────────────────────────────────────────────────────────

let reportsCache: { data: AgentReport[]; expireAt: number } | null = null;

export function invalidateReportsCache(): void {
  reportsCache = null;
}

// ── SQLite Helpers ───────────────────────────────────────────────────

function reportToRow(report: AgentReport): Record<string, unknown> {
  return {
    timestamp: report.timestamp,
    agent_name: report.agentName,
    task_id: report.taskId,
    prompt: report.prompt ?? null,
    result: report.result ?? null,
    cost_usd: report.costUsd ?? 0,
    duration: report.duration ?? null,
    confidence: report.confidence ?? null,
    trace_summary: report.traceSummary ?? null,
    metadata: null,
  };
}

function rowToReport(row: AgentReportRow): AgentReport {
  return {
    timestamp: row.timestamp,
    agentName: row.agent_name,
    taskId: row.task_id ?? '',
    prompt: row.prompt ?? '',
    result: row.result ?? '',
    costUsd: row.cost_usd ?? 0,
    duration: row.duration ?? 0,
    confidence: row.confidence ?? 0,
    traceSummary: row.trace_summary ?? undefined,
  };
}

function insertReportToDb(report: AgentReport): void {
  try {
    const db = getDb();
    const row = reportToRow(report);
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    db.prepare(
      `INSERT INTO agent_reports (${columns.join(', ')}) VALUES (${placeholders})`,
    ).run(...columns.map(k => row[k] ?? null));
  } catch (err) {
    logger.warn('ReportStore', `insertReportToDb failed: ${(err as Error).message}`);
  }
}

function getRecentReportsFromDb(limit: number): AgentReport[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM agent_reports ORDER BY timestamp DESC LIMIT ?',
  ).all(limit) as AgentReportRow[];
  return rows.map(rowToReport);
}

// ── Write ────────────────────────────────────────────────────────────

export async function writeReport(report: AgentReport): Promise<void> {
  // 1. Write to SQLite (primary)
  insertReportToDb(report);

  // 2. Write to JSONL (backup)
  const date = report.timestamp.slice(0, 10);
  const dir = join(REPORTS_DIR, report.agentName);
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, `${date}.jsonl`);
  await writer.appendJsonl(filePath, report);

  await logger.debug('ReportStore', `Report written: ${filePath}`);
}

// ── Read ─────────────────────────────────────────────────────────────

/** Read recent agent reports (last 24h) for context weaving. */
export async function getRecentReports(maxEntries: number = 5): Promise<AgentReport[]> {
  if (reportsCache && Date.now() < reportsCache.expireAt) {
    return reportsCache.data.slice(0, maxEntries);
  }

  // Primary: read from SQLite
  try {
    const cacheLimit = Math.max(maxEntries, 50);
    const sorted = getRecentReportsFromDb(cacheLimit);
    reportsCache = { data: sorted, expireAt: Date.now() + REPORTS_CACHE_TTL };
    return sorted.slice(0, maxEntries);
  } catch {
    // Fallback: read from JSONL files
  }

  const reports: AgentReport[] = [];
  const today = getTodayString();
  const yesterday = getTodayString(new Date(Date.now() - 86400_000));

  const agentDirs = await readdir(REPORTS_DIR).catch(() => [] as string[]);

  for (const agentDir of agentDirs) {
    for (const dateStr of [today, yesterday]) {
      const filePath = join(REPORTS_DIR, agentDir, `${dateStr}.jsonl`);
      const raw = await readFile(filePath, 'utf-8').catch(() => '');
      if (!raw) continue;
      const lines = raw.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as AgentReport & { agent?: string };
          if (!parsed.agentName) {
            parsed.agentName = parsed.agent ?? agentDir;
          }
          reports.push(parsed);
        } catch { /* skip malformed */ }
      }
    }
  }

  const sorted = reports.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  reportsCache = { data: sorted, expireAt: Date.now() + REPORTS_CACHE_TTL };
  return sorted.slice(0, maxEntries);
}

// ── Cleanup ──────────────────────────────────────────────────────────

/**
 * Delete agent report files older than REPORT_TTL_DAYS.
 * Extracts date from filename via regex; files without a parseable date are skipped.
 */
export async function cleanupOldReports(): Promise<void> {
  const today = getTodayString();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - REPORT_TTL_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let count = 0;
  const agentDirs = await readdir(REPORTS_DIR).catch(() => [] as string[]);

  for (const agentDir of agentDirs) {
    const dirPath = join(REPORTS_DIR, agentDir);
    const dirStat = await stat(dirPath).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    const files = await readdir(dirPath).catch(() => [] as string[]);
    for (const file of files) {
      const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      if (dateMatch[1]! < cutoffStr) {
        await unlink(join(dirPath, file)).catch(() => {});
        count++;
      }
    }

    const remaining = await readdir(dirPath).catch(() => ['placeholder']);
    if (remaining.length === 0) {
      await rmdir(dirPath).catch(() => {});
    }
  }

  if (count > 0) {
    await logger.info('ReportStore', `Cleaned up ${count} old report(s) older than ${REPORT_TTL_DAYS} days`);
  }
}
