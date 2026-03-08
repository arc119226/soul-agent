import { InlineKeyboard } from 'grammy';
import { commandRegistry, registerParentCommand } from '../telegram/command-registry.js';
import { getTodayString } from '../core/timezone.js';
import type { BotContext } from '../bot.js';

// ── Helpers ──────────────────────────────────────────────────────────

function renderBar(ratio: number): string {
  const filled = Math.round(ratio * 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// ── Handlers ─────────────────────────────────────────────────────────

/** System status (original /status) */
async function handleSystemStatus(ctx: BotContext): Promise<void> {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(1);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);

  const lines = [
    `📊 *系統狀態*`,
    ``,
    `⏱ 運行時間: ${hours}h ${minutes}m`,
    `💾 記憶體: ${rss}MB (heap: ${heap}MB)`,
    `🟢 狀態: 運行中`,
    `📡 Node.js: ${process.version}`,
  ];

  // Identity health status
  try {
    const { getHealthStatus } = await import('../identity/vitals.js');
    const health = await getHealthStatus();
    if (health.status) {
      const emoji = health.status === 'healthy' ? '🟢'
        : health.status === 'degraded' ? '🟡' : '🔴';
      const ago = health.checkedAt
        ? `${Math.round((Date.now() - new Date(health.checkedAt).getTime()) / 60000)}m ago`
        : '';
      lines.push(`${emoji} 身份驗證: ${health.status}${ago ? ` (${ago})` : ''}`);
    }
  } catch {
    // Health status is non-critical
  }

  const text = lines.join('\n');

  const keyboard = new InlineKeyboard()
    .text('🤖 我的狀態', 'status:me')
    .text('📋 選單', 'menu:home');

  try {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch {
    await ctx.reply(text.replace(/\*/g, ''), { reply_markup: keyboard });
  }
}

/** Bot vitals status (original /mystatus) */
async function handleMyStatus(ctx: BotContext): Promise<void> {
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
    const firstSeen = user.firstSeen ? new Date(user.firstSeen) : new Date();
    const daysSince = Math.max(1, Math.floor(
      (Date.now() - firstSeen.getTime()) / 86400000,
    ));
    if (daysSince <= 1) {
      todayCount = user.messageCount;
    } else {
      const lastSeenDate = user.lastSeen?.slice(0, 10);
      if (lastSeenDate === todayStr) {
        todayCount = Math.ceil(user.messageCount / daysSince);
      }
    }
  }

  const energyPct = Math.round(vitals.energy_level * 100);
  const energyBar = renderBar(vitals.energy_level);
  const confPct = Math.round(vitals.confidence_level * 100);
  const confBar = renderBar(vitals.confidence_level);

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
}

// ── Registration ──────────────────────────────────────────────────────

export function registerStatusCommand(): void {
  registerParentCommand({
    name: 'status',
    description: '系統狀態 / 我的狀態',
    aliases: ['狀態', '系統'],
    subcommands: [
      {
        name: 'me',
        aliases: ['my', '我'],
        description: '我的狀態 (精力/心情/信心)',
        handler: handleMyStatus,
      },
      {
        name: 'system',
        aliases: ['sys'],
        description: '系統資訊 (uptime/memory)',
        handler: handleSystemStatus,
      },
    ],
    defaultHandler: handleSystemStatus,
  });

  // Callback for inline keyboard "我的狀態" button
  commandRegistry.registerCallback('status:me', async (ctx) => {
    await handleMyStatus(ctx as BotContext);
    await ctx.answerCallbackQuery();
  });
}
