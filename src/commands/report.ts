/**
 * /report command — unified agent report browser with interactive UI.
 *
 * Modes:
 *   /report           — Today's dashboard with buttons per agent
 *   /report list      — All agents overview
 *   /report <agent>   — Recent reports for that agent (with detail buttons)
 *   /report <agent> N — View full report #N
 */

import { InlineKeyboard } from 'grammy';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { commandRegistry } from '../telegram/command-registry.js';
import { sendLongMessage } from '../telegram/helpers.js';
import { getTodayString } from '../core/timezone.js';
import { agentLabel } from '../agents/config/agent-labels.js';
import type { BotContext } from '../bot.js';

// ── Types ───────────────────────────────────────────────────────────

interface AgentReport {
  timestamp: string;
  agentName: string;
  taskId: string;
  prompt: string;
  result: string;
  costUsd: number;
  duration: number;
  confidence: number;
}

// ── Constants ───────────────────────────────────────────────────────

const REPORTS_DIR = join(process.cwd(), 'soul', 'agent-reports');

// ── Data Loading ────────────────────────────────────────────────────

async function listAgents(): Promise<string[]> {
  try {
    const entries = await readdir(REPORTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function loadReports(agentName: string): Promise<AgentReport[]> {
  const dir = join(REPORTS_DIR, agentName);
  const reports: AgentReport[] = [];

  try {
    const files = await readdir(dir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort().reverse();

    for (const file of jsonlFiles) {
      const raw = await readFile(join(dir, file), 'utf-8');
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line) as AgentReport;
          if (r.result?.trim() && r.result.trim().length >= 30) {
            reports.push(r);
          }
        } catch { /* skip malformed */ }
      }
    }
  } catch { /* dir doesn't exist */ }

  reports.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return reports;
}

async function loadAllReportsToday(): Promise<Map<string, AgentReport[]>> {
  const today = getTodayString();
  const agents = await listAgents();
  const result = new Map<string, AgentReport[]>();

  for (const agent of agents) {
    const filePath = join(REPORTS_DIR, agent, `${today}.jsonl`);
    const reports: AgentReport[] = [];
    try {
      const raw = await readFile(filePath, 'utf-8');
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line) as AgentReport;
          if (r.result?.trim() && r.result.trim().length >= 30) {
            reports.push(r);
          }
        } catch { /* skip */ }
      }
    } catch { /* no file for today */ }

    if (reports.length > 0) {
      result.set(agent, reports);
    }
  }

  return result;
}

// ── Display Helpers ─────────────────────────────────────────────────

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

function confidenceBar(c: number): string {
  const filled = Math.round(c * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function resolveAgent(agents: string[], input: string): string | null {
  return agents.find(
    (a) => a === input || a.startsWith(input) || agentLabel(a) === input,
  ) || null;
}

// ── Handlers ────────────────────────────────────────────────────────

/** /report — today's dashboard */
async function handleDashboard(ctx: BotContext): Promise<void> {
  const todayReports = await loadAllReportsToday();

  if (todayReports.size === 0) {
    const keyboard = new InlineKeyboard().text('📋 所有代理人', 'rpt:list');
    await ctx.reply(
      '📊 今日報告\n\n今天還沒有任何代理人報告。',
      { reply_markup: keyboard },
    );
    return;
  }

  const today = getTodayString();
  const lines: string[] = [`📊 今日報告 (${today})`, ''];

  let totalCost = 0;
  let totalReports = 0;
  const keyboard = new InlineKeyboard();
  let btnCount = 0;

  for (const [agent, reports] of todayReports) {
    const count = reports.length;
    totalReports += count;
    const cost = reports.reduce((sum, r) => sum + r.costUsd, 0);
    totalCost += cost;
    const avgConf = reports.reduce((sum, r) => sum + r.confidence, 0) / count;
    const latest = reports[0]!;

    lines.push(
      `▸ ${agentLabel(agent)} (${agent})`,
      `  ${count} 筆 | $${cost.toFixed(3)} | ${confidenceBar(avgConf)} | 最新 ${timeAgo(latest.timestamp)}`,
      '',
    );

    // 2 buttons per row
    keyboard.text(`📖 ${agentLabel(agent)}`, `rpt:agent:${agent}`);
    btnCount++;
    if (btnCount % 2 === 0) keyboard.row();
  }

  lines.push(
    '─'.repeat(30),
    `合計：${totalReports} 筆報告 | 總花費 $${totalCost.toFixed(3)}`,
  );

  if (btnCount % 2 !== 0) keyboard.row();
  keyboard.text('📋 所有代理人', 'rpt:list');

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('選擇代理人查看報告：', { reply_markup: keyboard });
}

/** /report list — all agents overview */
async function handleList(ctx: BotContext): Promise<void> {
  const agents = await listAgents();

  if (agents.length === 0) {
    await ctx.reply('📊 沒有找到任何代理人報告目錄。');
    return;
  }

  const lines: string[] = ['📊 所有代理人', ''];
  const keyboard = new InlineKeyboard();
  let btnCount = 0;

  for (const agent of agents) {
    const reports = await loadReports(agent);
    const total = reports.length;
    const latest = reports[0];

    if (total === 0) {
      lines.push(`▸ ${agentLabel(agent)} (${agent}) — 無報告`, '');
    } else {
      const cost = reports.reduce((sum, r) => sum + r.costUsd, 0);
      lines.push(
        `▸ ${agentLabel(agent)} (${agent})`,
        `  共 ${total} 筆 | $${cost.toFixed(3)} | 最新 ${timeAgo(latest!.timestamp)}`,
        '',
      );
    }
    keyboard.text(`📖 ${agentLabel(agent)}`, `rpt:agent:${agent}`);
    btnCount++;
    if (btnCount % 2 === 0) keyboard.row();
  }

  if (btnCount % 2 !== 0) keyboard.row();
  keyboard.text('📊 今日總覽', 'rpt:dashboard');

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('選擇代理人：', { reply_markup: keyboard });
}

/** /report <agent> — recent reports with navigation buttons */
async function handleAgent(ctx: BotContext, agentName: string): Promise<void> {
  const agents = await listAgents();
  const match = resolveAgent(agents, agentName);

  if (!match) {
    await ctx.reply(
      `❌ 找不到代理人「${agentName}」\n\n可用：${agents.join(', ')}`,
    );
    return;
  }

  const reports = await loadReports(match);

  if (reports.length === 0) {
    const keyboard = new InlineKeyboard().text('← 返回', 'rpt:dashboard');
    await ctx.reply(`📊 ${agentLabel(match)} — 沒有報告紀錄。`, { reply_markup: keyboard });
    return;
  }

  const recent = reports.slice(0, 5);
  const lines: string[] = [
    `📊 ${agentLabel(match)} (${match}) — 共 ${reports.length} 筆`,
    '',
  ];

  recent.forEach((r, i) => {
    const preview = truncate(
      r.result.replace(/\n/g, ' ').replace(/#{1,3}\s*/g, ''),
      120,
    );
    lines.push(
      `${i + 1}. [${r.timestamp.slice(0, 10)} ${formatTime(r.timestamp)}]`,
      `   ${preview}`,
      `   ── ${confidenceBar(r.confidence)} | $${r.costUsd.toFixed(3)} | ${Math.round(r.duration / 1000)}s`,
      '',
    );
  });

  const keyboard = new InlineKeyboard();
  recent.forEach((_r, i) => {
    keyboard.text(`#${i + 1}`, `rpt:detail:${match}:${i}`);
  });
  keyboard.row();
  if (reports.length > 5) {
    keyboard.text(`更多 (${reports.length - 5})`, `rpt:page:${match}:1`);
  }
  keyboard.text('📊 今日總覽', 'rpt:dashboard');

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('選擇報告查看詳情：', { reply_markup: keyboard });
}

/** /report <agent> N — full detail */
async function handleDetail(ctx: BotContext, agentName: string, index: number): Promise<void> {
  const agents = await listAgents();
  const match = resolveAgent(agents, agentName);

  if (!match) {
    await ctx.reply(`❌ 找不到代理人「${agentName}」`);
    return;
  }

  const reports = await loadReports(match);

  if (index < 0 || index >= reports.length) {
    await ctx.reply(`❌ 無效的編號。${agentLabel(match)} 共有 ${reports.length} 筆報告。`);
    return;
  }

  const report = reports[index]!;
  const date = report.timestamp.slice(0, 10);

  const lines = [
    `📊 ${agentLabel(match)} #${index + 1}`,
    `📅 ${date} ${formatTime(report.timestamp)}`,
    `📊 信心 ${confidenceBar(report.confidence)} (${(report.confidence * 100).toFixed(0)}%)`,
    '',
    report.result,
    '',
    `── 花費 $${report.costUsd.toFixed(3)} | 耗時 ${Math.round(report.duration / 1000)}s | 任務 ${report.taskId.slice(0, 8)}`,
  ];

  // Navigation buttons
  const keyboard = new InlineKeyboard();
  if (index > 0) {
    keyboard.text('← 上一篇', `rpt:detail:${match}:${index - 1}`);
  }
  if (index < reports.length - 1) {
    keyboard.text('下一篇 →', `rpt:detail:${match}:${index + 1}`);
  }
  keyboard.row();
  keyboard.text(`↩ ${agentLabel(match)} 列表`, `rpt:agent:${match}`);
  keyboard.text('📊 今日總覽', 'rpt:dashboard');

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('導航：', { reply_markup: keyboard });
}

/** Paginated agent reports (page 1 = items 5-9, page 2 = items 10-14, etc.) */
async function handlePage(ctx: BotContext, agentName: string, page: number): Promise<void> {
  const agents = await listAgents();
  const match = resolveAgent(agents, agentName);
  if (!match) return;

  const reports = await loadReports(match);
  const pageSize = 5;
  const start = page * pageSize;
  const slice = reports.slice(start, start + pageSize);

  if (slice.length === 0) {
    await ctx.reply('沒有更多報告了。');
    return;
  }

  const lines: string[] = [
    `📊 ${agentLabel(match)} — 第 ${page + 1} 頁（共 ${Math.ceil(reports.length / pageSize)} 頁）`,
    '',
  ];

  slice.forEach((r, i) => {
    const globalIdx = start + i;
    const preview = truncate(
      r.result.replace(/\n/g, ' ').replace(/#{1,3}\s*/g, ''),
      120,
    );
    lines.push(
      `${globalIdx + 1}. [${r.timestamp.slice(0, 10)} ${formatTime(r.timestamp)}]`,
      `   ${preview}`,
      `   ── ${confidenceBar(r.confidence)} | $${r.costUsd.toFixed(3)}`,
      '',
    );
  });

  const keyboard = new InlineKeyboard();
  slice.forEach((_r, i) => {
    keyboard.text(`#${start + i + 1}`, `rpt:detail:${match}:${start + i}`);
  });
  keyboard.row();

  if (page > 0) {
    keyboard.text('← 上一頁', `rpt:page:${match}:${page - 1}`);
  }
  if (start + pageSize < reports.length) {
    keyboard.text('下一頁 →', `rpt:page:${match}:${page + 1}`);
  }
  keyboard.row();
  keyboard.text('📊 今日總覽', 'rpt:dashboard');

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('選擇報告：', { reply_markup: keyboard });
}

// ── Registration ────────────────────────────────────────────────────

/** Report handler — handles args from /report or /content report */
export async function handleReport(ctx: Parameters<typeof handleDashboard>[0]): Promise<void> {
  const text = ctx.message?.text || '';
  const args = text.replace(/^\/(?:content\s+)?reports?\s*/i, '').trim();

  if (!args) {
    await handleDashboard(ctx);
    return;
  }

  if (args === 'list' || args === '列表') {
    await handleList(ctx);
    return;
  }

  // /report <agent> [index]
  const parts = args.split(/\s+/);
  const agentName = parts[0]!.toLowerCase();
  const indexStr = parts[1];

  if (indexStr) {
    const n = parseInt(indexStr, 10);
    if (!isNaN(n) && n >= 1) {
      await handleDetail(ctx, agentName, n - 1);
      return;
    }
  }

  await handleAgent(ctx, agentName);
}

/** Register report callback handlers (called from content.ts) */
export function registerReportCallbacks(): void {
  commandRegistry.registerCallback('rpt:dashboard', async (ctx) => {
    await handleDashboard(ctx);
  });

  commandRegistry.registerCallback('rpt:list', async (ctx) => {
    await handleList(ctx);
  });

  commandRegistry.registerCallback('rpt:agent:', async (ctx, data) => {
    await handleAgent(ctx, data);
  });

  commandRegistry.registerCallback('rpt:detail:', async (ctx, data) => {
    const sep = data.indexOf(':');
    if (sep === -1) return;
    const agent = data.slice(0, sep);
    const index = parseInt(data.slice(sep + 1), 10);
    if (isNaN(index)) return;
    await handleDetail(ctx, agent, index);
  });

  commandRegistry.registerCallback('rpt:page:', async (ctx, data) => {
    const sep = data.indexOf(':');
    if (sep === -1) return;
    const agent = data.slice(0, sep);
    const page = parseInt(data.slice(sep + 1), 10);
    if (isNaN(page)) return;
    await handlePage(ctx, agent, page);
  });
}
