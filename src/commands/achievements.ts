/**
 * Achievements handler.
 * Registered as /soul achievements via soul.ts.
 */

import { getMilestones, collectStats, type Milestone } from '../identity/milestones.js';
import type { BotContext } from '../bot.js';

const SIGNIFICANCE_EMOJI: Record<number, string> = {
  5: '🏆', 4: '🏅', 3: '⭐', 2: '🌟', 1: '✨',
};

function milestoneEmoji(significance: number): string {
  return SIGNIFICANCE_EMOJI[significance] || '✨';
}

function significanceLabel(significance: number): string {
  const labels: Record<number, string> = {
    5: '史詩級', 4: '重要', 3: '值得紀念', 2: '小成就', 1: '起步',
  };
  return labels[significance] || '成就';
}

function formatMilestone(m: Milestone): string {
  const emoji = milestoneEmoji(m.significance);
  const label = significanceLabel(m.significance);
  const date = m.timestamp.slice(0, 10);
  return `${emoji} ${label}：${m.description}（${date}）`;
}

/** Achievements handler */
export async function handleAchievements(ctx: BotContext): Promise<void> {
  const [milestones, stats] = await Promise.all([
    getMilestones(),
    collectStats(),
  ]);

  const lines: string[] = [];

  if (milestones.length === 0) {
    lines.push('🏆 成就列表');
    lines.push('');
    lines.push('還沒有解鎖任何成就。繼續互動就會慢慢解鎖！');
  } else {
    lines.push(`🏆 成就列表（${milestones.length} 個）`);
    lines.push('');

    const sorted = [...milestones].sort((a, b) => {
      if (b.significance !== a.significance) return b.significance - a.significance;
      return b.timestamp.localeCompare(a.timestamp);
    });

    for (const m of sorted) {
      lines.push(formatMilestone(m));
    }
  }

  lines.push('');
  const statParts: string[] = [];
  if (stats.totalInteractions > 0) statParts.push(`互動 ${stats.totalInteractions} 次`);
  if (stats.totalEvolutions > 0) statParts.push(`進化 ${stats.totalEvolutions} 次`);
  if (stats.uptimeDays > 0) statParts.push(`運行 ${stats.uptimeDays} 天`);
  if (stats.totalUsers > 0) statParts.push(`${stats.totalUsers} 位用戶`);

  if (statParts.length > 0) {
    lines.push(`📊 統計：${statParts.join(' | ')}`);
  }

  await ctx.reply(lines.join('\n'));
}
