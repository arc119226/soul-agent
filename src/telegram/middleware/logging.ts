import { type NextFunction } from 'grammy';
import { logger } from '../../core/logger.js';
import type { BotContext } from '../../bot.js';

/** Log all incoming messages to per-chat JSONL files */
export async function loggingMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const text = ctx.message?.text ?? ctx.message?.caption ?? '';

  if (chatId && userId && text) {
    // Fire-and-forget logging
    logger.logChat(chatId, userId, 'user', text).catch(() => {});
  }

  await next();
}
