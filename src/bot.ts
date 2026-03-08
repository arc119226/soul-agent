import { Bot, type Context } from 'grammy';
import { Agent as HttpsAgent } from 'node:https';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { autoRetry } from '@grammyjs/auto-retry';
import { config } from './config.js';
import { logger } from './core/logger.js';

/**
 * Extended context for our bot — will be enriched as we add features.
 */
export interface BotContext extends Context {
  // Extend as needed
}

// Force IPv4 — WSL2 often has broken IPv6 to Telegram API
const ipv4Agent = new HttpsAgent({ keepAlive: true, family: 4 });

/** Create and configure the grammY Bot instance */
export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.BOT_TOKEN, {
    client: {
      baseFetchConfig: {
        // grammY uses node-fetch internally; pass custom agent to force IPv4
        agent: ipv4Agent as never,
      },
    },
  });

  // API throttler — prevents 429 Too Many Requests from Telegram
  bot.api.config.use(apiThrottler());

  // Auto-retry — retries on transient errors (429, 5xx) with exponential backoff
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  // Global error handler
  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    logger.error('bot', `Error handling update ${ctx.update.update_id}`, e);
  });

  return bot;
}
