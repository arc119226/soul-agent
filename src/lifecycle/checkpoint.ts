/**
 * Checkpoint — state snapshot on lifecycle transitions.
 *
 * Saves a lightweight snapshot when the bot enters resting/dormant state,
 * enabling rapid context restoration on wake-up. The snapshot is stored
 * in-memory only (ephemeral per process lifetime), since the bot's
 * persistent soul state is already managed by the soul/ system.
 *
 * Design:
 *   - Captures: fatigue metrics, activity snapshot, ELU history, timestamp
 *   - Restores: provides context to heartbeat so it can skip warm-up phase
 *   - Auto-save on state transitions to resting/dormant via EventBus
 *   - Auto-clear on explicit reset (boot) or after successful restore
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eventBus } from '../core/event-bus.js';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import type { FatigueMetrics } from './fatigue-score.js';
import type { ActivitySnapshot } from './activity-monitor.js';

const CHECKPOINT_FILE = join(process.cwd(), 'data', 'checkpoint.json');

export interface CheckpointData {
  /** When the checkpoint was taken */
  savedAt: number;
  /** The state the bot was transitioning TO */
  targetState: string;
  /** Reason for the transition */
  reason: string;
  /** Fatigue metrics at time of checkpoint */
  fatigue: FatigueMetrics | null;
  /** Activity snapshot at time of checkpoint */
  activity: ActivitySnapshot | null;
  /** ELU average at time of checkpoint */
  eluAverage: number;
  /** How long the bot had been in the previous state */
  previousStateDuration: number;
  /** Soul fingerprint hash at time of checkpoint */
  identityFingerprint?: string;
  /** Per-file hashes at time of checkpoint for precise diff on wake */
  identityFileHashes?: Record<string, string>;
}

let lastCheckpoint: CheckpointData | null = null;
let attached = false;

/**
 * Save a checkpoint with the current system state.
 */
export function saveCheckpoint(
  targetState: string,
  reason: string,
  fatigue: FatigueMetrics | null,
  activity: ActivitySnapshot | null,
  eluAverage: number,
  previousStateDuration: number,
  identityFingerprint?: string,
  identityFileHashes?: Record<string, string>,
): CheckpointData {
  lastCheckpoint = {
    savedAt: Date.now(),
    targetState,
    reason,
    fatigue,
    activity,
    eluAverage,
    previousStateDuration,
    identityFingerprint,
    identityFileHashes,
  };

  logger.info(
    'Checkpoint',
    `saved: state=${targetState}, fatigue=${fatigue?.score ?? 'N/A'}, elu=${(eluAverage * 100).toFixed(1)}%`,
  );

  // Persist to disk for cross-restart recovery
  writer.schedule(CHECKPOINT_FILE, lastCheckpoint);

  return lastCheckpoint;
}

/**
 * Restore the last checkpoint, returning it and clearing storage.
 * Returns null if no checkpoint exists.
 */
export function restoreCheckpoint(): CheckpointData | null {
  if (!lastCheckpoint) return null;

  const checkpoint = lastCheckpoint;
  const ageMs = Date.now() - checkpoint.savedAt;

  logger.info(
    'Checkpoint',
    `restored: was ${checkpoint.targetState} for ${Math.round(ageMs / 60000)}min, prior fatigue=${checkpoint.fatigue?.score ?? 'N/A'}`,
  );

  // Clear after restore — one-shot usage
  lastCheckpoint = null;
  return checkpoint;
}

/**
 * Check if a checkpoint exists without consuming it.
 */
export function hasCheckpoint(): boolean {
  return lastCheckpoint !== null;
}

/**
 * Get the age of the current checkpoint in milliseconds.
 * Returns Infinity if no checkpoint exists.
 */
export function getCheckpointAge(): number {
  if (!lastCheckpoint) return Infinity;
  return Date.now() - lastCheckpoint.savedAt;
}

/**
 * Attach to EventBus — auto-save checkpoint on transitions to rest/dormant states.
 * This is called from heartbeat.ts during startup.
 */
export function attachCheckpointListener(): void {
  if (attached) return;

  eventBus.on('lifecycle:state', (data) => {
    const { to, reason } = data;

    // Auto-save on entering rest/dormant states
    if (to === 'resting' || to === 'dormant') {
      // Import dynamically to avoid circular deps
      Promise.all([
        import('./fatigue-score.js'),
        import('./activity-monitor.js'),
        import('./elu-monitor.js'),
        import('./state-machine.js'),
        import('../safety/soul-integrity.js'),
      ]).then(async ([fatigueModule, activityModule, eluModule, smModule, integrityModule]) => {
        const fatigue = fatigueModule.calculateFatigue();
        const activity = activityModule.activityMonitor.getSnapshot();
        const eluAvg = eluModule.getELUAverage();
        const duration = smModule.getStateDuration();

        // Compute soul fingerprint for checkpoint identity verification
        let fingerprint: string | undefined;
        let fileHashes: Record<string, string> | undefined;
        const fpResult = await integrityModule.computeSoulFingerprint();
        if (fpResult.ok) {
          fingerprint = fpResult.value.hash;
          fileHashes = fpResult.value.files;
        }

        saveCheckpoint(to, reason, fatigue, activity, eluAvg, duration, fingerprint, fileHashes);

        // Create persistent soul snapshot (async, non-blocking)
        import('../safety/soul-snapshot.js').then((snapshotModule) => {
          snapshotModule.createSnapshot(to as 'resting' | 'dormant').catch((snapErr) => {
            logger.error('Checkpoint', 'failed to create soul snapshot', snapErr);
          });
        }).catch(() => { /* soul-snapshot module unavailable — non-critical */ });
      }).catch((err) => {
        logger.error('Checkpoint', 'failed to save checkpoint', err);
      });
    }
  });

  attached = true;
  logger.info('Checkpoint', 'listener attached to lifecycle:state');
}

/**
 * Load checkpoint from disk on startup.
 * Populates lastCheckpoint so restoreCheckpoint() can return it even after restart.
 * Safe to call multiple times — only loads if in-memory is currently null.
 */
export async function loadCheckpoint(): Promise<void> {
  if (lastCheckpoint !== null) return; // already loaded

  try {
    const raw = await readFile(CHECKPOINT_FILE, 'utf-8');
    const data = JSON.parse(raw) as CheckpointData;

    // Reject stale checkpoints older than 24 hours
    const ageMs = Date.now() - data.savedAt;
    if (ageMs > 24 * 60 * 60 * 1000) {
      logger.info('Checkpoint', `Discarding stale disk checkpoint (age=${Math.round(ageMs / 3600000)}h)`);
      return;
    }

    lastCheckpoint = data;
    logger.info(
      'Checkpoint',
      `Loaded from disk: state=${data.targetState}, age=${Math.round(ageMs / 60000)}min`,
    );
  } catch {
    // No checkpoint file or corrupt — start fresh (expected on first boot)
  }
}

/**
 * Clear checkpoint manually (e.g., on boot reset).
 */
export function clearCheckpoint(): void {
  lastCheckpoint = null;
  // Also clear from disk (fire-and-forget)
  writer.schedule(CHECKPOINT_FILE, null);
}
