/**
 * Plugin Degradation — Fallback mechanism when Plugins fail repeatedly.
 *
 * Design principle (Arc's insight):
 * "自動化降維成程序可能會因為外部資料結構環境改而運行出錯——要保留升級的彈性"
 *
 * When a Plugin fails N consecutive times:
 * 1. Disable the plugin
 * 2. Check if there's a corresponding Markdown Skill fallback
 * 3. If no skill exists, create a placeholder skill with error notice
 * 4. Notify user via Telegram
 *
 * Integration point: Listens to 'plugin:error' events from plugin-loader
 */

import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../config.js';

/** Consecutive failure threshold before triggering degradation */
const FAILURE_THRESHOLD = 3;

/** Track consecutive failures per plugin */
const failureCount = new Map<string, number>();

/** Track degraded plugins (to avoid re-degrading) */
const degradedPlugins = new Set<string>();

let botRef: Bot<BotContext> | null = null;
let errorHandler: ((data: { name: string; error: string }) => void) | null = null;

/**
 * Start listening for plugin errors and auto-degrade on repeated failures.
 */
export function startPluginDegradation(bot: Bot<BotContext>): void {
  botRef = bot;

  errorHandler = (data) => {
    handlePluginError(data.name, data.error).catch((err) => {
      logger.warn('PluginDegradation', 'Failed to handle plugin error', err);
    });
  };

  eventBus.on('plugin:error', errorHandler);
  logger.info('PluginDegradation', 'Plugin degradation monitor started');
}

/**
 * Stop listening and release bot reference.
 */
export function stopPluginDegradation(): void {
  if (errorHandler) {
    eventBus.off('plugin:error', errorHandler);
    errorHandler = null;
  }
  botRef = null;
  logger.info('PluginDegradation', 'Plugin degradation monitor stopped');
}

/**
 * Handle a plugin error — track failures and trigger degradation if threshold reached.
 */
async function handlePluginError(pluginName: string, error: string): Promise<void> {
  // Skip if already degraded
  if (degradedPlugins.has(pluginName)) {
    return;
  }

  // Increment failure count
  const count = (failureCount.get(pluginName) ?? 0) + 1;
  failureCount.set(pluginName, count);

  logger.warn('PluginDegradation', `Plugin ${pluginName} failed (${count}/${FAILURE_THRESHOLD}): ${error}`);

  // Check threshold
  if (count >= FAILURE_THRESHOLD) {
    logger.info('PluginDegradation', `Plugin ${pluginName} reached failure threshold — degrading...`);
    await degradePlugin(pluginName, error);
  }
}

/**
 * Degrade a plugin: disable it and create/activate fallback skill.
 */
async function degradePlugin(pluginName: string, lastError: string): Promise<void> {
  try {
    // 1. Mark as degraded (prevent re-entry)
    degradedPlugins.add(pluginName);

    // 2. Disable plugin (remove from loaded plugins)
    const { getPlugin } = await import('./plugin-loader.js');
    const plugin = getPlugin(pluginName);
    if (plugin && plugin.dispose) {
      try {
        await plugin.dispose();
      } catch {
        // Best effort disposal
      }
    }

    logger.info('PluginDegradation', `Plugin ${pluginName} disabled`);

    // 3. Check if a fallback skill exists
    const { join } = await import('node:path');
    const { access } = await import('node:fs/promises');
    const skillPath = join(process.cwd(), 'soul', 'skills', `${pluginName}.md`);

    let skillExists = false;
    try {
      await access(skillPath);
      skillExists = true;
      logger.info('PluginDegradation', `Found fallback skill: ${pluginName}.md`);
    } catch {
      // Skill doesn't exist — create placeholder
      await createPlaceholderSkill(pluginName, lastError);
    }

    // 4. Signal skill rebuild
    const rebuildSignalPath = join(process.cwd(), 'soul', 'skills', '.rebuild');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(rebuildSignalPath, Date.now().toString(), 'utf-8');

    // 5. Record in narrative
    const { appendNarrative } = await import('../identity/narrator.js');
    await appendNarrative('evolution', `Plugin ${pluginName} 降級為 Skill 模式（連續失敗 ${FAILURE_THRESHOLD} 次）`);

    // 6. Notify user
    await notifyDegradation(pluginName, skillExists, lastError);

    logger.info('PluginDegradation', `Plugin ${pluginName} successfully degraded to skill mode`);
  } catch (err) {
    logger.error('PluginDegradation', `Failed to degrade plugin ${pluginName}`, err);
  }
}

/**
 * Create a placeholder skill when no fallback exists.
 */
async function createPlaceholderSkill(pluginName: string, error: string): Promise<void> {
  const { join } = await import('node:path');
  const { writeFile } = await import('node:fs/promises');

  const markdown = [
    '---',
    `name: ${pluginName}`,
    `description: Degraded from plugin — needs manual repair`,
    `keywords: ["${pluginName}", "degraded", "fallback"]`,
    'category: fallback',
    'priority: 3',
    'enabled: true',
    '---',
    '',
    '## ⚠️ 此技能為降級後的占位符',
    '',
    `原本的 TypeScript Plugin「${pluginName}」因連續失敗而自動降級。`,
    '',
    '**最後錯誤**:',
    '```',
    error,
    '```',
    '',
    '**建議操作**:',
    '1. 檢查外部 API 或資料結構是否改變',
    '2. 修復 Plugin 程式碼後重新載入',
    '3. 或將此 Skill 更新為純 AI 驅動的替代方案',
  ].join('\n');

  const skillPath = join(process.cwd(), 'soul', 'skills', `${pluginName}.md`);
  const tmpPath = `${skillPath}.tmp`;
  await writeFile(tmpPath, markdown, 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmpPath, skillPath);

  logger.info('PluginDegradation', `Created placeholder skill: ${pluginName}.md`);
}

/**
 * Notify user about plugin degradation via Telegram.
 */
async function notifyDegradation(pluginName: string, hadFallback: boolean, error: string): Promise<void> {
  if (!botRef || !config.ADMIN_USER_ID) return;

  const message = [
    '⚠️ **Plugin 自動降級**',
    '',
    `Plugin「${pluginName}」連續失敗 ${FAILURE_THRESHOLD} 次，已自動降級為 Skill 模式。`,
    '',
    hadFallback
      ? `✓ 已啟用備用 Skill「${pluginName}.md」`
      : `⚠️ 建立了占位符 Skill，需要手動修復`,
    '',
    '**最後錯誤**:',
    '```',
    error.slice(0, 200),
    '```',
    '',
    '你可以：',
    '• 檢查並修復 Plugin 程式碼',
    '• 更新 Skill 為 AI 驅動的替代方案',
    '• 回覆「重試 <插件名稱>」清除失敗計數',
  ].join('\n');

  try {
    await botRef.api.sendMessage(config.ADMIN_USER_ID, message, {
      parse_mode: 'Markdown',
    });
    logger.info('PluginDegradation', `Sent degradation notification for ${pluginName}`);
  } catch (err) {
    logger.warn('PluginDegradation', `Failed to send degradation notification for ${pluginName}`, err);
  }
}

/**
 * Reset failure count for a plugin (manual recovery).
 */
export function resetPluginFailureCount(pluginName: string): void {
  failureCount.delete(pluginName);
  degradedPlugins.delete(pluginName);
  logger.info('PluginDegradation', `Reset failure count for: ${pluginName}`);
}

/**
 * Get degradation status for all plugins.
 */
export function getDegradationStatus(): { name: string; failures: number; degraded: boolean }[] {
  const status: { name: string; failures: number; degraded: boolean }[] = [];

  for (const [name, failures] of failureCount) {
    status.push({
      name,
      failures,
      degraded: degradedPlugins.has(name),
    });
  }

  return status;
}
