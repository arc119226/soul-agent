/**
 * Upgrade Advisor — Proactively suggests Plugin upgrades to the user.
 *
 * Monitors skill usage stats and sends Telegram notifications when:
 * - A skill crosses high-frequency threshold (weekly > 20)
 * - Cumulative usage justifies Plugin conversion (total > 50)
 *
 * Integration points:
 * - Scheduler: Register a weekly check via `schedule()`
 * - Telegram: Send upgrade suggestions as proactive messages
 * - Evolution: Provide "upgrade candidate" context to pipeline
 */

import { getUpgradeSuggestions, pruneGhostEntries, type UpgradeSuggestion } from './skill-usage-tracker.js';
import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import { config } from '../config.js';

/** Minimum time between notifications (7 days) to avoid spam */
const NOTIFICATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Track last notification time per skill to enforce cooldown */
const lastNotificationTime = new Map<string, number>();

export interface UpgradeNotification {
  skillName: string;
  reason: string;
  priority: 'high' | 'medium';
  estimatedSaving: number;
  notifiedAt: string;
}

/**
 * Check for upgrade candidates and send Telegram notifications.
 * Called by scheduler on a weekly basis.
 */
export async function runUpgradeCheck(): Promise<void> {
  logger.info('upgrade-advisor', 'Running upgrade check...');

  // Clean up ghost entries before checking
  await pruneGhostEntries();

  const suggestions = await getUpgradeSuggestions();
  if (suggestions.length === 0) {
    logger.info('upgrade-advisor', 'No upgrade candidates found');
    return;
  }

  const notifications: UpgradeNotification[] = [];

  for (const suggestion of suggestions) {
    // Check cooldown
    const lastNotified = lastNotificationTime.get(suggestion.skillName) ?? 0;
    const now = Date.now();
    if (now - lastNotified < NOTIFICATION_COOLDOWN_MS) {
      logger.info(
        'upgrade-advisor',
        `Skipping ${suggestion.skillName} — notified ${Math.round((now - lastNotified) / 86400000)} days ago`,
      );
      continue;
    }

    // Send notification
    const notification: UpgradeNotification = {
      skillName: suggestion.skillName,
      reason: suggestion.reason,
      priority: suggestion.priority,
      estimatedSaving: suggestion.estimatedMonthlySaving,
      notifiedAt: new Date().toISOString(),
    };

    // Emit event → Telegram handler will catch this
    await eventBus.emit('upgrade:suggested', notification);

    lastNotificationTime.set(suggestion.skillName, now);
    notifications.push(notification);

    logger.info(
      'upgrade-advisor',
      `Sent upgrade notification: ${suggestion.skillName} (${suggestion.priority}, ~${suggestion.estimatedMonthlySaving} tokens/month)`,
    );
  }

  if (notifications.length > 0) {
    await eventBus.emit('upgrade:batch_sent', { count: notifications.length });
  }

  logger.info('upgrade-advisor', `Upgrade check complete: ${notifications.length} notification(s) sent`);
}

/**
 * Get upgrade candidates (for manual queries).
 * Does NOT send notifications — just returns current state.
 */
export async function getUpgradeCandidates(): Promise<UpgradeSuggestion[]> {
  return await getUpgradeSuggestions();
}

/**
 * Format upgrade suggestion as Telegram message.
 */
export function formatUpgradeMessage(notification: UpgradeNotification): string {
  const emoji = notification.priority === 'high' ? '🚀' : '💡';
  const lines: string[] = [
    `${emoji} **Skill 升級建議**`,
    '',
    `**技能名稱**: ${notification.skillName}`,
    `**原因**: ${notification.reason}`,
    `**預估每月節省**: ~${notification.estimatedSaving.toLocaleString()} tokens`,
    '',
    '你可以：',
    '• 接受建議 → 我會把這個 Markdown Skill 演化成 TypeScript Plugin',
    '• 延後處理 → 7 天後再提醒',
    '• 忽略此建議 → 技能保持原樣',
    '',
    '💡 註：這是建議把 Skill 檔案格式升級，不是修改專案功能',
  ];

  return lines.join('\n');
}

/**
 * Register scheduler task for weekly upgrade checks.
 * Call this during bot initialization.
 */
export function registerUpgradeCheckScheduler(): void {
  import('../core/schedule-engine.js')
    .then((mod) => {
      const cronExpr = config.UPGRADE_CHECK_SCHEDULE ?? 'daily@09:00';
      mod.scheduleEngine.register({
        id: 'upgrade-advisor-check', cronExpr,
        executor: { type: 'callback', fn: runUpgradeCheck },
        enabled: true, lastRun: null, source: 'proactive',
      });
      logger.info('upgrade-advisor', `Registered upgrade check: ${cronExpr}`);
    })
    .catch((err) => {
      logger.warn('upgrade-advisor', 'Failed to register scheduler (non-critical)', err);
    });
}

/**
 * Reset notification cooldown for a skill (for testing or manual override).
 */
export function resetCooldown(skillName: string): void {
  lastNotificationTime.delete(skillName);
  logger.info('upgrade-advisor', `Reset cooldown for: ${skillName}`);
}
