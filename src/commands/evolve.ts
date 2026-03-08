/**
 * /evolve — unified evolution management.
 *
 * Subcommands:
 *   /evolve             — Dashboard + buttons
 *   /evolve run [id]    — Execute evolution (auto-pick or by goalId/description)
 *   /evolve goals       — List goals
 *   /evolve add <desc>  — Add goal
 *   /evolve rm <id>     — Remove goal
 *   /evolve suggest     — Data-driven proposals
 *   /evolve log         — Change history
 *   /evolve validate    — TypeScript syntax check
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry, registerParentCommand } from '../telegram/command-registry.js';
import {
  addGoal,
  getAllGoals,
  getNextGoal,
  removeGoal,
  type Goal,
} from '../evolution/goals.js';
import { executePipeline } from '../evolution/pipeline.js';
import { getRecentChanges } from '../evolution/changelog.js';
import { layeredValidation, validateSyntax } from '../evolution/validator.js';
import { getCircuitBreakerInfo, forceReset } from '../evolution/circuit-breaker.js';
import { getAutoEvolveStatus, startAutoEvolve, stopAutoEvolve } from '../evolution/auto-evolve.js';
import { isOk } from '../result.js';
import { logger } from '../core/logger.js';

// ── Helpers ──────────────────────────────────────────────────────────

function statusEmoji(status: string): string {
  switch (status) {
    case 'pending': return '⏳';
    case 'in_progress': return '🔄';
    case 'completed': return '✅';
    case 'failed': return '❌';
    default: return '❓';
  }
}

function priorityBar(priority: number): string {
  return '█'.repeat(priority) + '░'.repeat(5 - priority);
}

function extractArgs(text: string, sub: string): string {
  return text.replace(new RegExp(`^\\/evolve\\s+${sub}\\s*`, 'i'), '').trim();
}

// ── Registration ─────────────────────────────────────────────────────

export function registerEvolveCommands(): void {
  registerParentCommand({
    name: 'evolve',
    description: '進化管理 (目標/執行/記錄)',
    aliases: ['進化', '升級'],
    adminOnly: true,
    subcommands: [
      {
        name: 'run',
        aliases: ['r', 'exec'],
        description: '執行進化 (自動選目標或指定ID)',
        handler: async (ctx) => {
          const text = ctx.message?.text ?? '';
          const arg = extractArgs(text, 'run');

          if (!arg) {
            // Auto-pick next goal
            const goal = getNextGoal();
            if (!goal) {
              await ctx.reply('目前沒有待處理的目標。使用 /evolve add <描述> 添加。');
              return;
            }
            await ctx.reply(`🧬 開始進化: ${goal.description}\n目標ID: ${goal.id}`);
            const result = await executePipeline(goal.id);
            if (isOk(result)) {
              const r = result.value;
              const files = r.filesChanged.length > 0
                ? r.filesChanged.map((f: string) => `  - ${f}`).join('\n')
                : '  (no files detected)';
              let msg = `✅ 進化成功!\n\n修改的檔案:\n${files}`;
              if (r.requiresRestart) {
                msg += '\n\n🔄 核心檔案已修改，即將重啟...';
              }
              await ctx.reply(msg);
            } else {
              await ctx.reply(`❌ 進化失敗: ${result.error}`);
            }
            return;
          }

          // goalId (short hex) or new description
          if (arg.length <= 8 && /^[a-f0-9]+$/.test(arg)) {
            await ctx.reply(`🧬 執行目標: ${arg}`);
            const result = await executePipeline(arg);
            if (isOk(result)) {
              await ctx.reply(`✅ 進化成功! ${result.value.filesChanged.length} 個檔案已修改。`);
            } else {
              await ctx.reply(`❌ 進化失敗: ${result.error}`);
            }
          } else {
            const addResult = addGoal(arg, 4);
            if (!isOk(addResult)) {
              await ctx.reply(`❌ 無法添加目標: ${addResult.error}`);
              return;
            }
            const goalId = addResult.value;
            await ctx.reply(`🧬 已添加目標並開始進化: ${arg}\n目標ID: ${goalId}`);
            const result = await executePipeline(goalId);
            if (isOk(result)) {
              await ctx.reply(`✅ 進化成功! ${result.value.filesChanged.length} 個檔案已修改。`);
            } else {
              await ctx.reply(`❌ 進化失敗: ${result.error}`);
            }
          }
        },
      },
      {
        name: 'goals',
        aliases: ['g', 'list'],
        description: '列出進化目標',
        handler: async (ctx) => {
          const goals = getAllGoals();
          if (goals.length === 0) {
            await ctx.reply('目前沒有目標。使用 /evolve add <描述> 添加。');
            return;
          }

          const lines = goals.map((g: Goal) => {
            const emoji = statusEmoji(g.status);
            const bar = priorityBar(g.priority);
            return `${emoji} [${g.id}] ${bar} ${g.description}`;
          });

          const cb = getCircuitBreakerInfo();
          const autoStatus = getAutoEvolveStatus();
          const footer = [
            '',
            `--- 狀態 ---`,
            `熔斷器: ${cb.state} (連續失敗: ${cb.consecutiveFailures})`,
            `自動進化: ${autoStatus.active ? '開啟' : '關閉'} (今日: ${autoStatus.evolvesToday}/${autoStatus.maxPerDay})`,
          ];

          await ctx.reply(lines.concat(footer).join('\n'));
        },
      },
      {
        name: 'add',
        description: '添加目標 (/evolve add [P3] 描述)',
        handler: async (ctx) => {
          const text = ctx.message?.text ?? '';
          const desc = extractArgs(text, 'add');

          if (!desc) {
            await ctx.reply('請提供目標描述。用法: /evolve add <描述>');
            return;
          }

          let priority = 3;
          let description = desc;
          const pMatch = desc.match(/^\[P(\d)]\s*/);
          if (pMatch) {
            priority = parseInt(pMatch[1]!, 10);
            description = desc.slice(pMatch[0]!.length);
          }
          const result = addGoal(description, priority);
          if (isOk(result)) {
            await ctx.reply(`✅ 已添加目標 (${result.value}): ${description} [P${priority}]`);
          } else {
            await ctx.reply(`❌ ${result.error}`);
          }
        },
      },
      {
        name: 'rm',
        aliases: ['remove', 'del'],
        description: '移除目標 (/evolve rm <id>)',
        handler: async (ctx) => {
          const text = ctx.message?.text ?? '';
          const id = extractArgs(text, '(?:rm|remove|del)');

          if (!id) {
            await ctx.reply('請提供目標ID。用法: /evolve rm <id>');
            return;
          }
          const result = removeGoal(id);
          if (isOk(result)) {
            await ctx.reply(`✅ 已移除目標: ${id}`);
          } else {
            await ctx.reply(`❌ ${result.error}`);
          }
        },
      },
      {
        name: 'suggest',
        aliases: ['s'],
        description: '資料驅動進化建議',
        handler: async (ctx) => {
          const { generateProposals, formatProposals } = await import('../metacognition/proposal-engine.js');
          const proposals = await generateProposals();
          const text = formatProposals(proposals);

          try {
            await ctx.reply(text, { parse_mode: 'Markdown' });
          } catch {
            await ctx.reply(text.replace(/\*/g, ''));
          }
        },
      },
      {
        name: 'log',
        aliases: ['changelog', 'history'],
        description: '進化記錄',
        handler: async (ctx) => {
          const changes = await getRecentChanges(10);
          if (changes.length === 0) {
            await ctx.reply('目前沒有進化記錄。');
            return;
          }

          const lines = changes.map((c) => {
            const status = c.success ? '✅' : '❌';
            const date = c.timestamp.slice(0, 16).replace('T', ' ');
            const files = c.filesChanged.length;
            return `${status} [${date}] ${c.description} (${files} files)`;
          });

          await ctx.reply(`📋 最近的進化記錄:\n\n${lines.join('\n')}`);
        },
      },
      {
        name: 'validate',
        aliases: ['check'],
        description: '驗證程式碼 (TypeScript)',
        handler: async (ctx) => {
          await ctx.reply('🔍 正在驗證...');
          const tsResult = await validateSyntax();
          if (!tsResult.ok) {
            await ctx.reply(`❌ TypeScript 檢查失敗:\n${tsResult.error}`);
            return;
          }
          await ctx.reply('✅ TypeScript 檢查通過!');
        },
      },
    ],
    defaultHandler: async (ctx) => {
      const goals = getAllGoals();
      const pending = goals.filter((g) => g.status === 'pending').length;
      const cb = getCircuitBreakerInfo();
      const autoStatus = getAutoEvolveStatus();

      const lines = [
        '*🧬 進化管理*',
        '',
        `🎯 目標: ${goals.length} 個 (${pending} 待處理)`,
        `熔斷器: ${cb.state}`,
        `自動進化: ${autoStatus.active ? '開啟' : '關閉'} (今日 ${autoStatus.evolvesToday}/${autoStatus.maxPerDay})`,
      ];

      const kb = new InlineKeyboard()
        .text('▶️ 執行進化', 'evolve:run')
        .text('🎯 目標列表', 'evolve:goals')
        .row()
        .text('💡 建議', 'evolve:suggest')
        .text('📋 記錄', 'evolve:log')
        .row()
        .text('✅ 驗證', 'evolve:validate')
        .text('◀️ 返回選單', 'menu:home');

      try {
        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
      } catch {
        await ctx.reply(lines.join('\n').replace(/[*`]/g, ''), { reply_markup: kb });
      }
    },
  });

  // Callbacks for evolve inline keyboard buttons
  commandRegistry.registerCallback('evolve:', async (ctx, data) => {
    const entry = commandRegistry.getCommand('evolve');
    if (!entry) return;

    switch (data) {
      case 'run':
      case 'goals':
      case 'suggest':
      case 'log':
      case 'validate': {
        await ctx.answerCallbackQuery();
        // Find the subcommand handler via a fresh call
        // Since we can't inject message text, directly import and call the handlers
        const handlers: Record<string, () => Promise<void>> = {
          run: async () => {
            const goal = getNextGoal();
            if (!goal) {
              await ctx.reply('目前沒有待處理的目標。');
              return;
            }
            await ctx.reply(`🧬 開始進化: ${goal.description}`);
            const result = await executePipeline(goal.id);
            if (isOk(result)) {
              await ctx.reply(`✅ 進化成功! ${result.value.filesChanged.length} 個檔案已修改。`);
            } else {
              await ctx.reply(`❌ 進化失敗: ${result.error}`);
            }
          },
          goals: async () => {
            const goals = getAllGoals();
            if (goals.length === 0) {
              await ctx.reply('目前沒有目標。');
              return;
            }
            const lines = goals.map((g: Goal) => {
              return `${statusEmoji(g.status)} [${g.id}] ${priorityBar(g.priority)} ${g.description}`;
            });
            await ctx.reply(lines.join('\n'));
          },
          suggest: async () => {
            const { generateProposals, formatProposals } = await import('../metacognition/proposal-engine.js');
            const proposals = await generateProposals();
            const text = formatProposals(proposals);
            try {
              await ctx.reply(text, { parse_mode: 'Markdown' });
            } catch {
              await ctx.reply(text.replace(/\*/g, ''));
            }
          },
          log: async () => {
            const changes = await getRecentChanges(10);
            if (changes.length === 0) {
              await ctx.reply('目前沒有進化記錄。');
              return;
            }
            const lines = changes.map((c) => {
              const status = c.success ? '✅' : '❌';
              const date = c.timestamp.slice(0, 16).replace('T', ' ');
              return `${status} [${date}] ${c.description} (${c.filesChanged.length} files)`;
            });
            await ctx.reply(`📋 最近的進化記錄:\n\n${lines.join('\n')}`);
          },
          validate: async () => {
            await ctx.reply('🔍 正在驗證...');
            const tsResult = await validateSyntax();
            if (!tsResult.ok) {
              await ctx.reply(`❌ TypeScript 檢查失敗:\n${tsResult.error}`);
              return;
            }
            await ctx.reply('✅ TypeScript 檢查通過!');
          },
        };
        await handlers[data]!();
        break;
      }
      default:
        await ctx.answerCallbackQuery({ text: '未知操作' });
    }
  });

  logger.info('commands', 'Registered /evolve with subcommands: run, goals, add, rm, suggest, log, validate');
}
