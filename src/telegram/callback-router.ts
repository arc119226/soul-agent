import { commandRegistry } from './command-registry.js';
import type { BotContext } from '../bot.js';

/**
 * Callback router — delegates to commandRegistry.
 * This module exists for any custom callback routing beyond command callbacks.
 */
export async function routeCallback(ctx: BotContext, data: string): Promise<void> {
  await commandRegistry.routeCallback(ctx, data);
}
