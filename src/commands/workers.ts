/**
 * /workers command — display background worker queue status.
 *
 * Shows:
 *   - Pending / running task counts
 *   - Recent completed tasks with agent name, time ago, cost
 *
 * Pure display command — no callbacks or mutations.
 */

import { commandRegistry } from '../telegram/command-registry.js';
import { getQueueStatus, getRecentReports, MAX_CONCURRENT_WORKERS } from '../agents/worker-scheduler.js';
import type { BotContext } from '../bot.js';

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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleWorkers(ctx: BotContext): Promise<void> {
  const status = await getQueueStatus();
  const reports = await getRecentReports(5);

  const lines: string[] = [];

  // ELU (Event Loop Utilization) — real workload indicator
  let eluLine = '';
  try {
    const { getELU, getELUAverage } = await import('../lifecycle/elu-monitor.js');
    const cur = (getELU() * 100).toFixed(1);
    const avg = (getELUAverage() * 100).toFixed(1);
    eluLine = `📊 ELU: ${cur}% (avg: ${avg}%)`;
  } catch {
    // elu-monitor unavailable
  }

  lines.push('⚙️ Worker 狀態');
  if (eluLine) lines.push(eluLine);
  lines.push('');
  lines.push(`待處理：${status.pending} 任務`);
  lines.push(`執行中：${status.running}/${MAX_CONCURRENT_WORKERS} 通道`);

  // Show running tasks if any
  const runningTasks = status.tasks.filter((t) => t.status === 'running');
  if (runningTasks.length > 0) {
    lines.push('');
    lines.push('🔄 執行中：');
    for (const task of runningTasks) {
      const elapsed = task.startedAt
        ? timeAgo(task.startedAt)
        : '';
      lines.push(`  ├ ${task.agentName} — ${truncate(task.prompt || '(task)', 30)} (${elapsed})`);
    }
  }

  // Show pending tasks if any
  const pendingTasks = status.tasks.filter((t) => t.status === 'pending');
  if (pendingTasks.length > 0) {
    lines.push('');
    lines.push('⏳ 等待中：');
    for (let i = 0; i < pendingTasks.length; i++) {
      const task = pendingTasks[i]!;
      const connector = i === pendingTasks.length - 1 ? '└' : '├';
      lines.push(`  ${connector} ${task.agentName} — ${truncate(task.prompt || '(task)', 30)} (P${task.priority})`);
    }
  }

  // Show recent completed reports
  if (reports.length > 0) {
    lines.push('');
    lines.push('📋 最近完成：');
    for (let i = 0; i < reports.length; i++) {
      const r = reports[i]!;
      const connector = i === reports.length - 1 ? '└' : '├';
      const prompt = r.prompt || '(routine task)';
      const cost = r.costUsd ?? 0;
      const seed = truncate(prompt.split('\n')[0] || prompt, 30);
      lines.push(`  ${connector} ${r.agentName} — ${seed} (${timeAgo(r.timestamp)}, $${cost.toFixed(2)})`);
    }
  }

  if (status.total === 0 && reports.length === 0) {
    lines.push('');
    lines.push('目前沒有任何任務紀錄。');
  }

  await ctx.reply(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWorkersCommand(): void {
  commandRegistry.registerCommand({
    name: 'workers',
    description: '背景任務狀態',
    aliases: ['worker', '任務', '工作'],
    handler: handleWorkers,
  });
}
