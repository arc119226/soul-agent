import type { Plugin } from '../src/plugins/plugin-api.js';

const plugin: Plugin = {
  meta: {
    name: 'dice',
    description: '隨機選擇器',
    icon: '🎲',
    aliases: ['骰子', '隨機', '抽籤', 'dice'],
  },
  handler: async (ctx, args) => {
    if (!args.trim()) {
      await ctx.sendMarkdown(
        '🎲 *隨機選擇器*\n\n用法：`/dice 選項1 選項2 選項3`\n用空格分隔選項'
      );
      return;
    }

    const options = args.split(/\s+/).filter(Boolean);
    if (options.length < 2) {
      await ctx.sendMarkdown('請至少提供兩個選項！');
      return;
    }

    const chosen = options[Math.floor(Math.random() * options.length)]!;
    await ctx.sendMarkdown(`🎲 從 ${options.length} 個選項中選出：\n\n**${chosen}**`);
  },
};

export default plugin;
