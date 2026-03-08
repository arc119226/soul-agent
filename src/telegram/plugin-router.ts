/**
 * Plugin command router — matches user text against loaded plugins.
 */

import type { BotContext } from '../bot.js';
import { logger } from '../core/logger.js';
import { getLoadedPlugins } from '../plugins/plugin-loader.js';
import { pluginHealth } from '../plugins/plugin-health.js';
import { sendLongMessage, sendMarkdown } from './helpers.js';

const PLUGIN_TIMEOUT_MS = 5000;

/**
 * Try to route a message to a plugin.
 * Returns true if a plugin handled it, false otherwise.
 */
export async function tryRouteToPlugin(
  ctx: BotContext,
  chatId: number,
  userId: number,
  text: string,
): Promise<boolean> {
  const plugins = getLoadedPlugins();
  if (plugins.size === 0) return false;

  const lower = text.toLowerCase().trim();
  const spaceIdx = lower.indexOf(' ');
  const firstWord = spaceIdx > 0 ? lower.slice(0, spaceIdx) : lower;
  const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';

  for (const [name, plugin] of plugins) {
    if (pluginHealth.isDisabled(name)) continue;

    const matchNames = [plugin.meta.name.toLowerCase()];
    if (plugin.meta.aliases) {
      matchNames.push(...plugin.meta.aliases.map((a) => a.toLowerCase()));
    }

    if (!matchNames.includes(firstWord)) continue;

    try {
      const pluginContext = {
        bot: ctx,
        chatId,
        userId,
        sendMarkdown: (t: string) => sendMarkdown(ctx, chatId, t),
        sendLongMessage: (t: string) => sendLongMessage(ctx, chatId, t),
      };

      await Promise.race([
        plugin.handler(pluginContext, args),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Plugin "${name}" timed out after ${PLUGIN_TIMEOUT_MS}ms`)),
            PLUGIN_TIMEOUT_MS,
          ),
        ),
      ]);
      pluginHealth.recordSuccess(name);
      await logger.debug('plugin-router', `Plugin "${name}" handled message`);
      return true;
    } catch (err) {
      pluginHealth.recordError(name);
      const errorMsg = err instanceof Error ? err.message : String(err);
      await logger.error('plugin-router', `Plugin "${name}" error: ${errorMsg}`);
      await ctx.reply(`插件「${plugin.meta.name}」執行出錯：${errorMsg}`);
      return true;
    }
  }

  return false;
}
