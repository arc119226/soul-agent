/**
 * Wake Manager — multi-layer wake-up mechanism for the bot lifecycle.
 *
 * Five priority layers (highest to lowest):
 *   1. Telegram — direct user interaction (handled by existing wakeUp())
 *   2. Priority Task — urgent evolution or agent task enqueued
 *   3. Health Check — anomaly recovery or safety level change
 *   4. Daily Rhythm — time-based (handled by existing heartbeat)
 *   5. Manual — admin override (handled by existing forceReset)
 *
 * This module implements layers 2 and 3, which were previously missing.
 * It listens to EventBus events and triggers wakeUp() when appropriate.
 */

import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { getCurrentState } from './state-machine.js';

let attached = false;

/** Wake source tracking for diagnostics */
export interface WakeEvent {
  source: 'telegram' | 'priority-task' | 'health-check' | 'daily-rhythm' | 'manual';
  reason: string;
  timestamp: number;
}

const wakeHistory: WakeEvent[] = [];
const MAX_HISTORY = 20;

function recordWake(source: WakeEvent['source'], reason: string): void {
  wakeHistory.push({ source, reason, timestamp: Date.now() });
  if (wakeHistory.length > MAX_HISTORY) wakeHistory.shift();
}

/**
 * Attempt to wake the bot from resting/dormant state.
 * Returns true if wake was triggered, false if bot wasn't sleeping or wake was suppressed.
 */
async function tryWake(source: WakeEvent['source'], reason: string): Promise<boolean> {
  const state = getCurrentState();

  // Only wake from resting — dormant requires explicit user interaction or daytime
  // (Priority tasks and health checks should not override deep-night dormancy)
  if (state !== 'resting') return false;

  recordWake(source, reason);

  // Use dynamic import to avoid circular dependency with heartbeat
  const { wakeUp } = await import('./heartbeat.js');
  await wakeUp(`[${source}] ${reason}`);

  await logger.info('WakeManager', `wake triggered: source=${source}, reason=${reason}`);
  return true;
}

/**
 * Attach wake listeners to EventBus.
 * Call once during bot startup (from heartbeat or main init).
 */
export function attachWakeListeners(): void {
  if (attached) return;

  // Layer 2: Priority Task — evolution starts or urgent agent tasks
  eventBus.on('evolution:start', (data) => {
    tryWake('priority-task', `evolution started: ${data.goalId}`).catch((err) => {
      logger.error('WakeManager', 'failed to wake for evolution', err);
    });
  });

  // Layer 3: Health Check — safety level recovered from restricted/emergency to normal
  eventBus.on('safety:level_changed', (data) => {
    // Only wake on recovery (restriction lifted), not on escalation
    if (data.to === 'normal' && data.from !== 'normal') {
      tryWake('health-check', `safety recovered: ${data.from} → ${data.to}`).catch((err) => {
        logger.error('WakeManager', 'failed to wake for safety recovery', err);
      });
    }
  });

  attached = true;
  logger.info('WakeManager', 'wake listeners attached (priority-task + health-check)');
}

/**
 * Get recent wake history for diagnostics.
 */
export function getWakeHistory(): readonly WakeEvent[] {
  return wakeHistory;
}
