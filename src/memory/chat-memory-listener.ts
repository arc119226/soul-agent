/**
 * Chat memory listener — listens for message:received events
 * and automatically records topics/events to soul/memory/.
 * Completely non-blocking (fire-and-forget).
 */

import { eventBus } from '../core/event-bus.js';
import { addEvent } from './chat-memory.js';
import { logger } from '../core/logger.js';

const MIN_TEXT_LENGTH = 10;

/** Extract a short topic string from message text, or null if too short. */
export function extractTopic(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return null;

  // Take the first sentence or first 60 chars
  const firstSentence = trimmed.split(/[。.!?！？\n]/)[0];
  if (!firstSentence || firstSentence.length < MIN_TEXT_LENGTH) return null;

  return firstSentence.slice(0, 60).trim();
}

/** Estimate importance (1-5) based on keywords in the text. */
export function estimateImportance(text: string): number {
  const lower = text.toLowerCase();
  const highKeywords = ['重要', 'important', 'urgent', '緊急', 'bug', 'fix', 'error', '記住', 'remember'];
  const medKeywords = ['請', 'please', '改', 'change', '新增', 'add', '功能', 'feature'];

  if (highKeywords.some((k) => lower.includes(k))) return 4;
  if (medKeywords.some((k) => lower.includes(k))) return 3;
  return 2;
}

/** Register the chat memory event listener on the eventBus. */
export function setupChatMemoryListener(): void {
  eventBus.on('message:received', async ({ chatId, userId, text }) => {
    try {
      const topic = extractTopic(text);
      if (!topic) return;

      const importance = estimateImportance(text);
      // Only store as event — topics should come from semantic extraction, not raw messages
      await addEvent(chatId, `User message: ${topic}`, [userId], importance);
    } catch (err) {
      logger.error('chat-memory-listener', 'Failed to record chat memory', err);
    }
  });

  logger.info('chat-memory-listener', 'Chat memory listener registered');
}
