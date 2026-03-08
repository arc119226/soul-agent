import { commandRegistry } from '../telegram/command-registry.js';
import { getTodayString } from '../core/timezone.js';

export function registerMyStatusCommand(): void {
  commandRegistry.registerCommand({
    name: 'mystatus',
    description: '我的狀態',
    aliases: ['我的狀態', '狀態報告'],
    handler: async (ctx) => {
      const { getVitals } = await import('../identity/vitals.js');
      const { getUser } = await import('../memory/user-store.js');
      const { getMilestones } = await import('../identity/milestones.js');

      const vitals = await getVitals();
      const userId = ctx.from?.id;
      const user = userId ? await getUser(userId) : undefined;
      const milestones = await getMilestones();

      // Calculate today's interaction count
      const todayStr = getTodayString();
      let todayCount = 0;
      if (user?.activityHours) {
        // activityHours records one entry per interaction,
        // but we need today's count — use lastSeen date as heuristic
        // Count recent activity hours that were added today
        // Since we don't have per-day breakdown, estimate from messageCount and days
        const firstSeen = user.firstSeen ? new Date(user.firstSeen) : new Date();
        const daysSince = Math.max(1, Math.floor(
          (Date.now() - firstSeen.getTime()) / 86400000,
        ));
        if (daysSince <= 1) {
          todayCount = user.messageCount;
        } else {
          // If lastSeen is today, estimate today's messages
          const lastSeenDate = user.lastSeen?.slice(0, 10);
          if (lastSeenDate === todayStr) {
            todayCount = Math.ceil(user.messageCount / daysSince);
          }
        }
      }

      // Energy bar
      const energyPct = Math.round(vitals.energy_level * 100);
      const energyBar = renderBar(vitals.energy_level);

      // Confidence bar
      const confPct = Math.round(vitals.confidence_level * 100);
      const confBar = renderBar(vitals.confidence_level);

      // Recent milestones (last 3)
      const recentMilestones = milestones
        .slice(-3)
        .map((m) => `  • ${m.description}`)
        .join('\n');

      const text = [
        `🤖 *我的狀態*`,
        ``,
        `⚡ 精力: ${energyBar} ${energyPct}%`,
        `😊 心情: ${vitals.mood}${vitals.mood_reason ? ` (${vitals.mood_reason})` : ''}`,
        `💪 信心: ${confBar} ${confPct}%`,
        `💬 今日互動: ~${todayCount} 則`,
        `🏅 成就: ${milestones.length} 個`,
        ``,
        `*近期成就:*`,
        recentMilestones || '  (尚無)',
      ].join('\n');

      try {
        await ctx.reply(text, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(text.replace(/\*/g, ''));
      }
    },
  });
}

function renderBar(ratio: number): string {
  const filled = Math.round(ratio * 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
