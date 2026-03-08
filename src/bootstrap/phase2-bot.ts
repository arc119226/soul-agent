/**
 * Bootstrap Phase 2 — Bot Creation
 *
 * Creates the grammY bot instance, sets up middleware stack,
 * registers commands, message handler, and document handler.
 */

import { logger } from '../core/logger.js';
import { createBot, type BotContext } from '../bot.js';
import { setupMiddleware } from '../telegram/middleware/index.js';
import { registerCommands } from '../commands/index.js';
import { setupMessageHandler } from '../telegram/message-handler.js';
import type { Bot } from 'grammy';

export async function createAndConfigureBot(): Promise<Bot<BotContext>> {
  await logger.info('startup', 'Creating bot instance...');
  const bot = createBot();

  // Middleware stack
  setupMiddleware(bot);

  // Command handlers
  registerCommands(bot);

  // General message handler (AFTER commands so commands take priority)
  setupMessageHandler(bot);

  // Document handler (file uploads: PDF, DOCX, CSV, XLSX)
  try {
    const { setupDocumentHandler } = await import('../documents/document-handler.js');
    setupDocumentHandler(bot);
    await logger.info('startup', 'Document handler registered');
  } catch (err) {
    await logger.warn('startup', 'Document handler failed (non-fatal)', err);
  }

  return bot;
}
