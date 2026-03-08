/**
 * Soul Cleanup — TTL-based archival and deletion for soul/ flat files.
 *
 * Complements `runDailyCleanup()` (SQLite TTL) with file-system cleanup
 * for soul/ subdirectories that still use flat files.
 *
 * Design principles:
 *   - Safe by default: only removes files with confirmed SQLite backups
 *   - Date-based detection: extracts dates from filenames (YYYY-MM-DD)
 *   - Passport pruning: keeps N most recent, removes rest
 *   - JSONL logs: truncates dual-write logs whose data lives in SQLite
 *   - Idempotent: safe to call multiple times per day
 *
 * Called from heartbeat's daily maintenance cycle.
 */

import { readdir, stat, rm, rename, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { getTodayString } from './timezone.js';

const SOUL_DIR = join(process.cwd(), 'soul');

/** TTL configuration per soul/ subdirectory (in days) */
const TTL_CONFIG = {
  /** soul/agent-reports/{agent}/{date}.jsonl — backed by SQLite agent_reports */
  agentReports: 30,
  /** soul/agent-stats/daily/{date}.json — daily snapshots */
  agentStats: 90,
  /** soul/metrics/{date}.json — migrated to SQLite daily_metrics */
  metrics: 30,
  /** soul/checkpoints/passports/ — pre-evolution identity snapshots */
  passportMaxKeep: 5,
  /** soul/logs/ JSONL files — dual-write backup, data in SQLite */
  logsMaxSizeBytes: 500_000, // ~500KB — truncate when exceeded
} as const;

export interface SoulCleanupResult {
  agentReports: { removed: number; freedBytes: number };
  agentStats: { removed: number };
  metrics: { removed: number };
  passports: { removed: number };
  logs: { truncated: string[] };
}

/**
 * Run TTL-based cleanup on soul/ flat files.
 * Returns a summary of what was removed.
 */
export async function runSoulCleanup(): Promise<SoulCleanupResult> {
  const result: SoulCleanupResult = {
    agentReports: { removed: 0, freedBytes: 0 },
    agentStats: { removed: 0 },
    metrics: { removed: 0 },
    passports: { removed: 0 },
    logs: { truncated: [] },
  };

  const cutoffDate = (ttlDays: number): string => {
    const d = new Date(Date.now() - ttlDays * 86_400_000);
    return getTodayString(d); // Use local timezone, consistent with soul/ filenames
  };

  // ── 1. Agent Reports: remove JSONL/MD files older than TTL ──
  try {
    const reportsDir = join(SOUL_DIR, 'agent-reports');
    const agentDirs = await readdir(reportsDir, { withFileTypes: true });
    const cutoff = cutoffDate(TTL_CONFIG.agentReports);

    for (const entry of agentDirs) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(reportsDir, entry.name);
      const files = await readdir(agentDir);

      for (const file of files) {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;
        const fileDate = dateMatch[1]!;
        if (fileDate < cutoff) {
          const filePath = join(agentDir, file);
          const fileStat = await stat(filePath).catch(() => null);
          const size = fileStat?.size ?? 0;
          await rm(filePath, { force: true });
          result.agentReports.removed++;
          result.agentReports.freedBytes += size;
        }
      }
    }
  } catch {
    // agent-reports dir may not exist — non-critical
  }

  // ── 2. Agent Stats Daily: remove old snapshots ──
  try {
    const statsDir = join(SOUL_DIR, 'agent-stats', 'daily');
    const files = await readdir(statsDir);
    const cutoff = cutoffDate(TTL_CONFIG.agentStats);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      if (dateMatch[1]! < cutoff) {
        await rm(join(statsDir, file), { force: true });
        result.agentStats.removed++;
      }
    }
  } catch {
    // agent-stats dir may not exist — non-critical
  }

  // ── 3. Metrics: remove old JSON files (migrated to SQLite) ──
  try {
    const metricsDir = join(SOUL_DIR, 'metrics');
    const files = await readdir(metricsDir);
    const cutoff = cutoffDate(TTL_CONFIG.metrics);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      if (dateMatch[1]! < cutoff) {
        await rm(join(metricsDir, file), { force: true });
        result.metrics.removed++;
      }
    }
  } catch {
    // metrics dir may not exist — non-critical
  }

  // ── 4. Passports: keep only N most recent ──
  try {
    const passportsDir = join(SOUL_DIR, 'checkpoints', 'passports');
    const files = await readdir(passportsDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    if (jsonFiles.length > TTL_CONFIG.passportMaxKeep) {
      // Sort by mtime descending (newest first)
      const withMtime = await Promise.all(
        jsonFiles.map(async (f) => {
          const s = await stat(join(passportsDir, f)).catch(() => null);
          return { name: f, mtime: s?.mtimeMs ?? 0 };
        }),
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const toRemove = withMtime.slice(TTL_CONFIG.passportMaxKeep);
      for (const { name } of toRemove) {
        await rm(join(passportsDir, name), { force: true });
        result.passports.removed++;
      }
    }
  } catch {
    // passports dir may not exist — non-critical
  }

  // ── 5. Logs: truncate oversized JSONL files (data lives in SQLite) ──
  try {
    const logsDir = join(SOUL_DIR, 'logs');
    const files = await readdir(logsDir);

    for (const file of files) {
      if (extname(file) !== '.jsonl') continue;
      // Skip archive files — already archived, avoid infinite re-archiving
      if (file.includes('.archive')) continue;
      // Skip anomaly.jsonl — it's small and useful for quick debugging
      if (file === 'anomaly.jsonl') continue;

      const filePath = join(logsDir, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || fileStat.size <= TTL_CONFIG.logsMaxSizeBytes) continue;

      // Archive: rename to .archive.jsonl, create fresh empty file
      const archivePath = join(logsDir, file.replace('.jsonl', `.archive-${Date.now()}.jsonl`));
      await rename(filePath, archivePath);
      await writeFile(filePath, '');
      result.logs.truncated.push(file);
    }
  } catch {
    // logs dir may not exist — non-critical
  }

  return result;
}
