import { commandRegistry } from '../telegram/command-registry.js';
import { buildMainMenu } from './menu.js';
import { config } from '../config.js';

export function registerHelpCommand(): void {
  commandRegistry.registerCommand({
    name: 'help',
    description: '使用說明',
    aliases: ['幫助', '說明', 'help'],
    handler: async (ctx) => {
      const isAdmin = ctx.from?.id === config.ADMIN_USER_ID;
      const text = [
        '📖 *使用說明*',
        '',
        '*訊息前綴*',
        '  直接輸入 → 智能分類（自動選擇模型）',
        '  /指令 → 執行指令（如 /status）',
        '  ?訊息 → 指定 Sonnet 模型',
        '  ~訊息 → 深度思考模式（直達 Opus）',
        '',
        '*常用指令*',
        '  /menu — 互動式選單',
        '  /team — 團隊儀表板',
        '  /content — 內容管理',
        '  /cost — 成本追蹤',
        '',
        `💡 共 ${commandRegistry.getCommandList().length} 個指令，點選分類瀏覽：`,
      ].join('\n');

      try {
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: buildMainMenu(isAdmin) });
      } catch {
        await ctx.reply(text.replace(/\*/g, ''), { reply_markup: buildMainMenu(isAdmin) });
      }
    },
  });
}
