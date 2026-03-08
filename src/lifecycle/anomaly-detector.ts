/**
 * Anomaly Detector — statistical approach to detecting abnormal system behavior.
 *
 * Instead of fixed thresholds, uses rolling statistics (mean + standard deviation)
 * to compute Z-scores. A Z-score > 2 means the current value is 2 standard
 * deviations above the baseline — likely an anomaly.
 *
 * This complements (not replaces) the fixed-threshold checks in kill-switch.ts.
 * The kill-switch handles absolute safety limits (e.g., RSS > 768MB = always bad),
 * while this module detects relative anomalies (e.g., ELU jumped 5x from baseline).
 *
 * Design:
 *   - Maintains rolling windows per metric (configurable depth)
 *   - Z-score = (current - mean) / stddev
 *   - Minimum sample count before detection activates (avoids cold-start false positives)
 *   - Exposes a unified `detectAnomalies()` that returns all active anomalies
 */

import { readFile } from 'node:fs/promises';
import { logger } from '../core/logger.js';
import { writer } from '../core/debounced-writer.js';
import { ANOMALY_THRESHOLDS } from '../safety/anomaly-thresholds.js';

export interface AnomalyResult {
  metric: string;
  current: number;
  mean: number;
  stddev: number;
  zScore: number;
  isAnomaly: boolean;
}

export interface AnomalyDetectorConfig {
  /** Number of samples in the rolling window (default: 30 = ~2.5 hours at 5-min ticks) */
  windowSize: number;
  /** Z-score threshold above which a value is flagged as anomalous (default: 2.5) */
  zScoreThreshold: number;
  /** Minimum samples before detection activates (default: 6 = 30 min warm-up) */
  minSamples: number;
}

const DEFAULT_CONFIG: AnomalyDetectorConfig = {
  windowSize: 30,
  zScoreThreshold: ANOMALY_THRESHOLDS.NOTICE,
  minSamples: 6,
};

/** Baselines older than 24 hours are considered stale and discarded */
const BASELINE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RollingStatsSnapshot {
  values: number[];
  maxSize: number;
}

class RollingStats {
  private values: number[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.maxSize) {
      this.values.shift();
    }
  }

  get count(): number {
    return this.values.length;
  }

  mean(): number {
    if (this.values.length === 0) return 0;
    const sum = this.values.reduce((a, b) => a + b, 0);
    return sum / this.values.length;
  }

  stddev(): number {
    if (this.values.length < 2) return 0;
    const avg = this.mean();
    const squaredDiffs = this.values.map((v) => (v - avg) ** 2);
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (this.values.length - 1);
    return Math.sqrt(variance);
  }

  zScore(value: number): number {
    const sd = this.stddev();
    const MIN_STDDEV = 0.01; // Prevent false positives from near-zero variance
    if (sd < MIN_STDDEV) return 0; // Variance too low → no meaningful Z-score
    return (value - this.mean()) / sd;
  }

  /** Export internal state for persistence */
  export(): RollingStatsSnapshot {
    return { values: [...this.values], maxSize: this.maxSize };
  }

  /** Restore from a persisted snapshot */
  static fromSnapshot(snap: RollingStatsSnapshot): RollingStats {
    const stats = new RollingStats(snap.maxSize);
    // Only keep the most recent values that fit the window
    const start = Math.max(0, snap.values.length - snap.maxSize);
    stats.values = snap.values.slice(start);
    return stats;
  }
}

export class AnomalyDetector {
  private metrics = new Map<string, RollingStats>();
  private config: AnomalyDetectorConfig;

  constructor(config?: Partial<AnomalyDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a metric sample. Call on every heartbeat tick for each tracked metric.
   */
  record(metric: string, value: number): void {
    if (!this.metrics.has(metric)) {
      this.metrics.set(metric, new RollingStats(this.config.windowSize));
    }
    this.metrics.get(metric)!.push(value);
  }

  /**
   * Check a single metric for anomaly.
   * Returns the analysis result including Z-score and anomaly flag.
   */
  check(metric: string, currentValue: number): AnomalyResult {
    const stats = this.metrics.get(metric);

    if (!stats || stats.count < this.config.minSamples) {
      // Not enough data — cannot detect anomalies yet
      return {
        metric,
        current: currentValue,
        mean: stats?.mean() ?? 0,
        stddev: stats?.stddev() ?? 0,
        zScore: 0,
        isAnomaly: false,
      };
    }

    const mean = stats.mean();
    const stddev = stats.stddev();
    const zScore = stats.zScore(currentValue);

    return {
      metric,
      current: currentValue,
      mean,
      stddev,
      zScore,
      isAnomaly: zScore > this.config.zScoreThreshold,
    };
  }

  /**
   * Detect anomalies across all tracked metrics given current values.
   * Returns only the metrics that are flagged as anomalous.
   */
  detectAnomalies(currentValues: Record<string, number>): AnomalyResult[] {
    const anomalies: AnomalyResult[] = [];

    for (const [metric, value] of Object.entries(currentValues)) {
      // Record the new value
      this.record(metric, value);

      // Check for anomaly
      const result = this.check(metric, value);
      if (result.isAnomaly) {
        anomalies.push(result);
        logger.warn(
          'AnomalyDetector',
          `anomaly detected: ${metric}=${value.toFixed(2)} ` +
          `(mean=${result.mean.toFixed(2)}, stddev=${result.stddev.toFixed(2)}, Z=${result.zScore.toFixed(2)})`,
        );
      }
    }

    return anomalies;
  }

  /**
   * Get a diagnostic summary of all tracked metrics.
   */
  getSummary(): Record<string, { count: number; mean: number; stddev: number }> {
    const summary: Record<string, { count: number; mean: number; stddev: number }> = {};
    for (const [metric, stats] of this.metrics) {
      summary[metric] = {
        count: stats.count,
        mean: Math.round(stats.mean() * 1000) / 1000,
        stddev: Math.round(stats.stddev() * 1000) / 1000,
      };
    }
    return summary;
  }

  /**
   * Reset all tracked data (e.g., on boot).
   */
  reset(): void {
    this.metrics.clear();
  }

  /**
   * Export all baselines for persistence.
   * Returns a serializable object that can be saved to disk.
   */
  exportBaselines(): Record<string, RollingStatsSnapshot> {
    const baselines: Record<string, RollingStatsSnapshot> = {};
    for (const [metric, stats] of this.metrics) {
      baselines[metric] = stats.export();
    }
    return baselines;
  }

  /**
   * Import baselines from a persisted snapshot.
   * Restores rolling window state so detection resumes without warm-up.
   */
  importBaselines(baselines: Record<string, RollingStatsSnapshot>): number {
    let restored = 0;
    for (const [metric, snap] of Object.entries(baselines)) {
      if (snap?.values?.length > 0) {
        this.metrics.set(metric, RollingStats.fromSnapshot(snap));
        restored++;
      }
    }
    return restored;
  }

  /**
   * Save baselines to disk.
   */
  async saveBaselines(path: string): Promise<void> {
    const baselines = this.exportBaselines();
    if (Object.keys(baselines).length === 0) return;
    writer.schedule(path, { savedAt: new Date().toISOString(), baselines });
    logger.debug('AnomalyDetector', `baselines saved (${Object.keys(baselines).length} metrics)`);
  }

  /**
   * Load baselines from disk and restore rolling windows.
   */
  async loadBaselines(path: string): Promise<number> {
    try {
      const content = await readFile(path, 'utf-8');
      const data = JSON.parse(content) as { savedAt: string; baselines: Record<string, RollingStatsSnapshot> };
      if (!data.baselines) return 0;

      // Staleness check: discard baselines older than 24 hours
      if (data.savedAt) {
        const age = Date.now() - new Date(data.savedAt).getTime();
        if (age > BASELINE_MAX_AGE_MS) {
          logger.info('AnomalyDetector', 'Baseline older than 24h, starting fresh');
          return 0;
        }
      }

      const restored = this.importBaselines(data.baselines);
      if (restored > 0) {
        this.config.minSamples = 2; // Historical baseline available, reduce warm-up
        logger.info('AnomalyDetector', `baselines restored: ${restored} metrics from ${data.savedAt} (minSamples=2)`);
      }
      return restored;
    } catch {
      // No baselines file — cold start, will build baselines from scratch
      return 0;
    }
  }
}

/** Singleton instance for global use */
export const anomalyDetector = new AnomalyDetector();
