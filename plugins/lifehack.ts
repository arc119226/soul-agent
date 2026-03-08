import type { Plugin } from '../src/plugins/plugin-api.js';

const TIPS: { category: string; tip: string }[] = [
  { category: '🍳 廚房', tip: '煮麵時加一小匙橄欖油，麵條不容易黏在一起。' },
  { category: '🍳 廚房', tip: '薑不好去皮？用湯匙刮比刀削更快更省料。' },
  { category: '🍳 廚房', tip: '切洋蔥前先放冰箱冷藏 30 分鐘，就不容易流眼淚。' },
  { category: '🍳 廚房', tip: '白飯煮好後，用筷子在飯中戳幾個洞，口感會更鬆軟。' },
  { category: '🍳 廚房', tip: '檸檬微波 15 秒再切，能擠出更多汁。' },
  { category: '🧹 清潔', tip: '用白醋加小蘇打可以疏通輕微堵塞的排水孔。' },
  { category: '🧹 清潔', tip: '鍵盤縫隙用便利貼的黏面滑過去，能黏起灰塵碎屑。' },
  { category: '🧹 清潔', tip: '不鏽鋼水漬用牙膏擦拭，輕鬆恢復光亮。' },
  { category: '🧹 清潔', tip: '衣服沾到油漬，先撒上麵粉吸油，再清洗效果更好。' },
  { category: '🧹 清潔', tip: '用洗碗精加溫水可以輕鬆清除抽油煙機的油垢。' },
  { category: '💻 科技', tip: 'Ctrl+Shift+T 可以恢復瀏覽器剛關閉的分頁。' },
  { category: '💻 科技', tip: '手機充電時開啟飛航模式，充電速度會快不少。' },
  { category: '💻 科技', tip: '螢幕截圖後可以直接貼到很多聊天軟體中，不用先存檔。' },
  { category: '💻 科技', tip: 'Wi-Fi 訊號弱？試試把路由器放高一點，訊號會更好。' },
  { category: '💻 科技', tip: '長按計算機上的數字可以複製結果，不用手動重打。' },
  { category: '🏠 居家', tip: '衣架上套個拉環，就能把兩個衣架串在一起，節省衣櫃空間。' },
  { category: '🏠 居家', tip: '鞋子有異味？放幾個茶包進去，隔夜就能除臭。' },
  { category: '🏠 居家', tip: '用長尾夾夾住牙膏尾部，擠牙膏更方便也更省。' },
  { category: '🏠 居家', tip: '橡皮筋纏在螺絲起子上，能增加摩擦力，更容易轉動滑牙的螺絲。' },
  { category: '🏠 居家', tip: '出門前拍一張門鎖和瓦斯開關的照片，就不用擔心忘記關了。' },
  { category: '🌿 健康', tip: '久坐工作每 30 分鐘站起來活動一下，對腰椎和眼睛都好。' },
  { category: '🌿 健康', tip: '睡前一小時減少藍光，可以用手機的夜間模式，幫助入睡。' },
  { category: '🌿 健康', tip: '喝水不是等渴了才喝，在桌上放瓶水隨時提醒自己。' },
  { category: '🌿 健康', tip: '午餐後散步 15 分鐘，比喝咖啡更能提振下午的精神。' },
  { category: '🌿 健康', tip: '通勤時做幾次深呼吸，4 秒吸氣、7 秒憋氣、8 秒吐氣，有效減壓。' },
];

function getTodayTip(): { category: string; tip: string } {
  const today = new Date();
  const dayOfYear = Math.floor(
    (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000
  );
  return TIPS[dayOfYear % TIPS.length]!;
}

function getRandomTip(): { category: string; tip: string } {
  return TIPS[Math.floor(Math.random() * TIPS.length)]!;
}

const plugin: Plugin = {
  meta: {
    name: 'lifehack',
    description: '每日生活小妙招',
    icon: '💡',
    aliases: ['妙招', '小撇步', '生活', 'tip', 'tips'],
  },
  handler: async (ctx, args) => {
    const sub = args.trim().toLowerCase();

    if (sub === 'random' || sub === '隨機') {
      const { category, tip } = getRandomTip();
      await ctx.sendMarkdown(`💡 *隨機生活小妙招*\n\n${category}\n${tip}`);
      return;
    }

    if (sub === 'all' || sub === '列表') {
      const grouped = new Map<string, string[]>();
      for (const t of TIPS) {
        const list = grouped.get(t.category) ?? [];
        list.push(t.tip);
        grouped.set(t.category, list);
      }
      let text = '💡 *生活小妙招大全*\n';
      for (const [cat, tips] of grouped) {
        text += `\n*${cat}*\n`;
        for (const t of tips) {
          text += `• ${t}\n`;
        }
      }
      await ctx.sendLongMessage(text);
      return;
    }

    const { category, tip } = getTodayTip();
    await ctx.sendMarkdown(`💡 *今日生活小妙招*\n\n${category}\n${tip}\n\n_輸入 \`/lifehack random\` 隨機一則，\`/lifehack all\` 看全部_`);
  },
};

export default plugin;
