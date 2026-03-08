import { type NextFunction } from 'grammy';
import { config } from '../../config.js';
import { logger } from '../../core/logger.js';
import type { BotContext } from '../../bot.js';

/**
 * Whitelist auth middleware.
 * If ALLOWED_USERS is non-empty, only those users can interact.
 * Admin always has access.
 */
export function authMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return next(); // No user info (channel posts, etc.)

  const allowedUsers = config.ALLOWED_USERS;

  // Empty whitelist = allow everyone
  if (allowedUsers.length === 0) return next();

  // Check whitelist
  if (allowedUsers.includes(userId) || userId === config.ADMIN_USER_ID) {
    return next();
  }

  // Silently ignore unauthorized users (log only)
  logger.debug('auth', `Unauthorized user ${userId} ignored`);
  return Promise.resolve();
}
