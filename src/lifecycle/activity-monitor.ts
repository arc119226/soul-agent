/**
 * Activity Monitor — tracks event activity frames to detect rest states.
 *
 * Core concept: "rest" is not sleep but the absence of meaningful activity.
 * We track activity frames (significant events) within a sliding time window.
 * When the window empties, the system is objectively at rest.
 *
 * Inspired by Kubernetes liveness probes and event-driven idle detection.
 */

import { eventBus, type EventName } from '../core/event-bus.js';
import { logger } from '../core/logger.js';

/** Activity frame types — events that indicate the system is doing meaningful work */
export type ActivityFrame =
  | 'message-received'
  | 'message-sent'
  | 'claude-response'
  | 'plugin-execution'
  | 'evolution-attempt'
  | 'agent-task'
  | 'memory-update'
  | 'reflection';

/** Map EventBus events to ActivityFrame types */
const EVENT_TO_FRAME: Partial<Record<EventName, ActivityFrame>> = {
  'message:received': 'message-received',
  'message:sent': 'message-sent',
  'agent:task:completed': 'agent-task',
  'agent:task:failed': 'agent-task',
  'plugin:loaded': 'plugin-execution',
  'plugin:reloaded': 'plugin-execution',
  'evolution:start': 'evolution-attempt',
  'evolution:success': 'evolution-attempt',
  'memory:updated': 'memory-update',
  'memory:compressed': 'memory-update',
  'reflection:done': 'reflection',
};

export interface ActivitySnapshot {
  /** Total activity count in current window */
  totalCount: number;
  /** Per-frame-type counts */
  frameCounts: Partial<Record<ActivityFrame, number>>;
  /** Time since last activity (ms), Infinity if never */
  timeSinceLastActivity: number;
  /** Whether the system is in a rest state (no activity in window) */
  isResting: boolean;
  /** How long the system has been continuously resting (ms) */
  restDurationMs: number;
  /** Activity rate: events per minute in window */
  eventsPerMinute: number;
}

interface ActivityEvent {
  timestamp: number;
  frame: ActivityFrame;
}

export class ActivityMonitor {
  private events: ActivityEvent[] = [];
  private restStartedAt: number | null = null;
  private windowMs: number;
  private attached = false;

  constructor(windowMs: number = 5 * 60 * 1000) {
    this.windowMs = windowMs;
  }

  /** Record an activity event */
  record(frame: ActivityFrame): void {
    this.events.push({ timestamp: Date.now(), frame });
    this.prune();

    // If we were resting, we're not anymore
    if (this.restStartedAt !== null) {
      this.restStartedAt = null;
    }
  }

  /** Get a snapshot of current activity state */
  getSnapshot(): ActivitySnapshot {
    this.prune();

    const now = Date.now();
    const totalCount = this.events.length;
    const isResting = totalCount === 0;

    // Compute per-frame counts
    const frameCounts: Partial<Record<ActivityFrame, number>> = {};
    for (const evt of this.events) {
      frameCounts[evt.frame] = (frameCounts[evt.frame] ?? 0) + 1;
    }

    // Time since last activity
    const lastEvent = this.events[this.events.length - 1];
    const timeSinceLastActivity = lastEvent
      ? now - lastEvent.timestamp
      : Infinity;

    // Rest duration tracking
    if (isResting && this.restStartedAt === null) {
      // Just entered rest — mark when the last event expired from window
      this.restStartedAt = lastEvent
        ? lastEvent.timestamp + this.windowMs
        : now;
    }
    const restDurationMs =
      isResting && this.restStartedAt !== null
        ? now - this.restStartedAt
        : 0;

    // Events per minute
    const windowSeconds = this.windowMs / 1000;
    const eventsPerMinute =
      totalCount > 0 ? (totalCount / windowSeconds) * 60 : 0;

    return {
      totalCount,
      frameCounts,
      timeSinceLastActivity,
      isResting,
      restDurationMs,
      eventsPerMinute,
    };
  }

  /** Attach to EventBus — auto-record activity from system events */
  attach(): void {
    if (this.attached) return;

    for (const [eventName, frame] of Object.entries(EVENT_TO_FRAME)) {
      eventBus.on(eventName as EventName, () => {
        this.record(frame);
      });
    }

    this.attached = true;
    logger.info('ActivityMonitor', `attached to EventBus (window=${this.windowMs / 1000}s)`);
  }

  /** Remove events outside the sliding window */
  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    // Find first event within window (events are chronologically ordered)
    let i = 0;
    while (i < this.events.length && this.events[i]!.timestamp < cutoff) {
      i++;
    }
    if (i > 0) {
      this.events.splice(0, i);
    }
  }

  /** Reset all state */
  reset(): void {
    this.events = [];
    this.restStartedAt = null;
  }
}

/** Singleton instance with default 5-minute window */
export const activityMonitor = new ActivityMonitor();
