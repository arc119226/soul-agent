/**
 * /research command — trigger and view deep research tasks.
 *
 * Modes:
 *   /research <topic>   — Start a new deep research task on the given topic
 *   /research            — Show recent research reports
 *   /research list       — List all research reports
 */

import { InlineKeyboard } from 'grammy';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { commandRegistry } from '../telegram/command-registry.js';
import { sendLongMessage } from '../telegram/helpers.js';
import { enqueueTask, type AgentReport } from '../agents/worker-scheduler.js';
import { checkQuota, recordUsage, getUserQuota } from '../web/user-quota.js';
import type { BotContext } from '../bot.js';

const RESEARCHER_DIR = join(process.cwd(), 'soul', 'agent-reports', 'deep-researcher');

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function isUsableReport(report: AgentReport): boolean {
  const result = report.result?.trim();
  if (!result || result.length < 30) return false;

  if (result.startsWith('{') && result.includes('"type"')) {
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>;
      if (parsed.is_error === true || parsed.subtype === 'error_max_turns') {
        return false;
      }
    } catch { /* not valid JSON — keep it */ }
  }

  return true;
}

async function loadResearchReports(): Promise<AgentReport[]> {
  const reports: AgentReport[] = [];

  try {
    const files = await readdir(RESEARCHER_DIR);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort().reverse();

    for (const file of jsonlFiles) {
      const raw = await readFile(join(RESEARCHER_DIR, file), 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const report = JSON.parse(line) as AgentReport;
          if (isUsableReport(report)) {
            reports.push(report);
          }
        } catch { /* skip malformed */ }
      }
    }
  } catch { /* dir doesn't exist yet */ }

  reports.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return reports;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  const days = Math.floor(hours / 24);
  return `${days}d 前`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function extractTopic(prompt: string): string {
  // Try to extract from "主題：XXX" line
  const topicMatch = prompt.match(/主題[：:]\s*(.+)/);
  if (topicMatch?.[1]) return topicMatch[1].trim().slice(0, 60);
  // Fallback to first line
  return truncate(prompt.split('\n')[0] || prompt, 60);
}

function formatReportDetail(report: AgentReport, index: number): string {
  const date = report.timestamp.slice(0, 10);
  const time = new Date(report.timestamp).toLocaleTimeString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
  });

  return [
    `📚 研究 #${index + 1}`,
    `📅 ${date} ${time}`,
    '',
    `🔬 主題：${extractTopic(report.prompt)}`,
    '',
    report.result,
    '',
    `── 花費 $${report.costUsd.toFixed(2)} | 耗時 ${Math.round(report.duration / 1000)}s`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleResearchNew(ctx: BotContext, topic: string): Promise<void> {
  // Check user quota before dispatching
  const userId = ctx.from?.id;
  if (userId) {
    const { allowed, reason } = checkQuota(userId);
    if (!allowed) {
      const quota = getUserQuota(userId);
      await ctx.reply(
        `⚠️ ${reason}\n\n` +
        `📊 今日已用 ${quota.usedToday}/${quota.dailyLimit} 次\n` +
        `💎 目前方案：${quota.tier === 'premium' ? 'Premium' : 'Free'}`,
      );
      return;
    }
  }

  // Build research prompt (same format as pipeline's buildResearchPrompt)
  const prompt = [
    `## 深度研究任務`,
    '',
    `主題：${topic}`,
    '',
    `## 研究步驟`,
    '',
    '1. 用 2-3 次搜尋理解主題的全貌',
    '2. 閱讀最相關的 2-3 個網頁，提取關鍵資訊',
    '3. 彙整成結構化的研究報告',
    '',
    '## 報告格式',
    '',
    '# {主題} 深度研究報告',
    '',
    '> 研究日期：{今天日期}',
    '',
    '## 概述',
    '{2-3 句概括}',
    '',
    '## 關鍵發現',
    '### 1. {發現標題}',
    '{說明，附來源}',
    '',
    '(列出 3-5 個關鍵發現)',
    '',
    '## 與我們專案的關聯',
    '{這些發現對 本專案有什麼啟發或應用？}',
    '',
    '## 延伸問題',
    '1. {值得繼續研究的問題}',
    '2. {值得繼續研究的問題}',
    '',
    '## 重要性：X/5',
    '',
    '## 注意事項',
    '- 用繁體中文撰寫',
    '- 每個發現標注來源（URL）',
    '- 整份報告 500-1000 字',
  ].join('\n');

  try {
    const taskId = await enqueueTask('deep-researcher', prompt, 8);

    // Record usage for quota tracking
    if (userId) {
      recordUsage(userId, 'deep-researcher');
    }

    const quota = userId ? getUserQuota(userId) : null;
    const quotaLine = quota ? `\n📊 今日配額：${quota.usedToday}/${quota.dailyLimit}` : '';

    await ctx.reply(
      `📚 已派遣深度研究任務\n\n` +
      `主題：${topic}\n` +
      `任務 ID：${taskId.slice(0, 8)}\n\n` +
      `研究代理人將在背景執行，完成後可用 /research 查看結果。${quotaLine}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`研究任務派遣失敗：${msg}`);
  }
}

async function handleResearchDefault(ctx: BotContext): Promise<void> {
  const reports = await loadResearchReports();

  if (reports.length === 0) {
    await ctx.reply(
      '還沒有深度研究紀錄。\n\n' +
      '使用方式：/research <主題>\n' +
      '例如：/research MCP 生態系最新發展',
    );
    return;
  }

  const recent = reports.slice(0, 3);
  const lines: string[] = [`📚 最近的深度研究（共 ${reports.length} 筆）`, ''];

  recent.forEach((r, i) => {
    const topic = extractTopic(r.prompt);
    const preview = truncate(r.result, 200);
    lines.push(`${i + 1}. ${topic}`);
    lines.push(`   ${preview}`);
    lines.push(`   ── ${timeAgo(r.timestamp)} | $${r.costUsd.toFixed(2)}`);
    lines.push('');
  });

  const keyboard = new InlineKeyboard();
  recent.forEach((_r, i) => {
    keyboard.text(`📖 #${i + 1} 詳情`, `research:detail:${i}`);
  });
  if (reports.length > 3) {
    keyboard.row().text('📋 所有研究', 'research:list');
  }

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('點選查看詳情：', { reply_markup: keyboard });
}

async function handleResearchList(ctx: BotContext): Promise<void> {
  const reports = await loadResearchReports();

  if (reports.length === 0) {
    await ctx.reply('還沒有深度研究紀錄。');
    return;
  }

  const lines: string[] = [`📚 所有深度研究（共 ${reports.length} 筆）`, ''];
  const keyboard = new InlineKeyboard();

  const byDate = new Map<string, { report: AgentReport; globalIndex: number }[]>();
  reports.forEach((r, i) => {
    const date = r.timestamp.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push({ report: r, globalIndex: i });
  });

  for (const [date, entries] of byDate) {
    lines.push(`📅 ${date}`);
    for (const { report, globalIndex } of entries) {
      const topic = extractTopic(report.prompt);
      lines.push(`  ${globalIndex + 1}. ${topic}`);
      keyboard.text(`#${globalIndex + 1}`, `research:detail:${globalIndex}`).row();
    }
    lines.push('');
  }

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('點選查看詳情：', { reply_markup: keyboard });
}

async function handleResearchDetail(ctx: BotContext, index: number): Promise<void> {
  const reports = await loadResearchReports();

  if (index < 0 || index >= reports.length) {
    await ctx.reply(`找不到研究 #${index + 1}。目前共有 ${reports.length} 筆研究。`);
    return;
  }

  const report = reports[index]!;
  const text = formatReportDetail(report, index);

  const keyboard = new InlineKeyboard()
    .text('📋 返回列表', 'research:list')
    .text('📚 最近研究', 'research:recent');

  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('操作：', { reply_markup: keyboard });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Research handler — handles args from /research or /content research */
export async function handleResearch(ctx: Parameters<typeof handleResearchDefault>[0]): Promise<void> {
  const text = ctx.message?.text || '';
  const args = text.replace(/^\/(?:content\s+)?research\s*/i, '').trim();

  if (!args) {
    await handleResearchDefault(ctx);
  } else if (args === 'list') {
    await handleResearchList(ctx);
  } else if (args === 'quota') {
    await handleQuota(ctx);
  } else {
    const n = parseInt(args, 10);
    if (!isNaN(n) && n >= 1 && args.length <= 3) {
      await handleResearchDetail(ctx, n - 1);
    } else {
      await handleResearchNew(ctx, args);
    }
  }
}

/** Show user's research quota and usage stats. */
async function handleQuota(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('無法取得使用者 ID。');
    return;
  }

  const quota = getUserQuota(userId);
  const { getUserUsageStats } = await import('../web/user-quota.js');
  const stats = getUserUsageStats(userId);

  const lines = [
    `📊 研究配額`,
    '',
    `💎 方案：${quota.tier === 'premium' ? 'Premium' : 'Free'}`,
    `📅 今日：${quota.usedToday}/${quota.dailyLimit} 次`,
    `📈 近 7 天：${stats.last7d} 次`,
    `💰 累計花費：$${stats.totalCost.toFixed(4)}`,
    `🔢 歷史總計：${quota.totalLifetime} 次`,
  ];

  if (quota.premiumUntil) {
    lines.push(`⏰ Premium 到期：${quota.premiumUntil.slice(0, 10)}`);
  }

  await ctx.reply(lines.join('\n'));
}

/** Register research callback handlers (called from content.ts) */
export function registerResearchCallbacks(): void {
  commandRegistry.registerCallback('research:detail:', async (ctx, data) => {
    const index = parseInt(data, 10);
    if (isNaN(index)) {
      await ctx.reply('無效的研究索引。');
      return;
    }
    await handleResearchDetail(ctx, index);
  });

  commandRegistry.registerCallback('research:list', async (ctx) => {
    await handleResearchList(ctx);
  });

  commandRegistry.registerCallback('research:recent', async (ctx) => {
    await handleResearchDefault(ctx);
  });
}
