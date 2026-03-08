/**
 * /team command — AI team dashboard for the CEO.
 *
 * Single-glance view of the entire agent team:
 *   - Team size (active / disabled)
 *   - Who's working right now
 *   - Who's idle and when they last reported
 *   - Active pipeline runs
 *   - Cost breakdown: daily / weekly / monthly
 *
 * Operating model: 甲方外包制
 *   CEO (Arc) → CTO (主意識) → Persistent Agents (內部) + Task Agents (乙方)
 */

import { tailReadJsonl } from '../core/tail-read.js';
import { join } from 'node:path';
import { commandRegistry } from '../telegram/command-registry.js';
import { loadAllAgentConfigs } from '../agents/config/agent-config.js';
import { getQueueStatus, getRecentReports } from '../agents/worker-scheduler.js';
import { getActivePipelines } from '../agents/pipeline-engine.js';
import { getTodayString } from '../core/timezone.js';
import type { BotContext } from '../bot.js';

// ── Constants ─────────────────────────────────────────────────────────

const HISTORY_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'history.jsonl');

const AGENT_ICONS: Record<string, string> = {
  'explorer': '🔭',
  'crypto-analyst': '📈',
  'market-researcher': '📊',
  'hackernews-digest': '📰',
  'blog-writer': '✏️',
  'blog-publisher': '🚀',
  'comment-monitor': '💬',
  'github-patrol': '🔍',
  'security-scanner': '🛡️',
  'deep-researcher': '🔬',
  'summarizer': '📝',
};

const DEPT_MAP: Record<string, string> = {
  'explorer': '情報',
  'market-researcher': '情報',
  'crypto-analyst': '情報',
  'hackernews-digest': '情報',
  'github-patrol': '情報',
  'security-scanner': '情報',
  'deep-researcher': '內容',
  'blog-writer': '內容',
  'blog-publisher': '內容',
  'summarizer': '內容',
  'comment-monitor': '監控',
};

const MS_PER_DAY = 86_400_000;

// ── Helpers ───────────────────────────────────────────────────────────

function agentIcon(name: string): string {
  return AGENT_ICONS[name] ?? '🤖';
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '剛剛';
  if (minutes < 60) return `${minutes}分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小時前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function scheduleLabel(schedule: string): string {
  if (schedule === 'manual') return '手動';
  if (schedule.startsWith('every:')) {
    const val = schedule.slice(6);
    return `每${val}`;
  }
  if (schedule.startsWith('daily@')) {
    return `每日 ${schedule.slice(6)}`;
  }
  return schedule;
}

interface HistoryEntry {
  agentName: string;
  costUsd: number;
  timestamp: string;
  status: string;
}

async function loadAllHistory(): Promise<HistoryEntry[]> {
  const entries = await tailReadJsonl<HistoryEntry>(HISTORY_PATH, 1000, 524288);
  return entries.filter((e) => typeof e.costUsd === 'number');
}

function sumCostSince(history: HistoryEntry[], sinceMs: number): number {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  return history
    .filter((e) => e.timestamp >= cutoff)
    .reduce((sum, e) => sum + e.costUsd, 0);
}

function countRunsSince(history: HistoryEntry[], sinceMs: number): number {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  return history.filter((e) => e.timestamp >= cutoff).length;
}

// ── Handler ───────────────────────────────────────────────────────────

async function handleTeam(ctx: BotContext): Promise<void> {
  const [configs, queueStatus, recentReports, activePipes, allHistory] = await Promise.all([
    loadAllAgentConfigs(),
    getQueueStatus(),
    getRecentReports(10),
    Promise.resolve(getActivePipelines()),
    loadAllHistory(),
  ]);

  const today = getTodayString();
  const lines: string[] = [];

  // ── Header with team size ──
  const enabledCount = configs.filter((c) => c.enabled).length;
  const disabledCount = configs.filter((c) => !c.enabled).length;
  const sizeStr = disabledCount > 0
    ? `${enabledCount} 活躍 / ${disabledCount} 停用`
    : `${enabledCount} 位`;
  lines.push(`👥 AI 團隊儀表板 — ${sizeStr}`);
  lines.push('');

  // ── Running Now ──
  const runningTasks = queueStatus.tasks.filter((t) => t.status === 'running');
  if (runningTasks.length > 0) {
    lines.push('🔄 正在工作：');
    for (const task of runningTasks) {
      const icon = agentIcon(task.agentName);
      const elapsed = task.startedAt ? timeAgo(task.startedAt) : '';
      const prompt = (task.prompt || '').split('\n')[0]?.slice(0, 35) || '例行任務';
      lines.push(`  ${icon} ${task.agentName} — ${prompt} (${elapsed})`);
    }
    lines.push('');
  }

  // ── Active Pipelines ──
  if (activePipes.length > 0) {
    lines.push('⚡ Pipeline 執行中：');
    for (const pipe of activePipes) {
      const stages = Object.values(pipe.stages);
      const done = stages.filter((s) => s.status === 'completed').length;
      const total = stages.length;
      const running = stages.filter((s) => s.status === 'running').map((s) => s.agentName);
      lines.push(`  📋 ${pipe.teamName} — ${done}/${total} 階段完成 ($${pipe.totalCostUsd.toFixed(2)})`);
      if (running.length > 0) {
        lines.push(`     執行中: ${running.map((n) => `${agentIcon(n)} ${n}`).join(', ')}`);
      }
    }
    lines.push('');
  }

  // ── Pending Queue ──
  const pendingTasks = queueStatus.tasks.filter((t) => t.status === 'pending');
  if (pendingTasks.length > 0) {
    lines.push(`⏳ 排隊中 (${pendingTasks.length})：`);
    for (const task of pendingTasks.slice(0, 3)) {
      lines.push(`  ${agentIcon(task.agentName)} ${task.agentName}`);
    }
    if (pendingTasks.length > 3) {
      lines.push(`  ... 還有 ${pendingTasks.length - 3} 個`);
    }
    lines.push('');
  }

  // ── Team Roster ──
  const enabledAgents = configs.filter((c) => c.enabled);
  const disabledAgents = configs.filter((c) => !c.enabled);
  const runningNames = new Set(runningTasks.map((t) => t.agentName));

  // Find last report time for each agent
  const lastReportMap = new Map<string, string>();
  for (const r of recentReports) {
    if (!lastReportMap.has(r.agentName)) {
      lastReportMap.set(r.agentName, r.timestamp);
    }
  }
  // Also check full history for latest timestamps
  for (const h of allHistory) {
    const existing = lastReportMap.get(h.agentName);
    if (!existing || h.timestamp > existing) {
      lastReportMap.set(h.agentName, h.timestamp);
    }
  }

  // Group agents by department
  const deptOrder = ['情報', '內容', '監控'];
  const deptAgents = new Map<string, typeof enabledAgents>();
  for (const agent of enabledAgents) {
    const dept = DEPT_MAP[agent.name] ?? '其他';
    const list = deptAgents.get(dept) ?? [];
    list.push(agent);
    deptAgents.set(dept, list);
  }

  lines.push('📋 團隊成員：');
  for (const dept of deptOrder) {
    const agents = deptAgents.get(dept);
    if (!agents || agents.length === 0) continue;
    lines.push(`  【${dept}】`);
    for (const agent of agents) {
      const icon = agentIcon(agent.name);
      const isRunning = runningNames.has(agent.name);
      const status = isRunning ? '🟢' : '⚪';
      const lastReport = lastReportMap.get(agent.name);
      const lastStr = lastReport ? timeAgo(lastReport) : '尚無報告';
      const sched = scheduleLabel(agent.schedule);
      lines.push(`  ${status} ${icon} ${agent.name} (${sched}) — ${isRunning ? '工作中' : lastStr}`);
    }
  }
  // Ungrouped agents
  const ungrouped = enabledAgents.filter((a) => !deptOrder.includes(DEPT_MAP[a.name] ?? ''));
  for (const agent of ungrouped) {
    const icon = agentIcon(agent.name);
    const isRunning = runningNames.has(agent.name);
    const status = isRunning ? '🟢' : '⚪';
    const lastReport = lastReportMap.get(agent.name);
    const lastStr = lastReport ? timeAgo(lastReport) : '尚無報告';
    const sched = scheduleLabel(agent.schedule);
    lines.push(`  ${status} ${icon} ${agent.name} (${sched}) — ${isRunning ? '工作中' : lastStr}`);
  }
  if (disabledAgents.length > 0) {
    lines.push(`  ⛔ ${disabledAgents.map((a) => a.name).join(', ')} (已停用)`);
  }
  lines.push('');

  // ── Cost Breakdown: daily / weekly / monthly ──
  const dayCost = sumCostSince(allHistory, MS_PER_DAY);
  const weekCost = sumCostSince(allHistory, MS_PER_DAY * 7);
  const monthCost = sumCostSince(allHistory, MS_PER_DAY * 30);
  const dayRuns = countRunsSince(allHistory, MS_PER_DAY);
  const weekRuns = countRunsSince(allHistory, MS_PER_DAY * 7);

  lines.push(`💰 今日 $${dayCost.toFixed(2)} (${dayRuns}次) | 本週 $${weekCost.toFixed(2)} (${weekRuns}次) | 本月 $${monthCost.toFixed(2)}`);

  // Top 3 spenders today (from agent configs for accuracy)
  const spenders = configs
    .filter((c) => c.costResetDate === today && c.totalCostToday > 0)
    .sort((a, b) => b.totalCostToday - a.totalCostToday)
    .slice(0, 3);

  if (spenders.length > 0) {
    const spenderStr = spenders
      .map((c) => `${agentIcon(c.name)} ${c.name} $${c.totalCostToday.toFixed(3)}`)
      .join(' | ');
    lines.push(`   ${spenderStr}`);
  }

  // ── No activity fallback ──
  if (runningTasks.length === 0 && activePipes.length === 0 && pendingTasks.length === 0 && dayRuns === 0) {
    lines.push('');
    lines.push('💤 今天還沒有任何活動。');
  }

  await ctx.reply(lines.join('\n'));
}

// ── Registration ──────────────────────────────────────────────────────

export function registerTeamCommand(): void {
  commandRegistry.registerCommand({
    name: 'team',
    description: 'AI 團隊儀表板',
    aliases: ['團隊', '看板'],
    handler: handleTeam,
  });
}
