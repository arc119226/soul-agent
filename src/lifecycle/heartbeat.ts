/**
 * Heartbeat engine — periodic tick that drives lifecycle transitions.
 *
 * Integrates three signal sources:
 *   1. Daily rhythm (time of day) — dormant/rest by schedule
 *   2. User interaction — idle detection
 *   3. Fatigue score — graceful degradation under load
 */

import { join } from 'node:path';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { scheduleEngine } from '../core/schedule-engine.js';
import { getCurrentState, getStateDuration, transition } from './state-machine.js';
import { getTimeSinceLastInteraction } from './awareness.js';
import { getDailyPhase } from './daily-rhythm.js';
import { sampleELU, isUnderLoad } from './elu-monitor.js';
import { calculateFatigue, logFatigue, getFatigueThresholds } from './fatigue-score.js';
import { activityMonitor } from './activity-monitor.js';
import { attachCheckpointListener, loadCheckpoint, restoreCheckpoint } from './checkpoint.js';
import { anomalyDetector } from './anomaly-detector.js';
import { attachWakeListeners } from './wake-manager.js';

const DEFAULT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const IDLE_THRESHOLD = 30 * 60 * 1000;  // 30 minutes
const DORMANT_MIN_DURATION = 10 * 60 * 1000; // 10 minutes — hysteresis lock to prevent oscillation
const RESTING_MIN_DURATION = 10 * 60 * 1000; // 10 minutes — prevents resting↔active oscillation
const WAKE_GRACE_PERIOD = 10 * 60 * 1000; // 10 minutes — user interaction grace period during dormant phase

/** Adaptive intervals — lengthen tick rate when resting to conserve resources */
const INTERVAL_ACTIVE = 5 * 60 * 1000;  // 5 min
const INTERVAL_RESTING = 10 * 60 * 1000; // 10 min
const INTERVAL_DORMANT = 15 * 60 * 1000; // 15 min

let timer: ReturnType<typeof setInterval> | null = null;
let intervalMs = DEFAULT_INTERVAL;

const ANOMALY_BASELINES_PATH = join(process.cwd(), 'data', 'anomaly-baselines.json');

/** Tracks when the bot was last woken by user interaction during dormant phase */
let lastUserWakeAt = 0;

// ── Heartbeat periodic tasks (registered in schedule engine) ─────────

async function runAuditWitness(): Promise<void> {
  try {
    const state = getCurrentState();
    const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
    const fpResult = await computeSoulFingerprint();
    if (fpResult.ok) {
      const witnessHashes = { ...fpResult.value.files };
      try {
        const { readFile: rf } = await import('node:fs/promises');
        const narrativeContent = await rf(
          join(process.cwd(), 'soul', 'narrative.jsonl'), 'utf-8',
        );
        const { createHash: ch } = await import('node:crypto');
        witnessHashes['soul/narrative.jsonl'] = ch('sha256').update(narrativeContent).digest('hex');
      } catch {
        // narrative.jsonl may not exist yet
      }
      const { recordWitness } = await import('../safety/audit-chain.js');
      await recordWitness(witnessHashes, state);
      await eventBus.emit('audit:witness', {
        merkleRoot: fpResult.value.hash,
        chainLength: 0,
        state,
      });
    }
  } catch {
    // Audit witness is non-critical
  }

  // Save anomaly detector baselines alongside witness
  try {
    await anomalyDetector.saveBaselines(ANOMALY_BASELINES_PATH);
  } catch {
    // Baseline persistence is non-critical
  }
}

async function runIdentityHealthCheck(): Promise<void> {
  try {
    const state = getCurrentState();
    const { runFullIdentityCheck } = await import('../identity/identity-continuity.js');
    const { setHealthStatus } = await import('../identity/vitals.js');

    const report = await runFullIdentityCheck();
    await setHealthStatus(report.status);

    // Refresh fingerprint baseline
    try {
      const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
      const { setFingerprint } = await import('../identity/vitals.js');
      const fp = await computeSoulFingerprint();
      if (fp.ok) await setFingerprint(fp.value.hash, fp.value.files);
    } catch {
      // Fingerprint refresh is non-critical
    }

    await eventBus.emit('identity:health_check', {
      status: report.status,
      summary: report.summary,
      context: 'heartbeat',
    });

    if (report.status === 'compromised') {
      await logger.error('Heartbeat', `Identity health: COMPROMISED — ${report.summary}`);
      await eventBus.emit('soul:integrity_mismatch', {
        changedFiles: report.layers.filter((l: { status: string; layer: string }) => l.status === 'fail').map((l: { layer: string }) => l.layer),
        expected: 'healthy',
        actual: report.status,
      });
    } else if (report.status === 'degraded') {
      await logger.warn('Heartbeat', `Identity health: degraded — ${report.summary}`);
    }
  } catch {
    // Identity health check is non-critical
  }
}

/**
 * Adjust heartbeat interval based on current state.
 * Dormant/resting states use longer intervals to conserve resources.
 */
function adjustInterval(state: string): void {
  const target =
    state === 'dormant' ? INTERVAL_DORMANT :
    state === 'resting' ? INTERVAL_RESTING :
    INTERVAL_ACTIVE;

  if (target !== intervalMs && timer) {
    intervalMs = target;
    clearInterval(timer);
    timer = setInterval(() => {
      tick().catch((err) => {
        logger.error('Heartbeat', 'tick error', err);
      });
    }, intervalMs);
    logger.info('Heartbeat', `interval adjusted to ${intervalMs / 1000}s (state=${state})`);
  }
}

export async function tick(): Promise<void> {
  // Sample ELU first — measures the interval since last tick
  const elu = sampleELU();
  const eluPct = (elu * 100).toFixed(1);

  // Calculate fatigue score (also samples heap)
  const fatigue = calculateFatigue();
  logFatigue(fatigue);

  let state = getCurrentState();
  const phase = getDailyPhase();
  const activity = activityMonitor.getSnapshot();
  const thresholds = getFatigueThresholds();

  // ── Auto-transition logic FIRST (so heartbeat:tick carries the correct state) ──

  // 1. Deep night → dormant (time takes priority, unless user recently woke us)
  if (phase.phase === 'dormant' && state !== 'dormant') {
    const timeSinceUserWake = Date.now() - lastUserWakeAt;
    if (timeSinceUserWake > WAKE_GRACE_PERIOD) {
      await transition('dormant', 'deep night — entering dormant mode');
      state = getCurrentState();
    }
    // else: user recently interacted — stay awake during grace period
  }

  // 2. Night rest phase — progressive wind-down
  else if (phase.phase === 'rest') {
    if (state === 'active' || state === 'throttled') {
      const idle = getTimeSinceLastInteraction();
      // Only rest if BOTH idle AND ELU confirms low activity
      if (idle > IDLE_THRESHOLD && !isUnderLoad()) {
        await transition('resting', `night time — winding down (ELU: ${eluPct}%)`);
        state = getCurrentState();
      }
    } else if (state === 'resting') {
      // Night rest phase: stay resting — dormant transition deferred to deep_night phase (1:00+)
      // which is handled by the first branch (phase.phase === 'dormant' && state !== 'dormant')
    } else if (state === 'dormant') {
      // Night phase but dormant — stay dormant (don't wake prematurely)
    }
  }

  // 3. Daytime phases (morning/day/evening)
  else {
    // 3a. Wake up from dormant — it's daytime now
    //     Hysteresis: require dormant for at least DORMANT_MIN_DURATION to prevent oscillation
    if (state === 'dormant') {
      const dormantDuration = getStateDuration();
      if (dormantDuration >= DORMANT_MIN_DURATION) {
        await transition('active', `waking up — it is ${phase.timeOfDay} (dormant for ${Math.round(dormantDuration / 60000)}min)`);
        state = getCurrentState();
      }
    }

    // 3b. Daytime resting → wake up if minimum rest period has elapsed
    else if (state === 'resting') {
      const restDuration = getStateDuration();
      if (restDuration >= RESTING_MIN_DURATION) {
        await transition('active', `rested ${Math.round(restDuration / 60000)}min — resuming active`);
        state = getCurrentState();
      }
      // else: stay resting — minimum rest period not yet met
    }

    // 3c. Fatigue-driven graceful degradation
    else if (state === 'active') {
      if (fatigue.score >= thresholds.THROTTLE_ENTER) {
        await transition('throttled', `fatigue=${fatigue.score} — throttling non-essential work`);
        state = getCurrentState();
      } else {
        // Idle detection (only when not fatigued)
        const idle = getTimeSinceLastInteraction();
        if (idle > IDLE_THRESHOLD && !isUnderLoad()) {
          await transition('resting', `no interaction for ${Math.round(idle / 60000)}min (ELU: ${eluPct}%)`);
          state = getCurrentState();
        }
      }
    }

    else if (state === 'throttled') {
      if (fatigue.score >= thresholds.DRAIN_ENTER) {
        // Worsening → escalate to drained
        await transition('drained', `fatigue=${fatigue.score} — draining, stop new tasks`);
        state = getCurrentState();
      } else if (fatigue.score < thresholds.THROTTLE_EXIT) {
        // Recovering → back to active
        await transition('active', `fatigue=${fatigue.score} — recovered from throttle`);
        state = getCurrentState();
      }
    }

    else if (state === 'drained') {
      if (fatigue.score < thresholds.DRAIN_EXIT && activity.isResting) {
        // Queue empty + fatigue low → enter rest to cool down
        await transition('resting', `fatigue=${fatigue.score} — drained complete, entering rest`);
        state = getCurrentState();
      } else if (fatigue.score < thresholds.THROTTLE_EXIT) {
        // Improving but still some activity → step down to throttled
        await transition('throttled', `fatigue=${fatigue.score} — improving, stepping down to throttled`);
        state = getCurrentState();
      }
    }
  }

  // ── Feed anomaly detector with current metrics ──
  const anomalies = anomalyDetector.detectAnomalies({
    elu,
    fatigueScore: fatigue.score,
    heapGrowthRate: fatigue.heapGrowthRate,
    eventsPerMinute: activity.eventsPerMinute,
  });

  if (anomalies.length > 0) {
    // Emit dedicated anomaly event for logging and alerting
    const anomalyPayload = anomalies.map((a) => ({
      metric: a.metric,
      current: a.current,
      mean: a.mean,
      zScore: a.zScore,
    }));
    await eventBus.emit('lifecycle:anomaly', { metrics: anomalyPayload, timestamp: Date.now() });

    // Append to anomaly log — dual-write: SQLite + JSONL
    try {
      const anomalyTimestamp = new Date().toISOString();
      const anomaliesJson = JSON.stringify(anomalyPayload);

      // 1. Write to SQLite
      try {
        const { getDb } = await import('../core/database.js');
        const db = getDb();
        db.prepare(
          `INSERT INTO anomalies (timestamp, state, anomalies) VALUES (?, ?, ?)`,
        ).run(anomalyTimestamp, state, anomaliesJson);
      } catch {
        // SQLite write failure is non-critical
      }

      // 2. Write to JSONL (dual-write backup — removed in Phase 5)
      const { writer } = await import('../core/debounced-writer.js');
      const { join: pathJoin } = await import('node:path');
      await writer.appendJsonl(pathJoin(process.cwd(), 'soul', 'logs', 'anomaly.jsonl'), {
        timestamp: anomalyTimestamp,
        state,
        anomalies: anomalyPayload,
      });
    } catch {
      // Anomaly logging is non-critical
    }

    await eventBus.emit('heartbeat:tick', {
      timestamp: Date.now(),
      state,
      elu,
      fatigueScore: fatigue.score,
      fatigueLevel: `${fatigue.level} [ANOMALY: ${anomalies.map((a) => a.metric).join(',')}]`,
    });
  } else {
    // ── Emit tick with the CURRENT state, ELU, and fatigue (after transitions) ──
    await eventBus.emit('heartbeat:tick', {
      timestamp: Date.now(),
      state,
      elu,
      fatigueScore: fatigue.score,
      fatigueLevel: fatigue.level,
    });
  }

  // Memory staging: check for expired items on every tick
  try {
    const { checkExpired } = await import('../memory/staging.js');
    await checkExpired();
  } catch {
    // staging module unavailable — non-critical
  }

  // Kill switch: run anomaly detection on every tick
  try {
    const { checkAnomalies } = await import('../safety/kill-switch.js');
    await checkAnomalies();
  } catch {
    // kill-switch module unavailable — non-critical
  }

  // Soul integrity: periodic verification (4 small files, <1ms)
  try {
    const { getFingerprint, setFingerprint, getFileHashes } = await import('../identity/vitals.js');
    const { computeSoulFingerprint, diffFingerprints } = await import('../safety/soul-integrity.js');

    const storedHash = await getFingerprint();
    if (storedHash) {
      const currentFp = await computeSoulFingerprint();
      if (currentFp.ok && currentFp.value.hash !== storedHash) {
        const storedFileHashes = await getFileHashes();
        const changedFiles = diffFingerprints(storedFileHashes, currentFp.value);
        await logger.warn('Heartbeat',
          `Soul identity changed between ticks! Changed: [${changedFiles.join(', ')}]`,
        );
        await eventBus.emit('soul:integrity_mismatch', {
          changedFiles,
          expected: storedHash,
          actual: currentFp.value.hash,
        });
        // Accept and update — legitimate changes (e.g. mood update) are expected
        await setFingerprint(currentFp.value.hash, currentFp.value.files);
      }
    }
  } catch {
    // Soul integrity check is non-critical in heartbeat
  }

  // ── Audit witness + identity health check now handled by ScheduleEngine ──
  // (registered as every:30m and every:60m entries in startHeartbeat())

  // ── Adaptive interval: lengthen ticks when idle, shorten when active ──
  adjustInterval(state);

  await logger.debug(
    'Heartbeat',
    `tick: state=${state}, phase=${phase.phase}, fatigue=${fatigue.score}(${fatigue.level}), elu=${eluPct}%, activity=${activity.totalCount}events, interval=${intervalMs / 1000}s`,
  );
}

export function startHeartbeat(interval?: number): void {
  if (timer) return;
  intervalMs = interval ?? DEFAULT_INTERVAL;

  // Attach activity monitor, checkpoint listener, wake manager, and integrity listener to EventBus
  activityMonitor.attach();
  attachCheckpointListener();
  attachWakeListeners();

  // Load persisted checkpoint from previous run (async, non-blocking)
  loadCheckpoint().catch((err) => logger.error('Heartbeat', 'Failed to load checkpoint from disk', err));

  // Restore anomaly detector baselines from previous run (async, non-blocking)
  anomalyDetector.loadBaselines(ANOMALY_BASELINES_PATH).catch(() => {
    // Baseline load failure is non-critical — detector will cold-start
  });

  // Initialize audit chain (async, non-blocking)
  import('../safety/audit-chain.js').then((ac) => ac.initAuditChain()).catch(() => {
    // audit-chain unavailable — non-critical
  });

  // Initialize transition log (async, non-blocking)
  import('./transition-log.js').then((tl) => tl.attachTransitionListener()).catch(() => {
    // transition-log unavailable — non-critical
  });

  // Attach kill-switch integrity listener (records soul mismatches as failures)
  import('../safety/kill-switch.js').then((ks) => ks.attachIntegrityListener()).catch(() => {
    // kill-switch unavailable — non-critical
  });

  // Register heartbeat periodic tasks in unified schedule engine
  scheduleEngine.register({
    id: 'heartbeat:audit-witness', cronExpr: 'every:30m',
    executor: { type: 'callback', fn: runAuditWitness },
    enabled: true, lastRun: null, source: 'heartbeat',
    meta: { description: 'Audit witness: Merkle root + anomaly baselines' },
  });
  scheduleEngine.register({
    id: 'heartbeat:identity-check', cronExpr: 'every:60m',
    executor: { type: 'callback', fn: runIdentityHealthCheck },
    enabled: true, lastRun: null, source: 'heartbeat',
    meta: { description: 'Full 4-layer identity health check' },
  });

  timer = setInterval(() => {
    tick().catch((err) => {
      logger.error('Heartbeat', 'tick error', err);
    });
  }, intervalMs);

  logger.info('Heartbeat', `started (interval=${intervalMs}ms)`);
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    scheduleEngine.unregister('heartbeat:audit-witness');
    scheduleEngine.unregister('heartbeat:identity-check');
    logger.info('Heartbeat', 'stopped');
  }
}

/** Wake up on user message — respects daily phase to prevent deep-night oscillation */
export async function wakeUp(reason: string): Promise<void> {
  const state = getCurrentState();
  if (state === 'resting' || state === 'dormant') {
    // During deep night (dormant phase), only explicit user messages should wake us,
    // and we check the phase to prevent immediate re-dormant on next tick
    const phase = getDailyPhase();
    if (phase.phase === 'dormant') {
      // Deep night: only wake if the reason indicates a direct user interaction
      if (reason.includes('user message') || reason.includes('telegram')) {
        lastUserWakeAt = Date.now(); // Set grace period so next tick doesn't re-dormant
        await transition('active', `${reason} (overriding dormant phase)`);
      }
      // Otherwise stay dormant — internal events should not trigger wake during deep night
      return;
    }

    // Restore checkpoint context for logging — helps understand pre-rest state
    const checkpoint = restoreCheckpoint();
    if (checkpoint) {
      const restDuration = Date.now() - checkpoint.savedAt;
      await logger.info(
        'Heartbeat',
        `waking with checkpoint: rested ${Math.round(restDuration / 60000)}min, ` +
        `pre-rest fatigue=${checkpoint.fatigue?.score ?? 'N/A'}`,
      );

      // Verify identity fingerprint hasn't changed during rest
      if (checkpoint.identityFingerprint) {
        try {
          const { computeSoulFingerprint, diffFingerprints } = await import('../safety/soul-integrity.js');
          const currentFp = await computeSoulFingerprint();
          if (currentFp.ok && currentFp.value.hash !== checkpoint.identityFingerprint) {
            const changedFiles = diffFingerprints(checkpoint.identityFileHashes, currentFp.value);
            await logger.warn('Heartbeat',
              `Soul identity changed during ${checkpoint.targetState}! Changed: [${changedFiles.join(', ')}]`,
            );
            await eventBus.emit('soul:integrity_mismatch', {
              context: 'wake',
              changedFiles,
              expected: checkpoint.identityFingerprint,
              actual: currentFp.value.hash,
            });
            // Update stored fingerprint
            const { setFingerprint } = await import('../identity/vitals.js');
            await setFingerprint(currentFp.value.hash, currentFp.value.files);
          }
        } catch {
          // Identity verification is non-critical during wake-up
        }
      }
    }

    await transition('active', reason);
  }
  // Note: throttled/drained are NOT woken by messages — they need fatigue to drop
}

export function isRunning(): boolean {
  return timer !== null;
}

export function getInterval(): number {
  return intervalMs;
}
