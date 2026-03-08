import { type NextFunction } from 'grammy';
import { config } from '../../config.js';
import type { BotContext } from '../../bot.js';
import { getTodayString } from '../../core/timezone.js';

/** Per-user daily rate limiting */
const dailyCounts = new Map<number, { count: number; resetDate: string }>();

export async function rateLimitMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  const limit = config.DAILY_REQUEST_LIMIT;
  if (limit <= 0) return next(); // Unlimited

  const userId = ctx.from?.id;
  if (!userId) return next();

  // Admin is exempt
  if (userId === config.ADMIN_USER_ID) return next();

  const today = getTodayString();
  let entry = dailyCounts.get(userId);

  if (!entry || entry.resetDate !== today) {
    entry = { count: 0, resetDate: today };
    dailyCounts.set(userId, entry);
  }

  if (entry.count >= limit) {
    const tz = config.TIMEZONE || 'UTC';
    await ctx.reply(
      `已達到每日使用上限（${entry.count}/${limit}）。\n將於明日 00:00 (${tz}) 重置。`
    );
    return;
  }

  entry.count++;
  return next();
}
