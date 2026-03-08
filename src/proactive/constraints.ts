/**
 * Proactive constraints — central gate for all proactive deliveries.
 * Enforces quiet hours, frequency caps, and auto-throttle.
 */

import { config } from '../config.js';
import { isQuietHours } from '../lifecycle/awareness.js';
import { logger } from '../core/logger.js';
import { getTodayString, toLocalDateString } from '../core/timezone.js';

export type ProactiveType = 'greeting' | 'checkin' | 'care' | 'reminder' | 'reflection';

interface DeliveryRecord {
  type: ProactiveType;
  userId: number;
  timestamp: number;
}

/** Per-type daily caps */
const DAILY_CAPS: Record<ProactiveType, number> = {
  greeting: 1,
  checkin: 1,    // per week actually, enforced separately
  care: 2,
  reminder: 5,
  reflection: 1,
};

const TOTAL_DAILY_CAP = 3; // max proactive messages per day total (excluding reminders)
const CHECKIN_COOLDOWN = 24 * 60 * 60 * 1000; // 24h (matches plan: trigger after 24h without interaction)
const IGNORED_THRESHOLD = 3; // after 3 consecutive ignored messages, throttle

const deliveryLog: DeliveryRecord[] = [];
let ignoredCount = 0;

function getTodayDeliveries(userId: number): DeliveryRecord[] {
  const today = getTodayString();
  return deliveryLog.filter(
    (d) =>
      d.userId === userId &&
      toLocalDateString(new Date(d.timestamp).toISOString()) === today,
  );
}

export function canDeliver(type: ProactiveType, userId: number): boolean {
  // 1. Quiet hours
  if (isQuietHours()) {
    logger.debug('Constraints', `Blocked ${type}: quiet hours`);
    return false;
  }

  // 2. Auto-throttle after ignored messages
  if (ignoredCount >= IGNORED_THRESHOLD) {
    logger.debug('Constraints', `Blocked ${type}: ${ignoredCount} consecutive ignored`);
    return false;
  }

  const todayRecords = getTodayDeliveries(userId);

  // 3. Per-type daily cap
  const typeCount = todayRecords.filter((d) => d.type === type).length;
  const cap = DAILY_CAPS[type] ?? 1;
  if (typeCount >= cap) {
    logger.debug('Constraints', `Blocked ${type}: daily cap (${typeCount}/${cap})`);
    return false;
  }

  // 4. Total daily cap (exclude reminders)
  if (type !== 'reminder') {
    const proactiveCount = todayRecords.filter((d) => d.type !== 'reminder').length;
    if (proactiveCount >= TOTAL_DAILY_CAP) {
      logger.debug('Constraints', `Blocked ${type}: total daily cap (${proactiveCount}/${TOTAL_DAILY_CAP})`);
      return false;
    }
  }

  // 5. Checkin weekly cooldown
  if (type === 'checkin') {
    const lastCheckin = deliveryLog
      .filter((d) => d.type === 'checkin' && d.userId === userId)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (lastCheckin && Date.now() - lastCheckin.timestamp < CHECKIN_COOLDOWN) {
      logger.debug('Constraints', `Blocked checkin: weekly cooldown`);
      return false;
    }
  }

  return true;
}

/** Record a delivery */
export function recordDelivery(type: ProactiveType, userId: number): void {
  deliveryLog.push({ type, userId, timestamp: Date.now() });

  // Trim old records (keep last 30 days)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  while (deliveryLog.length > 0 && deliveryLog[0]!.timestamp < cutoff) {
    deliveryLog.shift();
  }
}

/** Called when user responds to a proactive message */
export function recordResponse(): void {
  ignoredCount = 0;
}

/** Called when a proactive message was apparently ignored */
export function recordIgnored(): void {
  ignoredCount++;
  if (ignoredCount >= IGNORED_THRESHOLD) {
    logger.info('Constraints', `Auto-throttle activated: ${ignoredCount} consecutive ignored messages`);
  }
}

/** Reset throttle state */
export function resetThrottle(): void {
  ignoredCount = 0;
}

export function getDeliveryStats(userId: number): {
  today: number;
  ignoredStreak: number;
  byType: Record<string, number>;
} {
  const todayRecords = getTodayDeliveries(userId);
  const byType: Record<string, number> = {};
  for (const r of todayRecords) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }
  return {
    today: todayRecords.length,
    ignoredStreak: ignoredCount,
    byType,
  };
}
