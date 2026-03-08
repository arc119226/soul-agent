/**
 * Agent Performance Trend Observability (SPEC-08)
 *
 * Daily snapshot of all agent stats + queryable trend data.
 * Snapshots stored in soul/agent-stats/daily/{YYYY-MM-DD}.json
 */

import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../../core/debounced-writer.js';
import { logger } from '../../core/logger.js';
import { loadAllAgentConfigs } from '../config/agent-config.js';
import { detectAgentDrift, type AgentDriftReport } from './drift-detector.js';
import { getDb } from '../../core/database.js';

const STATS_DIR = join(process.cwd(), 'soul', 'agent-stats', 'daily');

// ── Handoff Stats Query ─────────────────────────────────────────────

interface HandoffStatsResult {
  handoffsSent: number;
  handoffsReceived: number;
  feedbackRounds: number;
  durationCv: number;
}

/**
 * Query agent_tasks DB for HANDOFF coordination metrics on a given date.
 * All queries use parameterized statements (no SQL injection risk).
 */
export function queryHandoffStats(agentName: string, date: string): HandoffStatsResult {
  const db = getDb();
  const datePrefix = `${date}%`;

  // handoffsSent: tasks created via HANDOFF where this agent was the origin
  const sentRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM agent_tasks WHERE source = 'handoff' AND origin_agent = ? AND created_at LIKE ?`
  ).get(agentName, datePrefix) as { cnt: number } | undefined;

  // handoffsReceived: tasks this agent received via HANDOFF
  const recvRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM agent_tasks WHERE source = 'handoff' AND agent_name = ? AND created_at LIKE ?`
  ).get(agentName, datePrefix) as { cnt: number } | undefined;

  // feedbackRounds: tasks with feedback iteration tags in prompt
  const fbRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM agent_tasks WHERE agent_name = ? AND created_at LIKE ? AND prompt LIKE '%[feedbackIteration:%'`
  ).get(agentName, datePrefix) as { cnt: number } | undefined;

  // durationCv: coefficient of variation (σ/μ) of completed task durations
  const durRows = db.prepare(
    `SELECT duration FROM agent_tasks WHERE agent_name = ? AND created_at LIKE ? AND duration IS NOT NULL AND status = 'completed'`
  ).all(agentName, datePrefix) as { duration: number }[];

  let durationCv = 0;
  if (durRows.length >= 2) {
    const durations = durRows.map(r => r.duration);
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    if (mean > 0) {
      const variance = durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length;
      durationCv = Math.sqrt(variance) / mean;
    }
  }

  return {
    handoffsSent: sentRow?.cnt ?? 0,
    handoffsReceived: recvRow?.cnt ?? 0,
    feedbackRounds: fbRow?.cnt ?? 0,
    durationCv: Math.round(durationCv * 1000) / 1000,  // 3 decimal places
  };
}

// ── Types ────────────────────────────────────────────────────────────

export interface AgentDayStats {
  runs: number;
  failures: number;
  totalCost: number;
  avgConfidence: number;
  avgDuration: number;
  topFailureReason?: string;
  handoffsSent?: number;
  handoffsReceived?: number;
  feedbackRounds?: number;
  durationCv?: number;
}

export interface DailyAgentStats {
  date: string;
  agents: Record<string, AgentDayStats>;
  systemTotals: {
    totalCost: number;
    totalRuns: number;
    totalFailures: number;
    activeAgents: number;
  };
}

export interface TrendPoint {
  date: string;
  value: number;
}

export interface TrendData {
  agentName: string;
  days: number;
  costTrend: TrendPoint[];
  failureTrend: TrendPoint[];
  confidenceTrend: TrendPoint[];
  handoffFeedbackRateTrend: TrendPoint[];
  durationCvTrend: TrendPoint[];
  summary: {
    costChangePercent: number | null;
    failureChangePercent: number | null;
    recommendation: string;
  };
  /** Concept drift analysis via Page-Hinkley test (populated when ≥5 data points) */
  drift?: AgentDriftReport;
}

// ── Snapshot ──────────────────────────────────────────────────────────

/**
 * Add a single agent's daily stats to the snapshot file (additive/merge).
 * Called from recordAgentRun() BEFORE cost reset — captures the agent's
 * data while it's still intact, avoiding the race condition where concurrent
 * agents resetting costResetDate would make them invisible to bulk queries.
 */
export async function addAgentToSnapshot(
  date: string,
  agentName: string,
  stats: AgentDayStats,
): Promise<void> {
  if (stats.runs === 0 && stats.totalCost === 0) return; // skip inactive agents

  // Enrich with handoff coordination metrics from DB
  try {
    const handoff = queryHandoffStats(agentName, date);
    stats.handoffsSent = handoff.handoffsSent;
    stats.handoffsReceived = handoff.handoffsReceived;
    stats.feedbackRounds = handoff.feedbackRounds;
    stats.durationCv = handoff.durationCv;
  } catch {
    // non-fatal: DB may not be available in all contexts (e.g. tests)
  }

  await mkdir(STATS_DIR, { recursive: true });
  const filePath = join(STATS_DIR, `${date}.json`);

  // Load existing snapshot or create new
  let snapshot: DailyAgentStats;
  try {
    const raw = await readFile(filePath, 'utf-8');
    snapshot = JSON.parse(raw) as DailyAgentStats;
  } catch {
    snapshot = {
      date,
      agents: {},
      systemTotals: { totalCost: 0, totalRuns: 0, totalFailures: 0, activeAgents: 0 },
    };
  }

  // Add/update this agent's entry
  snapshot.agents[agentName] = stats;

  // Recompute system totals from all agents in snapshot
  let totalCost = 0, totalRuns = 0, totalFailures = 0;
  const activeAgents = Object.keys(snapshot.agents).length;
  for (const agentStats of Object.values(snapshot.agents)) {
    totalCost += agentStats.totalCost;
    totalRuns += agentStats.runs;
    totalFailures += agentStats.failures;
  }
  snapshot.systemTotals = { totalCost, totalRuns, totalFailures, activeAgents };

  await writer.writeNow(filePath, snapshot);
  await logger.info('StatsSnapshot',
    `Agent ${agentName} added to ${date} snapshot (${activeAgents} agents, $${totalCost.toFixed(4)})`);
}

/**
 * Fallback: snapshot remaining agents whose costResetDate still matches
 * the target date (agents that haven't run on the new day yet).
 * Called from checkScheduledAgents() daily tick.
 * Additive — merges with data already captured by addAgentToSnapshot.
 */
export async function snapshotDailyStats(date: string): Promise<void> {
  await mkdir(STATS_DIR, { recursive: true });

  const configs = await loadAllAgentConfigs();
  let added = 0;

  for (const cfg of configs) {
    // Only include agents that still have the target date (not yet reset)
    if (cfg.costResetDate !== date) continue;

    const runs = cfg.runsToday ?? 0;
    const cost = cfg.totalCostToday ?? 0;
    if (runs === 0 && cost === 0) continue;

    await addAgentToSnapshot(date, cfg.name, {
      runs,
      failures: cfg.failureCount7d ?? 0,
      totalCost: cost,
      avgConfidence: cfg.valueScore ?? 0,
      avgDuration: cfg.avgDurationMs ?? 0,
      topFailureReason: cfg.lastFailureReason ?? undefined,
    });
    added++;
  }

  if (added > 0) {
    await logger.info('StatsSnapshot', `Fallback snapshot: added ${added} remaining agents for ${date}`);
  }
}

// ── Trends ───────────────────────────────────────────────────────────

/**
 * Read recent daily snapshots and compute trend metrics for an agent.
 */
export async function getAgentTrends(agentName: string, days: number = 7): Promise<TrendData> {
  await mkdir(STATS_DIR, { recursive: true });

  let files: string[];
  try {
    files = (await readdir(STATS_DIR))
      .filter(f => f.endsWith('.json'))
      .sort(); // lexicographic = chronological for YYYY-MM-DD
  } catch {
    files = [];
  }

  const recent = files.slice(-days);

  const costTrend: TrendPoint[] = [];
  const failureTrend: TrendPoint[] = [];
  const confidenceTrend: TrendPoint[] = [];
  const handoffFeedbackRateTrend: TrendPoint[] = [];
  const durationCvTrend: TrendPoint[] = [];

  for (const file of recent) {
    try {
      const raw = await readFile(join(STATS_DIR, file), 'utf-8');
      const snapshot = JSON.parse(raw) as DailyAgentStats;
      const agentData = snapshot.agents[agentName];

      const date = snapshot.date;
      if (agentData) {
        costTrend.push({ date, value: agentData.totalCost });
        failureTrend.push({ date, value: agentData.failures });
        confidenceTrend.push({ date, value: agentData.avgConfidence });

        // Coordination metrics: compute handoff feedback rate
        const totalHandoffs = (agentData.handoffsSent ?? 0) + (agentData.handoffsReceived ?? 0);
        const fbRate = totalHandoffs > 0 ? (agentData.feedbackRounds ?? 0) / totalHandoffs : 0;
        handoffFeedbackRateTrend.push({ date, value: fbRate });
        durationCvTrend.push({ date, value: agentData.durationCv ?? 0 });
      } else {
        // Agent had no activity that day
        costTrend.push({ date, value: 0 });
        failureTrend.push({ date, value: 0 });
        confidenceTrend.push({ date, value: 0 });
        handoffFeedbackRateTrend.push({ date, value: 0 });
        durationCvTrend.push({ date, value: 0 });
      }
    } catch {
      // skip malformed files
    }
  }

  const costChange = computeChangePercent(costTrend);
  const failureChange = computeChangePercent(failureTrend);

  // ── Concept drift detection (Page-Hinkley) ──
  const drift = detectAgentDrift(
    agentName, costTrend, confidenceTrend, failureTrend,
    handoffFeedbackRateTrend, durationCvTrend,
  );

  let recommendation = 'Stable — no significant changes detected.';
  if (drift.hasDrift) {
    // Drift takes priority — it catches slow changes that % thresholds miss
    const driftSummaries = drift.drifts
      .filter(d => d.detected)
      .map(d => d.summary);
    recommendation = `Concept drift detected: ${driftSummaries.join('; ')}`;
  } else if (failureChange !== null && failureChange > 50) {
    recommendation = 'Failures increasing significantly — investigate root causes.';
  } else if (costChange !== null && costChange > 30) {
    recommendation = 'Cost increasing — review task complexity or model usage.';
  } else if (costChange !== null && costChange < -20) {
    recommendation = 'Cost decreasing — efficiency improving.';
  }

  return {
    agentName,
    days,
    costTrend,
    failureTrend,
    confidenceTrend,
    handoffFeedbackRateTrend,
    durationCvTrend,
    summary: {
      costChangePercent: costChange,
      failureChangePercent: failureChange,
      recommendation,
    },
    drift: drift.hasDrift ? drift : undefined,
  };
}

// TODO(SPEC-08): Auto-compact daily files older than 90 days into monthly/{YYYY-MM}.json

// ── Helpers ──────────────────────────────────────────────────────────

function computeChangePercent(points: TrendPoint[]): number | null {
  if (points.length < 2) return null;

  const mid = Math.floor(points.length / 2);
  const firstHalf = points.slice(0, mid);
  const secondHalf = points.slice(mid);

  const avgFirst = firstHalf.reduce((s, p) => s + p.value, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, p) => s + p.value, 0) / secondHalf.length;

  if (avgFirst === 0) return avgSecond > 0 ? 100 : null;

  return Math.round(((avgSecond - avgFirst) / avgFirst) * 100);
}
