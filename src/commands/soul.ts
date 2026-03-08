/**
 * /soul — unified self-awareness & inner life commands.
 *
 * Subcommands:
 *   /soul              — Dashboard + buttons
 *   /soul reflect      — Trigger manual reflection
 *   /soul diary [date] — View diary
 *   /soul dream [mode] — Interact with dreams
 *   /soul speak <text> — Text-to-speech
 *   /soul achievements — Milestones & stats
 *   /soul metacognition — Metacognition status
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry, registerParentCommand } from '../telegram/command-registry.js';
import { handleReflect, handleMetacognition } from './metacognition.js';
import { handleDiary, registerDiaryCallbacks } from './diary.js';
import { handleDream, registerDreamCallbacks } from './dream.js';
import { handleSpeak } from './speak.js';
import { handleAchievements } from './achievements.js';
import { logger } from '../core/logger.js';
import type { BotContext } from '../bot.js';

export function registerSoulCommand(): void {
  registerParentCommand({
    name: 'soul',
    description: '自我認知 / 內在世界',
    aliases: ['靈魂', '內在'],
    subcommands: [
      {
        name: 'reflect',
        aliases: ['反思'],
        description: '觸發手動反思',
        handler: handleReflect,
      },
      {
        name: 'diary',
        aliases: ['日記'],
        description: '查看日記 (/soul diary [date|list])',
        handler: handleDiary,
      },
      {
        name: 'dream',
        aliases: ['夢', '夢境'],
        description: '與夢境互動 (/soul dream [talk|list])',
        handler: handleDream,
      },
      {
        name: 'speak',
        aliases: ['說話', '唸'],
        description: '文字轉語音 (/soul speak <文字>)',
        handler: handleSpeak,
      },
      {
        name: 'achievements',
        aliases: ['成就'],
        description: '成就與里程碑',
        handler: handleAchievements,
      },
      {
        name: 'metacognition',
        aliases: ['meta', '後設認知'],
        description: '後設認知狀態',
        handler: handleMetacognition,
      },
    ],
    defaultHandler: async (ctx) => {
      const lines = [
        '*🧬 靈魂面板*',
        '',
        '自我認知、反思、日記、夢境、成就',
      ];

      const kb = new InlineKeyboard()
        .text('🪞 反思', 'soul:reflect')
        .text('📔 日記', 'soul:diary')
        .row()
        .text('🌙 夢境', 'soul:dream')
        .text('🏆 成就', 'soul:achievements')
        .row()
        .text('🧠 後設認知', 'soul:metacognition')
        .text('◀️ 返回選單', 'menu:home');

      try {
        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
      } catch {
        await ctx.reply(lines.join('\n').replace(/[*`]/g, ''), { reply_markup: kb });
      }
    },
  });

  // Register soul: callbacks for inline keyboard buttons
  commandRegistry.registerCallback('soul:', async (ctx, data) => {
    await ctx.answerCallbackQuery();
    switch (data) {
      case 'reflect':
        await handleReflect(ctx as BotContext);
        break;
      case 'diary':
        await (await import('./diary.js')).handleDiaryDefault(ctx as BotContext);
        break;
      case 'dream':
        await (await import('./dream.js')).handleDreamDefault(ctx as BotContext);
        break;
      case 'achievements':
        await handleAchievements(ctx as BotContext);
        break;
      case 'metacognition':
        await handleMetacognition(ctx as BotContext);
        break;
      default:
        break;
    }
  });

  // Register callbacks from sub-modules
  registerDiaryCallbacks();
  registerDreamCallbacks();

  logger.info('commands', 'Registered /soul with subcommands: reflect, diary, dream, speak, achievements, metacognition');
}
