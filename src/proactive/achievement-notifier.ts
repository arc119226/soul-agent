/**
 * Achievement notifier — sends Telegram messages when milestones are reached.
 *
 * Listens to 'milestone:reached' events and pushes celebratory
 * notifications to the admin user via Telegram.
 */

import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../config.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';

let botRef: Bot<BotContext> | null = null;
let handler: ((data: { type: string; description: string }) => void) | null = null;

/** Achievement announcement messages by significance level */
const CELEBRATION: Record<number, string[]> = {
  1: ['📌 小小進步'],
  2: ['⭐ 新成就解鎖！'],
  3: ['🌟 成就達成！'],
  4: ['🏅 重要里程碑！'],
  5: ['🏆 史詩級成就！'],
};

function getCelebration(significance: number): string {
  const msgs = CELEBRATION[significance] ?? CELEBRATION[3]!;
  return msgs[Math.floor(Math.random() * msgs.length)]!;
}

/**
 * Start listening for milestone events and notify via Telegram.
 */
export function startAchievementNotifier(bot: Bot<BotContext>): void {
  botRef = bot;

  handler = (data) => {
    notifyAchievement(data.type, data.description).catch((err) => {
      logger.warn('AchievementNotifier', 'Failed to notify', err);
    });
  };

  eventBus.on('milestone:reached', handler);
  logger.info('AchievementNotifier', 'Achievement notifier started');
}

/**
 * Stop listening and release bot reference.
 */
export function stopAchievementNotifier(): void {
  if (handler) {
    eventBus.off('milestone:reached', handler);
    handler = null;
  }
  botRef = null;
  logger.info('AchievementNotifier', 'Achievement notifier stopped');
}

/**
 * Send an achievement notification to the admin user.
 */
async function notifyAchievement(type: string, description: string): Promise<void> {
  if (!botRef || !config.ADMIN_USER_ID) return;

  // Extract significance from description prefix or default to 3
  let significance = 3;
  try {
    const { getMilestones } = await import('../identity/milestones.js');
    const milestones = await getMilestones();
    const found = milestones.find((m) => m.type === type);
    if (found) significance = found.significance;
  } catch { /* use default */ }

  const header = getCelebration(significance);
  const stars = '⭐'.repeat(Math.min(significance, 5));

  const message = [
    header,
    '',
    `${description}`,
    '',
    stars,
  ].join('\n');

  try {
    await botRef.api.sendMessage(config.ADMIN_USER_ID, message);
    await logger.info('AchievementNotifier', `Notified: ${type} — ${description}`);
  } catch (err) {
    await logger.warn('AchievementNotifier', `Failed to send notification for ${type}`, err);
  }
}
