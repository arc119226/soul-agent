/**
 * Circuit breaker — blocks evolution after consecutive failures.
 * States: closed (normal) → open (blocked) → half-open (testing).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { ANOMALY_THRESHOLDS } from '../safety/anomaly-thresholds.js';

const STATE_FILE = join(process.cwd(), 'data', 'circuit-breaker.json');

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours — longer cooldown to avoid wasting resources

/**
 * Z-score enhanced threshold:
 * When evolution anomaly Z-score > Z_SCORE_ALERT_THRESHOLD, the circuit breaker
 * opens after fewer consecutive failures (ANOMALY_FAILURE_THRESHOLD instead of FAILURE_THRESHOLD).
 * This makes the breaker more sensitive when the system is already in a degraded state.
 */
const Z_SCORE_ALERT_THRESHOLD = ANOMALY_THRESHOLDS.WARNING;
const ANOMALY_FAILURE_THRESHOLD = 2;

type CircuitState = 'closed' | 'open' | 'half-open';

export type FailureType = 'type-check' | 'test-failure' | 'runtime' | 'timeout' | 'validation' | 'unknown';

interface FailureRecord {
  type: FailureType;
  message: string;
  timestamp: string;
}

interface CircuitBreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  openedAt: string | null;
  totalFailures: number;
  totalSuccesses: number;
  recentFailures: FailureRecord[];
}

let cbState: CircuitBreakerState = {
  state: 'closed',
  consecutiveFailures: 0,
  lastFailureAt: null,
  openedAt: null,
  totalFailures: 0,
  totalSuccesses: 0,
  recentFailures: [],
};

/** Load circuit breaker state from disk */
export async function loadCircuitBreaker(): Promise<void> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    const saved: CircuitBreakerState = JSON.parse(raw);
    cbState = saved;

    // Check if cooldown has elapsed and we should transition to half-open
    if (cbState.state === 'open' && cbState.openedAt) {
      const elapsed = Date.now() - new Date(cbState.openedAt).getTime();
      if (elapsed >= COOLDOWN_MS) {
        cbState.state = 'half-open';
        saveState();
        logger.info('circuit-breaker', 'Cooldown elapsed, transitioning to half-open');
      }
    }

    logger.info('circuit-breaker', `Loaded state: ${cbState.state} (${cbState.consecutiveFailures} consecutive failures)`);
  } catch {
    logger.info('circuit-breaker', 'No existing circuit breaker state, starting closed');
  }
}

function saveState(): void {
  writer.schedule(STATE_FILE, cbState);
}

/** Record a successful evolution */
export function recordSuccess(): void {
  cbState.consecutiveFailures = 0;
  cbState.totalSuccesses++;
  cbState.lastFailureAt = null;

  if (cbState.state === 'half-open') {
    cbState.state = 'closed';
    cbState.openedAt = null;
    logger.info('circuit-breaker', 'Half-open succeeded, transitioning to closed');
  }

  // Clear recent failures on success streak
  if (cbState.consecutiveFailures === 0) {
    cbState.recentFailures = [];
  }

  saveState();
  logger.info('circuit-breaker', `Success recorded (total: ${cbState.totalSuccesses})`);
}

/** Classify a failure error message into a FailureType */
export function classifyFailure(errorMsg: string): FailureType {
  const lower = errorMsg.toLowerCase();
  if (lower.includes('type check') || lower.includes('tsc') || lower.includes('ts2')) return 'type-check';
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) return 'timeout';
  if (lower.includes('validation') || lower.includes('soul-guard') || lower.includes('layered')) return 'validation';
  if (lower.includes('test') && (lower.includes('failed') || lower.includes('failure'))) return 'test-failure';
  if (lower.includes('runtime') || lower.includes('error:') || lower.includes('throw')) return 'runtime';
  return 'unknown';
}

/**
 * Check evolution metrics Z-scores to determine if the system is in an anomalous state.
 * Used to dynamically lower the failure threshold when evolution health is degraded.
 * Returns the effective threshold (lower when anomaly detected, standard otherwise).
 */
async function getEffectiveThreshold(): Promise<number> {
  try {
    const { getRecentMetrics, computeZScores } = await import('./evolution-metrics.js');
    const metrics = await getRecentMetrics();
    if (metrics.length < 5) return FAILURE_THRESHOLD; // Not enough data

    const zScores = computeZScores(metrics, Z_SCORE_ALERT_THRESHOLD);
    if (zScores.isAnomaly) {
      logger.warn('circuit-breaker', `Evolution anomaly detected: ${zScores.message} — lowering threshold to ${ANOMALY_FAILURE_THRESHOLD}`);
      return ANOMALY_FAILURE_THRESHOLD;
    }
    return FAILURE_THRESHOLD;
  } catch {
    return FAILURE_THRESHOLD; // Fallback to static threshold
  }
}

/** Record a failed evolution with classification */
export function recordFailure(errorMsg?: string): void {
  cbState.consecutiveFailures++;
  cbState.totalFailures++;
  cbState.lastFailureAt = new Date().toISOString();

  // Classify and record failure details
  if (errorMsg) {
    const failureType = classifyFailure(errorMsg);
    cbState.recentFailures.push({
      type: failureType,
      message: errorMsg.length > 200 ? errorMsg.slice(0, 197) + '...' : errorMsg,
      timestamp: new Date().toISOString(),
    });
    // Keep only last 10 failures
    if (cbState.recentFailures.length > 10) {
      cbState.recentFailures.splice(0, cbState.recentFailures.length - 10);
    }
  }

  if (cbState.state === 'half-open') {
    // Failed during test phase — go back to open
    cbState.state = 'open';
    cbState.openedAt = new Date().toISOString();
    logger.warn('circuit-breaker', 'Half-open test failed, returning to open');
  } else if (cbState.consecutiveFailures >= FAILURE_THRESHOLD) {
    // Hard limit always applies (3 failures = open regardless of Z-score)
    cbState.state = 'open';
    cbState.openedAt = new Date().toISOString();
    logger.warn('circuit-breaker', `${FAILURE_THRESHOLD} consecutive failures, circuit OPEN (blocked for ${COOLDOWN_MS / 60000} min)`);
  } else {
    // Z-score enhanced check: open earlier if evolution health is degraded
    // Run async — if anomaly threshold is lower and we've hit it, open immediately
    getEffectiveThreshold().then((threshold) => {
      if (threshold < FAILURE_THRESHOLD && cbState.consecutiveFailures >= threshold && cbState.state !== 'open') {
        cbState.state = 'open';
        cbState.openedAt = new Date().toISOString();
        saveState();
        logger.warn('circuit-breaker', `Z-score enhanced: ${cbState.consecutiveFailures} failures + anomaly detected, circuit OPEN early`);
      }
    }).catch(() => { /* non-critical */ });
  }

  saveState();
  logger.info('circuit-breaker', `Failure recorded (consecutive: ${cbState.consecutiveFailures})`);
}

/** Get recent failure history for strategy building */
export function getRecentFailures(): FailureRecord[] {
  return [...cbState.recentFailures];
}

/** Check if the circuit breaker is open (evolution should be blocked) */
export function isOpen(): boolean {
  if (cbState.state !== 'open') return false;

  // Check if cooldown has elapsed
  if (cbState.openedAt) {
    const elapsed = Date.now() - new Date(cbState.openedAt).getTime();
    if (elapsed >= COOLDOWN_MS) {
      cbState.state = 'half-open';
      saveState();
      logger.info('circuit-breaker', 'Cooldown elapsed, transitioning to half-open');
      return false;
    }
  }

  return true;
}

/** Get current state */
export function getState(): CircuitState {
  // Trigger cooldown check
  if (cbState.state === 'open') isOpen();
  return cbState.state;
}

/** Get full state info for diagnostics */
export function getCircuitBreakerInfo(): CircuitBreakerState & { cooldownRemainingMs: number } {
  let cooldownRemainingMs = 0;
  if (cbState.state === 'open' && cbState.openedAt) {
    const elapsed = Date.now() - new Date(cbState.openedAt).getTime();
    cooldownRemainingMs = Math.max(0, COOLDOWN_MS - elapsed);
  }
  return { ...cbState, cooldownRemainingMs };
}

/** Get evolution health summary (for /status display) */
export async function getEvolutionHealth(): Promise<{
  state: CircuitState;
  consecutiveFailures: number;
  effectiveThreshold: number;
  anomalyDetected: boolean;
  failureRateZ: number;
  durationZ: number;
}> {
  let effectiveThreshold = FAILURE_THRESHOLD;
  let anomalyDetected = false;
  let failureRateZ = 0;
  let durationZ = 0;

  try {
    const { getRecentMetrics, computeZScores } = await import('./evolution-metrics.js');
    const metrics = await getRecentMetrics();
    if (metrics.length >= 5) {
      const zScores = computeZScores(metrics);
      failureRateZ = zScores.failureRateZ;
      durationZ = zScores.durationZ;
      anomalyDetected = zScores.isAnomaly;
      if (anomalyDetected) effectiveThreshold = ANOMALY_FAILURE_THRESHOLD;
    }
  } catch { /* non-critical */ }

  return {
    state: getState(),
    consecutiveFailures: cbState.consecutiveFailures,
    effectiveThreshold,
    anomalyDetected,
    failureRateZ: Math.round(failureRateZ * 100) / 100,
    durationZ: Math.round(durationZ * 100) / 100,
  };
}

/** Force reset the circuit breaker (admin action) */
export function forceReset(): void {
  cbState.state = 'closed';
  cbState.consecutiveFailures = 0;
  cbState.lastFailureAt = null;
  cbState.openedAt = null;
  saveState();
  logger.warn('circuit-breaker', 'Force reset to closed');
}
