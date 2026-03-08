/**
 * Shutdown/restart/dormant handlers.
 * Registered as /sys subcommands via sys.ts.
 */

import { shutdown } from '../core/shutdown.js';
import { transition, getCurrentState } from '../lifecycle/state-machine.js';
import { logger } from '../core/logger.js';
import type { BotContext } from '../bot.js';

export async function handleShutdown(ctx: BotContext): Promise<void> {
  await ctx.reply('正在關機...');
  await logger.info('Command', 'Shutdown requested by admin');
  await shutdown.execute('Admin requested shutdown', 0);
}

export async function handleRestart(ctx: BotContext): Promise<void> {
  await ctx.reply('正在重啟...');
  await logger.info('Command', 'Restart requested by admin');
  await shutdown.execute('Admin requested restart', 42);
}

export async function handleDormant(ctx: BotContext): Promise<void> {
  const currentState = getCurrentState();
  const success = await transition('dormant', 'Admin requested dormant mode');

  if (success) {
    await ctx.reply('已進入休眠模式。心跳會維持最低頻率。\n發送任何訊息即可喚醒。');
  } else {
    await ctx.reply(`無法從 ${currentState} 轉換到 dormant。請先回到 active 或 resting 狀態。`);
  }
}
