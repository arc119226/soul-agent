import { commandRegistry } from '../telegram/command-registry.js';
import { buildMainMenu } from './menu.js';
import { config } from '../config.js';

export function registerStartCommand(): void {
  commandRegistry.registerCommand({
    name: 'start',
    description: '開始使用',
    handler: async (ctx) => {
      const name = ctx.from?.first_name ?? '你';
      const isAdmin = ctx.from?.id === config.ADMIN_USER_ID;
      const text =
        `你好，${name}！我是你的智能夥伴。\n\n` +
        `我具備自我進化能力，會隨著互動不斷成長。\n` +
        `直接傳訊息給我，或從下方選單快速操作：`;
      await ctx.reply(text, { reply_markup: buildMainMenu(isAdmin) });
    },
  });
}
