/**
 * Generic cron-like scheduler.
 * Supports simplified expressions: 'daily@HH:MM', 'every:Nm', 'every:Nh'
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';
import { getTodayString } from '../core/timezone.js';

const SCHEDULES_PATH = join(process.cwd(), 'soul', 'schedules.json');

type ScheduleHandler = () => void | Promise<void>;

interface ScheduleEntry {
  id: string;
  cronExpr: string;
  handler: ScheduleHandler;
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null;
  lastRun: number;
}

interface PersistedSchedule {
  id: string;
  cronExpr: string;
  createdAt: string;
}

interface SchedulesFile {
  version: number;
  schedules: PersistedSchedule[];
}

const schedules = new Map<string, ScheduleEntry>();
const restoredHandlers = new Map<string, ScheduleHandler>();

function parseCronExpr(expr: string): { type: 'daily'; hour: number; minute: number }
  | { type: 'interval_m'; minutes: number }
  | { type: 'interval_h'; hours: number }
  | null {
  // daily@HH:MM
  const dailyMatch = expr.match(/^daily@(\d{1,2}):(\d{2})$/);
  if (dailyMatch) {
    return { type: 'daily', hour: Number(dailyMatch[1]), minute: Number(dailyMatch[2]) };
  }

  // every:Nm
  const minMatch = expr.match(/^every:(\d+)m$/);
  if (minMatch) {
    return { type: 'interval_m', minutes: Number(minMatch[1]) };
  }

  // every:Nh
  const hourMatch = expr.match(/^every:(\d+)h$/);
  if (hourMatch) {
    return { type: 'interval_h', hours: Number(hourMatch[1]) };
  }

  return null;
}

function startScheduleTimer(entry: ScheduleEntry): void {
  const parsed = parseCronExpr(entry.cronExpr);
  if (!parsed) {
    logger.warn('Scheduler', `Invalid cron expression: ${entry.cronExpr}`);
    return;
  }

  const run = async () => {
    entry.lastRun = Date.now();
    try {
      await entry.handler();
    } catch (err) {
      logger.error('Scheduler', `Schedule ${entry.id} handler error`, err);
    }
  };

  if (parsed.type === 'interval_m') {
    const timer = setInterval(run, parsed.minutes * 60 * 1000);
    timer.unref(); // Don't block Node.js shutdown
    entry.timer = timer;
  } else if (parsed.type === 'interval_h') {
    const timer = setInterval(run, parsed.hours * 60 * 60 * 1000);
    timer.unref();
    entry.timer = timer;
  } else if (parsed.type === 'daily') {
    // Check every minute whether it's time
    const timer = setInterval(() => {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: config.TIMEZONE,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      });
      const parts = formatter.formatToParts(now);
      const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
      const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);

      if (h === parsed.hour && m === parsed.minute) {
        // Only run once per day (timezone-aware)
        const todayKey = getTodayString(now);
        const lastRunDay = entry.lastRun > 0
          ? getTodayString(new Date(entry.lastRun))
          : '';
        if (todayKey !== lastRunDay) {
          run();
        }
      }
    }, 60 * 1000);
    timer.unref();
    entry.timer = timer;
  }
}

async function persist(): Promise<void> {
  const data: SchedulesFile = {
    version: 1,
    schedules: [...schedules.values()].map((s) => ({
      id: s.id,
      cronExpr: s.cronExpr,
      createdAt: new Date().toISOString(),
    })),
  };
  writer.schedule(SCHEDULES_PATH, data);
}

export function schedule(id: string, cronExpr: string, handler: ScheduleHandler): void {
  // Cancel existing if any
  cancel(id);

  const parsed = parseCronExpr(cronExpr);
  if (!parsed) {
    logger.warn('Scheduler', `Cannot schedule ${id}: invalid expression "${cronExpr}"`);
    return;
  }

  const entry: ScheduleEntry = {
    id,
    cronExpr,
    handler,
    timer: null,
    lastRun: 0,
  };

  schedules.set(id, entry);
  startScheduleTimer(entry);
  persist();

  logger.info('Scheduler', `Scheduled: ${id} (${cronExpr})`);
}

export function cancel(id: string): void {
  const entry = schedules.get(id);
  if (!entry) return;

  if (entry.timer) {
    clearInterval(entry.timer as ReturnType<typeof setInterval>);
  }
  schedules.delete(id);
  persist();

  logger.info('Scheduler', `Cancelled: ${id}`);
}

export function getSchedules(): { id: string; cronExpr: string; lastRun: number }[] {
  return [...schedules.values()].map((s) => ({
    id: s.id,
    cronExpr: s.cronExpr,
    lastRun: s.lastRun,
  }));
}

/** Register a handler that will be used when restoring persisted schedules */
export function registerRestoreHandler(id: string, handler: ScheduleHandler): void {
  restoredHandlers.set(id, handler);
}

/** Restore schedules from disk on startup */
export async function restoreSchedules(): Promise<void> {
  try {
    const raw = await readFile(SCHEDULES_PATH, 'utf-8');
    const data = JSON.parse(raw) as SchedulesFile;

    for (const persisted of data.schedules) {
      const handler = restoredHandlers.get(persisted.id);
      if (handler) {
        schedule(persisted.id, persisted.cronExpr, handler);
      } else {
        await logger.warn('Scheduler', `No handler registered for restored schedule: ${persisted.id}`);
      }
    }

    await logger.info('Scheduler', `Restored ${data.schedules.length} schedules`);
  } catch {
    // No schedules file — that's fine
  }
}

/** Stop all schedules */
export function stopAll(): void {
  for (const entry of schedules.values()) {
    if (entry.timer) {
      clearInterval(entry.timer as ReturnType<typeof setInterval>);
    }
  }
  schedules.clear();
}
