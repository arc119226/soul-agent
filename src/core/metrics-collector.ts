/**
 * Metrics Collector — structured daily metrics for observability.
 *
 * Collects system metrics on every heartbeat tick and rolls them up
 * into a daily summary file at soul/metrics/YYYY-MM-DD.json.
 *
 * Metrics tracked:
 *   - messages: received/sent counts
 *   - agents: runs, completions, failures
 *   - evolution: attempts, successes, failures
 *   - performance: ELU p50/p95/max, fatigue p50/p95/max, heap max
 *   - lifecycle: time spent in each state
 *
 * Collection happens via EventBus listeners (zero-coupling).
 * Flush to disk on shutdown or when manually triggered.
 */

import { eventBus } from './event-bus.js';
import { logger } from './logger.js';
import { getTodayString } from './timezone.js';
import { getDb } from './database.js';
import type { DailyMetricsRow } from './db-types.js';

// ── Types ─────────────────────────────────────────────────────────

export interface DailyMetrics {
  date: string;
  messages: {
    received: number;
    sent: number;
  };
  agents: {
    tasksCompleted: number;
    tasksFailed: number;
  };
  evolution: {
    attempts: number;
    successes: number;
    failures: number;
  };
  performance: {
    /** ELU samples collected throughout the day */
    eluSamples: number[];
    /** Fatigue score samples */
    fatigueSamples: number[];
    /** Max heap used (MB) */
    heapMaxMB: number;
  };
  lifecycle: {
    /** Seconds spent in each state */
    stateSeconds: Partial<Record<string, number>>;
  };
  cost: {
    /** Main consciousness (CTO) cost */
    mainCostUsd: number;
    /** Agent worker total cost */
    agentCostUsd: number;
    /** Per-agent breakdown */
    agentBreakdown: Record<string, number>;
    /** Per-tier breakdown (haiku/sonnet/opus) for main consciousness */
    tierBreakdown: Record<string, number>;
  };
}

export interface DailyMetricsSummary {
  date: string;
  messages: { received: number; sent: number };
  agents: { tasksCompleted: number; tasksFailed: number };
  evolution: { attempts: number; successes: number; failures: number };
  performance: {
    eluP50: number;
    eluP95: number;
    eluMax: number;
    fatigueP50: number;
    fatigueP95: number;
    fatigueMax: number;
    heapMaxMB: number;
  };
  lifecycle: { stateSeconds: Partial<Record<string, number>> };
  cost: {
    mainCostUsd: number;
    agentCostUsd: number;
    totalCostUsd: number;
    agentBreakdown: Record<string, number>;
    tierBreakdown: Record<string, number>;
  };
}

// ── State ─────────────────────────────────────────────────────────

let currentDate = todayStr();
let metrics = createEmptyMetrics(currentDate);
let lastStateChangeAt = Date.now();
let lastState = 'active';
let attached = false;

// ── Handler references (for cleanup) ──

type MsgHandler = (data: { chatId: number; userId: number; text: string }) => void;
type SentHandler = (data: { chatId: number; text: string }) => void;
type AgentDoneHandler = (data: { agentName: string; taskId: string; result: string }) => void;
type AgentFailHandler = (data: { agentName: string; taskId: string; error: string }) => void;
type EvoStartHandler = (data: { goalId: string; description: string }) => void;
type EvoSuccessHandler = (data: { goalId: string; description: string }) => void;
type EvoFailHandler = (data: { goalId: string; error: string }) => void;
type TickHandler = (data: { timestamp: number; state: string; elu: number; fatigueScore?: number }) => void;
type StateHandler = (data: { from: string; to: string; reason: string }) => void;
type CostHandler = (data: { source: 'main' | 'agent'; tier?: string; agentName?: string; costUsd: number }) => void;

let msgHandler: MsgHandler | null = null;
let sentHandler: SentHandler | null = null;
let agentDoneHandler: AgentDoneHandler | null = null;
let agentFailHandler: AgentFailHandler | null = null;
let evoStartHandler: EvoStartHandler | null = null;
let evoSuccessHandler: EvoSuccessHandler | null = null;
let evoFailHandler: EvoFailHandler | null = null;
let tickHandler: TickHandler | null = null;
let stateHandler: StateHandler | null = null;
let costHandler: CostHandler | null = null;

// ── Helpers ───────────────────────────────────────────────────────

function todayStr(): string {
  return getTodayString();
}

function createEmptyMetrics(date: string): DailyMetrics {
  return {
    date,
    messages: { received: 0, sent: 0 },
    agents: { tasksCompleted: 0, tasksFailed: 0 },
    evolution: { attempts: 0, successes: 0, failures: 0 },
    performance: { eluSamples: [], fatigueSamples: [], heapMaxMB: 0 },
    lifecycle: { stateSeconds: {} },
    cost: { mainCostUsd: 0, agentCostUsd: 0, agentBreakdown: {}, tierBreakdown: {} },
  };
}

/** Roll over to next day if midnight crossed */
async function checkDayRollover(): Promise<void> {
  const today = todayStr();
  if (today !== currentDate) {
    // Flush previous day
    await flushMetrics();
    currentDate = today;
    metrics = createEmptyMetrics(today);
    lastStateChangeAt = Date.now();
  }
}

/** Record time spent in a state */
function recordStateTime(state: string): void {
  const now = Date.now();
  const elapsed = (now - lastStateChangeAt) / 1000;
  const prev = metrics.lifecycle.stateSeconds[state] ?? 0;
  metrics.lifecycle.stateSeconds[state] = prev + elapsed;
  lastStateChangeAt = now;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Attach EventBus listeners to collect metrics.
 * Call once during startup.
 */
export function attachMetricsCollector(): void {
  if (attached) return;
  attached = true;

  msgHandler = () => { metrics.messages.received++; };
  sentHandler = () => { metrics.messages.sent++; };
  agentDoneHandler = () => { metrics.agents.tasksCompleted++; };
  agentFailHandler = () => { metrics.agents.tasksFailed++; };
  evoStartHandler = () => { metrics.evolution.attempts++; };
  evoSuccessHandler = () => { metrics.evolution.successes++; };
  evoFailHandler = () => { metrics.evolution.failures++; };

  tickHandler = (data) => {
    checkDayRollover().catch(() => {});
    // Sample ELU
    if (typeof data.elu === 'number') {
      metrics.performance.eluSamples.push(Math.round(data.elu * 10000) / 10000);
    }
    // Sample fatigue
    if (typeof data.fatigueScore === 'number') {
      metrics.performance.fatigueSamples.push(data.fatigueScore);
    }
    // Track heap max
    const heapMB = process.memoryUsage().heapUsed / (1024 * 1024);
    if (heapMB > metrics.performance.heapMaxMB) {
      metrics.performance.heapMaxMB = Math.round(heapMB * 10) / 10;
    }
    // Record time in current state
    recordStateTime(data.state);
    lastState = data.state;
  };

  stateHandler = (data) => {
    recordStateTime(data.from);
    lastState = data.to;
  };

  eventBus.on('message:received', msgHandler);
  eventBus.on('message:sent', sentHandler);
  eventBus.on('agent:task:completed', agentDoneHandler);
  eventBus.on('agent:task:failed', agentFailHandler);
  eventBus.on('evolution:start', evoStartHandler);
  eventBus.on('evolution:success', evoSuccessHandler);
  eventBus.on('evolution:fail', evoFailHandler);
  eventBus.on('heartbeat:tick', tickHandler);
  eventBus.on('lifecycle:state', stateHandler);

  costHandler = (data) => {
    if (data.source === 'main') {
      metrics.cost.mainCostUsd += data.costUsd;
      if (data.tier) {
        metrics.cost.tierBreakdown[data.tier] = (metrics.cost.tierBreakdown[data.tier] ?? 0) + data.costUsd;
      }
    } else if (data.source === 'agent' && data.agentName) {
      metrics.cost.agentCostUsd += data.costUsd;
      metrics.cost.agentBreakdown[data.agentName] = (metrics.cost.agentBreakdown[data.agentName] ?? 0) + data.costUsd;
    }
  };
  eventBus.on('cost:incurred', costHandler);

  logger.info('MetricsCollector', 'Metrics collection attached');
}

/**
 * Detach all listeners.
 */
export function detachMetricsCollector(): void {
  if (!attached) return;

  if (msgHandler) eventBus.off('message:received', msgHandler);
  if (sentHandler) eventBus.off('message:sent', sentHandler);
  if (agentDoneHandler) eventBus.off('agent:task:completed', agentDoneHandler);
  if (agentFailHandler) eventBus.off('agent:task:failed', agentFailHandler);
  if (evoStartHandler) eventBus.off('evolution:start', evoStartHandler);
  if (evoSuccessHandler) eventBus.off('evolution:success', evoSuccessHandler);
  if (evoFailHandler) eventBus.off('evolution:fail', evoFailHandler);
  if (tickHandler) eventBus.off('heartbeat:tick', tickHandler);
  if (stateHandler) eventBus.off('lifecycle:state', stateHandler);

  if (costHandler) eventBus.off('cost:incurred', costHandler);
  msgHandler = sentHandler = null;
  agentDoneHandler = agentFailHandler = null;
  evoStartHandler = evoSuccessHandler = evoFailHandler = null;
  tickHandler = null;
  stateHandler = null;
  costHandler = null;
  attached = false;

  logger.info('MetricsCollector', 'Metrics collection detached');
}

/**
 * Flush current day's metrics to SQLite daily_metrics table.
 */
export async function flushMetrics(): Promise<void> {
  // Record time for current state before flushing
  recordStateTime(lastState);

  const eluSorted = [...metrics.performance.eluSamples].sort((a, b) => a - b);
  const fatigueSorted = [...metrics.performance.fatigueSamples].sort((a, b) => a - b);

  const summary: DailyMetricsSummary = {
    date: metrics.date,
    messages: { ...metrics.messages },
    agents: { ...metrics.agents },
    evolution: { ...metrics.evolution },
    performance: {
      eluP50: percentile(eluSorted, 50),
      eluP95: percentile(eluSorted, 95),
      eluMax: eluSorted.length > 0 ? eluSorted[eluSorted.length - 1]! : 0,
      fatigueP50: percentile(fatigueSorted, 50),
      fatigueP95: percentile(fatigueSorted, 95),
      fatigueMax: fatigueSorted.length > 0 ? fatigueSorted[fatigueSorted.length - 1]! : 0,
      heapMaxMB: metrics.performance.heapMaxMB,
    },
    lifecycle: { stateSeconds: { ...metrics.lifecycle.stateSeconds } },
    cost: {
      mainCostUsd: Math.round(metrics.cost.mainCostUsd * 10000) / 10000,
      agentCostUsd: Math.round(metrics.cost.agentCostUsd * 10000) / 10000,
      totalCostUsd: Math.round((metrics.cost.mainCostUsd + metrics.cost.agentCostUsd) * 10000) / 10000,
      agentBreakdown: Object.fromEntries(
        Object.entries(metrics.cost.agentBreakdown).map(([k, v]) => [k, Math.round(v * 10000) / 10000])
      ),
      tierBreakdown: Object.fromEntries(
        Object.entries(metrics.cost.tierBreakdown).map(([k, v]) => [k, Math.round(v * 10000) / 10000])
      ),
    },
  };

  try {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO daily_metrics (date, messages, agents, evolution, performance, lifecycle, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      summary.date,
      JSON.stringify(summary.messages),
      JSON.stringify(summary.agents),
      JSON.stringify(summary.evolution),
      JSON.stringify(summary.performance),
      JSON.stringify(summary.lifecycle),
      JSON.stringify(summary.cost),
    );
    await logger.info('MetricsCollector', `Metrics flushed for ${metrics.date}: ${metrics.messages.received} msgs, ${metrics.agents.tasksCompleted} agent tasks, $${(metrics.cost.mainCostUsd + metrics.cost.agentCostUsd).toFixed(2)} total cost`);
  } catch (err) {
    await logger.warn('MetricsCollector', `Failed to flush metrics for ${metrics.date}`, err);
  }
}

/**
 * Get the current in-memory metrics (for diagnostics).
 */
export function getCurrentMetrics(): DailyMetrics {
  return { ...metrics };
}

/**
 * Load a specific day's metrics from SQLite.
 */
export async function loadDailyMetrics(date: string): Promise<DailyMetricsSummary | null> {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM daily_metrics WHERE date = ?').get(date) as DailyMetricsRow | undefined;
    if (!row) return null;
    return {
      date: row.date,
      messages: JSON.parse(row.messages) as DailyMetricsSummary['messages'],
      agents: JSON.parse(row.agents) as DailyMetricsSummary['agents'],
      evolution: JSON.parse(row.evolution) as DailyMetricsSummary['evolution'],
      performance: JSON.parse(row.performance) as DailyMetricsSummary['performance'],
      lifecycle: JSON.parse(row.lifecycle) as DailyMetricsSummary['lifecycle'],
      cost: JSON.parse(row.cost) as DailyMetricsSummary['cost'],
    };
  } catch {
    return null;
  }
}
