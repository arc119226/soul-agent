/**
 * /sys — unified system administration.
 *
 * Subcommands:
 *   /sys              — Dashboard + buttons
 *   /sys restart      — Restart (exit 42)
 *   /sys shutdown     — Graceful shutdown (exit 0)
 *   /sys dormant      — Enter dormant mode
 *   /sys logs [cmd]   — Narrative history
 *   /sys info         — System information
 *   /sys files [path] — Browse filesystem
 *   /sys run <lang>   — Execute code
 *   /sys git [cmd]    — Git operations
 *   /sys proactive    — Proactive care settings
 *   /sys schedules    — Schedule overview
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry, registerParentCommand } from '../telegram/command-registry.js';
import { handleShutdown, handleRestart, handleDormant } from './shutdown.js';
import { handleFiles, handleRun, handleGit, handleSysinfo, registerRemoteCallbacks } from './remote.js';
import { handleProactive } from './proactive.js';
import { handleLogs } from './logs.js';
import { handleSchedules } from './schedules.js';
import { logger } from '../core/logger.js';
import type { BotContext } from '../bot.js';

export function registerSysCommand(): void {
  registerParentCommand({
    name: 'sys',
    description: '系統管理 (重啟/關機/日誌/排程)',
    aliases: ['系統管理'],
    adminOnly: true,
    subcommands: [
      { name: 'restart', aliases: ['重啟'], description: '手動重啟', handler: handleRestart },
      { name: 'shutdown', aliases: ['關機'], description: '優雅關機', handler: handleShutdown },
      { name: 'dormant', aliases: ['休眠', '睡覺'], description: '進入休眠', handler: handleDormant },
      { name: 'logs', aliases: ['日誌'], description: '對話歷史', handler: handleLogs },
      { name: 'info', aliases: ['sysinfo', '資訊'], description: '系統資訊', handler: handleSysinfo },
      { name: 'files', aliases: ['檔案'], description: '瀏覽檔案', handler: handleFiles },
      { name: 'run', aliases: ['exec', '執行'], description: '執行程式碼', handler: handleRun },
      { name: 'git', description: 'Git 操作', handler: handleGit },
      { name: 'proactive', aliases: ['主動'], description: '主動關懷設定', handler: handleProactive },
      { name: 'schedules', aliases: ['排程', 'sched'], description: '排程總覽', handler: handleSchedules },
    ],
    defaultHandler: async (ctx) => {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);

      const lines = [
        '*⚙️ 系統管理*',
        '',
        `⏱ 運行: ${hours}h ${minutes}m`,
        `📡 Node.js: ${process.version}`,
      ];

      const kb = new InlineKeyboard()
        .text('🔄 重啟', 'sys:restart')
        .text('💤 休眠', 'sys:dormant')
        .text('⏹️ 關機', 'sys:shutdown')
        .row()
        .text('📜 日誌', 'sys:logs')
        .text('📊 系統資訊', 'sys:info')
        .text('⏰ 排程', 'sys:schedules')
        .row()
        .text('📂 檔案', 'sys:files')
        .text('🔀 Git', 'sys:git')
        .text('💡 主動關懷', 'sys:proactive')
        .row()
        .text('◀️ 返回選單', 'menu:home');

      try {
        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
      } catch {
        await ctx.reply(lines.join('\n').replace(/[*`]/g, ''), { reply_markup: kb });
      }
    },
  });

  // Callbacks for sys inline keyboard buttons
  commandRegistry.registerCallback('sys:', async (ctx, data) => {
    await ctx.answerCallbackQuery();
    const handlers: Record<string, (c: BotContext) => Promise<void>> = {
      restart: handleRestart,
      shutdown: handleShutdown,
      dormant: handleDormant,
      logs: handleLogs,
      info: handleSysinfo,
      files: handleFiles,
      git: handleGit,
      proactive: handleProactive,
      schedules: handleSchedules,
    };
    const handler = handlers[data];
    if (handler) {
      await handler(ctx as BotContext);
    }
  });

  // Register file browser callbacks from remote module
  registerRemoteCallbacks();

  logger.info('commands', 'Registered /sys with 10 subcommands');
}
