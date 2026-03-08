import type { Plugin } from '../src/plugins/plugin-api.js';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function buildCalendar(year: number, month: number): string {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const daysInMonth = lastDay.getDate();
  const startWeekday = firstDay.getDay();

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const todayDate = today.getDate();

  let cal = `📅 ${year}年${month}月\n\n`;
  cal += WEEKDAYS.map((d) => ` ${d} `).join('') + '\n';

  let line = '   '.repeat(startWeekday);
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = d.toString().padStart(2, ' ');
    if (isCurrentMonth && d === todayDate) {
      line += `[${dayStr}]`;
    } else {
      line += ` ${dayStr} `;
    }
    if ((startWeekday + d) % 7 === 0) {
      cal += line + '\n';
      line = '';
    }
  }
  if (line.trim()) cal += line + '\n';

  return cal;
}

const plugin: Plugin = {
  meta: {
    name: 'calendar',
    description: '日曆',
    icon: '📅',
    aliases: ['日曆', '月曆', 'calendar'],
  },
  handler: async (ctx, args) => {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth() + 1;

    if (args.trim()) {
      const parts = args.trim().split(/[\/\-\.]/);
      if (parts.length === 2) {
        year = parseInt(parts[0]!, 10) || year;
        month = parseInt(parts[1]!, 10) || month;
      } else if (parts.length === 1) {
        month = parseInt(parts[0]!, 10) || month;
      }
    }

    month = Math.max(1, Math.min(12, month));
    const cal = buildCalendar(year, month);
    await ctx.sendMarkdown('```\n' + cal + '```');
  },
};

export default plugin;
