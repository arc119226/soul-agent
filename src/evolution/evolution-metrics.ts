/**
 * Evolution Metrics Collector — tracks success/failure/duration of evolution runs.
 *
 * Feeds statistical anomaly detection for the circuit breaker.
 * Metrics are persisted to data/evolution-metrics.jsonl (append-only, 24h window).
 *
 * Design:
 *   - Each evolution run records: timestamp, goalId, success, duration, failedStep, filesChanged
 *   - getRecentMetrics() reads the window and computes failure rate + duration stats
 *   - computeZScores() returns Z-scores for failure rate and average duration
 *   - The circuit breaker consults these Z-scores to dynamically adjust its threshold
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';

const METRICS_FILE = join(process.cwd(), 'data', 'evolution-metrics.jsonl');

/** Default rolling window: 7 days of evolution history */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum data points before Z-score computation is meaningful */
const MIN_DATA_POINTS = 5;

export interface EvolutionMetric {
  timestamp: string;
  goalId: string;
  success: boolean;
  duration: number;
  failedStep?: string;
  filesChanged: number;
}

export interface EvolutionStats {
  total: number;
  successes: number;
  failures: number;
  failureRate: number;
  avgDuration: number;
  stddevDuration: number;
}

export interface EvolutionZScores {
  /** Z-score of current failure rate vs historical baseline */
  failureRateZ: number;
  /** Z-score of recent average duration vs historical baseline */
  durationZ: number;
  /** Whether the system is in an anomalous state */
  isAnomaly: boolean;
  /** Human-readable summary */
  message: string;
}

/**
 * Record an evolution metric (append to JSONL).
 */
export async function recordEvolutionMetric(metric: EvolutionMetric): Promise<void> {
  try {
    await writer.appendJsonl(METRICS_FILE, metric);
    logger.debug('EvolutionMetrics', `recorded: ${metric.success ? 'success' : 'fail'} ${metric.goalId} (${metric.duration}ms)`);
  } catch (err) {
    logger.warn('EvolutionMetrics', `failed to record metric: ${err}`);
  }
}

/**
 * Read evolution metrics within a time window.
 */
export async function getRecentMetrics(windowMs = DEFAULT_WINDOW_MS): Promise<EvolutionMetric[]> {
  try {
    const content = await readFile(METRICS_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - windowMs;

    const metrics: EvolutionMetric[] = [];
    for (const line of lines) {
      try {
        const metric = JSON.parse(line) as EvolutionMetric;
        if (new Date(metric.timestamp).getTime() > cutoff) {
          metrics.push(metric);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return metrics;
  } catch {
    // File doesn't exist yet
    return [];
  }
}

/**
 * Compute aggregate stats from a list of metrics.
 */
export function computeStats(metrics: EvolutionMetric[]): EvolutionStats {
  if (metrics.length === 0) {
    return { total: 0, successes: 0, failures: 0, failureRate: 0, avgDuration: 0, stddevDuration: 0 };
  }

  const successes = metrics.filter((m) => m.success).length;
  const failures = metrics.length - successes;
  const failureRate = failures / metrics.length;

  const durations = metrics.map((m) => m.duration);
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const variance = durations.length > 1
    ? durations.reduce((sum, d) => sum + (d - avgDuration) ** 2, 0) / (durations.length - 1)
    : 0;
  const stddevDuration = Math.sqrt(variance);

  return { total: metrics.length, successes, failures, failureRate, avgDuration, stddevDuration };
}

/**
 * Compute Z-scores for evolution health.
 *
 * Splits the data into baseline (older 70%) and recent (newer 30%).
 * Compares recent failure rate and duration against baseline.
 */
export function computeZScores(metrics: EvolutionMetric[], zThreshold = 3.0): EvolutionZScores {
  if (metrics.length < MIN_DATA_POINTS) {
    return {
      failureRateZ: 0,
      durationZ: 0,
      isAnomaly: false,
      message: `Insufficient data (${metrics.length}/${MIN_DATA_POINTS})`,
    };
  }

  // Sort by timestamp ascending
  const sorted = [...metrics].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Split: baseline = older 70%, recent = newer 30%
  const splitIdx = Math.max(1, Math.floor(sorted.length * 0.7));
  const baseline = sorted.slice(0, splitIdx);
  const recent = sorted.slice(splitIdx);

  if (recent.length === 0 || baseline.length < 2) {
    return {
      failureRateZ: 0,
      durationZ: 0,
      isAnomaly: false,
      message: 'Insufficient baseline/recent split',
    };
  }

  // --- Failure rate Z-score ---
  // Use binomial proportion with Laplace smoothing to avoid zero-variance edge case
  // (when baseline is 100% success or 100% failure, raw stdErr = 0)
  const baselineFailCount = baseline.filter((m) => !m.success).length;
  const smoothedBaseline = (baselineFailCount + 0.5) / (baseline.length + 1);
  const recentFailRate = recent.filter((m) => !m.success).length / recent.length;
  const failStdErr = Math.sqrt(
    (smoothedBaseline * (1 - smoothedBaseline)) / (baseline.length + 1),
  );
  const failureRateZ = failStdErr > 0
    ? (recentFailRate - smoothedBaseline) / failStdErr
    : 0;

  // --- Duration Z-score ---
  const baselineDurations = baseline.map((m) => m.duration);
  const recentDurations = recent.map((m) => m.duration);
  const baselineAvgDur = baselineDurations.reduce((a, b) => a + b, 0) / baselineDurations.length;
  const baselineVarDur = baselineDurations.length > 1
    ? baselineDurations.reduce((s, d) => s + (d - baselineAvgDur) ** 2, 0) / (baselineDurations.length - 1)
    : 0;
  const baselineStdDur = Math.sqrt(baselineVarDur);
  const recentAvgDur = recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length;
  // When stddev is 0 (all identical durations), use 10% of mean as floor
  const effectiveStdDur = baselineStdDur > 0 ? baselineStdDur : baselineAvgDur * 0.1;
  const durationZ = effectiveStdDur > 0
    ? (recentAvgDur - baselineAvgDur) / effectiveStdDur
    : 0;

  const isAnomaly = failureRateZ > zThreshold || durationZ > zThreshold;

  const parts: string[] = [];
  if (failureRateZ > zThreshold) {
    parts.push(`failure rate Z=${failureRateZ.toFixed(2)} (recent ${(recentFailRate * 100).toFixed(0)}% vs baseline ${(smoothedBaseline * 100).toFixed(0)}%)`);
  }
  if (durationZ > zThreshold) {
    parts.push(`duration Z=${durationZ.toFixed(2)} (recent ${Math.round(recentAvgDur)}ms vs baseline ${Math.round(baselineAvgDur)}ms)`);
  }

  const message = isAnomaly
    ? `ANOMALY: ${parts.join('; ')}`
    : `Normal (failZ=${failureRateZ.toFixed(2)}, durZ=${durationZ.toFixed(2)})`;

  return { failureRateZ, durationZ, isAnomaly, message };
}
