/**
 * Agent Tuner — auto-adjust agent schedules, timeout, and maxTurns.
 *
 * Called after daily reflection to review agent value-vs-cost.
 * High-value agents get more frequent schedules; low-value ones get reduced.
 * Timeout/maxTurns are adjusted based on P95 historical durations and turn counts.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tailReadJsonl } from '../../core/tail-read.js';
import { logger } from '../../core/logger.js';
import {
  loadAllAgentConfigs,
  saveAgentConfig,
  type AgentConfig,
} from './agent-config.js';
import type { AgentReport } from '../worker-scheduler.js';

const REPORTS_DIR = join(process.cwd(), 'soul', 'agent-reports');
const HISTORY_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'history.jsonl');

// ── Schedule tiers (from most to least frequent) ─────────────────────

const SCHEDULE_TIERS = [
  'every:1h',
  'every:2h',
  'every:4h',
  'every:6h',
  'every:12h',
  'daily@08:00',
] as const;

// ── Performance Metrics ──────────────────────────────────────────────

export interface AgentMetrics {
  name: string;
  totalRuns: number;
  recentRuns: number;        // last 7 days
  successRate: number;       // 0-1
  avgCostPerRun: number;     // USD
  totalCostWeek: number;     // USD in last 7 days
  avgReportLength: number;   // chars, proxy for value
  lastRun: string | null;
  schedule: string;
  enabled: boolean;
}

// ── Gather Metrics ───────────────────────────────────────────────────

/** Load task history entries from the last N days. */
async function loadRecentHistory(days: number = 7): Promise<Array<{
  agentName: string;
  status: string;
  costUsd: number;
  duration: number;
  completedAt: string;
}>> {
  const entries: Array<{
    agentName: string;
    status: string;
    costUsd: number;
    duration: number;
    completedAt: string;
  }> = [];

  try {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const allEntries = await tailReadJsonl<{ agentName: string; status: string; costUsd: number; duration: number; completedAt: string }>(HISTORY_PATH, 300, 262144);
    for (const task of allEntries) {
      if (task.completedAt && task.completedAt >= cutoff) {
        entries.push({
          agentName: task.agentName,
          status: task.status,
          costUsd: task.costUsd || 0,
          duration: task.duration || 0,
          completedAt: task.completedAt,
        });
      }
    }
  } catch { /* history file doesn't exist yet */ }

  return entries;
}

/** Load recent agent reports for a specific agent. */
async function loadAgentReports(agentName: string, days: number = 7): Promise<AgentReport[]> {
  const reports: AgentReport[] = [];
  const now = Date.now();

  try {
    const { readdir } = await import('node:fs/promises');
    const dir = join(REPORTS_DIR, agentName);
    const files = await readdir(dir).catch(() => [] as string[]);

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;

      // Check if file date is within range
      const dateStr = file.replace('.jsonl', '');
      const fileDate = new Date(dateStr).getTime();
      if (now - fileDate > days * 86400_000) continue;

      try {
        const raw = await readFile(join(dir, file), 'utf-8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            reports.push(JSON.parse(line) as AgentReport);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }

  return reports;
}

/** Compute performance metrics for all agents. */
export async function computeAllMetrics(): Promise<AgentMetrics[]> {
  const configs = await loadAllAgentConfigs();
  const history = await loadRecentHistory(7);
  const metrics: AgentMetrics[] = [];

  for (const cfg of configs) {
    const agentHistory = history.filter((h) => h.agentName === cfg.name);
    const reports = await loadAgentReports(cfg.name, 7);

    const completed = agentHistory.filter((h) => h.status === 'completed');
    const failed = agentHistory.filter((h) => h.status === 'failed');
    const total = completed.length + failed.length;

    const totalCost = agentHistory.reduce((sum, h) => sum + h.costUsd, 0);
    const avgCost = total > 0 ? totalCost / total : 0;
    const avgLen = reports.length > 0
      ? reports.reduce((sum, r) => sum + (r.result?.length || 0), 0) / reports.length
      : 0;

    const successRate = total > 0 ? completed.length / total : 1;

    // Compute value score: success rate (60%) + report quality (40%, capped at 2000 chars)
    const reportQuality = Math.min(avgLen / 2000, 1);
    const valueScore = parseFloat((successRate * 0.6 + reportQuality * 0.4).toFixed(3));

    // Persist value score back to agent config for future access
    if (cfg.valueScore !== valueScore) {
      cfg.valueScore = valueScore;
      saveAgentConfig(cfg).catch(() => {/* non-fatal */});
    }

    metrics.push({
      name: cfg.name,
      totalRuns: cfg.totalRuns,
      recentRuns: total,
      successRate,
      avgCostPerRun: avgCost,
      totalCostWeek: totalCost,
      avgReportLength: avgLen,
      lastRun: cfg.lastRun,
      schedule: cfg.schedule,
      enabled: cfg.enabled,
    });
  }

  return metrics;
}

// ── Tuning Logic ─────────────────────────────────────────────────────

function getScheduleTierIndex(schedule: string): number {
  // Find closest match in tiers
  for (let i = 0; i < SCHEDULE_TIERS.length; i++) {
    if (schedule === SCHEDULE_TIERS[i]) return i;
  }

  // Parse interval and find closest tier
  const hourMatch = schedule.match(/^every:(\d+)h$/);
  if (hourMatch) {
    const hours = parseInt(hourMatch[1]!, 10);
    if (hours <= 1) return 0;
    if (hours <= 2) return 1;
    if (hours <= 4) return 2;
    if (hours <= 6) return 3;
    if (hours <= 12) return 4;
    return 5;
  }

  if (schedule.startsWith('daily@')) return 5;
  return -1; // manual or unknown — don't tune
}

interface TuneResult {
  agentName: string;
  action: 'increase' | 'decrease' | 'disable' | 'none';
  oldSchedule: string;
  newSchedule: string;
  reason: string;
}

/** Determine tuning action for a single agent. */
function decideTune(metrics: AgentMetrics, cfg: AgentConfig): TuneResult {
  const result: TuneResult = {
    agentName: metrics.name,
    action: 'none',
    oldSchedule: cfg.schedule,
    newSchedule: cfg.schedule,
    reason: '',
  };

  // Don't tune manual or disabled agents
  if (cfg.schedule === 'manual' || !cfg.enabled) return result;

  // Don't tune schedule-locked agents (manually configured by CTO/CEO)
  if (cfg.scheduleLocked) return result;

  const tierIdx = getScheduleTierIndex(cfg.schedule);
  if (tierIdx < 0) return result; // Unknown schedule format

  // Rule 1: High failure rate → decrease frequency
  if (metrics.recentRuns >= 3 && metrics.successRate < 0.5) {
    const newIdx = Math.min(tierIdx + 2, SCHEDULE_TIERS.length - 1);
    if (newIdx !== tierIdx) {
      result.action = 'decrease';
      result.newSchedule = SCHEDULE_TIERS[newIdx]!;
      result.reason = `成功率過低 (${(metrics.successRate * 100).toFixed(0)}%)，降頻`;
    }
    return result;
  }

  // Rule 2: Consistently failing → disable
  if (metrics.recentRuns >= 5 && metrics.successRate === 0) {
    result.action = 'disable';
    result.newSchedule = cfg.schedule;
    result.reason = `連續 ${metrics.recentRuns} 次失敗，停用`;
    return result;
  }

  // Rule 3: High value (long reports, high success) → increase frequency
  if (
    metrics.recentRuns >= 2 &&
    metrics.successRate >= 0.8 &&
    metrics.avgReportLength > 200
  ) {
    const newIdx = Math.max(tierIdx - 1, 0);
    if (newIdx !== tierIdx) {
      result.action = 'increase';
      result.newSchedule = SCHEDULE_TIERS[newIdx]!;
      result.reason = `績效良好 (${(metrics.successRate * 100).toFixed(0)}% 成功率，平均報告 ${Math.round(metrics.avgReportLength)} 字)，增頻`;
    }
    return result;
  }

  // Rule 4: Low value (short reports) → decrease frequency
  if (
    metrics.recentRuns >= 3 &&
    metrics.avgReportLength < 50 &&
    metrics.successRate >= 0.5
  ) {
    const newIdx = Math.min(tierIdx + 1, SCHEDULE_TIERS.length - 1);
    if (newIdx !== tierIdx) {
      result.action = 'decrease';
      result.newSchedule = SCHEDULE_TIERS[newIdx]!;
      result.reason = `報告內容過短 (平均 ${Math.round(metrics.avgReportLength)} 字)，降頻`;
    }
    return result;
  }

  return result;
}

// ── Public API ───────────────────────────────────────────────────────

/** Run auto-tuning for all agents. Returns list of actions taken. */
export async function tuneAgents(): Promise<TuneResult[]> {
  const allMetrics = await computeAllMetrics();
  const configs = await loadAllAgentConfigs();
  const results: TuneResult[] = [];

  for (const metrics of allMetrics) {
    const cfg = configs.find((c) => c.name === metrics.name);
    if (!cfg) continue;

    const result = decideTune(metrics, cfg);
    if (result.action === 'none') continue;

    // Apply the change
    if (result.action === 'disable') {
      cfg.enabled = false;
      await saveAgentConfig(cfg);
      await logger.info('AgentTuner', `Disabled agent "${cfg.name}": ${result.reason}`);
    } else {
      cfg.schedule = result.newSchedule;
      await saveAgentConfig(cfg);
      await logger.info('AgentTuner',
        `Tuned agent "${cfg.name}": ${result.oldSchedule} → ${result.newSchedule} (${result.reason})`);
    }

    results.push(result);
  }

  if (results.length === 0) {
    await logger.debug('AgentTuner', 'No schedule adjustments needed');
  }

  return results;
}

/** Generate a human-readable performance summary for reflection insights. */
export async function generatePerformanceSummary(): Promise<string[]> {
  const allMetrics = await computeAllMetrics();
  const insights: string[] = [];

  if (allMetrics.length === 0) return insights;

  const active = allMetrics.filter((m) => m.enabled);
  const withRuns = active.filter((m) => m.recentRuns > 0);

  if (withRuns.length === 0) {
    if (active.length > 0) {
      insights.push(`有 ${active.length} 個背景代理人已啟用，但本週尚無執行紀錄。`);
    }
    return insights;
  }

  // Overall summary
  const totalRuns = withRuns.reduce((sum, m) => sum + m.recentRuns, 0);
  const totalCost = withRuns.reduce((sum, m) => sum + m.totalCostWeek, 0);
  const avgSuccess = withRuns.reduce((sum, m) => sum + m.successRate, 0) / withRuns.length;

  insights.push(
    `背景代理人本週總計執行 ${totalRuns} 次，` +
    `成功率 ${(avgSuccess * 100).toFixed(0)}%，` +
    `花費 $${totalCost.toFixed(4)}。`,
  );

  // Per-agent highlights
  for (const m of withRuns) {
    if (m.successRate < 0.5 && m.recentRuns >= 3) {
      insights.push(`代理人「${m.name}」表現不佳（成功率 ${(m.successRate * 100).toFixed(0)}%），需要關注。`);
    } else if (m.successRate >= 0.9 && m.recentRuns >= 3) {
      insights.push(`代理人「${m.name}」表現優秀（${m.recentRuns} 次執行，${(m.successRate * 100).toFixed(0)}% 成功率）。`);
    }
  }

  return insights;
}

// ── Timeout / MaxTurns Auto-Tuning ──────────────────────────────────

/** Floors and ceilings for auto-tuned values. */
const TIMEOUT_FLOOR = 60_000;       // 1 min minimum
const TIMEOUT_CEILING = 900_000;    // 15 min maximum
const MAXTURNS_FLOOR = 10;          // minimum turns
const MAXTURNS_CEILING = 200;       // maximum turns
const P95_MULTIPLIER = 1.5;         // headroom factor

export interface ParamTuneResult {
  agentName: string;
  field: 'timeout' | 'maxTurns';
  oldValue: number;
  newValue: number;
  p95: number;
  reason: string;
}

/**
 * Compute P95 of an array of numbers.
 */
function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)]!;
}

/**
 * Auto-tune timeout and maxTurns for all agents based on historical task data.
 * Uses P95 of completed task durations/turns × multiplier with floor/ceiling bounds.
 * Respects `promptLocked` flag — won't modify locked agents.
 */
export async function tuneAgentParams(): Promise<ParamTuneResult[]> {
  const configs = await loadAllAgentConfigs();
  const history = await loadRecentHistory(14); // 14 days for better P95 accuracy
  const results: ParamTuneResult[] = [];

  for (const cfg of configs) {
    if (!cfg.enabled) continue;
    if (cfg.promptLocked) continue; // CTO-locked config, don't touch

    const agentHistory = history.filter(
      (h) => h.agentName === cfg.name && h.status === 'completed' && h.duration > 0,
    );

    // Need at least 5 data points for meaningful P95
    if (agentHistory.length < 5) continue;

    const durations = agentHistory.map((h) => h.duration);
    const p95Duration = percentile95(durations);

    // ── Timeout tuning ──
    const suggestedTimeout = Math.round(p95Duration * P95_MULTIPLIER);
    const clampedTimeout = Math.max(TIMEOUT_FLOOR, Math.min(TIMEOUT_CEILING, suggestedTimeout));
    const currentTimeout = cfg.timeout ?? 120_000;

    // Only adjust if difference is significant (>20%)
    const timeoutDiffPct = Math.abs(clampedTimeout - currentTimeout) / currentTimeout;
    if (timeoutDiffPct > 0.2) {
      results.push({
        agentName: cfg.name,
        field: 'timeout',
        oldValue: currentTimeout,
        newValue: clampedTimeout,
        p95: p95Duration,
        reason: `P95 duration ${(p95Duration / 1000).toFixed(0)}s × ${P95_MULTIPLIER} = ${(suggestedTimeout / 1000).toFixed(0)}s → clamped to ${(clampedTimeout / 1000).toFixed(0)}s`,
      });
      cfg.timeout = clampedTimeout;
    }

    // ── MaxTurns tuning (based on avgDurationMs as proxy for turn complexity) ──
    // If agent consistently finishes quickly, reduce maxTurns
    // If agent consistently takes long, increase maxTurns proportionally
    const avgDuration = cfg.avgDurationMs ?? 0;
    if (avgDuration > 0) {
      const currentMaxTurns = cfg.maxTurns ?? 100;

      // Heuristic: estimate typical turns from duration ratio
      // Agents that take >5 min on avg likely need more turns than the 50-turn default
      // Agents that finish <1 min likely don't need 100 turns
      let suggestedMaxTurns: number;
      if (avgDuration < 30_000) {
        suggestedMaxTurns = 30; // Quick tasks: 30 turns
      } else if (avgDuration < 60_000) {
        suggestedMaxTurns = 50; // 1-min tasks: 50 turns
      } else if (avgDuration < 180_000) {
        suggestedMaxTurns = 75; // 1-3 min tasks: 75 turns
      } else if (avgDuration < 300_000) {
        suggestedMaxTurns = 100; // 3-5 min tasks: 100 turns
      } else {
        suggestedMaxTurns = 150; // >5 min tasks: 150 turns
      }

      const clampedMaxTurns = Math.max(MAXTURNS_FLOOR, Math.min(MAXTURNS_CEILING, suggestedMaxTurns));
      const maxTurnsDiffPct = Math.abs(clampedMaxTurns - currentMaxTurns) / currentMaxTurns;

      if (maxTurnsDiffPct > 0.2) {
        results.push({
          agentName: cfg.name,
          field: 'maxTurns',
          oldValue: currentMaxTurns,
          newValue: clampedMaxTurns,
          p95: avgDuration,
          reason: `avgDuration ${(avgDuration / 1000).toFixed(0)}s → maxTurns ${clampedMaxTurns}`,
        });
        cfg.maxTurns = clampedMaxTurns;
      }
    }

    // Save if any changes were made for this agent
    const agentChanged = results.some(
      (r) => r.agentName === cfg.name,
    );
    if (agentChanged) {
      await saveAgentConfig(cfg);
    }
  }

  if (results.length > 0) {
    await logger.info('AgentTuner',
      `Param tuning: ${results.length} adjustment(s) — ${results.map((r) => `${r.agentName}.${r.field}: ${r.oldValue}→${r.newValue}`).join(', ')}`);
  } else {
    await logger.debug('AgentTuner', 'No timeout/maxTurns adjustments needed');
  }

  return results;
}
