/**
 * Proactive care handler.
 * Registered as /sys proactive via sys.ts.
 */

import { scheduleEngine } from '../core/schedule-engine.js';
import { getDeliveryStats, resetThrottle } from '../proactive/constraints.js';
import { getDailyPhase } from '../lifecycle/daily-rhythm.js';
import { isQuietHours } from '../lifecycle/awareness.js';
import { config } from '../config.js';
import type { BotContext } from '../bot.js';

export async function handleProactive(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.message?.text ?? '';
  const args = text.replace(/^\/(?:sys\s+)?proactive\s*/i, '').trim();

  if (args === 'reset') {
    resetThrottle();
    await ctx.reply('已重置主動關懷節流器。');
    return;
  }

  const phase = getDailyPhase();
  const schedules = scheduleEngine.getBySource('proactive').map((e) => ({
    id: e.id, cronExpr: e.cronExpr, lastRun: e.lastRun ? new Date(e.lastRun).getTime() : 0,
  }));
  const stats = getDeliveryStats(userId);
  const quiet = isQuietHours();

  const lines = [
    '*主動關懷狀態*',
    '',
    `*當前階段:* ${phase.phase} (${phase.description})`,
    `*主動程度:* ${(phase.proactiveLevel * 100).toFixed(0)}%`,
    `*安靜時段:* ${quiet ? '是' : '否'} (${config.QUIET_HOURS_START}:00-${config.QUIET_HOURS_END}:00)`,
    '',
    `*今日發送:* ${stats.today} 則`,
    ...Object.entries(stats.byType).map(
      ([type, count]) => `  ${type}: ${count}`,
    ),
    `*被忽略連續:* ${stats.ignoredStreak} 次`,
    '',
    `*排程:* ${schedules.length} 個`,
    ...schedules.map(
      (s) =>
        `  ${s.id}: ${s.cronExpr}${s.lastRun > 0 ? ` (上次: ${new Date(s.lastRun).toISOString().slice(11, 16)})` : ''}`,
    ),
    '',
    '使用 /sys proactive reset 重置節流器',
  ];

  const output = lines.join('\n');
  try {
    await ctx.reply(output, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(output.replace(/\*/g, ''));
  }
}
