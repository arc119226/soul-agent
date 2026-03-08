/**
 * Scheduled automatic evolution — picks goals and runs the pipeline.
 * Adaptive interval: longer after failures, shorter after successes.
 */

import { logger } from '../core/logger.js';
import { config } from '../config.js';
import { getNextGoal } from './goals.js';
import { executePipeline } from './pipeline.js';
import { isOpen, getCircuitBreakerInfo } from './circuit-breaker.js';
import { isOk } from '../result.js';
import { getTodayString } from '../core/timezone.js';
import { scheduleEngine } from '../core/schedule-engine.js';

const BASE_INTERVAL_MS = 30 * 60 * 1000;   // 30 minutes
const MAX_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MIN_INTERVAL_MS = 10 * 60 * 1000;     // 10 minutes

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let currentIntervalMs = BASE_INTERVAL_MS;
let evolvesToday = 0;
let lastResetDate = '';

function todayStr(): string {
  return getTodayString();
}

function resetDailyCountIfNeeded(): void {
  const today = todayStr();
  if (lastResetDate !== today) {
    evolvesToday = 0;
    lastResetDate = today;
  }
}

/** Check if we're in quiet hours */
function isQuietHours(): boolean {
  const now = new Date();
  // Convert to configured timezone hour
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: config.TIMEZONE,
  });
  const hour = parseInt(formatter.format(now), 10);

  const start = config.QUIET_HOURS_START;
  const end = config.QUIET_HOURS_END;

  if (start < end) {
    return hour >= start && hour < end;
  }
  // Wraps midnight: e.g., 23-7
  return hour >= start || hour < end;
}

/** Run one auto-evolution cycle */
async function runCycle(): Promise<void> {
  if (running) {
    logger.debug('auto-evolve', 'Cycle already running, skipping');
    return;
  }

  running = true;

  try {
    // Guard checks
    resetDailyCountIfNeeded();

    if (isQuietHours()) {
      logger.debug('auto-evolve', 'Quiet hours, skipping');
      return;
    }

    if (config.MAX_AUTO_EVOLVES_PER_DAY > 0 && evolvesToday >= config.MAX_AUTO_EVOLVES_PER_DAY) {
      logger.info('auto-evolve', `Daily limit reached (${evolvesToday}/${config.MAX_AUTO_EVOLVES_PER_DAY})`);
      return;
    }

    if (isOpen()) {
      const info = getCircuitBreakerInfo();
      const remainMin = Math.ceil(info.cooldownRemainingMs / 60000);
      logger.info('auto-evolve', `Circuit breaker open, cooldown: ${remainMin} min`);
      // Extend interval when blocked
      currentIntervalMs = Math.min(currentIntervalMs * 2, MAX_INTERVAL_MS);
      return;
    }

    // Pick next goal
    const goal = getNextGoal();
    if (!goal) {
      logger.debug('auto-evolve', 'No pending goals');
      return;
    }

    // Pre-flight viability check: warn if goal has failed before
    if (goal.failCount && goal.failCount > 0) {
      logger.info('auto-evolve', `Retrying goal ${goal.id} (attempt ${goal.failCount + 1}/${3}): ${goal.description.slice(0, 60)}`);
    }

    logger.info('auto-evolve', `Auto-evolving goal: ${goal.id} — ${goal.description}`);

    const result = await executePipeline(goal.id);
    evolvesToday++;

    if (isOk(result)) {
      const hadRealChanges = result.value.filesChanged.length > 0;
      if (hadRealChanges) {
        // Real code evolution — shorten interval (more productive)
        currentIntervalMs = Math.max(currentIntervalMs * 0.75, MIN_INTERVAL_MS);
        logger.info('auto-evolve', `Evolution succeeded (${result.value.filesChanged.length} files), next interval: ${Math.round(currentIntervalMs / 60000)} min`);
      } else {
        // Dispatched to research/skill path — keep interval steady (async result pending)
        logger.info('auto-evolve', `Goal dispatched to alternative path, next interval: ${Math.round(currentIntervalMs / 60000)} min`);
      }
    } else {
      // Failure — lengthen interval (back off)
      currentIntervalMs = Math.min(currentIntervalMs * 1.5, MAX_INTERVAL_MS);
      logger.warn('auto-evolve', `Evolution failed: ${result.error}, next interval: ${Math.round(currentIntervalMs / 60000)} min`);
    }
  } catch (err) {
    logger.error('auto-evolve', 'Unexpected error in auto-evolve cycle', err);
    currentIntervalMs = Math.min(currentIntervalMs * 2, MAX_INTERVAL_MS);
  } finally {
    running = false;
    // Update schedule engine observability entry
    scheduleEngine.reschedule('evolution:auto-evolve', `every:${Math.round(currentIntervalMs / 60000)}m`);
    scheduleEngine.markRun('evolution:auto-evolve', 'success').catch(() => {});
    scheduleNext();
  }
}

/** Schedule the next cycle */
function scheduleNext(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    runCycle().catch((err) => {
      logger.error('auto-evolve', 'Unhandled error in runCycle', err);
      scheduleNext();
    });
  }, currentIntervalMs);
}

/** Start the auto-evolution scheduler */
export function startAutoEvolve(): void {
  logger.info('auto-evolve', `Starting auto-evolution (interval: ${Math.round(currentIntervalMs / 60000)} min)`);
  lastResetDate = todayStr();

  // Register in schedule engine for observability (self-managed — engine won't evaluate)
  scheduleEngine.register({
    id: 'evolution:auto-evolve',
    cronExpr: `every:${Math.round(currentIntervalMs / 60000)}m`,
    executor: { type: 'callback', fn: () => {} }, // No-op — self-managed timer
    enabled: true, lastRun: null, source: 'evolution',
    selfManaged: true,
    meta: { description: 'Adaptive auto-evolution (self-managed timer)' },
  });

  scheduleNext();
}

/** Stop the auto-evolution scheduler */
export function stopAutoEvolve(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  scheduleEngine.unregister('evolution:auto-evolve');
  logger.info('auto-evolve', 'Auto-evolution stopped');
}

/** Check if auto-evolution is active */
export function isAutoEvolveActive(): boolean {
  return timer !== null;
}

/** Get auto-evolution status */
export function getAutoEvolveStatus(): {
  active: boolean;
  evolvesToday: number;
  maxPerDay: number;
  currentIntervalMin: number;
  running: boolean;
} {
  return {
    active: timer !== null,
    evolvesToday,
    maxPerDay: config.MAX_AUTO_EVOLVES_PER_DAY,
    currentIntervalMin: Math.round(currentIntervalMs / 60000),
    running,
  };
}

/** Trigger an immediate evolution cycle (bypasses timer) */
export async function triggerNow(): Promise<void> {
  await runCycle();
}
