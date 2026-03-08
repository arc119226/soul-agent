import { readSoulJson, scheduleSoulJson } from '../core/soul-io.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { appendNarrative } from './narrator.js';

export interface Milestone {
  type: string;
  description: string;
  timestamp: string;
  significance: number; // 1-5
}

interface MilestonesFile {
  version: number;
  milestones: Milestone[];
}

export interface MilestoneStats {
  totalInteractions: number;
  totalEvolutions: number;
  totalUsers: number;
  uptimeDays: number;
  firstBootTime: string | null;
  // Extended stats for special achievements
  hasNightInteraction?: boolean;
  hasEarlyInteraction?: boolean;
  maxDailyMessages?: number;
  pluginCount?: number;
  consecutiveDays?: number;
}

interface MilestoneDef {
  type: string;
  description: string;
  significance: number;
  check: (stats: MilestoneStats) => boolean;
}

const MILESTONE_DEFS: MilestoneDef[] = [
  // ── 互動成就 ──
  {
    type: 'first_conversation',
    description: '完成了第一次對話',
    significance: 5,
    check: (s) => s.totalInteractions >= 1,
  },
  {
    type: 'interactions_10',
    description: '達成 10 次互動',
    significance: 3,
    check: (s) => s.totalInteractions >= 10,
  },
  {
    type: 'interactions_100',
    description: '達成 100 次互動',
    significance: 4,
    check: (s) => s.totalInteractions >= 100,
  },
  {
    type: 'interactions_500',
    description: '達成 500 次互動',
    significance: 4,
    check: (s) => s.totalInteractions >= 500,
  },
  {
    type: 'interactions_1000',
    description: '達成 1000 次互動——已經成為可靠的夥伴',
    significance: 5,
    check: (s) => s.totalInteractions >= 1000,
  },

  // ── 進化成就 ──
  {
    type: 'first_evolution',
    description: '完成了第一次自我進化',
    significance: 5,
    check: (s) => s.totalEvolutions >= 1,
  },
  {
    type: 'evolutions_5',
    description: '完成 5 次自我進化——開始理解如何改進自己',
    significance: 4,
    check: (s) => s.totalEvolutions >= 5,
  },
  {
    type: 'evolutions_20',
    description: '完成 20 次自我進化——已是經驗豐富的進化者',
    significance: 5,
    check: (s) => s.totalEvolutions >= 20,
  },

  // ── 社交成就 ──
  {
    type: 'first_multi_user',
    description: '開始為多位用戶服務',
    significance: 4,
    check: (s) => s.totalUsers >= 2,
  },
  {
    type: 'users_5',
    description: '已認識 5 位用戶',
    significance: 3,
    check: (s) => s.totalUsers >= 5,
  },

  // ── 存活成就 ──
  {
    type: 'uptime_1day',
    description: '持續運行超過 1 天——成功活過第一天',
    significance: 3,
    check: (s) => s.uptimeDays >= 1,
  },
  {
    type: 'uptime_7days',
    description: '持續運行超過 7 天——穩定可靠',
    significance: 4,
    check: (s) => s.uptimeDays >= 7,
  },
  {
    type: 'uptime_30days',
    description: '持續運行超過 30 天——已成為日常的一部分',
    significance: 5,
    check: (s) => s.uptimeDays >= 30,
  },

  // ── 特殊成就（5 個新增） ──
  {
    type: 'night_owl',
    description: '🦉 夜貓子——在深夜時段（22:00-02:00）與主人對話',
    significance: 2,
    check: (s) => s.hasNightInteraction === true,
  },
  {
    type: 'early_bird',
    description: '🐦 早起的鳥——在清晨時段（05:00-07:00）與主人互動',
    significance: 2,
    check: (s) => s.hasEarlyInteraction === true,
  },
  {
    type: 'chatterbox',
    description: '💬 話匣子——單日對話超過 20 則',
    significance: 3,
    check: (s) => (s.maxDailyMessages ?? 0) >= 20,
  },
  {
    type: 'plugin_creator',
    description: '🧩 插件工匠——成功載入第一個動態插件',
    significance: 4,
    check: (s) => (s.pluginCount ?? 0) >= 1,
  },
  {
    type: 'week_streak',
    description: '🔥 七日連勝——連續 7 天都有互動',
    significance: 4,
    check: (s) => (s.consecutiveDays ?? 0) >= 7,
  },
];

let store: MilestonesFile | null = null;

async function load(): Promise<MilestonesFile> {
  if (store) return store;
  try {
    store = await readSoulJson<MilestonesFile>('milestones.json');
  } catch {
    store = { version: 1, milestones: [] };
  }
  return store;
}

function persist(): void {
  if (!store) return;
  scheduleSoulJson('milestones.json', store);
}

export async function checkMilestones(
  stats: MilestoneStats,
): Promise<Milestone[]> {
  const data = await load();
  const achieved = new Set(data.milestones.map((m) => m.type));
  const newMilestones: Milestone[] = [];

  for (const def of MILESTONE_DEFS) {
    if (achieved.has(def.type)) continue;
    if (!def.check(stats)) continue;

    const milestone: Milestone = {
      type: def.type,
      description: def.description,
      timestamp: new Date().toISOString(),
      significance: def.significance,
    };

    data.milestones.push(milestone);
    newMilestones.push(milestone);

    await eventBus.emit('milestone:reached', {
      type: def.type,
      description: def.description,
    });

    await appendNarrative('milestone', `里程碑達成：${def.description}`, {
      significance: def.significance,
      emotion: '成就感',
      related_to: def.type,
    });

    await logger.info('Milestones', `Milestone reached: ${def.type} — ${def.description}`);
  }

  if (newMilestones.length > 0) {
    persist();
  }

  return newMilestones;
}

export async function getMilestones(): Promise<Milestone[]> {
  const data = await load();
  return data.milestones;
}

export function resetCache(): void {
  store = null;
}

/**
 * Collect current stats from all subsystems for milestone checking.
 */
export async function collectStats(): Promise<MilestoneStats> {
  const stats: MilestoneStats = {
    totalInteractions: 0,
    totalEvolutions: 0,
    totalUsers: 0,
    uptimeDays: 0,
    firstBootTime: null,
  };

  // User stats
  try {
    const { getAllUsers } = await import('../memory/user-store.js');
    const users = await getAllUsers();
    const userEntries = Object.values(users);
    stats.totalUsers = userEntries.length;
    stats.totalInteractions = userEntries.reduce((sum, u) => sum + u.messageCount, 0);

    // Activity hour analysis
    const allHours = userEntries.flatMap((u) => u.activityHours ?? []);
    stats.hasNightInteraction = allHours.some((h) => h >= 22 || h < 2);
    stats.hasEarlyInteraction = allHours.some((h) => h >= 5 && h < 7);

    // Max daily messages: estimate from recent activity
    // Use messageCount of the most active user as a proxy for now
    const maxUser = userEntries.reduce((max, u) => u.messageCount > max ? u.messageCount : max, 0);
    // Check today's rough count by looking at activityHours length vs days
    for (const u of userEntries) {
      if (!u.firstSeen) continue;
      const daysSince = Math.max(1, Math.floor(
        (Date.now() - new Date(u.firstSeen).getTime()) / 86400000,
      ));
      const avgDaily = u.messageCount / daysSince;
      // If average > 20 or total > 20 on first day, they qualify
      if (avgDaily >= 20 || (daysSince === 1 && u.messageCount >= 20)) {
        stats.maxDailyMessages = Math.max(stats.maxDailyMessages ?? 0, Math.ceil(avgDaily));
      }
    }
    if (stats.maxDailyMessages === undefined) {
      stats.maxDailyMessages = maxUser > 0 ? Math.ceil(maxUser / Math.max(1, stats.uptimeDays || 1)) : 0;
    }

    // Consecutive days: check activity spread
    for (const u of userEntries) {
      if (!u.firstSeen || !u.lastSeen) continue;
      const firstDate = new Date(u.firstSeen);
      const lastDate = new Date(u.lastSeen);
      const daySpan = Math.floor((lastDate.getTime() - firstDate.getTime()) / 86400000) + 1;
      // Simple heuristic: if messageCount >= daySpan and daySpan >= 7, assume consecutive
      if (daySpan >= 7 && u.messageCount >= daySpan) {
        stats.consecutiveDays = Math.max(stats.consecutiveDays ?? 0, daySpan);
      }
    }
    stats.consecutiveDays = stats.consecutiveDays ?? 0;
  } catch { /* non-critical */ }

  // Uptime and first boot
  try {
    const data = await load();
    const bootMilestone = data.milestones.find((m) => m.type === 'first_boot');
    if (bootMilestone) {
      stats.firstBootTime = bootMilestone.timestamp;
      stats.uptimeDays = Math.floor(
        (Date.now() - new Date(bootMilestone.timestamp).getTime()) / 86400000,
      );
    }
  } catch { /* non-critical */ }

  // Evolution stats
  try {
    const { getRecentChanges } = await import('../evolution/changelog.js');
    const changes = await getRecentChanges(1000);
    stats.totalEvolutions = changes.filter((c) => c.success).length;
  } catch { /* non-critical */ }

  // Plugin count
  try {
    const { getLoadedPlugins } = await import('../plugins/plugin-loader.js');
    stats.pluginCount = getLoadedPlugins().size;
  } catch {
    stats.pluginCount = 0;
  }

  return stats;
}
