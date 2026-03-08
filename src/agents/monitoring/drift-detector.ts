/**
 * Concept Drift Detector — Page-Hinkley Test for agent performance metrics.
 *
 * Detects gradual shifts in agent behavior that Z-score anomaly detection misses.
 * Z-scores catch point anomalies (single spikes), but not slow drift where the
 * mean itself moves — e.g., avgConfidence drifting 0.85→0.65 over two weeks,
 * each daily value within 1σ of its neighbors.
 *
 * Page-Hinkley test tracks cumulative deviation from the running mean:
 *   m_T = Σ(x_i - x̄_T - δ)
 *   Drift detected when max(m) - m_T > λ
 *
 * Where δ (tolerance) absorbs natural noise and λ (threshold) sets sensitivity.
 *
 * Design:
 *   - Stateless per call: takes an array of TrendPoints, returns drift analysis
 *   - No persistence needed — recomputed from daily snapshots on each query
 *   - Operates on cost, confidence, and failure metrics independently
 */

import type { TrendPoint } from './stats-snapshot.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DriftResult {
  /** Which metric was tested */
  metric: string;
  /** Whether drift was detected */
  detected: boolean;
  /** Index in the series where drift was first detected (-1 if none) */
  changePoint: number;
  /** Page-Hinkley statistic at detection point */
  phStatistic: number;
  /** Direction of drift: 'increase' means metric is rising, 'decrease' means falling */
  direction: 'increase' | 'decrease' | 'none';
  /** Human-readable summary */
  summary: string;
}

export interface DriftConfig {
  /** Tolerance parameter δ — absorbs noise below this magnitude (default: 0.01) */
  delta: number;
  /** Detection threshold λ — lower = more sensitive (default: 5) */
  lambda: number;
  /** Minimum data points before drift detection activates (default: 5) */
  minSamples: number;
}

const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  delta: 0.01,
  lambda: 5,
  minSamples: 5,
};

// ── Per-metric config overrides ──────────────────────────────────────

const METRIC_CONFIGS: Record<string, Partial<DriftConfig>> = {
  cost: { delta: 0.05, lambda: 3 },       // Cost drift: moderate sensitivity
  confidence: { delta: 0.02, lambda: 4 },  // Confidence: tighter tolerance
  failures: { delta: 0.5, lambda: 5 },     // Failures: wider tolerance (integer counts)
  handoffFeedbackRate: { delta: 0.1, lambda: 4 },  // Feedback-to-handoff ratio
  durationCv: { delta: 0.05, lambda: 4 },           // Task duration stability
};

// ── Core Algorithm ───────────────────────────────────────────────────

/**
 * Run Page-Hinkley test on a time series.
 *
 * Tests for both upward and downward drift, returns the more significant one.
 */
export function pageHinkleyTest(
  points: TrendPoint[],
  metric: string,
  config?: Partial<DriftConfig>,
): DriftResult {
  const cfg = {
    ...DEFAULT_DRIFT_CONFIG,
    ...METRIC_CONFIGS[metric],
    ...config,
  };

  const noDrift: DriftResult = {
    metric,
    detected: false,
    changePoint: -1,
    phStatistic: 0,
    direction: 'none',
    summary: `No drift detected in ${metric}`,
  };

  if (points.length < cfg.minSamples) {
    noDrift.summary = `Insufficient data for ${metric} drift detection (${points.length}/${cfg.minSamples} samples)`;
    return noDrift;
  }

  const values = points.map(p => p.value);

  // Test both directions, return the one that triggers (or the stronger signal)
  const upDrift = testOneDirection(values, cfg.delta, cfg.lambda, 'increase');
  const downDrift = testOneDirection(values, cfg.delta, cfg.lambda, 'decrease');

  // Pick the direction with stronger signal (or the one that detected)
  let result: { detected: boolean; changePoint: number; statistic: number; direction: 'increase' | 'decrease' };

  if (upDrift.detected && !downDrift.detected) {
    result = { ...upDrift, direction: 'increase' };
  } else if (downDrift.detected && !upDrift.detected) {
    result = { ...downDrift, direction: 'decrease' };
  } else if (upDrift.detected && downDrift.detected) {
    // Both detected — pick earlier change point
    result = upDrift.changePoint <= downDrift.changePoint
      ? { ...upDrift, direction: 'increase' }
      : { ...downDrift, direction: 'decrease' };
  } else {
    return noDrift;
  }

  const changeDate = points[result.changePoint]?.date ?? 'unknown';

  return {
    metric,
    detected: true,
    changePoint: result.changePoint,
    phStatistic: result.statistic,
    direction: result.direction,
    summary: `Drift detected in ${metric}: ${result.direction} starting around ${changeDate} (PH=${result.statistic.toFixed(2)})`,
  };
}

/**
 * Test for drift in one direction using Page-Hinkley.
 *
 * For 'increase': detects upward shift (m_T = Σ(x_i - x̄_T - δ))
 * For 'decrease': detects downward shift (m_T = Σ(x̄_T - x_i - δ))
 */
function testOneDirection(
  values: number[],
  delta: number,
  lambda: number,
  direction: 'increase' | 'decrease',
): { detected: boolean; changePoint: number; statistic: number } {
  const n = values.length;
  let cumulativeSum = 0;
  let minOrMax = 0; // tracks min for increase, max for decrease
  let runningSum = 0;
  let changePoint = -1;
  let maxStatistic = 0;

  for (let i = 0; i < n; i++) {
    runningSum += values[i]!;
    const runningMean = runningSum / (i + 1);

    if (direction === 'increase') {
      // Detect upward drift: accumulate positive deviations
      cumulativeSum += values[i]! - runningMean - delta;
      minOrMax = Math.min(minOrMax, cumulativeSum);
      const statistic = cumulativeSum - minOrMax;

      if (statistic > maxStatistic) {
        maxStatistic = statistic;
        changePoint = i;
      }

      if (statistic > lambda) {
        return { detected: true, changePoint, statistic };
      }
    } else {
      // Detect downward drift: accumulate negative deviations
      cumulativeSum += runningMean - values[i]! - delta;
      minOrMax = Math.min(minOrMax, cumulativeSum);
      const statistic = cumulativeSum - minOrMax;

      if (statistic > maxStatistic) {
        maxStatistic = statistic;
        changePoint = i;
      }

      if (statistic > lambda) {
        return { detected: true, changePoint, statistic };
      }
    }
  }

  return { detected: false, changePoint: -1, statistic: maxStatistic };
}

// ── Batch Analysis ───────────────────────────────────────────────────

export interface AgentDriftReport {
  agentName: string;
  drifts: DriftResult[];
  hasDrift: boolean;
}

/**
 * Run drift detection on agent metrics (cost, confidence, failures + coordination).
 */
export function detectAgentDrift(
  agentName: string,
  costTrend: TrendPoint[],
  confidenceTrend: TrendPoint[],
  failureTrend: TrendPoint[],
  handoffFeedbackRateTrend?: TrendPoint[],
  durationCvTrend?: TrendPoint[],
): AgentDriftReport {
  const drifts = [
    pageHinkleyTest(costTrend, 'cost'),
    pageHinkleyTest(confidenceTrend, 'confidence'),
    pageHinkleyTest(failureTrend, 'failures'),
  ];

  if (handoffFeedbackRateTrend?.length) {
    drifts.push(pageHinkleyTest(handoffFeedbackRateTrend, 'handoffFeedbackRate'));
  }
  if (durationCvTrend?.length) {
    drifts.push(pageHinkleyTest(durationCvTrend, 'durationCv'));
  }

  return {
    agentName,
    drifts,
    hasDrift: drifts.some(d => d.detected),
  };
}
