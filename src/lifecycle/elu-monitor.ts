/**
 * Event Loop Utilization (ELU) monitor.
 *
 * Provides objective workload measurement using Node.js perf_hooks.
 * Designed to be sampled once per heartbeat tick (5 min intervals).
 *
 * Key concept: ELU measures the fraction of time the event loop spends
 * doing actual work vs idling. A bot with only a heartbeat timer will
 * show ELU ~0.02-0.04 ("basal metabolism"). Heavy agent work pushes
 * it above 0.3.
 */

import { performance } from 'node:perf_hooks';
import { appendSoulJsonl, getSoulPath } from '../core/soul-io.js';
import { tailReadJsonl } from '../core/tail-read.js';
import { logger } from '../core/logger.js';

export interface ELUSnapshot {
  timestamp: number;
  utilization: number; // 0-1
}

const WINDOW_SIZE = 6; // 6 ticks × 5 min = 30 min rolling window
const ELU_JSONL_PATH = 'logs/elu.jsonl';

let previousELU: ReturnType<typeof performance.eventLoopUtilization> | null =
  null;
const history: ELUSnapshot[] = [];

/** Call once at boot to set the ELU baseline and restore history from disk. */
export async function initELU(): Promise<void> {
  previousELU = performance.eventLoopUtilization();

  // Restore previous session's history from persistent storage
  try {
    const restored = await tailReadJsonl<ELUSnapshot>(
      getSoulPath(ELU_JSONL_PATH),
      WINDOW_SIZE,
    );
    if (restored.length > 0) {
      history.push(...restored);
      if (history.length > WINDOW_SIZE) history.splice(0, history.length - WINDOW_SIZE);
      logger.debug('ELU', `Restored ${restored.length} snapshots from disk`);
    }
  } catch {
    // No previous data — cold start is fine
  }
}

/**
 * Sample current ELU — call once per heartbeat tick.
 * Returns the utilization for the period since last sample.
 */
export function sampleELU(): number {
  const current = performance.eventLoopUtilization(previousELU ?? undefined);
  previousELU = performance.eventLoopUtilization();

  const snapshot: ELUSnapshot = {
    timestamp: Date.now(),
    utilization: current.utilization,
  };

  history.push(snapshot);
  if (history.length > WINDOW_SIZE) history.shift();

  // Persist to disk (fire-and-forget, non-blocking)
  appendSoulJsonl(ELU_JSONL_PATH, snapshot).catch(() => {});

  return current.utilization;
}

/** Current utilization from last sample. */
export function getELU(): number {
  if (history.length === 0) return 0;
  return history[history.length - 1]!.utilization;
}

/** Average utilization over the rolling window. */
export function getELUAverage(): number {
  if (history.length === 0) return 0;
  const sum = history.reduce((acc, s) => acc + s.utilization, 0);
  return sum / history.length;
}

/** True when ELU has been below threshold for 3+ consecutive samples (≥15 min). */
export function isSustainedIdle(threshold: number = 0.1): boolean {
  if (history.length < 3) return false;
  return history.every((s) => s.utilization < threshold);
}

/** True when current ELU indicates significant work. */
export function isUnderLoad(threshold: number = 0.3): boolean {
  return getELU() > threshold;
}

/** Get full history for diagnostics. */
export function getELUHistory(): readonly ELUSnapshot[] {
  return history;
}
