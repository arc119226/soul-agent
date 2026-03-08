/**
 * Unified Kill Switch — global anomaly detection and safety mode control.
 *
 * Operates as an overlay on top of the lifecycle state machine, without
 * modifying state-machine.ts. Other modules observe the safety level via
 * EventBus ('safety:level_changed') and adjust their behaviour accordingly.
 *
 * Safety levels:
 *   NORMAL     — everything runs normally
 *   RESTRICTED — background agents and evolution are paused; bot still responds
 *   EMERGENCY  — only /restart and /shutdown are accepted
 *
 * Auto-recovery:
 *   RESTRICTED → NORMAL    after 6 consecutive clean ticks (30 min)
 *   EMERGENCY  → RESTRICTED after 3 consecutive clean ticks (15 min)
 */

import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { ANOMALY_THRESHOLDS } from './anomaly-thresholds.js';

/* ── types ─────────────────────────────────── */
export enum SafetyLevel {
  NORMAL = 'normal',
  RESTRICTED = 'restricted',
  EMERGENCY = 'emergency',
}

export interface AnomalyReport {
  type: string;
  message: string;
  timestamp: number;
  suggestedLevel: SafetyLevel;
}

/* ── thresholds & constants ───────────────────── */
const RSS_CRITICAL_MB = 768;
const RSS_HIGH_MB = 512;
const ELU_SATURATED_THRESHOLD = 0.8;
const EMERGENCY_RECOVERY_TICKS = 3;   // 15 min (tick=5min)
const RESTRICTED_RECOVERY_TICKS = 6;  // 30 min
const ZSCORE_EMERGENCY = ANOMALY_THRESHOLDS.EMERGENCY;
const ZSCORE_RESTRICTED = ANOMALY_THRESHOLDS.RESTRICTED;
const MAX_ANOMALY_HISTORY = 50;

/* ── state (in-memory only, resets on restart) ── */
let currentLevel: SafetyLevel = SafetyLevel.NORMAL;
let levelChangedAt: number = Date.now();
let consecutiveCleanTicks = 0;
const recentAnomalies: AnomalyReport[] = [];

/* ── anomaly detection counters (sliding window) ── */
interface SlidingWindow {
  timestamps: number[];
  windowMs: number;
  threshold: number;
}

const apiCallWindow: SlidingWindow = {
  timestamps: [],
  windowMs: 5 * 60 * 1000, // 5 minutes
  threshold: 50,
};

const failureWindow: SlidingWindow = {
  timestamps: [],
  windowMs: 10 * 60 * 1000, // 10 minutes
  threshold: 5,
};

/* ── sliding window helpers ────────────────── */
function addToWindow(win: SlidingWindow, now: number): void {
  win.timestamps.push(now);
  // Prune old entries
  const cutoff = now - win.windowMs;
  while (win.timestamps.length > 0 && win.timestamps[0]! < cutoff) {
    win.timestamps.shift();
  }
}

function isOverThreshold(win: SlidingWindow): boolean {
  return win.timestamps.length > win.threshold;
}

/* ── public API ────────────────────────────── */

/** Get the current safety level. */
export function getSafetyLevel(): SafetyLevel {
  return currentLevel;
}

/** Check if the bot is in restricted or emergency mode. */
export function isRestricted(): boolean {
  return currentLevel !== SafetyLevel.NORMAL;
}

/** Check if the bot is in full emergency lockdown. */
export function isEmergency(): boolean {
  return currentLevel === SafetyLevel.EMERGENCY;
}

/**
 * Record an API/tool call for rate monitoring.
 * Call this from approval-server or message-handler on each outgoing call.
 */
export function recordApiCall(): void {
  addToWindow(apiCallWindow, Date.now());
}

/**
 * Record a repeated failure (same operation failing consecutively).
 * Call this from evolution pipeline, agent workers, etc.
 */
export function recordFailure(): void {
  addToWindow(failureWindow, Date.now());
}

/**
 * Run anomaly checks. Called by heartbeat on every tick.
 * Returns true if an anomaly was detected.
 */
export async function checkAnomalies(): Promise<boolean> {
  const anomalies: AnomalyReport[] = [];
  const now = Date.now();

  // 1. API call frequency check
  if (isOverThreshold(apiCallWindow)) {
    anomalies.push({
      type: 'api_frequency',
      message: `API 呼叫頻率過高：5 分鐘內 ${apiCallWindow.timestamps.length} 次（閾值 ${apiCallWindow.threshold}）`,
      timestamp: now,
      suggestedLevel: SafetyLevel.RESTRICTED,
    });
  }

  // 2. Repeated failure check
  if (isOverThreshold(failureWindow)) {
    anomalies.push({
      type: 'repeated_failure',
      message: `重複失敗：10 分鐘內 ${failureWindow.timestamps.length} 次（閾值 ${failureWindow.threshold}）`,
      timestamp: now,
      suggestedLevel: SafetyLevel.RESTRICTED,
    });
  }

  // 3. Memory usage check — use RSS absolute value (not heap ratio)
  //    V8 dynamically grows heapTotal to match usage, so heapUsed/heapTotal
  //    ratio is almost always 80-90% and produces false positives.
  //    RSS (Resident Set Size) reflects actual physical memory consumption.
  const memUsage = process.memoryUsage();
  const rssMB = memUsage.rss / (1024 * 1024);

  if (rssMB > RSS_CRITICAL_MB) {
    anomalies.push({
      type: 'memory_critical',
      message: `RSS 記憶體用量過高：${rssMB.toFixed(0)}MB（閾值 ${RSS_CRITICAL_MB}MB）`,
      timestamp: now,
      suggestedLevel: SafetyLevel.EMERGENCY,
    });
  } else if (rssMB > RSS_HIGH_MB) {
    anomalies.push({
      type: 'memory_high',
      message: `RSS 記憶體用量偏高：${rssMB.toFixed(0)}MB（閾值 ${RSS_HIGH_MB}MB）`,
      timestamp: now,
      suggestedLevel: SafetyLevel.RESTRICTED,
    });
  }

  // 4. Event loop saturation check (ELU consistently > 80%)
  try {
    const { getELUAverage } = await import('../lifecycle/elu-monitor.js');
    const eluAvg = getELUAverage();
    if (eluAvg > ELU_SATURATED_THRESHOLD) {
      anomalies.push({
        type: 'event_loop_saturated',
        message: `事件循環利用率過高：${(eluAvg * 100).toFixed(1)}%（閾值 80%）`,
        timestamp: now,
        suggestedLevel: SafetyLevel.RESTRICTED,
      });
    }
  } catch {
    // elu-monitor unavailable — skip check
  }

  // No anomalies → increment clean counter
  if (anomalies.length === 0) {
    consecutiveCleanTicks++;
    await tryAutoRecover();
    return false;
  }

  // Anomalies detected → reset clean counter and escalate
  consecutiveCleanTicks = 0;

  // Keep recent anomalies for debugging (max 50)
  recentAnomalies.push(...anomalies);
  while (recentAnomalies.length > MAX_ANOMALY_HISTORY) recentAnomalies.shift();

  // Escalate to highest suggested level
  const highest = anomalies.reduce<SafetyLevel>((acc, a) => {
    if (a.suggestedLevel === SafetyLevel.EMERGENCY) return SafetyLevel.EMERGENCY;
    if (a.suggestedLevel === SafetyLevel.RESTRICTED && acc !== SafetyLevel.EMERGENCY) {
      return SafetyLevel.RESTRICTED;
    }
    return acc;
  }, SafetyLevel.NORMAL);

  await escalate(highest, anomalies.map((a) => a.message).join('; '));
  return true;
}

async function transitionLevel(
  target: SafetyLevel,
  reason: string,
  logLevel: 'warn' | 'info',
): Promise<void> {
  const from = currentLevel;
  currentLevel = target;
  levelChangedAt = Date.now();

  await logger[logLevel]('KillSwitch', `${from} → ${target}: ${reason}`);
  await eventBus.emit('safety:level_changed', {
    from,
    to: target,
    reason,
    timestamp: levelChangedAt,
  });
}

/**
 * Escalate to a higher safety level. Never downgrades — use tryAutoRecover() for that.
 */
async function escalate(target: SafetyLevel, reason: string): Promise<void> {
  // Only escalate (never downgrade via this function)
  if (target === SafetyLevel.NORMAL) return;
  if (currentLevel === SafetyLevel.EMERGENCY) return; // already at max
  if (currentLevel === SafetyLevel.RESTRICTED && target === SafetyLevel.RESTRICTED) return;

  // Reset clean-tick counter so auto-recovery must re-accumulate from zero.
  // Without this, a prior accumulation of clean ticks could cause instant
  // step-down (e.g. EMERGENCY → RESTRICTED in the same heartbeat tick).
  consecutiveCleanTicks = 0;

  await transitionLevel(target, reason, 'warn');
}

async function stepDown(
  tickThreshold: number,
  target: SafetyLevel,
  reason: string,
): Promise<boolean> {
  if (consecutiveCleanTicks < tickThreshold) return false;
  consecutiveCleanTicks = 0;
  await transitionLevel(target, `Auto-recovery: ${reason}`, 'info');
  return true;
}

/**
 * Auto-recovery: step down safety level after consecutive clean ticks.
 */
async function tryAutoRecover(): Promise<void> {
  if (currentLevel === SafetyLevel.NORMAL) return;

  if (currentLevel === SafetyLevel.EMERGENCY) {
    await stepDown(EMERGENCY_RECOVERY_TICKS, SafetyLevel.RESTRICTED, '連續 15 分鐘無異常，降級至 RESTRICTED');
    return;
  }

  if (currentLevel === SafetyLevel.RESTRICTED) {
    await stepDown(RESTRICTED_RECOVERY_TICKS, SafetyLevel.NORMAL, '連續 30 分鐘無異常，恢復正常');
  }
}

/**
 * Manual override: admin can force-reset to NORMAL via /restart etc.
 */
export async function forceReset(): Promise<void> {
  if (currentLevel === SafetyLevel.NORMAL) return;
  consecutiveCleanTicks = 0;
  await transitionLevel(SafetyLevel.NORMAL, '管理員手動重置', 'info');
}

/** Attach soul integrity mismatch listener. Call once at startup. */
export function attachIntegrityListener(): void {
  eventBus.on('soul:integrity_mismatch', () => {
    recordFailure();
    logger.warn('KillSwitch', 'Soul integrity mismatch recorded as failure');
  });

  eventBus.on('lifecycle:anomaly', async ({ metrics }) => {
    // Tiered Z-score escalation: severity determines response level.
    // Z > 4.5 → EMERGENCY (extreme anomaly, likely attack or critical failure)
    // Z > 3.5 → RESTRICTED (clear anomaly, pause non-essential work)
    // Z ≤ 3.5 → recordFailure (mild anomaly, accumulate toward threshold)
    for (const m of metrics) {
      const absZ = Math.abs(m.zScore);
      if (absZ > ZSCORE_EMERGENCY) {
        await escalate(SafetyLevel.EMERGENCY,
          `Critical anomaly: ${m.metric} Z=${m.zScore.toFixed(1)}`);
      } else if (absZ > ZSCORE_RESTRICTED) {
        await escalate(SafetyLevel.RESTRICTED,
          `Severe anomaly: ${m.metric} Z=${m.zScore.toFixed(1)}`);
      } else {
        recordFailure();
      }
    }
    const names = metrics.map((m: { metric: string; zScore: number }) =>
      `${m.metric}(Z=${m.zScore.toFixed(1)})`).join(', ');
    await logger.warn('KillSwitch', `Statistical anomaly: ${names}`);
  });
}

/** Get recent anomaly reports for diagnostics. */
export function getRecentAnomalies(): AnomalyReport[] {
  return [...recentAnomalies];
}

/** Get status summary for display. */
export function getStatus(): {
  level: SafetyLevel;
  since: string;
  cleanTicks: number;
  recentAnomalyCount: number;
} {
  return {
    level: currentLevel,
    since: new Date(levelChangedAt).toISOString(),
    cleanTicks: consecutiveCleanTicks,
    recentAnomalyCount: recentAnomalies.length,
  };
}
