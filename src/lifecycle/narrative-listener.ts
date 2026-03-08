/**
 * Narrative lifecycle listener — bridges EventBus events to narrative.jsonl.
 *
 * This is the key connector for the learning loop:
 *   interaction → narrative → reflection → evolution → growth
 *
 * Without this, narrative.jsonl stays nearly empty, and the reflection
 * system (Layer 2 of context weaving) has no material to work with.
 */

import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { appendNarrative } from '../identity/narrator.js';

type AnyHandler = (...args: unknown[]) => void | Promise<void>;

const registeredHandlers: Array<{ event: string; handler: AnyHandler }> = [];

function register<T>(
  event: string,
  handler: (data: T) => void | Promise<void>,
): void {
  eventBus.on(event as never, handler as never);
  registeredHandlers.push({ event, handler: handler as AnyHandler });
}

// --- Interaction throttle (at most one narrative entry per 5 min per user) ---
const INTERACTION_COOLDOWN_MS = 5 * 60 * 1000;
const lastInteractionRecord = new Map<number, number>();

/**
 * Setup all narrative lifecycle event listeners.
 * Call once during startup.
 */
export function setupNarrativeListener(): void {
  // 1. Record user interactions (emitted after successful Claude Code reply)
  register<{ chatId: number; userId: number; text: string }>(
    'message:received',
    async ({ userId, text }) => {
      try {
        const now = Date.now();
        const last = lastInteractionRecord.get(userId) ?? 0;
        if (now - last < INTERACTION_COOLDOWN_MS) return;
        lastInteractionRecord.set(userId, now);

        const topic =
          text.length > 60 ? text.slice(0, 57) + '...' : text;
        await appendNarrative('interaction', `與用戶對話：${topic}`, {
          significance: 2,
          related_to: topic,
        });

        // Track questions as curiosity topics (detect ? or Chinese question particles)
        if (/[?？]|嗎|呢|什麼|如何|為什麼|怎麼/.test(text)) {
          try {
            const { trackQuestion } = await import('../metacognition/curiosity.js');
            await trackQuestion(topic);
          } catch { /* curiosity tracking is non-critical */ }
        }
      } catch (err) {
        await logger.error(
          'narrative-listener',
          'Failed to record interaction narrative',
          err,
        );
      }
    },
  );

  // 2. Record evolution success
  register<{ goalId: string; description: string }>(
    'evolution:success',
    async ({ goalId, description }) => {
      try {
        await appendNarrative('evolution', `進化成功：${description}`, {
          significance: 4,
          emotion: '成長',
          related_to: goalId,
        });
      } catch (err) {
        await logger.error(
          'narrative-listener',
          'Failed to record evolution success',
          err,
        );
      }
    },
  );

  // 3. Record evolution failure
  register<{ goalId: string; error: string }>(
    'evolution:fail',
    async ({ goalId, error }) => {
      try {
        const shortError =
          error.length > 80 ? error.slice(0, 77) + '...' : error;
        await appendNarrative('evolution', `進化失敗：${shortError}`, {
          significance: 3,
          emotion: '挫折',
          related_to: goalId,
        });
      } catch (err) {
        await logger.error(
          'narrative-listener',
          'Failed to record evolution failure',
          err,
        );
      }
    },
  );

  // 4. Record significant lifecycle state transitions
  register<{ from: string; to: string; reason: string }>(
    'lifecycle:state',
    async ({ from, to, reason }) => {
      // Only record significant transitions, not every minor change
      const significant =
        to === 'dormant' ||
        (from === 'dormant' && to === 'active') ||
        (to === 'resting' && from === 'active');

      if (!significant) return;

      try {
        const summaryMap: Record<string, string> = {
          dormant: `進入休眠：${reason}`,
          active: `從休眠中醒來：${reason}`,
          resting: `開始休息：${reason}`,
        };
        const summary =
          summaryMap[to] ?? `狀態轉換 ${from} → ${to}：${reason}`;
        await appendNarrative('reflection', summary, {
          significance: 1,
          related_to: 'lifecycle',
        });
      } catch (err) {
        await logger.error(
          'narrative-listener',
          'Failed to record state transition',
          err,
        );
      }
    },
  );

  // 5. Record milestones
  register<{ type: string; description: string }>(
    'milestone:reached',
    async ({ description, type }) => {
      try {
        await appendNarrative('milestone', description, {
          significance: 5,
          emotion: '喜悅',
          related_to: type,
        });
      } catch (err) {
        await logger.error(
          'narrative-listener',
          'Failed to record milestone',
          err,
        );
      }
    },
  );

  logger.info(
    'narrative-listener',
    'Narrative lifecycle listener registered (5 events)',
  );
}

/**
 * Detach all listeners. Call during shutdown.
 */
export function disposeNarrativeListener(): void {
  for (const { event, handler } of registeredHandlers) {
    eventBus.off(event as never, handler as never);
  }
  registeredHandlers.length = 0;
}
