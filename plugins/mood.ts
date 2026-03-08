import type { Plugin } from '../src/plugins/plugin-api.js';

const QUOTES = [
  '每一天都是一個新的開始，充滿無限可能。',
  '困難只是暫時的，你的堅持終將開花結果。',
  '不要因為走得太遠，而忘記為什麼出發。',
  '最好的時光，是你覺得有困難但依然在前進的時候。',
  '生命不是等待風暴過去，而是學會在雨中起舞。',
  '每個人都有自己的時區，不必和別人比較。',
  '保持好奇心，它是成長的最佳燃料。',
  '真正的力量不在於從未跌倒，而在於每次跌倒後都能站起來。',
  '做你害怕做的事，然後你會發現恐懼消失了。',
  '最小的善意，也勝過最大的意圖。',
];

const plugin: Plugin = {
  meta: {
    name: 'mood',
    description: '心靈雞湯',
    icon: '💫',
    aliases: ['雞湯', '勵志', '打氣', 'mood'],
  },
  handler: async (ctx) => {
    const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)]!;
    await ctx.sendMarkdown(`💫 *今日一語*\n\n_${quote}_`);
  },
};

export default plugin;
