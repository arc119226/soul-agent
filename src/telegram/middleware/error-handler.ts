import { type NextFunction } from 'grammy';
import { logger } from '../../core/logger.js';
import type { BotContext } from '../../bot.js';
import { formatUserError } from '../helpers.js';

/** Global error boundary middleware */
export async function errorHandlerMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  try {
    await next();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await logger.error('middleware', `Unhandled error in update ${ctx.update.update_id}`, {
      error: errorMsg,
      chat: ctx.chat?.id,
      user: ctx.from?.id,
    });

    // Try to notify user
    try {
      await ctx.reply(formatUserError('system-error'));
    } catch {
      // If even error reply fails, just log
    }
  }
}
