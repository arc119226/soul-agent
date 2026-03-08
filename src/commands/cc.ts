import { existsSync } from 'node:fs';
import { InlineKeyboard } from 'grammy';
import { commandRegistry, registerParentCommand } from '../telegram/command-registry.js';
import {
  abortClaudeCode,
  newSession,
  resumeSession,
  getCwd,
  setCwd,
  isBusy,
  getSessionInfo,
} from '../claude/claude-code.js';

/** Extract arguments after `/parent sub ...` */
function extractArgs(text: string, parent: string, sub: string): string {
  return text.replace(new RegExp(`^\\/${parent}\\s+${sub}\\s*`, 'i'), '').trim();
}

/** Show CC dashboard with inline buttons */
async function showDashboard(ctx: Parameters<Parameters<typeof commandRegistry.registerCallback>[1]>[0]): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const info = getSessionInfo(userId);
  const lines = [
    '*🧠 Claude Code*',
    '',
    `Session: \`${info.sessionId ?? '(none)'}\``,
    `CWD: \`${info.cwd}\``,
    `Busy: ${info.busy ? 'Yes' : 'No'}`,
  ];

  const kb = new InlineKeyboard()
    .text('🆕 新工作階段', 'cc:new')
    .text('▶️ 恢復', 'cc:resume')
    .row()
    .text('⛔ 終止', 'cc:abort')
    .text('📂 工作目錄', 'cc:cwd')
    .row()
    .text('◀️ 返回選單', 'menu:home');

  try {
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
  } catch {
    await ctx.reply(lines.join('\n').replace(/[*`]/g, ''), { reply_markup: kb });
  }
}

/** Register all Claude Code commands under /cc */
export function registerCCCommands(): void {
  registerParentCommand({
    name: 'cc',
    description: 'Claude Code 工作階段管理',
    aliases: ['claude'],
    adminOnly: true,
    subcommands: [
      {
        name: 'new',
        aliases: ['n'],
        description: '開始新的工作階段',
        handler: async (ctx) => {
          const userId = ctx.from?.id;
          if (!userId) return;

          if (isBusy(userId)) {
            await ctx.reply('Claude Code is busy. Use /cc abort first.');
            return;
          }

          newSession(userId);
          await ctx.reply('New session started. Next message will begin a fresh conversation.');
        },
      },
      {
        name: 'resume',
        aliases: ['r'],
        description: '恢復工作階段',
        handler: async (ctx) => {
          const userId = ctx.from?.id;
          if (!userId) return;

          if (isBusy(userId)) {
            await ctx.reply('Claude Code is busy. Use /cc abort first.');
            return;
          }

          const text = ctx.message?.text ?? '';
          const sessionId = extractArgs(text, 'cc', 'resume');

          if (!sessionId) {
            const info = getSessionInfo(userId);
            if (info.sessionId) {
              await ctx.reply(`Current session: \`${info.sessionId}\`\n\nUsage: /cc resume <session-id>`, {
                parse_mode: 'Markdown',
              });
            } else {
              await ctx.reply('No current session. Usage: /cc resume <session-id>');
            }
            return;
          }

          resumeSession(userId, sessionId);
          await ctx.reply(`Session resumed: \`${sessionId}\``, { parse_mode: 'Markdown' });
        },
      },
      {
        name: 'abort',
        aliases: ['a', 'kill'],
        description: '終止執行',
        handler: async (ctx) => {
          const userId = ctx.from?.id;
          if (!userId) return;

          const killed = abortClaudeCode(userId);
          if (killed) {
            await ctx.reply('Claude Code process terminated.');
          } else {
            await ctx.reply('No running process to abort.');
          }
        },
      },
      {
        name: 'cwd',
        description: '設定/顯示工作目錄',
        handler: async (ctx) => {
          const userId = ctx.from?.id;
          if (!userId) return;

          const text = ctx.message?.text ?? '';
          const newPath = extractArgs(text, 'cc', 'cwd');

          if (!newPath) {
            const current = getCwd(userId);
            await ctx.reply(`Current working directory:\n\`${current}\``, { parse_mode: 'Markdown' });
            return;
          }

          if (!existsSync(newPath)) {
            await ctx.reply(`Path does not exist: \`${newPath}\``, { parse_mode: 'Markdown' });
            return;
          }

          setCwd(userId, newPath);
          await ctx.reply(`Working directory set to:\n\`${newPath}\``, { parse_mode: 'Markdown' });
        },
      },
      {
        name: 'status',
        aliases: ['s', 'info'],
        description: '工作階段資訊',
        handler: async (ctx) => {
          const userId = ctx.from?.id;
          if (!userId) return;

          const info = getSessionInfo(userId);
          const lines = [
            '*Claude Code Status*',
            '',
            `Session: \`${info.sessionId ?? '(none)'}\``,
            `CWD: \`${info.cwd}\``,
            `Model: ${info.model || '(default)'}`,
            `Busy: ${info.busy ? 'Yes' : 'No'}`,
            `Last used: ${info.lastUsed}`,
          ];

          try {
            await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
          } catch {
            await ctx.reply(lines.join('\n').replace(/[*`]/g, ''));
          }
        },
      },
    ],
    defaultHandler: showDashboard,
  });

  // Inline keyboard callbacks for CC buttons
  commandRegistry.registerCallback('cc:', async (ctx, data) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    switch (data) {
      case 'new': {
        if (isBusy(userId)) {
          await ctx.answerCallbackQuery({ text: 'Claude Code is busy' });
          return;
        }
        newSession(userId);
        await ctx.answerCallbackQuery({ text: 'New session started' });
        await ctx.reply('New session started. Next message will begin a fresh conversation.');
        break;
      }
      case 'resume': {
        const info = getSessionInfo(userId);
        await ctx.answerCallbackQuery();
        if (info.sessionId) {
          await ctx.reply(`Current session: \`${info.sessionId}\`\n\nUsage: /cc resume <session-id>`, {
            parse_mode: 'Markdown',
          });
        } else {
          await ctx.reply('No current session. Usage: /cc resume <session-id>');
        }
        break;
      }
      case 'abort': {
        const killed = abortClaudeCode(userId);
        await ctx.answerCallbackQuery({ text: killed ? 'Process terminated' : 'No running process' });
        if (killed) {
          await ctx.reply('Claude Code process terminated.');
        }
        break;
      }
      case 'cwd': {
        const current = getCwd(userId);
        await ctx.answerCallbackQuery();
        await ctx.reply(`Current working directory:\n\`${current}\``, { parse_mode: 'Markdown' });
        break;
      }
      default:
        await ctx.answerCallbackQuery({ text: '未知操作' });
    }
  });
}
