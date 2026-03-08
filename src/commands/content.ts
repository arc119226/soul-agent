/**
 * /content — unified content management.
 *
 * Subcommands:
 *   /content             — Dashboard + buttons
 *   /content blog [cmd]  — Blog management
 *   /content site [cmd]  — Website management
 *   /content report [a]  — Agent reports
 *   /content research [q]— Deep research
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry, registerParentCommand } from '../telegram/command-registry.js';
import { handleBlog, registerBlogCallbacks } from './blog.js';
import { handleSite, registerSiteCallbacks } from './site.js';
import { handleReport, registerReportCallbacks } from './report.js';
import { handleResearch, registerResearchCallbacks } from './research.js';
import { logger } from '../core/logger.js';
import type { BotContext } from '../bot.js';

export function registerContentCommand(): void {
  registerParentCommand({
    name: 'content',
    description: '內容管理 (部落格/網站/報告/研究)',
    aliases: ['內容'],
    subcommands: [
      {
        name: 'blog',
        aliases: ['部落格'],
        description: '部落格管理',
        handler: handleBlog as (ctx: BotContext) => Promise<void>,
      },
      {
        name: 'site',
        aliases: ['網站'],
        description: '網站管理',
        handler: handleSite as (ctx: BotContext) => Promise<void>,
      },
      {
        name: 'report',
        aliases: ['報告'],
        description: '代理人報告',
        handler: handleReport as (ctx: BotContext) => Promise<void>,
      },
      {
        name: 'research',
        aliases: ['研究'],
        description: '深度研究',
        handler: handleResearch as (ctx: BotContext) => Promise<void>,
      },
    ],
    defaultHandler: async (ctx) => {
      const lines = [
        '*📝 內容管理*',
        '',
        '部落格、網站、報告、研究',
      ];

      const kb = new InlineKeyboard()
        .text('📝 部落格', 'blog:home')
        .text('🌐 網站', 'content:site')
        .row()
        .text('📊 報告', 'rpt:dashboard')
        .text('📚 研究', 'research:recent')
        .row()
        .text('◀️ 返回選單', 'menu:home');

      try {
        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
      } catch {
        await ctx.reply(lines.join('\n').replace(/[*`]/g, ''), { reply_markup: kb });
      }
    },
  });

  // Callback for content:site (since site doesn't have a home callback)
  commandRegistry.registerCallback('content:site', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleSite(ctx as BotContext);
  });

  // Register all sub-module callbacks
  registerBlogCallbacks();
  registerSiteCallbacks();
  registerReportCallbacks();
  registerResearchCallbacks();

  logger.info('commands', 'Registered /content with subcommands: blog, site, report, research');
}
