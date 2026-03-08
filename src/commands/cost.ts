/**
 * /cost command — Agent cost tracking dashboard.
 *
 * Shows per-agent cost breakdown, daily totals, and weekly trends.
 * Data sources:
 *   - Real-time: loadAllAgentConfigs() (totalCostToday, totalRuns)
 *   - Historical: soul/agent-tasks/history.jsonl (costUsd, agentName, timestamp)
 */

import { tailReadJsonl } from '../core/tail-read.js';
import { join } from 'node:path';
import { commandRegistry } from '../telegram/command-registry.js';
import { loadAllAgentConfigs } from '../agents/config/agent-config.js';
import { getTodayString } from '../core/timezone.js';

const HISTORY_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'history.jsonl');

interface HistoryEntry {
  agentName: string;
  costUsd: number;
  completedAt?: string;
  createdAt?: string;
  status: string;
}

function getEntryDate(entry: HistoryEntry): string | null {
  const ts = entry.completedAt ?? entry.createdAt;
  return ts ? ts.slice(0, 10) : null;
}

/** Parse history.jsonl for cost aggregation */
async function loadHistory(): Promise<HistoryEntry[]> {
  const entries = await tailReadJsonl<HistoryEntry>(HISTORY_PATH, 200, 262144);
  return entries.filter((e) => typeof e.costUsd === 'number' && !!(e.completedAt || e.createdAt));
}

/** Aggregate costs by agent for a date range */
function aggregateCosts(
  entries: HistoryEntry[],
  fromDate: string,
  toDate: string,
): Map<string, { cost: number; runs: number }> {
  const map = new Map<string, { cost: number; runs: number }>();
  for (const entry of entries) {
    const date = getEntryDate(entry);
    if (!date) continue;
    if (date >= fromDate && date <= toDate) {
      const existing = map.get(entry.agentName) ?? { cost: 0, runs: 0 };
      existing.cost += entry.costUsd;
      existing.runs += 1;
      map.set(entry.agentName, existing);
    }
  }
  return map;
}

export function registerCostCommand(): void {
  commandRegistry.registerCommand({
    name: 'cost',
    description: 'Agent 成本報告',
    aliases: ['成本', '花費', '費用'],
    handler: async (ctx) => {
      const args = (ctx.message?.text ?? '').replace(/^\/\w+\s*/, '').trim();

      try {
        if (args === 'week' || args === '週') {
          // Weekly cost trend
          await showWeeklyCost(ctx);
        } else if (args) {
          // Specific agent detail
          await showAgentCost(ctx, args);
        } else {
          // Default: today's summary
          await showTodayCost(ctx);
        }
      } catch (err) {
        await ctx.reply(`成本查詢失敗: ${(err as Error).message}`);
      }
    },
  });
}

/** Show today's cost summary for all agents */
async function showTodayCost(ctx: any): Promise<void> {
  const configs = await loadAllAgentConfigs();
  const today = getTodayString();

  let totalCost = 0;
  let totalRuns = 0;
  const rows: string[] = [];

  for (const cfg of configs) {
    const dayCost = cfg.costResetDate === today ? cfg.totalCostToday : 0;
    const dayRuns = cfg.costResetDate === today ? cfg.totalRuns : 0;
    totalCost += dayCost;
    totalRuns += dayRuns;

    const limitStr = cfg.dailyCostLimit > 0 ? `$${cfg.dailyCostLimit.toFixed(2)}` : '∞';
    const pct = cfg.dailyCostLimit > 0 ? Math.round((dayCost / cfg.dailyCostLimit) * 100) : 0;
    const bar = cfg.dailyCostLimit > 0 ? (pct >= 80 ? '🔴' : pct >= 50 ? '🟡' : '🟢') : '⚪';

    rows.push(
      `${bar} ${cfg.name}\n` +
      `   $${dayCost.toFixed(4)} / ${limitStr}  (${dayRuns} runs)`,
    );
  }

  // 取得當日 metrics 中的主意識成本
  const { getCurrentMetrics } = await import('../core/metrics-collector.js');
  const currentMetrics = getCurrentMetrics();
  const mainCost = currentMetrics.cost?.mainCostUsd ?? 0;
  const tierBreakdown = currentMetrics.cost?.tierBreakdown ?? {};

  if (mainCost > 0) {
    const tierStr = Object.entries(tierBreakdown)
      .map(([tier, cost]) => `${tier}: $${(cost as number).toFixed(4)}`)
      .join(', ');
    rows.push(`\n🧠 主意識（CTO）\n   $${mainCost.toFixed(4)} (${tierStr})`);
    totalCost += mainCost;
  }

  const text = [
    `💰 *今日成本報告* (${today})`,
    ``,
    ...rows,
    ``,
    `────────────────────`,
    `📊 總計: $${totalCost.toFixed(4)} | ${totalRuns} 次執行`,
  ].join('\n');

  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/\*/g, ''));
  }
}

/** Show weekly cost trend from history */
async function showWeeklyCost(ctx: any): Promise<void> {
  const entries = await loadHistory();
  const now = new Date();
  const lines: string[] = [`💰 *過去 7 天成本趨勢*`, ``];

  let weekTotal = 0;

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = getTodayString(d);
    const dayCosts = aggregateCosts(entries, dateStr, dateStr);

    let dayTotal = 0;
    let dayRuns = 0;
    for (const v of dayCosts.values()) {
      dayTotal += v.cost;
      dayRuns += v.runs;
    }
    weekTotal += dayTotal;

    // Try to load metrics for more accurate total (includes main consciousness)
    try {
      const { loadDailyMetrics } = await import('../core/metrics-collector.js');
      const dayMetrics = await loadDailyMetrics(dateStr);
      if (dayMetrics && (dayMetrics as any).cost?.totalCostUsd) {
        const metricsTotal = (dayMetrics as any).cost.totalCostUsd as number;
        weekTotal = weekTotal - dayTotal + metricsTotal;
        dayTotal = metricsTotal;
      }
    } catch { /* fallback to history.jsonl totals */ }

    const barLen = Math.min(Math.round(dayTotal * 20), 20); // Scale: $1 = 20 blocks
    const bar = '█'.repeat(barLen) || '▏';
    const dayLabel = dateStr.slice(5); // MM-DD
    lines.push(`${dayLabel} ${bar} $${dayTotal.toFixed(2)} (${dayRuns})`);
  }

  lines.push(``);
  lines.push(`📊 週總計: $${weekTotal.toFixed(2)}`);
  lines.push(`📊 日均: $${(weekTotal / 7).toFixed(2)}`);

  const text = lines.join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/\*/g, ''));
  }
}

/** Show detailed cost for a specific agent */
async function showAgentCost(ctx: any, agentName: string): Promise<void> {
  const configs = await loadAllAgentConfigs();
  const cfg = configs.find((c) => c.name === agentName);

  if (!cfg) {
    await ctx.reply(`找不到代理人: ${agentName}\n可用: ${configs.map((c) => c.name).join(', ')}`);
    return;
  }

  const entries = await loadHistory();
  const agentEntries = entries.filter((e) => e.agentName === agentName);

  // Last 5 runs
  const recent = agentEntries.slice(-5).reverse();
  const recentLines = recent.map((e) => {
    const time = new Date(e.completedAt ?? e.createdAt ?? '').toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const status = e.status === 'completed' ? '✅' : '❌';
    return `${status} ${time} — $${e.costUsd.toFixed(4)}`;
  });

  // Lifetime total
  const lifetimeCost = agentEntries.reduce((sum, e) => sum + e.costUsd, 0);
  const lifetimeRuns = agentEntries.length;

  const today = getTodayString();
  const todayCost = cfg.costResetDate === today ? cfg.totalCostToday : 0;

  const text = [
    `💰 *${cfg.name}* 成本詳情`,
    ``,
    `📋 ${cfg.description}`,
    `⏰ 排程: ${cfg.schedule}`,
    `🤖 模型: ${cfg.model || 'default'}`,
    ``,
    `── 今日 ──`,
    `花費: $${todayCost.toFixed(4)} / $${cfg.dailyCostLimit.toFixed(2)}`,
    `執行: ${cfg.costResetDate === today ? cfg.totalRuns : 0} 次`,
    ``,
    `── 歷史 ──`,
    `總花費: $${lifetimeCost.toFixed(4)}`,
    `總執行: ${lifetimeRuns} 次`,
    `平均: $${lifetimeRuns > 0 ? (lifetimeCost / lifetimeRuns).toFixed(4) : '0.0000'}/次`,
    ``,
    `── 最近 5 次 ──`,
    ...recentLines,
  ].join('\n');

  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/\*/g, ''));
  }
}
