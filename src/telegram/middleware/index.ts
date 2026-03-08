import type { Bot } from 'grammy';
import type { BotContext } from '../../bot.js';
import { errorHandlerMiddleware } from './error-handler.js';
import { authMiddleware } from './auth.js';
import { loggingMiddleware } from './logging.js';
import { rateLimitMiddleware } from './rate-limit.js';

/** Setup the middleware stack in correct order */
export function setupMiddleware(bot: Bot<BotContext>): void {
  // Order matters: error boundary → auth → logging → rate limit
  bot.use(errorHandlerMiddleware);
  bot.use(authMiddleware);
  bot.use(loggingMiddleware);
  bot.use(rateLimitMiddleware);
}
