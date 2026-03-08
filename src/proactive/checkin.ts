/**
 * Proactive check-in — reach out when appropriate.
 */

import { getTimeSinceLastInteraction, estimateOwnerState, isQuietHours } from '../lifecycle/awareness.js';
import { getUser } from '../memory/user-store.js';
import { canDeliver, recordDelivery } from './constraints.js';
import { logger } from '../core/logger.js';

const CHECKIN_MIN_GAP = 24 * 60 * 60 * 1000; // at least 24h since last interaction

const CHECKIN_MESSAGES = [
  '好久不見！最近一切都好嗎？',
  '想到你了，需要什麼幫忙嗎？',
  '好一陣子沒聊了，一切順利嗎？',
  '嗨！最近都在忙什麼呢？',
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export function checkIfShouldCheckin(userId: number, chatId: number): boolean {
  // Don't check in during quiet hours
  if (isQuietHours()) return false;

  // Check constraints
  if (!canDeliver('checkin', userId)) return false;

  // Don't check in if owner is sleeping
  const ownerState = estimateOwnerState(userId);
  if (ownerState === 'sleeping') return false;

  // Only check in after sufficient idle time
  const timeSince = getTimeSinceLastInteraction(userId);
  if (timeSince < CHECKIN_MIN_GAP) return false;

  return true;
}

export async function generateCheckinMessage(userId: number): Promise<string | null> {
  if (!canDeliver('checkin', userId)) return null;

  const user = await getUser(userId);
  const name = user?.name ?? '';

  let message = pickRandom(CHECKIN_MESSAGES);

  if (name) {
    message = `${name}，${message}`;
  }

  recordDelivery('checkin', userId);
  await logger.info('Checkin', `Check-in message generated for user ${userId}`);

  return message;
}
