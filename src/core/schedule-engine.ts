/**
 * Unified Schedule Engine — single cron engine for all scheduled tasks.
 *
 * Replaces the dual-engine pattern (proactive/scheduler.ts + agents/daily-maintenance.ts)
 * with a tick-driven evaluator. No internal timers — driven by heartbeat:tick.
 *
 * Supports: 'daily@HH:MM', 'every:Xm', 'every:Xh', 'manual'
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from './debounced-writer.js';
import { logger } from './logger.js';
import { config } from '../config.js';
import { getTodayString } from './timezone.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ScheduleConstraints {
  activeHours?: [number, number];
  activeDays?: number[];
  costGate?: number;
}

export type ScheduleExecutor =
  | { type: 'callback'; fn: () => void | Promise<void> }
  | { type: 'agent'; agentName: string };

export interface ScheduleEntry {
  id: string;
  cronExpr: string;
  executor: ScheduleExecutor;
  enabled: boolean;
  lastRun: string | null;
  constraints?: ScheduleConstraints;
  source: 'proactive' | 'agent' | 'heartbeat' | 'evolution';
  /** If true, engine skips due-evaluation (entry manages its own timer) */
  selfManaged?: boolean;
  meta?: {
    description?: string;
    lastResult?: 'success' | 'failure' | 'skipped';
    runCount?: number;
  };
}

interface PersistedEntryState {
  lastRun: string | null;
  lastResult?: 'success' | 'failure' | 'skipped';
  runCount?: number;
  /** Persisted cronExpr — used to detect stale state after schedule changes */
  cronExpr?: string;
}

interface ScheduleStateFile {
  version: number;
  entries: Record<string, PersistedEntryState>;
}

// ── Cron Expression Parser ───────────────────────────────────────────

export type ParsedCron =
  | { type: 'daily'; hour: number; minute: number }
  | { type: 'interval'; ms: number }
  | null;

export function parseCronExpr(expr: string): ParsedCron {
  // daily@HH:MM
  const dailyMatch = expr.match(/^daily@(\d{1,2}):(\d{2})$/);
  if (dailyMatch) {
    return { type: 'daily', hour: Number(dailyMatch[1]), minute: Number(dailyMatch[2]) };
  }

  // every:Nm
  const minMatch = expr.match(/^every:(\d+)m$/);
  if (minMatch) {
    return { type: 'interval', ms: Number(minMatch[1]) * 60 * 1000 };
  }

  // every:Nh
  const hourMatch = expr.match(/^every:(\d+)h$/);
  if (hourMatch) {
    return { type: 'interval', ms: Number(hourMatch[1]) * 60 * 60 * 1000 };
  }

  return null;
}

// ── Constraint Checker ───────────────────────────────────────────────

export function meetsConstraints(
  constraints: ScheduleConstraints | undefined,
  now: Date = new Date(),
): boolean {
  if (!constraints) return true;

  const local = new Date(now.toLocaleString('en-US', { timeZone: config.TIMEZONE }));
  const hour = local.getHours();
  const day = local.getDay() || 7; // Sunday 0 → 7 (ISO: 1=Mon..7=Sun)

  if (constraints.activeHours) {
    const [start, end] = constraints.activeHours;
    if (start < end) {
      if (hour < start || hour >= end) return false;
    } else {
      // Overnight window (e.g., [22, 6])
      if (hour < start && hour >= end) return false;
    }
  }

  if (constraints.activeDays && !constraints.activeDays.includes(day)) return false;

  // costGate is agent-specific (needs totalCostToday from agent config).
  // For non-agent entries, costGate is ignored here.
  // Agent cost gating is handled externally before evaluateDue() for agent entries.

  return true;
}

// ── Schedule Engine (singleton) ──────────────────────────────────────

const STATE_PATH = join(process.cwd(), 'soul', 'schedule-state.json');

class ScheduleEngine {
  private entries = new Map<string, ScheduleEntry>();
  /** In-memory tracking for interval-based entries (ms since epoch of last run) */
  private lastRunMs = new Map<string, number>();
  /** Date-keyed dedup for daily entries (prevents re-fire on same day) */
  private dailyFired = new Map<string, string>(); // id → todayStr
  private loaded = false;

  // ── Registration ────────────────────────────────────────────────

  register(entry: Omit<ScheduleEntry, 'meta'> & { meta?: ScheduleEntry['meta'] }): void {
    const existing = this.entries.get(entry.id);

    // Merge persisted state if available
    const merged: ScheduleEntry = {
      ...entry,
      meta: entry.meta ?? existing?.meta ?? {},
    };

    // If we had persisted lastRun, use it — but ONLY if the cronExpr hasn't changed.
    // When the schedule itself changes, stale lastRun would cause incorrect
    // dailyFired / lastRunMs seeding, making agents fire at wrong times.
    // Exception: legacy stubs (cronExpr='manual' from pre-cronExpr-tracking state)
    // should always inherit lastRun to prevent schedule avalanche on migration.
    if (existing?.lastRun && !entry.lastRun &&
        (existing.cronExpr === entry.cronExpr || existing.cronExpr === 'manual')) {
      merged.lastRun = existing.lastRun;
    }

    this.entries.set(merged.id, merged);

    // Seed in-memory tracker from lastRun
    if (merged.lastRun) {
      const ts = new Date(merged.lastRun).getTime();
      if (!isNaN(ts)) {
        this.lastRunMs.set(merged.id, ts);
        // For daily entries, also seed dailyFired
        const parsed = parseCronExpr(merged.cronExpr);
        if (parsed?.type === 'daily') {
          const runDay = getTodayString(new Date(merged.lastRun));
          this.dailyFired.set(merged.id, runDay);
        }
      }
    }

    logger.debug('ScheduleEngine', `registered: ${merged.id} (${merged.cronExpr}, source=${merged.source})`);
  }

  unregister(id: string): void {
    this.entries.delete(id);
    this.lastRunMs.delete(id);
    this.dailyFired.delete(id);
  }

  // ── Tick-driven Evaluation ──────────────────────────────────────

  /**
   * Evaluate which entries are due at the given time.
   * Returns entries ready to execute (caller dispatches them).
   */
  evaluateDue(now: Date = new Date()): ScheduleEntry[] {
    const due: ScheduleEntry[] = [];
    const todayStr = getTodayString(now);
    const nowMs = now.getTime();

    for (const entry of this.entries.values()) {
      if (!entry.enabled) continue;
      if (entry.selfManaged) continue;

      const parsed = parseCronExpr(entry.cronExpr);
      if (!parsed) continue;

      // Check constraints (activeHours / activeDays)
      if (!meetsConstraints(entry.constraints, now)) continue;

      if (parsed.type === 'daily') {
        // Already fired today?
        if (this.dailyFired.get(entry.id) === todayStr) continue;

        // Is it time yet?
        if (!isDailyDue(parsed.hour, parsed.minute, now)) continue;

        due.push(entry);
      } else if (parsed.type === 'interval') {
        const lastMs = this.lastRunMs.get(entry.id) ?? 0;
        const elapsed = nowMs - lastMs;
        if (elapsed >= parsed.ms) {
          // If overdue by >2x interval, bot was likely offline — reset timer instead of firing
          // This prevents schedule avalanche on startup (all interval agents firing at once)
          if (lastMs > 0 && elapsed > parsed.ms * 2) {
            this.lastRunMs.set(entry.id, nowMs);
            logger.info('ScheduleEngine', `Skipping overdue interval entry ${entry.id} (${Math.round(elapsed / 60000)}min late, reset timer)`);
            continue;
          }
          due.push(entry);
        }
      }
    }

    return due;
  }

  /**
   * Mark an entry as having just run (updates in-memory + persists).
   */
  async markRun(
    id: string,
    result: 'success' | 'failure' | 'skipped' = 'success',
    now: Date = new Date(),
  ): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;

    const isoStr = now.toISOString();
    entry.lastRun = isoStr;
    entry.meta = entry.meta ?? {};
    entry.meta.lastResult = result;
    entry.meta.runCount = (entry.meta.runCount ?? 0) + 1;

    this.lastRunMs.set(id, now.getTime());

    const parsed = parseCronExpr(entry.cronExpr);
    if (parsed?.type === 'daily') {
      this.dailyFired.set(id, getTodayString(now));
    }

    await this.persistState();
  }

  /**
   * Update an entry's cron expression (e.g., auto-evolve adaptive interval).
   */
  reschedule(id: string, newCronExpr: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.cronExpr = newCronExpr;
  }

  setEnabled(id: string, enabled: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.enabled = enabled;
  }

  // ── Query ───────────────────────────────────────────────────────

  getAll(): ScheduleEntry[] {
    return [...this.entries.values()];
  }

  getById(id: string): ScheduleEntry | null {
    return this.entries.get(id) ?? null;
  }

  getBySource(source: ScheduleEntry['source']): ScheduleEntry[] {
    return this.getAll().filter((e) => e.source === source);
  }

  // ── Persistence ─────────────────────────────────────────────────

  async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const raw = await readFile(STATE_PATH, 'utf-8');
      const data = JSON.parse(raw) as ScheduleStateFile;

      for (const [id, state] of Object.entries(data.entries)) {
        // Create stub entries that will be merged when register() is called.
        // Preserve persisted cronExpr so register() can detect schedule changes.
        const stub: ScheduleEntry = {
          id,
          cronExpr: state.cronExpr ?? 'manual', // Use persisted cronExpr if available
          executor: { type: 'callback', fn: () => {} },
          enabled: false, // Will be overwritten on register()
          lastRun: state.lastRun,
          source: 'proactive', // Will be overwritten on register()
          meta: {
            lastResult: state.lastResult,
            runCount: state.runCount,
          },
        };
        this.entries.set(id, stub);

        // Seed in-memory tracker
        if (state.lastRun) {
          const ts = new Date(state.lastRun).getTime();
          if (!isNaN(ts)) {
            this.lastRunMs.set(id, ts);
          }
        }
      }

      logger.info('ScheduleEngine', `loaded state for ${Object.keys(data.entries).length} entries`);
    } catch {
      // No state file yet — first run
      logger.debug('ScheduleEngine', 'no schedule-state.json found, starting fresh');
    }
  }

  private async persistState(): Promise<void> {
    const data: ScheduleStateFile = {
      version: 1,
      entries: {},
    };

    for (const entry of this.entries.values()) {
      // Only persist entries that have actually run
      if (entry.lastRun) {
        data.entries[entry.id] = {
          lastRun: entry.lastRun,
          lastResult: entry.meta?.lastResult,
          runCount: entry.meta?.runCount,
          cronExpr: entry.cronExpr,
        };
      }
    }

    writer.schedule(STATE_PATH, data);
  }

  // ── Shutdown ────────────────────────────────────────────────────

  clear(): void {
    this.entries.clear();
    this.lastRunMs.clear();
    this.dailyFired.clear();
  }
}

// ── Helper: daily@HH:MM due check ────────────────────────────────────

function isDailyDue(targetHour: number, targetMinute: number, now: Date): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.TIMEZONE,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const currentTotal = h * 60 + m;
  const targetTotal = targetHour * 60 + targetMinute;

  // Due at or after target time (will only fire once per day via dailyFired dedup)
  return currentTotal >= targetTotal;
}

// ── Singleton Export ──────────────────────────────────────────────────

export const scheduleEngine = new ScheduleEngine();
