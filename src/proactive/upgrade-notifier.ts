/**
 * Upgrade notifier — sends Telegram messages when upgrade suggestions are available.
 *
 * Listens to 'upgrade:suggested' events from upgrade-advisor and pushes
 * notifications to the admin user via Telegram.
 */

import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../config.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import type { UpgradeNotification } from '../skills/upgrade-advisor.js';

let botRef: Bot<BotContext> | null = null;
let handler: ((notification: UpgradeNotification) => void) | null = null;

/**
 * Start listening for upgrade events and notify via Telegram.
 */
export function startUpgradeNotifier(bot: Bot<BotContext>): void {
  botRef = bot;

  handler = (notification) => {
    notifyUpgrade(notification).catch((err) => {
      logger.warn('UpgradeNotifier', 'Failed to notify', err);
    });
  };

  eventBus.on('upgrade:suggested', handler);
  logger.info('UpgradeNotifier', 'Upgrade notifier started');
}

/**
 * Stop listening and release bot reference.
 */
export function stopUpgradeNotifier(): void {
  if (handler) {
    eventBus.off('upgrade:suggested', handler);
    handler = null;
  }
  botRef = null;
  logger.info('UpgradeNotifier', 'Upgrade notifier stopped');
}

/**
 * Send an upgrade suggestion notification to the admin user.
 */
async function notifyUpgrade(notification: UpgradeNotification): Promise<void> {
  if (!botRef || !config.ADMIN_USER_ID) return;

  const emoji = notification.priority === 'high' ? '🚀' : '💡';
  const priorityText = notification.priority === 'high' ? '高優先級' : '中優先級';

  const message = [
    `${emoji} **Skill 升級建議** (${priorityText})`,
    '',
    `**技能名稱**: ${notification.skillName}`,
    `**原因**: ${notification.reason}`,
    `**預估每月節省**: ~${notification.estimatedSaving.toLocaleString()} tokens`,
    '',
    '你可以：',
    `• 回覆「轉換成 Plugin ${notification.skillName}」→ 我會把這個 Markdown Skill 演化成 TypeScript Plugin`,
    '• 回覆「延後」→ 7 天後再提醒',
    '• 忽略此訊息 → 技能保持原樣',
    '',
    '💡 註：這是建議把 Skill 檔案格式升級，不是修改專案功能',
  ].join('\n');

  try {
    await botRef.api.sendMessage(config.ADMIN_USER_ID, message, {
      parse_mode: 'Markdown',
    });
    await logger.info(
      'UpgradeNotifier',
      `Notified upgrade: ${notification.skillName} (${notification.priority}, ~${notification.estimatedSaving} tokens/month)`,
    );
  } catch (err) {
    await logger.warn('UpgradeNotifier', `Failed to send upgrade notification for ${notification.skillName}`, err);
  }
}
