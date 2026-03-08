/**
 * Escalation notifier — sends Telegram messages when pipeline agents escalate.
 *
 * Listens to 'team:pipeline:escalation' events and pushes alert
 * notifications to the admin user via Telegram.
 */

import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../config.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';

let botRef: Bot<BotContext> | null = null;
let handler: ((data: { teamName: string; runId: string; stageId: string; agentName: string; summary: string; to: string[] }) => void) | null = null;

/**
 * Start listening for pipeline escalation events and notify via Telegram.
 */
export function startEscalationNotifier(bot: Bot<BotContext>): void {
  botRef = bot;

  handler = (data) => {
    notifyEscalation(data).catch((err) => {
      logger.warn('EscalationNotifier', 'Failed to notify', err);
    });
  };

  eventBus.on('team:pipeline:escalation', handler);
  logger.info('EscalationNotifier', 'Escalation notifier started');
}

/**
 * Stop listening and release bot reference.
 */
export function stopEscalationNotifier(): void {
  if (handler) {
    eventBus.off('team:pipeline:escalation', handler);
    handler = null;
  }
  botRef = null;
  logger.info('EscalationNotifier', 'Escalation notifier stopped');
}

/**
 * Send an escalation notification to the admin user.
 */
async function notifyEscalation(data: {
  teamName: string;
  runId: string;
  stageId: string;
  agentName: string;
  summary: string;
  to: string[];
}): Promise<void> {
  if (!botRef || !config.ADMIN_USER_ID) return;

  const message = [
    '🚨 Pipeline Escalation',
    '',
    `**團隊**：${data.teamName}`,
    `**階段**：${data.stageId}（${data.agentName}）`,
    `**目標**：${data.to.join(', ')}`,
    '',
    `**摘要**：${data.summary}`,
    '',
    `Run ID: \`${data.runId.slice(0, 8)}\``,
  ].join('\n');

  try {
    await botRef.api.sendMessage(config.ADMIN_USER_ID, message, { parse_mode: 'Markdown' });
    await logger.info('EscalationNotifier', `Notified escalation: ${data.agentName} in ${data.teamName} — ${data.summary}`);
  } catch (err) {
    await logger.warn('EscalationNotifier', `Failed to send escalation notification`, err);
  }
}
