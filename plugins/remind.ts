import type { Plugin } from '../src/plugins/plugin-api.js';

interface Reminder {
  id: string;
  userId: number;
  chatId: number;
  text: string;
  triggerAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const reminders = new Map<string, Reminder>();
let nextId = 1;

function parseTime(input: string): number | null {
  // Support formats: 30m, 2h, 1d, HH:MM
  const match = input.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const [, numStr, unit] = match;
    const num = parseInt(numStr!, 10);
    const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return Date.now() + num * (multipliers[unit!] ?? 60_000);
  }

  // HH:MM format
  const timeMatch = input.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const [, hStr, mStr] = timeMatch;
    const now = new Date();
    const target = new Date(now);
    target.setHours(parseInt(hStr!, 10), parseInt(mStr!, 10), 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1); // Next day
    }
    return target.getTime();
  }

  return null;
}

const plugin: Plugin = {
  meta: {
    name: 'remind',
    description: '提醒功能',
    icon: '⏰',
    aliases: ['提醒', '鬧鐘', 'remind'],
  },
  handler: async (ctx, args) => {
    if (!args.trim()) {
      await ctx.sendMarkdown(
        '⏰ *提醒功能*\n\n' +
        '用法：`/remind <時間> <內容>`\n' +
        '時間格式：`30m`（分鐘）、`2h`（小時）、`1d`（天）、`14:30`（指定時間）\n\n' +
        '範例：\n' +
        '`/remind 30m 喝水`\n' +
        '`/remind 2h 開會`\n' +
        '`/remind 18:00 下班`'
      );
      return;
    }

    const parts = args.trim().split(/\s+/);
    const timeStr = parts[0];
    const text = parts.slice(1).join(' ') || '時間到了！';

    if (!timeStr) {
      await ctx.sendMarkdown('請指定提醒時間，例如：`/remind 30m 喝水`');
      return;
    }

    const triggerAt = parseTime(timeStr);
    if (!triggerAt) {
      await ctx.sendMarkdown('無法解析時間格式。支援：`30m`、`2h`、`1d`、`14:30`');
      return;
    }

    const id = String(nextId++);
    const delay = triggerAt - Date.now();

    const reminder: Reminder = {
      id,
      userId: ctx.userId,
      chatId: ctx.chatId,
      text,
      triggerAt,
    };

    // Set timer (in a real implementation, this would persist across restarts)
    reminder.timer = setTimeout(async () => {
      try {
        await ctx.sendMarkdown(`⏰ *提醒*\n\n${text}`);
      } catch {
        // Chat might be unavailable
      }
      reminders.delete(id);
    }, delay);

    reminders.set(id, reminder);

    const triggerDate = new Date(triggerAt);
    const timeDisplay = triggerDate.toLocaleTimeString('zh-TW', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Taipei',
    });

    await ctx.sendMarkdown(`✅ 提醒已設定！\n\n⏰ 時間：${timeDisplay}\n📝 內容：${text}\n🔑 ID：${id}`);
  },
  dispose: () => {
    for (const [, reminder] of reminders) {
      if (reminder.timer) clearTimeout(reminder.timer);
    }
    reminders.clear();
  },
};

export default plugin;
