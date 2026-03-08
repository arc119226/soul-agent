/**
 * Cost Anomaly Detector — Z-score alerting for per-agent cost spikes.
 *
 * Listens to `cost:incurred` events and maintains per-agent rolling windows.
 * When an agent's cost Z-score exceeds WARNING (3.0), emits an alert.
 * When it exceeds RESTRICTED (3.5), auto-pauses the agent via `pauseUntil`.
 *
 * Uses the same Z-score / rolling-window pattern as anomaly-detector.ts
 * but specialized for cost data with per-agent granularity.
 */

import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../core/logger.js';
import { ANOMALY_THRESHOLDS } from '../../safety/anomaly-thresholds.js';

// ── Constants ────────────────────────────────────────────────────────

/** Rolling window: 30 cost events per agent (~2-3 days at typical volumes). */
const WINDOW_SIZE = 30;

/** Minimum samples before alerting (avoid false positives on cold start). */
const MIN_SAMPLES = 5;

/** Auto-pause duration when Z-score exceeds RESTRICTED. */
const PAUSE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Rolling Stats (lightweight, per-agent) ───────────────────────────

class RollingCostStats {
  private values: number[] = [];

  push(value: number): void {
    this.values.push(value);
    if (this.values.length > WINDOW_SIZE) this.values.shift();
  }

  get count(): number {
    return this.values.length;
  }

  mean(): number {
    if (this.values.length === 0) return 0;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }

  stddev(): number {
    if (this.values.length < 2) return 0;
    const avg = this.mean();
    const variance = this.values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (this.values.length - 1);
    return Math.sqrt(variance);
  }

  zScore(value: number): number {
    const sd = this.stddev();
    if (sd < 0.001) return 0; // Near-zero variance → no meaningful Z-score
    return (value - this.mean()) / sd;
  }
}

// ── State ────────────────────────────────────────────────────────────

const agentWindows = new Map<string, RollingCostStats>();
let listenerAttached = false;

// ── Public API ───────────────────────────────────────────────────────

export interface CostAnomalyInfo {
  agentName: string;
  costUsd: number;
  zScore: number;
  mean: number;
  stddev: number;
  action: 'none' | 'alert' | 'pause';
}

/**
 * Attach the cost anomaly listener to the event bus.
 * Call once during startup (phase 3).
 */
export function attachCostAnomalyDetector(): void {
  if (listenerAttached) return;

  eventBus.on('cost:incurred', handleCostEvent);
  listenerAttached = true;
  logger.info('CostAnomaly', 'Cost anomaly detector attached');
}

/**
 * Detach the listener (for shutdown / tests).
 */
export function detachCostAnomalyDetector(): void {
  if (!listenerAttached) return;
  eventBus.off('cost:incurred', handleCostEvent);
  listenerAttached = false;
}

/**
 * Get current anomaly info for a specific agent (for diagnostics).
 */
export function getAgentCostStats(agentName: string): {
  samples: number;
  mean: number;
  stddev: number;
} | null {
  const stats = agentWindows.get(agentName);
  if (!stats) return null;
  return { samples: stats.count, mean: stats.mean(), stddev: stats.stddev() };
}

/**
 * Get all tracked agents and their stats (for dashboard).
 */
export function getAllCostStats(): Record<string, { samples: number; mean: number; stddev: number }> {
  const result: Record<string, { samples: number; mean: number; stddev: number }> = {};
  for (const [name, stats] of agentWindows) {
    result[name] = { samples: stats.count, mean: stats.mean(), stddev: stats.stddev() };
  }
  return result;
}

// ── Internal ─────────────────────────────────────────────────────────

async function handleCostEvent(data: {
  source: 'main' | 'agent';
  agentName?: string;
  costUsd: number;
}): Promise<void> {
  // Only track agent costs (not main chat costs)
  if (data.source !== 'agent' || !data.agentName) return;

  const { agentName, costUsd } = data;

  // Get or create rolling window for this agent
  if (!agentWindows.has(agentName)) {
    agentWindows.set(agentName, new RollingCostStats());
  }
  const stats = agentWindows.get(agentName)!;

  // Compute Z-score BEFORE pushing (compare against existing baseline)
  const zScore = stats.count >= MIN_SAMPLES ? stats.zScore(costUsd) : 0;

  // Record the value into the rolling window
  stats.push(costUsd);

  // Not enough data yet
  if (stats.count < MIN_SAMPLES) return;

  // Check thresholds
  if (zScore > ANOMALY_THRESHOLDS.RESTRICTED) {
    // Auto-pause agent
    await pauseAgent(agentName, costUsd, zScore, stats.mean(), stats.stddev());
  } else if (zScore > ANOMALY_THRESHOLDS.WARNING) {
    // Alert only
    await logger.warn('CostAnomaly',
      `Cost spike: ${agentName} $${costUsd.toFixed(4)} (Z=${zScore.toFixed(2)}, mean=$${stats.mean().toFixed(4)}, σ=$${stats.stddev().toFixed(4)})`);

    eventBus.emit('cost:anomaly', {
      agentName,
      costUsd,
      zScore,
      action: 'alert',
    }).catch(() => {});
  }
}

async function pauseAgent(
  agentName: string,
  costUsd: number,
  zScore: number,
  mean: number,
  stddev: number,
): Promise<void> {
  try {
    const { loadAgentConfig, saveAgentConfig } = await import('../config/agent-config.js');
    const cfg = await loadAgentConfig(agentName);
    if (!cfg) return;

    const pauseUntil = new Date(Date.now() + PAUSE_DURATION_MS).toISOString();
    cfg.pauseUntil = pauseUntil;
    await saveAgentConfig(cfg);

    await logger.warn('CostAnomaly',
      `AUTO-PAUSED ${agentName} until ${pauseUntil}: cost $${costUsd.toFixed(4)} (Z=${zScore.toFixed(2)}, mean=$${mean.toFixed(4)}, σ=$${stddev.toFixed(4)})`);

    eventBus.emit('cost:anomaly', {
      agentName,
      costUsd,
      zScore,
      action: 'pause',
    }).catch(() => {});
  } catch (err) {
    logger.debug('CostAnomaly', `Failed to pause ${agentName}: ${(err as Error).message}`);
  }
}
