/**
 * Worker Circuit Breaker — prevents cascade failures when Claude API is degraded.
 *
 * Sits in front of all worker task execution. When too many consecutive
 * transient API failures occur, the breaker opens and fast-fails new tasks
 * (requeueing them with backoff) instead of hammering the overloaded API.
 *
 * States: closed (normal) → open (blocked) → half-open (testing with 1 task)
 *
 * Different thresholds than the evolution circuit breaker:
 *   - Evolution: 3 failures → 6h cooldown (expensive mutations)
 *   - Workers:   5 failures → 30min cooldown (cheaper, more frequent)
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../../core/debounced-writer.js';
import { logger } from '../../core/logger.js';
import { eventBus } from '../../core/event-bus.js';

// ── Constants ────────────────────────────────────────────────────────

const STATE_FILE = join(process.cwd(), 'data', 'worker-circuit-breaker.json');

const FAILURE_THRESHOLD = 5;                    // 5 consecutive transient failures → open
const COOLDOWN_MS = 30 * 60 * 1000;            // 30 min lockout
const HALF_OPEN_MAX_CONCURRENT = 1;            // Allow 1 task through during half-open test

/** Errors that count toward the circuit breaker (API/infra problems, not agent bugs). */
const TRANSIENT_PATTERNS = [
  'rate limit',
  'overloaded',
  '503',
  '529',
  '429',
  'econnreset',
  'socket hang up',
  'claude code is busy',
  'etimedout',
  'worker process terminated unexpectedly',
];

// ── Types ────────────────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open';

interface FailureRecord {
  error: string;
  timestamp: string;
}

interface WorkerCircuitState {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  openedAt: string | null;
  totalFailures: number;
  totalSuccesses: number;
  recentFailures: FailureRecord[];
  halfOpenInFlight: number;
}

// ── State ────────────────────────────────────────────────────────────

let cbState: WorkerCircuitState = {
  state: 'closed',
  consecutiveFailures: 0,
  lastFailureAt: null,
  openedAt: null,
  totalFailures: 0,
  totalSuccesses: 0,
  recentFailures: [],
  halfOpenInFlight: 0,
};

// ── Persistence ──────────────────────────────────────────────────────

function saveState(): void {
  writer.schedule(STATE_FILE, cbState);
}

/** Load circuit breaker state from disk (call once at startup). */
export async function loadWorkerCircuitBreaker(): Promise<void> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    const saved: WorkerCircuitState = JSON.parse(raw);
    cbState = saved;
    cbState.halfOpenInFlight = 0; // Reset in-flight count on restart

    // Check if cooldown has elapsed
    if (cbState.state === 'open' && cbState.openedAt) {
      const elapsed = Date.now() - new Date(cbState.openedAt).getTime();
      if (elapsed >= COOLDOWN_MS) {
        cbState.state = 'half-open';
        saveState();
        logger.info('worker-circuit-breaker', 'Cooldown elapsed on startup, transitioning to half-open');
      }
    }

    logger.info('worker-circuit-breaker', `Loaded: ${cbState.state} (${cbState.consecutiveFailures} consecutive failures)`);
  } catch {
    logger.info('worker-circuit-breaker', 'No existing state, starting closed');
  }
}

// ── Public API ───────────────────────────────────────────────────────

/** Check if a transient error should count toward the circuit breaker. */
function isTransientForCircuit(error: string): boolean {
  const lower = error.toLowerCase();
  return TRANSIENT_PATTERNS.some(p => lower.includes(p));
}

/**
 * Check if the circuit breaker allows execution.
 * Returns true if the task should be fast-failed (circuit is open).
 */
export function isWorkerCircuitOpen(): boolean {
  if (cbState.state === 'closed') return false;

  if (cbState.state === 'open') {
    // Check cooldown
    if (cbState.openedAt) {
      const elapsed = Date.now() - new Date(cbState.openedAt).getTime();
      if (elapsed >= COOLDOWN_MS) {
        cbState.state = 'half-open';
        cbState.halfOpenInFlight = 0;
        saveState();
        logger.info('worker-circuit-breaker', 'Cooldown elapsed, transitioning to half-open');
        return false; // Allow one task through
      }
    }
    return true; // Still in cooldown
  }

  // half-open: allow limited tasks through for testing
  if (cbState.state === 'half-open') {
    if (cbState.halfOpenInFlight >= HALF_OPEN_MAX_CONCURRENT) {
      return true; // Already testing, block others
    }
    cbState.halfOpenInFlight++;
    return false; // Allow this one through as test
  }

  return false;
}

/** Get remaining cooldown in ms (0 if not open). */
export function getCooldownRemainingMs(): number {
  if (cbState.state !== 'open' || !cbState.openedAt) return 0;
  const elapsed = Date.now() - new Date(cbState.openedAt).getTime();
  return Math.max(0, COOLDOWN_MS - elapsed);
}

/** Record a successful task execution. */
export function recordWorkerSuccess(): void {
  cbState.consecutiveFailures = 0;
  cbState.totalSuccesses++;

  if (cbState.state === 'half-open') {
    cbState.state = 'closed';
    cbState.openedAt = null;
    cbState.halfOpenInFlight = 0;
    cbState.recentFailures = [];
    logger.info('worker-circuit-breaker', 'Half-open test succeeded → closed');
  }

  saveState();
}

/** Record a failed task execution. Only transient errors affect the breaker. */
export function recordWorkerFailure(errorMsg: string): void {
  if (!isTransientForCircuit(errorMsg)) return; // Non-transient errors don't trip the breaker

  cbState.consecutiveFailures++;
  cbState.totalFailures++;
  cbState.lastFailureAt = new Date().toISOString();

  cbState.recentFailures.push({
    error: errorMsg.length > 200 ? errorMsg.slice(0, 197) + '...' : errorMsg,
    timestamp: new Date().toISOString(),
  });
  if (cbState.recentFailures.length > 10) {
    cbState.recentFailures.splice(0, cbState.recentFailures.length - 10);
  }

  if (cbState.state === 'half-open') {
    cbState.state = 'open';
    cbState.openedAt = new Date().toISOString();
    cbState.halfOpenInFlight = 0;
    logger.warn('worker-circuit-breaker', 'Half-open test failed → open again');
  } else if (cbState.consecutiveFailures >= FAILURE_THRESHOLD) {
    cbState.state = 'open';
    cbState.openedAt = new Date().toISOString();
    const cooldownMin = Math.round(COOLDOWN_MS / 60000);
    logger.warn('worker-circuit-breaker',
      `${cbState.consecutiveFailures} consecutive transient failures → OPEN (blocked for ${cooldownMin} min)`);

    // Emit event for monitoring
    eventBus.emit('worker:circuit-open', {
      consecutiveFailures: cbState.consecutiveFailures,
      cooldownMs: COOLDOWN_MS,
    }).catch(() => {});
  }

  saveState();
  logger.info('worker-circuit-breaker', `Transient failure recorded (consecutive: ${cbState.consecutiveFailures})`);
}

/** Get current state for diagnostics (/status). */
export function getWorkerCircuitInfo(): WorkerCircuitState & { cooldownRemainingMs: number } {
  return {
    ...cbState,
    cooldownRemainingMs: getCooldownRemainingMs(),
  };
}

/** Force reset (admin command). */
export function forceResetWorkerCircuit(): void {
  cbState.state = 'closed';
  cbState.consecutiveFailures = 0;
  cbState.lastFailureAt = null;
  cbState.openedAt = null;
  cbState.halfOpenInFlight = 0;
  cbState.recentFailures = [];
  saveState();
  logger.warn('worker-circuit-breaker', 'Force reset to closed');
}
