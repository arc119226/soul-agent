/**
 * Fatigue Score calculator — quantifies system load into a 0-100 score.
 *
 * Combines three dimensions:
 *   1. ELU (Event Loop Utilization) — CPU pressure (weight: 40%)
 *   2. Memory growth rate — leak detection (weight: 30%)
 *   3. Activity density — event throughput pressure (weight: 30%)
 *
 * Score semantics:
 *   0-30  → Normal (system is healthy)
 *   31-50 → Elevated (approaching throttle threshold)
 *   51-75 → Throttled (should reduce non-essential work)
 *   76+   → Drained (should stop accepting new tasks)
 */

import { getELU, getELUAverage } from './elu-monitor.js';
import { activityMonitor } from './activity-monitor.js';
import { getDailyPhase } from './daily-rhythm.js';
import { logger } from '../core/logger.js';

export interface FatigueMetrics {
  /** Current ELU (0-1) */
  elu: number;
  /** Rolling average ELU (0-1) */
  eluAverage: number;
  /** Heap used in MB */
  heapUsedMB: number;
  /** Heap growth rate in MB/sample */
  heapGrowthRate: number;
  /** Activity events per minute */
  eventsPerMinute: number;
  /** Computed fatigue score (0-100) */
  score: number;
  /** Human-readable level */
  level: FatigueLevel;
}

export type FatigueLevel = 'normal' | 'elevated' | 'throttled' | 'drained';

/** Threshold set for fatigue-driven state transitions */
export interface FatigueThresholdSet {
  /** Score above which system enters throttled mode */
  THROTTLE_ENTER: number;
  /** Score below which system exits throttled mode back to normal */
  THROTTLE_EXIT: number;
  /** Score above which system enters drained mode */
  DRAIN_ENTER: number;
  /** Score below which system exits drained mode (queue must also be empty) */
  DRAIN_EXIT: number;
}

/** Phase-aware thresholds — lower at night so bot degrades more easily */
const THRESHOLDS_BY_PHASE: Record<string, FatigueThresholdSet> = {
  dormant: { THROTTLE_ENTER: 30, THROTTLE_EXIT: 20, DRAIN_ENTER: 50, DRAIN_EXIT: 15 },
  rest:    { THROTTLE_ENTER: 40, THROTTLE_EXIT: 25, DRAIN_ENTER: 60, DRAIN_EXIT: 20 },
  // daytime phases share the original defaults
  default: { THROTTLE_ENTER: 50, THROTTLE_EXIT: 35, DRAIN_ENTER: 75, DRAIN_EXIT: 30 },
};

/**
 * Get fatigue thresholds adjusted for the current daily phase.
 * During night/dormant, thresholds are lower so the bot enters rest more easily.
 */
export function getFatigueThresholds(): FatigueThresholdSet {
  const phase = getDailyPhase();
  return THRESHOLDS_BY_PHASE[phase.phase] ?? THRESHOLDS_BY_PHASE['default']!;
}

/** @deprecated Use getFatigueThresholds() for phase-aware values */
export const FATIGUE_THRESHOLDS = THRESHOLDS_BY_PHASE['default']!;

// ── Internal state for trend detection ──

const HEAP_HISTORY_SIZE = 6; // 6 samples ≈ 30 min at 5-min tick
const heapHistory: number[] = [];

/** Record a heap sample — call once per heartbeat tick */
function sampleHeap(): { heapUsedMB: number; growthRate: number } {
  const heapUsedMB = process.memoryUsage().heapUsed / (1024 * 1024);

  heapHistory.push(heapUsedMB);
  if (heapHistory.length > HEAP_HISTORY_SIZE) heapHistory.shift();

  // Compute growth rate: difference between oldest and newest, divided by samples
  let growthRate = 0;
  if (heapHistory.length >= 2) {
    const oldest = heapHistory[0]!;
    const newest = heapHistory[heapHistory.length - 1]!;
    growthRate = (newest - oldest) / (heapHistory.length - 1);
  }

  return { heapUsedMB, growthRate };
}

/**
 * Calculate the current fatigue score (0-100).
 *
 * Call this on every heartbeat tick to get fresh metrics.
 */
export function calculateFatigue(): FatigueMetrics {
  // 1. ELU dimension (weight: 40%)
  const elu = getELU();
  const eluAverage = getELUAverage();
  // Normalize: ELU 0.85+ is max stress, use average for stability
  const eluScore = Math.min(eluAverage / 0.85, 1) * 40;

  // 2. Memory dimension (weight: 30%)
  const { heapUsedMB, growthRate } = sampleHeap();
  // Growth > 2 MB/sample indicates potential leak
  const memoryScore = growthRate > 2 ? 30 : Math.min(growthRate / 2, 1) * 15;

  // 3. Activity density dimension (weight: 30%)
  const snapshot = activityMonitor.getSnapshot();
  const { eventsPerMinute } = snapshot;
  // 20+ events/min is high throughput for a bot
  const activityScore = Math.min(eventsPerMinute / 20, 1) * 30;

  const rawScore = eluScore + memoryScore + activityScore;
  const score = Math.round(Math.min(rawScore, 100));

  const level = scoreToLevel(score);

  return {
    elu,
    eluAverage,
    heapUsedMB: Math.round(heapUsedMB * 10) / 10,
    heapGrowthRate: Math.round(growthRate * 100) / 100,
    eventsPerMinute: Math.round(eventsPerMinute * 10) / 10,
    score,
    level,
  };
}

function scoreToLevel(score: number): FatigueLevel {
  const t = getFatigueThresholds();
  if (score >= t.DRAIN_ENTER) return 'drained';
  if (score >= t.THROTTLE_ENTER) return 'throttled';
  if (score > t.DRAIN_EXIT) return 'elevated';
  return 'normal';
}

/** Log fatigue metrics at appropriate verbosity */
export function logFatigue(metrics: FatigueMetrics): void {
  const msg = `fatigue=${metrics.score} (${metrics.level}) elu=${(metrics.elu * 100).toFixed(1)}% heap=${metrics.heapUsedMB}MB growth=${metrics.heapGrowthRate}MB/s epm=${metrics.eventsPerMinute}`;

  if (metrics.level === 'drained') {
    logger.warn('FatigueScore', msg);
  } else if (metrics.level === 'throttled') {
    logger.info('FatigueScore', msg);
  } else {
    logger.debug('FatigueScore', msg);
  }
}
