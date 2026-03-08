/**
 * Command Hub — interactive button menu system.
 *
 * Provides a navigable inline-keyboard menu so users can discover and invoke
 * commands without memorizing names.
 *
 * Callback data format:
 *   menu:home           — show main menu
 *   menu:cat:<key>      — show category sub-menu
 *   menu:cmd:<command>  — invoke a command handler
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry } from '../telegram/command-registry.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';

// ── Menu data ────────────────────────────────────────────────────────

interface MenuCommand {
  icon: string;
  label: string;
  command: string;
}

interface MenuCategory {
  key: string;
  icon: string;
  label: string;
  adminOnly: boolean;
  commands: MenuCommand[];
}

const CATEGORIES: MenuCategory[] = [
  // ── Public categories ──
  {
    key: 'status', icon: '🤖', label: '狀態', adminOnly: false,
    commands: [
      { icon: '👥', label: '團隊儀表板', command: 'team' },
      { icon: '📊', label: '系統狀態', command: 'status' },
    ],
  },
  {
    key: 'operations', icon: '📊', label: '營運', adminOnly: false,
    commands: [
      { icon: '💰', label: '成本', command: 'cost' },
      { icon: '⚙️', label: 'Workers', command: 'workers' },
    ],
  },
  {
    key: 'content', icon: '📝', label: '內容', adminOnly: false,
    commands: [
      { icon: '📝', label: '內容管理', command: 'content' },
      { icon: '📋', label: '計劃', command: 'plan' },
    ],
  },
  {
    key: 'soul', icon: '🧠', label: '靈魂', adminOnly: false,
    commands: [
      { icon: '🧠', label: '自我認知', command: 'soul' },
    ],
  },
  // ── Admin-only categories ──
  {
    key: 'agents', icon: '🤖', label: 'Agent', adminOnly: true,
    commands: [
      { icon: '🤖', label: 'Agent 管理', command: 'agents' },
      { icon: '🔍', label: '搜尋/知識', command: 'search' },
    ],
  },
  {
    key: 'dev', icon: '🛠️', label: '開發', adminOnly: true,
    commands: [
      { icon: '🧠', label: 'Claude Code', command: 'cc' },
      { icon: '🧬', label: '進化', command: 'evolve' },
    ],
  },
  {
    key: 'system', icon: '⚙️', label: '系統', adminOnly: true,
    commands: [
      { icon: '⚙️', label: '系統管理', command: 'sys' },
    ],
  },
];

// ── Keyboard builders ────────────────────────────────────────────────

/** Build the main menu keyboard (category buttons in 2-column grid). */
export function buildMainMenu(isAdmin: boolean): InlineKeyboard {
  const visible = isAdmin ? CATEGORIES : CATEGORIES.filter(c => !c.adminOnly);
  const kb = new InlineKeyboard();
  for (let i = 0; i < visible.length; i += 2) {
    if (i > 0) kb.row();
    const left = visible[i]!;
    kb.text(`${left.icon} ${left.label}`, `menu:cat:${left.key}`);
    const right = visible[i + 1];
    if (right) {
      kb.text(`${right.icon} ${right.label}`, `menu:cat:${right.key}`);
    }
  }
  return kb;
}

/** Build a category sub-menu keyboard (command buttons + back). */
function buildCategoryMenu(cat: MenuCategory): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < cat.commands.length; i += 2) {
    if (i > 0) kb.row();
    const left = cat.commands[i]!;
    kb.text(`${left.icon} ${left.label}`, `menu:cmd:${left.command}`);
    const right = cat.commands[i + 1];
    if (right) {
      kb.text(`${right.icon} ${right.label}`, `menu:cmd:${right.command}`);
    }
  }
  kb.row().text('◀️ 返回主選單', 'menu:home');
  return kb;
}

const MAIN_MENU_TEXT = '📋 *指令選單*\n\n選擇分類瀏覽指令：';

// ── Helpers ──────────────────────────────────────────────────────────

function checkAdmin(userId?: number): boolean {
  return userId === config.ADMIN_USER_ID;
}

/** Edit the existing message, or send a new one if editing fails. */
async function editOrReply(
  ctx: Parameters<Parameters<typeof commandRegistry.registerCallback>[1]>[0],
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch {
    // Message too old, deleted, or not editable — send fresh reply
    try {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    } catch {
      await ctx.reply(text.replace(/\*/g, ''), { reply_markup: keyboard });
    }
  }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerMenuCommand(): void {
  // /menu command — show main menu
  commandRegistry.registerCommand({
    name: 'menu',
    description: '互動式指令選單',
    aliases: ['選單', '功能'],
    handler: async (ctx) => {
      const isAdmin = checkAdmin(ctx.from?.id);
      try {
        await ctx.reply(MAIN_MENU_TEXT, {
          parse_mode: 'Markdown',
          reply_markup: buildMainMenu(isAdmin),
        });
      } catch {
        await ctx.reply(MAIN_MENU_TEXT.replace(/\*/g, ''), {
          reply_markup: buildMainMenu(isAdmin),
        });
      }
    },
  });

  // menu:home — return to main menu
  commandRegistry.registerCallback('menu:home', async (ctx) => {
    const isAdmin = checkAdmin(ctx.from?.id);
    await editOrReply(ctx, MAIN_MENU_TEXT, buildMainMenu(isAdmin));
    await ctx.answerCallbackQuery();
  });

  // menu:cat:<key> — open category sub-menu
  commandRegistry.registerCallback('menu:cat:', async (ctx, data) => {
    const cat = CATEGORIES.find(c => c.key === data);
    if (!cat) {
      await ctx.answerCallbackQuery({ text: '分類不存在' });
      return;
    }
    // Admin-only check
    if (cat.adminOnly && !checkAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '需要管理員權限' });
      return;
    }
    const text = `${cat.icon} *${cat.label}*\n\n選擇指令：`;
    await editOrReply(ctx, text, buildCategoryMenu(cat));
    await ctx.answerCallbackQuery();
  });

  // menu:cmd:<command> — invoke a command handler
  commandRegistry.registerCallback('menu:cmd:', async (ctx, data) => {
    const entry = commandRegistry.getCommand(data);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: '指令不存在' });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await entry.handler(ctx);
    } catch (err) {
      logger.warn('menu', `Failed to invoke /${data}: ${(err as Error).message}`);
      await ctx.reply(`執行 /${data} 時發生錯誤。`);
    }
  });

  logger.info('commands', 'Registered menu command with interactive navigation');
}

export { CATEGORIES, type MenuCategory };
