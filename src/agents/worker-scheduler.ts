/**
 * Worker Scheduler — dispatches background agent tasks via separate CLI channels.
 *
 * Architecture:
 *   - Uses negative userIds (-1, -2, ...) as worker channels
 *   - Each worker channel has its own busyLock + session in the existing CLI infrastructure
 *   - Hooks into heartbeat:tick to poll the task queue every 5 minutes
 *   - Reads tasks from soul/agent-tasks/queue.json
 *   - Writes results to soul/agent-reports/{agentName}/{date}.jsonl
 *
 * Key constraints:
 *   - Max concurrent workers (default 2)
 *   - Per-agent daily cost limit
 *   - Workers never touch code or soul/ (except agent-reports/)
 */

import { readFile, writeFile, stat, unlink, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { tailReadJsonl } from '../core/tail-read.js';
import { randomUUID } from 'node:crypto';
import { eventBus } from '../core/event-bus.js';
import { getTodayString } from '../core/timezone.js';
import { logger } from '../core/logger.js';
import { writer } from '../core/debounced-writer.js';
import { config } from '../config.js';
import { askClaudeCode, isBusy, LIGHTWEIGHT_CWD } from '../claude/claude-code.js';
import { assessHeuristic } from './monitoring/result-assessor.js';
import { appendDeadLetter, buildDeadLetterEntry } from './monitoring/dead-letter.js';
import { MAX_WORKTREES } from './governance/worktree-manager.js';
import { truncateWithMarker, PIPELINE_CONTEXT_CAP } from './truncate-utils.js';
import { getDb } from '../core/database.js';
import type { AgentTaskRow } from '../core/db-types.js';
import {
  loadAgentConfig,
  loadAllAgentConfigs,
  recordAgentRun,
  recordAgentFailure,
  isOverDailyLimit,
  type AgentConfig,
  type FailureCategory,
} from './config/agent-config.js';
import { checkScheduledAgents } from './daily-maintenance.js';

// ── Constants ────────────────────────────────────────────────────────

const QUEUE_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'queue.json');
const HISTORY_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'history.jsonl');
/** Signal file written by MCP dispatch_task tool to trigger immediate queue processing */
const DISPATCH_SIGNAL = join(process.cwd(), 'soul', 'agent-tasks', '.dispatch');

// ── Queue Cache ─────────────────────────────────────────────────────

const QUEUE_CACHE_TTL = 5_000; // 5 seconds
let queueCache: { data: TaskQueue; expireAt: number } | null = null;

function invalidateQueueCache(): void {
  queueCache = null;
}

/** Max number of concurrent worker CLI processes */
export const MAX_CONCURRENT_WORKERS = 3;

/** Startup grace period — don't dispatch scheduled tasks for 2 min after boot */
const STARTUP_GRACE_MS = 2 * 60 * 1000;
const startupTime = Date.now();

/** Worker channel IDs (negative userIds that don't collide with real users) */
const WORKER_IDS = [-1, -2, -3, -4, -5, -6, -7, -8] as const;

/** Default model for workers (cost-efficient) */
const WORKER_DEFAULT_MODEL = config.MODEL_TIER_SONNET;

/** Max retries for transient failures (e.g. "Claude Code is busy") */
const MAX_TASK_RETRIES = 3;

/** Errors considered transient and eligible for automatic retry */
const TRANSIENT_ERRORS = [
  'Claude Code is busy',
  'Worker process terminated unexpectedly',
  'ECONNRESET',
  'ETIMEDOUT',
  'socket hang up',
  'overloaded_error',
];

/** Estimated cost per task for budget reservation when no config data available */
const ESTIMATED_COST_PER_TASK = 0.15;

/** Minimum confidence score for cross-agent knowledge sharing */
const KNOWLEDGE_SHARE_THRESHOLD = 0.6;


/** Extract feedbackIteration counter from prompt text. Returns 0 if not found. */
function extractFeedbackIteration(prompt: string): number {
  const match = prompt.match(/\[feedbackIteration:\s*(\d+)\]/);
  return match?.[1] ? parseInt(match[1], 10) : 0;
}

/** Max feedback iterations before auto-escalating to CTO */
const MAX_FEEDBACK_ITERATIONS = 3;

/** Main project .mcp.json — bot-tools, duckduckgo, hexo */
const PROJECT_MCP_CONFIG = join(process.cwd(), '.mcp.json');

/** Code agent LSP config (cclsp) */
const CODE_AGENT_MCP_CONFIG = join(LIGHTWEIGHT_CWD, 'mcp-code-agent.json');

/** Merged MCP config for code agents (bot-tools + cclsp) */
const MERGED_MCP_CONFIG = join(LIGHTWEIGHT_CWD, 'mcp-merged.json');

/**
 * Build the MCP config path for a worker agent.
 * - Non-code agents: use the main project's .mcp.json (bot-tools, duckduckgo, hexo)
 * - Code agents: merge main project MCP + cclsp into a single config file
 */
async function buildMcpConfig(isCodeAgent: boolean): Promise<string> {
  if (!isCodeAgent) {
    return PROJECT_MCP_CONFIG;
  }

  // Code agent: merge both configs
  try {
    const [projectMcp, codeMcp] = await Promise.all([
      readFile(PROJECT_MCP_CONFIG, 'utf-8').then(JSON.parse),
      readFile(CODE_AGENT_MCP_CONFIG, 'utf-8').then(JSON.parse),
    ]);
    const merged = {
      mcpServers: {
        ...projectMcp.mcpServers,
        ...codeMcp.mcpServers,
      },
    };
    await writeFile(MERGED_MCP_CONFIG, JSON.stringify(merged, null, 2), 'utf-8');
    return MERGED_MCP_CONFIG;
  } catch (err) {
    // Fallback: if merge fails, at least give them bot-tools
    await logger.warn('WorkerScheduler', `buildMcpConfig merge failed: ${(err as Error).message}, falling back to project config`);
    return PROJECT_MCP_CONFIG;
  }
}

/** Exponential backoff with jitter: min(30s × 2^retryCount + random(0-10s), 300s) */
function getRetryDelay(retryCount: number): number {
  return Math.min(30_000 * Math.pow(2, retryCount) + Math.random() * 10_000, 300_000);
}

// ── Failure Classification ───────────────────────────────────────────

/**
 * Classify a failure into transient / budget / quality categories.
 * Only quality failures count toward graduated response thresholds.
 */
export function classifyFailure(error: string): FailureCategory {
  const lower = error.toLowerCase();

  // Transient: infrastructure / connectivity / capacity issues
  if (lower.includes('timed out') || lower.includes('timeout')) return 'transient';
  if (lower.includes('is busy') || lower.includes('rate limit')) return 'transient';
  if (lower.includes('econnreset') || lower.includes('network')) return 'transient';
  if (lower.includes('etimedout') || lower.includes('socket hang up')) return 'transient';
  if (lower.includes('overloaded')) return 'transient';
  if (lower.includes('max turns') || lower.includes('exceeded max turns')) return 'quality';
  if (lower.includes('terminated unexpectedly')) return 'transient';

  // Budget: cost / limit issues
  if (lower.includes('budget') || lower.includes('daily limit')) return 'budget';
  if (lower.includes('cost limit') || lower.includes('over limit')) return 'budget';
  if (lower.includes('per-task budget')) return 'budget';

  // Quality: everything else (output validation, low confidence, etc.)
  return 'quality';
}

// ── Task & Report Types (extracted to task-types.ts) ─────────────────
export type {
  TaskStatus,
  ExecutionTrace,
  AgentTask,
  PromptMetrics,
  AgentReport,
} from './task-types.js';
import type { TaskStatus, ExecutionTrace, AgentTask, TaskQueue, PromptMetrics, AgentReport } from './task-types.js';
import { writeReport, cleanupOldReports, invalidateReportsCache } from './report-store.js';
import { buildWorkerSystemPrompt } from './prompt-builder.js';
export { getRecentReports } from './report-store.js';

// ── State ────────────────────────────────────────────────────────────

let tickHandler: ((data: { timestamp: number; state: string }) => void) | null = null;
let dispatchPollTimer: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;
let reprocessCounter = 0; // Incremented when enqueueTask is called during processQueue

// ── Budget Reservation (prevents race condition on concurrent dispatch) ──
const budgetReservations = new Map<string, number>();

// Per-agent budget lock to prevent concurrent reserveBudget() calls from
// both passing the check before either writes. See SPEC-02.
const budgetLocks = new Map<string, Promise<void>>();

/** Serialize async operations on a per-agent basis to prevent race conditions. */
async function withBudgetLock<T>(agentName: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any pending lock on this agent
  while (budgetLocks.has(agentName)) {
    await budgetLocks.get(agentName);
  }
  let resolve: () => void;
  const lock = new Promise<void>(r => { resolve = r; });
  budgetLocks.set(agentName, lock);
  try {
    return await fn();
  } finally {
    budgetLocks.delete(agentName);
    resolve!();
  }
}

/** Reserve estimated cost before dispatch; returns false if over limit. */
async function reserveBudget(agentName: string, estimatedCost: number): Promise<boolean> {
  return withBudgetLock(agentName, async () => {
    if (await isOverDailyLimit(agentName)) return false;
    const reserved = budgetReservations.get(agentName) ?? 0;
    const cfg = await loadAgentConfig(agentName);
    if (!cfg) return false;
    // If costResetDate is stale (yesterday), today's spend is effectively 0.
    const today = getTodayString();
    const todaySpend = cfg.costResetDate === today ? (cfg.totalCostToday ?? 0) : 0;
    if (cfg.dailyCostLimit > 0 && todaySpend + reserved + estimatedCost > cfg.dailyCostLimit) {
      return false;
    }
    budgetReservations.set(agentName, reserved + estimatedCost);
    return true;
  });
}

/** Release reservation after task completes (actual cost recorded by recordAgentRun). */
async function releaseBudget(agentName: string, estimatedCost: number = ESTIMATED_COST_PER_TASK): Promise<void> {
  await withBudgetLock(agentName, async () => {
    const current = budgetReservations.get(agentName) ?? 0;
    const remaining = current - estimatedCost;
    if (remaining <= 0.001) {
      budgetReservations.delete(agentName);
    } else {
      budgetReservations.set(agentName, remaining);
    }
  });
}

// ── SQLite Task Helpers ──────────────────────────────────────────────

/** Convert AgentTask object to SQLite column values */
function taskToRow(task: AgentTask): Record<string, unknown> {
  return {
    id: task.id,
    agent_name: task.agentName,
    prompt: task.prompt,
    status: task.status,
    priority: task.priority,
    source: task.source ?? null,
    created_at: task.createdAt,
    started_at: task.startedAt ?? null,
    completed_at: task.completedAt ?? null,
    worker_id: task.workerId ?? null,
    result: task.result ?? null,
    error: task.error ?? null,
    cost_usd: task.costUsd ?? 0,
    duration: task.duration ?? 0,
    confidence: null,
    trace_summary: null,
    pipeline_id: task.pipelineRunId ?? null,
    stage_id: null,
    parent_task_id: task.parentTaskId ?? null,
    chain_depth: task.chainDepth ?? 0,
    retry_count: task.retryCount ?? 0,
    retry_after: task.retryAfter ?? null,
    depends_on: task.dependsOn ? JSON.stringify(task.dependsOn) : null,
    worktree_path: task.worktreePath ?? null,
    branch_name: task.branchName ?? null,
    trace: task.trace ? JSON.stringify(task.trace) : null,
    metadata: (task.rerouteCount || task.reroutedFrom || task.handoffIntent)
      ? JSON.stringify({
          ...(task.rerouteCount ? { rerouteCount: task.rerouteCount } : {}),
          ...(task.reroutedFrom ? { reroutedFrom: task.reroutedFrom } : {}),
          ...(task.handoffIntent ? { handoffIntent: task.handoffIntent } : {}),
        })
      : null,
    origin_agent: task.originAgent ?? null,
  };
}

/** Convert SQLite row to AgentTask object */
function rowToTask(row: AgentTaskRow): AgentTask {
  return {
    id: row.id,
    agentName: row.agent_name,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    priority: row.priority,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    workerId: row.worker_id,
    result: row.result,
    error: row.error,
    costUsd: row.cost_usd,
    duration: row.duration ?? 0,
    retryCount: row.retry_count ?? 0,
    retryAfter: row.retry_after ?? undefined,
    dependsOn: row.depends_on ? JSON.parse(row.depends_on) as string[] : undefined,
    source: row.source as AgentTask['source'],
    trace: row.trace ? JSON.parse(row.trace) as ExecutionTrace[] : undefined,
    parentTaskId: row.parent_task_id,
    originAgent: row.origin_agent,
    chainDepth: row.chain_depth ?? 0,
    pipelineRunId: row.pipeline_id ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    ...(row.metadata ? (() => {
      try {
        const meta = JSON.parse(row.metadata) as { rerouteCount?: number; reroutedFrom?: string; handoffIntent?: string };
        return { rerouteCount: meta.rerouteCount, reroutedFrom: meta.reroutedFrom, handoffIntent: meta.handoffIntent as AgentTask['handoffIntent'] };
      } catch { return {}; }
    })() : {}),
  };
}

/** Insert a task into SQLite */
function insertTaskToDb(task: AgentTask): void {
  try {
    const db = getDb();
    const row = taskToRow(task);
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    db.prepare(
      `INSERT OR REPLACE INTO agent_tasks (${columns.join(', ')}) VALUES (${placeholders})`,
    ).run(...columns.map(k => row[k] ?? null));
  } catch (err) {
    logger.warn('WorkerScheduler', `insertTaskToDb failed: ${(err as Error).message}`);
  }
}

/** Update a task in SQLite */
function updateTaskInDb(task: AgentTask): void {
  try {
    const db = getDb();
    const row = taskToRow(task);
    const columns = Object.keys(row).filter(k => k !== 'id');
    const setClause = columns.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE agent_tasks SET ${setClause} WHERE id = ?`)
      .run(...columns.map(k => row[k] ?? null), task.id);
  } catch (err) {
    logger.warn('WorkerScheduler', `updateTaskInDb failed: ${(err as Error).message}`);
  }
}

/** Delete a task from SQLite */
function deleteTaskFromDb(taskId: string): void {
  try {
    const db = getDb();
    db.prepare('DELETE FROM agent_tasks WHERE id = ?').run(taskId);
  } catch (err) {
    logger.warn('WorkerScheduler', `deleteTaskFromDb failed: ${(err as Error).message}`);
  }
}

/** Load tasks from SQLite filtered by status */
function loadTasksFromDb(statuses: string[]): AgentTask[] {
  const db = getDb();
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT * FROM agent_tasks WHERE status IN (${placeholders}) ORDER BY priority DESC, created_at ASC`,
  ).all(...statuses) as AgentTaskRow[];
  return rows.map(rowToTask);
}

/** Get a single task from SQLite by ID */
function getTaskFromDb(id: string): AgentTask | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as AgentTaskRow | undefined;
  return row ? rowToTask(row) : null;
}

// ── SQLite Report Helpers ───────────────────────────────────────────

// ── Queue I/O ────────────────────────────────────────────────────────

/** Load queue from JSON file (fallback/backup path) */
async function loadQueueFromJson(): Promise<TaskQueue> {
  try {
    const raw = await readFile(QUEUE_PATH, 'utf-8');
    const data = JSON.parse(raw) as TaskQueue;
    return { version: data.version || 1, tasks: data.tasks || [] };
  } catch {
    return { version: 1, tasks: [] };
  }
}

async function loadQueue(): Promise<TaskQueue> {
  if (queueCache && Date.now() < queueCache.expireAt) return queueCache.data;
  try {
    // Primary: read active tasks from SQLite
    const tasks = loadTasksFromDb(['pending', 'running']);
    const queue: TaskQueue = { version: 1, tasks };
    queueCache = { data: queue, expireAt: Date.now() + QUEUE_CACHE_TTL };
    return queue;
  } catch {
    // Fallback: read from JSON file
    const queue = await loadQueueFromJson();
    queueCache = { data: queue, expireAt: Date.now() + QUEUE_CACHE_TTL };
    return queue;
  }
}

async function saveQueue(queue: TaskQueue): Promise<void> {
  await writer.writeNow(QUEUE_PATH, queue);
  queueCache = { data: queue, expireAt: Date.now() + QUEUE_CACHE_TTL };
}

// ── Public API: Queue Management ─────────────────────────────────────

/** Add a task to the queue. Returns the task ID.
 *  Deduplicates: if a pending/running task with the same agentName+prompt already exists,
 *  returns the existing task ID instead of creating a duplicate. */
export async function enqueueTask(
  agentName: string,
  prompt: string,
  priority: number = 5,
  opts?: {
    dependsOn?: string[];
    source?: AgentTask['source'];
    parentTaskId?: string;
    originAgent?: string;
    worktreePath?: string;
    branchName?: string;
    handoffIntent?: AgentTask['handoffIntent'];
  },
): Promise<string> {
  const queue = await loadQueue();

  // Dedup: skip if identical agent+prompt is already pending or running
  const existing = queue.tasks.find(
    (t) => t.agentName === agentName && t.prompt === prompt && (t.status === 'pending' || t.status === 'running'),
  );
  if (existing) {
    await logger.info('WorkerScheduler', `Task dedup: reusing ${existing.id} for agent "${agentName}" (already ${existing.status})`);
    return existing.id;
  }

  const task: AgentTask = {
    id: randomUUID(),
    agentName,
    prompt,
    status: 'pending',
    priority: Math.max(1, Math.min(10, priority)),
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    workerId: null,
    result: null,
    error: null,
    costUsd: 0,
    duration: 0,
    dependsOn: opts?.dependsOn?.length ? opts.dependsOn : undefined,
    source: opts?.source,
    parentTaskId: opts?.parentTaskId,
    originAgent: opts?.originAgent,
    worktreePath: opts?.worktreePath,
    branchName: opts?.branchName,
    handoffIntent: opts?.handoffIntent,
  };

  // Dual-write: SQLite primary + JSON backup
  insertTaskToDb(task);
  queue.tasks.push(task);
  await saveQueue(queue);
  await logger.info('WorkerScheduler', `Task enqueued: ${task.id} for agent "${agentName}"${task.dependsOn ? ` (depends on ${task.dependsOn.length} task(s))` : ''}`);

  // Immediate dispatch: try to process queue now instead of waiting for next heartbeat tick.
  // If processQueue() is already running (e.g. pipeline advancement enqueues a downstream
  // stage inside executeTask's event chain), increment reprocessCounter so it runs again
  // after the current cycle completes.
  if (isProcessing) {
    reprocessCounter++;
  } else {
    processQueue().catch(() => {/* non-fatal */});
  }

  return task.id;
}

/** Get the current queue state. */
export async function getQueueStatus(): Promise<{
  pending: number;
  running: number;
  blocked: number;
  total: number;
  tasks: AgentTask[];
}> {
  const queue = await loadQueue();
  const completedIds = await getRecentCompletedIds();
  let blocked = 0;
  for (const t of queue.tasks) {
    if (t.status === 'pending' && t.dependsOn?.length) {
      if (!checkDependencies(t, queue.tasks, completedIds).satisfied) blocked++;
    }
  }
  const pending = queue.tasks.filter((t) => t.status === 'pending').length - blocked;
  const running = queue.tasks.filter((t) => t.status === 'running').length;
  return { pending, running, blocked, total: queue.tasks.length, tasks: queue.tasks };
}

/** Cancel a pending task. Returns true if found and cancelled. */
export async function cancelTask(taskId: string): Promise<boolean> {
  const queue = await loadQueue();
  const task = queue.tasks.find((t) => t.id === taskId && t.status === 'pending');
  if (!task) return false;

  task.status = 'failed';
  task.error = 'Cancelled by user';
  task.completedAt = new Date().toISOString();
  updateTaskInDb(task);
  await saveQueue(queue);
  return true;
}

// ── Worker Allocation ────────────────────────────────────────────────

/**
 * Find a free worker channel (not busy).
 * @param exclude - worker IDs already reserved in this dispatch round (prevents race condition)
 */
function findFreeWorker(exclude: Set<number> = new Set()): number | null {
  // Count currently running workers (including reserved ones)
  let runningCount = 0;
  for (const wid of WORKER_IDS) {
    if (isBusy(wid) || exclude.has(wid)) runningCount++;
  }

  if (runningCount >= MAX_CONCURRENT_WORKERS) return null;

  // Find first free (not busy AND not reserved)
  for (const wid of WORKER_IDS) {
    if (!isBusy(wid) && !exclude.has(wid)) return wid;
  }

  return null;
}

/** Check if an error is transient and eligible for retry. */
function isTransientError(error: string | null): boolean {
  if (!error) return false;
  return TRANSIENT_ERRORS.some((te) => error.includes(te));
}

/** Reset a failed task back to pending for retry with exponential backoff. */
function requeueForRetry(task: AgentTask): void {
  task.retryCount = (task.retryCount ?? 0) + 1;
  const delay = getRetryDelay(task.retryCount - 1);
  task.retryAfter = new Date(Date.now() + delay).toISOString();
  task.status = 'pending';
  task.startedAt = null;
  task.completedAt = null;
  task.workerId = null;
  task.error = null;
  addTrace(task, 'retry-backoff', `retry #${task.retryCount}, backoff ${Math.round(delay / 1000)}s until ${task.retryAfter}`);
}

// ── Reroute (fault tolerance) ────────────────────────────────────────

/**
 * Attempt to reroute a quality-failed task to a fallback agent.
 * Returns true if reroute was successful (task re-enqueued), false otherwise.
 */
async function attemptReroute(task: AgentTask): Promise<boolean> {
  // Guard 1: max reroute count (1 time)
  if ((task.rerouteCount ?? 0) >= 1) {
    addTrace(task, 'reroute-exhausted', 'Max reroute count reached');
    await appendDeadLetter(buildDeadLetterEntry(
      task.id, task.agentName, task.prompt,
      [{ attempt: 1, error: task.error ?? 'quality failure', timestamp: new Date().toISOString(), duration: task.duration, costUsd: task.costUsd }],
      'reroute-exhausted',
      { parentTaskId: task.parentTaskId ?? undefined, totalCost: task.costUsd },
    ));
    return false;
  }

  // Guard 2: load agent config to check fallbackAgents
  const agentCfg = await loadAgentConfig(task.agentName);
  if (!agentCfg?.fallbackAgents?.length) {
    addTrace(task, 'reroute-skipped', 'No fallback agents configured');
    return false;
  }

  // Guard 3: find a valid fallback (not paused, not disabled, not the reroutedFrom agent)
  let fallbackAgent: string | null = null;
  for (const candidate of agentCfg.fallbackAgents) {
    // Ping-pong guard: don't reroute back to the agent that produced this task
    if (candidate === task.reroutedFrom) {
      addTrace(task, 'reroute-skipped', `Skipping ${candidate} (ping-pong guard: reroutedFrom)`);
      continue;
    }
    const fallbackCfg = await loadAgentConfig(candidate);
    if (!fallbackCfg) continue;
    if (fallbackCfg.enabled === false) continue;
    if (fallbackCfg.pauseUntil && new Date(fallbackCfg.pauseUntil).getTime() > Date.now()) continue;
    fallbackAgent = candidate;
    break;
  }

  if (!fallbackAgent) {
    addTrace(task, 'reroute-skipped', 'No available fallback agent (all paused/disabled/ping-pong)');
    return false;
  }

  // Execute reroute: create NEW task, do NOT reuse original
  const reroutePrompt = buildReroutePrompt(task);

  const newTaskId = await enqueueTask(fallbackAgent, reroutePrompt, task.priority, {
    source: task.source,
    parentTaskId: task.parentTaskId ?? undefined,
    originAgent: task.originAgent ?? undefined,
    // No worktreePath/branchName — shouldUseWorktree() will assign a new worktree
  });

  // Set reroute metadata on the new task
  const queue = await loadQueue();
  const newTask = queue.tasks.find(t => t.id === newTaskId);
  if (newTask) {
    newTask.rerouteCount = (task.rerouteCount ?? 0) + 1;
    newTask.reroutedFrom = task.agentName;
    newTask.chainDepth = task.chainDepth;
    addTrace(newTask, 'rerouted', `Rerouted from ${task.agentName} (quality failure)`);
    updateTaskInDb(newTask);
    await saveQueue(queue);
  }

  addTrace(task, 'reroute', `Rerouted to ${fallbackAgent} as task ${newTaskId}`);

  await logger.info('WorkerScheduler',
    `Task ${task.id} rerouted from ${task.agentName} to ${fallbackAgent} (new task: ${newTaskId})`);

  return true;
}

/** Build a prompt for a rerouted task with context header. */
function buildReroutePrompt(originalTask: AgentTask): string {
  const contextHeader = [
    `[REROUTE] 你是 fallback 執行者。原始 agent「${originalTask.agentName}」執行此任務失敗。`,
    `失敗原因摘要：${originalTask.error?.slice(0, 300) ?? '未知'}`,
    `請以你的方式重新執行此任務。注意避免重複原始 agent 的錯誤。`,
    `---`,
  ].join('\n');
  return contextHeader + '\n' + originalTask.prompt;
}

// ── Execution Tracing ───────────────────────────────────────────────

/** Append a trace point to a task (O(1) push, 200-char cap). */
function addTrace(task: AgentTask, phase: string, detail: string): void {
  if (!task.trace) task.trace = [];
  task.trace.push({ phase, ts: new Date().toISOString(), detail: detail.slice(0, 200) });
}

// ── Worktree Decision ───────────────────────────────────────────────

/** Decide whether a task should run in a dedicated git worktree. */
function shouldUseWorktree(agentCfg: AgentConfig, task: AgentTask): boolean {
  if (task.worktreePath) return false; // already assigned (e.g. inherited from parent)
  const CODE_MODIFY_CAPABILITIES = ['code', 'refactoring'];
  return !!agentCfg.capabilities?.some(c => CODE_MODIFY_CAPABILITIES.includes(c));
}

// ── Task Dependencies ───────────────────────────────────────────────

/** Cache of recently completed task IDs from history (avoids re-reading per tick). */
let recentCompletedIds: Set<string> | null = null;
let completedIdsCacheTime = 0;
const COMPLETED_CACHE_TTL = 60_000; // 1 minute

async function getRecentCompletedIds(): Promise<Set<string>> {
  const now = Date.now();
  if (recentCompletedIds && now - completedIdsCacheTime < COMPLETED_CACHE_TTL) {
    return recentCompletedIds;
  }

  const ids = new Set<string>();

  // Primary: query SQLite for completed task IDs
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id FROM agent_tasks WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 200`,
    ).all() as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  } catch {
    // Fallback: read from JSONL
    const entries = await tailReadJsonl<{ id?: string; status?: string }>(HISTORY_PATH, 200, 262144);
    for (const entry of entries) {
      if (entry.status === 'completed' && entry.id) ids.add(entry.id);
    }
  }

  recentCompletedIds = ids;
  completedIdsCacheTime = now;
  return ids;
}

/**
 * Check whether all task-level dependencies have been satisfied.
 * A dependency is satisfied if the task ID is completed in queue or history.
 */
function checkDependencies(
  task: AgentTask,
  allTasks: AgentTask[],
  completedIds: Set<string>,
): { satisfied: boolean; blockedBy: string[]; failedDep: string | null } {
  if (!task.dependsOn || task.dependsOn.length === 0) {
    return { satisfied: true, blockedBy: [], failedDep: null };
  }

  const blockedBy: string[] = [];
  for (const depId of task.dependsOn) {
    const inQueue = allTasks.find(t => t.id === depId);
    // If dependency has permanently failed, propagate failure
    if (inQueue?.status === 'failed') {
      return { satisfied: false, blockedBy: [], failedDep: depId };
    }
    if (inQueue?.status === 'completed') continue;
    if (completedIds.has(depId)) continue;
    blockedBy.push(depId);
  }

  return { satisfied: blockedBy.length === 0, blockedBy, failedDep: null };
}

// ── Task Execution ───────────────────────────────────────────────────

/** Execute a single task on a worker channel. */
async function executeTask(task: AgentTask, workerId: number): Promise<void> {
  addTrace(task, 'dispatch', `Assigned to worker ${workerId}`);

  const agentCfg = await loadAgentConfig(task.agentName);
  if (!agentCfg) {
    addTrace(task, 'config-not-found', `Agent config missing: ${task.agentName}`);
    await logger.warn('WorkerScheduler', `Agent config not found: ${task.agentName}`);
    task.status = 'failed';
    task.error = `Agent config not found: ${task.agentName}`;
    task.completedAt = new Date().toISOString();
    updateTaskInDb(task);
    await eventBus.emit('agent:task:failed', {
      agentName: task.agentName,
      taskId: task.id,
      error: task.error,
    });
    return;
  }
  addTrace(task, 'config-loaded', `model=${agentCfg.model || 'default'}, maxTurns=${agentCfg.maxTurns}`);

  // Check daily cost limit
  if (await isOverDailyLimit(task.agentName)) {
    addTrace(task, 'cost-exceeded', `Daily limit reached for ${task.agentName}`);
    await logger.info('WorkerScheduler',
      `Agent "${task.agentName}" over daily cost limit, skipping task ${task.id}`);
    task.status = 'failed';
    task.error = 'Daily cost limit exceeded';
    task.completedAt = new Date().toISOString();
    updateTaskInDb(task);
    await eventBus.emit('agent:task:failed', {
      agentName: task.agentName,
      taskId: task.id,
      error: task.error,
    });
    return;
  }
  addTrace(task, 'cost-check', `OK (today: $${agentCfg.totalCostToday?.toFixed(4) ?? '0'})`);

  // Note: task.status/workerId/startedAt are set by the dispatch loop (processQueue)
  // BEFORE this function is called, to prevent race conditions with reprocessCounter.

  // Build system prompt for the worker (with section-level metrics)
  const { prompt: systemPrompt, metrics: promptMetrics } = await buildWorkerSystemPrompt(agentCfg, task);

  // Select model
  const model = agentCfg.model || WORKER_DEFAULT_MODEL;
  const topSections = Object.entries(promptMetrics.sections)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  addTrace(task, 'prompt-built', `${promptMetrics.totalChars} chars, model: ${model}, top: ${topSections}`);

  await logger.info('WorkerScheduler',
    `Executing task ${task.id} on worker ${workerId} (agent: ${task.agentName}, model: ${model})`);

  let isWorktreeCreator = false;

  try {
    // ── Worktree setup for code agents ──
    if (shouldUseWorktree(agentCfg, task)) {
      try {
        const { createTaskWorktree } = await import('./governance/worktree-manager.js');
        const wtResult = await createTaskWorktree(task.id);
        if (wtResult.ok) {
          task.worktreePath = wtResult.value.path;
          task.branchName = wtResult.value.branchName;
          isWorktreeCreator = true;
          addTrace(task, 'worktree-created', `path=${wtResult.value.path}, branch=${wtResult.value.branchName}`);
        } else {
          addTrace(task, 'worktree-fallback', `Worktree creation failed: ${wtResult.error}. Using LIGHTWEIGHT_CWD.`);
          await logger.warn('WorkerScheduler', `Worktree creation failed for task ${task.id}: ${wtResult.error}`);
        }
      } catch (err) {
        addTrace(task, 'worktree-fallback', `Worktree setup error: ${(err as Error).message}`);
      }
    }

    // Determine if this agent needs LSP tools (go-to-definition, find-references, diagnostics)
    const CODE_CAPABILITIES = ['code', 'architecture', 'code-review', 'refactoring'];
    const isCodeAgent = agentCfg.capabilities?.some(c => CODE_CAPABILITIES.includes(c)) ?? false;

    // All agents get bot-tools MCP (dispatch_task, soul_write, telegram_send, etc.)
    // Code agents additionally get cclsp MCP (find_definition, find_references, etc.)
    const mcpConfig = await buildMcpConfig(isCodeAgent);

    // ── Circuit breaker pre-check ──
    try {
      const { isWorkerCircuitOpen } = await import('./monitoring/worker-circuit-breaker.js');
      if (isWorkerCircuitOpen()) {
        addTrace(task, 'circuit-open', 'Worker circuit breaker open — requeueing');
        task.status = 'failed';
        task.error = 'Worker circuit breaker open (API recovering)';
        task.completedAt = new Date().toISOString();
        updateTaskInDb(task);
        await eventBus.emit('agent:task:failed', {
          agentName: task.agentName,
          taskId: task.id,
          error: task.error,
        });
        return;
      }
    } catch {
      // Circuit breaker not loaded — proceed normally
    }

    addTrace(task, 'cli-started', `timeout=${agentCfg.timeout || 120_000}ms, maxTurns=${agentCfg.maxTurns || 100}, mcp=${isCodeAgent ? 'merged' : 'project'}`);

    const result = await askClaudeCode(task.prompt, workerId, {
      systemPrompt,
      model,
      maxTurns: agentCfg.maxTurns || 100,
      timeout: agentCfg.timeout || 120_000,
      skipResume: true, // Workers always start fresh
      cwd: task.worktreePath || LIGHTWEIGHT_CWD, // Worktree for code agents, clean dir for others
      mcpConfig, // All agents: bot-tools; code agents: bot-tools + cclsp
    });

    // Check per-task budget cap (if configured)
    const maxCostPerTask = (agentCfg as AgentConfig & { maxCostPerTask?: number }).maxCostPerTask;
    if (result.ok && maxCostPerTask && maxCostPerTask > 0 && result.value.costUsd > maxCostPerTask) {
      addTrace(task, 'per-task-budget-exceeded', `$${result.value.costUsd.toFixed(4)} > max $${maxCostPerTask}`);
      await logger.warn('WorkerScheduler',
        `Task ${task.id} exceeded per-task budget: $${result.value.costUsd.toFixed(4)} > $${maxCostPerTask}`);
      // Still treat as completed (we already spent the money), but log the overage
    }

    if (result.ok && result.value.maxTurnsHit) {
      addTrace(task, 'max-turns-hit', `${result.value.numTurns} turns, ${result.value.duration}ms, $${result.value.costUsd.toFixed(4)}`);
      // Agent hit max turns — treat as failure (partial/unusable output)
      task.status = 'failed';
      task.error = `Agent exceeded max turns (${result.value.numTurns} turns, ${result.value.duration}ms)`;
      task.costUsd = result.value.costUsd;
      task.duration = result.value.duration;
      task.completedAt = new Date().toISOString();
      updateTaskInDb(task);

      const failCat = classifyFailure(task.error);
      await recordAgentFailure(task.agentName, task.error, failCat).catch((e) => {
        logger.debug('WorkerScheduler', `recordAgentFailure non-fatal: ${(e as Error).message}`);
      });

      await eventBus.emit('agent:task:failed', {
        agentName: task.agentName,
        taskId: task.id,
        error: task.error,
        costUsd: result.value.costUsd,
      });

      await logger.warn('WorkerScheduler',
        `Task ${task.id} hit max_turns: ${result.value.numTurns} turns, ${result.value.duration}ms (category: ${failCat})`);
    } else if (result.ok) {
      // Record success for circuit breaker
      try { const { recordWorkerSuccess } = await import('./monitoring/worker-circuit-breaker.js'); recordWorkerSuccess(); } catch { /* non-critical */ }

      addTrace(task, 'cli-completed', `${result.value.duration}ms, $${result.value.costUsd.toFixed(4)}, ${(result.value.result?.length ?? 0)} chars`);

      task.status = 'completed';
      task.result = result.value.result;
      task.costUsd = result.value.costUsd;
      task.duration = result.value.duration;
      task.completedAt = new Date().toISOString();

      // Assess confidence — dual-layer (heuristic + optional LLM Judge)
      let confidence: number;
      try {
        const { assessResult } = await import('./monitoring/result-assessor.js');
        const assessment = await assessResult(
          result.value.result,
          task.prompt,
          result.value.costUsd,
          agentCfg.failureCount7d ?? 0,
        );
        confidence = assessment.confidence;
        if (assessment.method === 'llm-judge') {
          addTrace(task, 'llm-judge', `score=${confidence.toFixed(2)} (${assessment.reason?.slice(0, 80) ?? ''})`);
        }
      } catch {
        confidence = assessHeuristic(result.value.result);
      }

      // Build trace summary for report
      const traceSummary = task.trace
        ?.map(t => `[${t.phase}] ${t.detail}`)
        .join(' → ') ?? '';

      // Write report
      await writeReport({
        timestamp: task.completedAt,
        agentName: task.agentName,
        taskId: task.id,
        prompt: task.prompt,
        result: result.value.result,
        costUsd: result.value.costUsd,
        duration: result.value.duration,
        confidence,
        traceSummary: traceSummary.slice(0, 500),
      });

      addTrace(task, 'report-written', `confidence=${confidence.toFixed(2)}`);
      updateTaskInDb(task);

      // Deposit knowledge for cross-agent sharing (confidence >= 0.6)
      if (confidence >= KNOWLEDGE_SHARE_THRESHOLD) {
        try {
          const { depositKnowledge } = await import('./knowledge/shared-knowledge.js');
          await depositKnowledge(task.agentName, task.id, result.value.result, task.prompt);
        } catch (e) {
          logger.debug('WorkerScheduler', `depositKnowledge non-fatal: ${(e as Error).message}`);
        }
      }

      // Auto-extract knowledge if conditions are met (Phase 2)
      try {
        const { shouldExtractKnowledge, extractAndDeposit } = await import('./knowledge/knowledge-extractor.js');
        if (shouldExtractKnowledge(task, confidence, agentCfg)) {
          const kbId = await extractAndDeposit(task, result.value.result ?? '', confidence, agentCfg, workerId);
          if (kbId) {
            logger.info('WorkerScheduler', `Knowledge extracted: ${kbId} from task ${task.id}`);
          }
        }
      } catch (e) {
        logger.debug('WorkerScheduler', `knowledge extraction non-fatal: ${(e as Error).message}`);
      }

      // Update agent stats (pass duration for tracking)
      await recordAgentRun(task.agentName, result.value.costUsd, result.value.duration);

      // Emit cost event for metrics tracking
      eventBus.emit('cost:incurred', {
        source: 'agent',
        agentName: task.agentName,
        costUsd: result.value.costUsd,
      }).catch(() => {});

      // Emit completion event (always, for goal tracking; notifyChat controls push notifications)
      await eventBus.emit('agent:task:completed', {
        agentName: task.agentName,
        taskId: task.id,
        result: result.value.result,
        costUsd: result.value.costUsd,
      });

      // ── Code merge notification (Phase 5: secretary PR workflow) ──
      if (task.agentName === 'secretary' && task.branchName && task.worktreePath) {
        // Secretary completed in a worktree = likely did a PR merge
        // Parse PR URL from result text if available
        const prUrlMatch = result.value.result?.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
        await eventBus.emit('code:merged', {
          taskId: task.id,
          prUrl: prUrlMatch?.[0] ?? '',
          branchName: task.branchName,
          agentName: 'secretary',
        });
      }

      await logger.info('WorkerScheduler',
        `Task ${task.id} completed: ${result.value.duration}ms, $${result.value.costUsd.toFixed(4)}`);

      // ── HANDOFF auto-dispatch (for non-pipeline tasks) ──
      // Pipeline tasks have their own HANDOFF handling in pipeline-engine.ts;
      // this block handles tasks dispatched via dispatch_task or manual enqueue.
      if (!task.pipelineRunId && task.result) {
        try {
          const { parseHandoff, stripHandoff } = await import('./pipeline-engine.js');
          const handoff = parseHandoff(task.result);
          if (handoff && handoff.to.length > 0) {
            // Strip HANDOFF from stored result
            task.result = stripHandoff(task.result);

            // Track feedback iteration to prevent infinite loops
            const currentIteration = handoff.intent === 'feedback'
              ? extractFeedbackIteration(task.prompt)
              : 0;

            // Auto-escalate if feedback loop exceeds threshold
            if (handoff.intent === 'feedback' && currentIteration >= MAX_FEEDBACK_ITERATIONS) {
              await logger.warn('WorkerScheduler',
                `Task ${task.id} feedback loop detected (${currentIteration} iterations), auto-escalating to CTO`);
              await logger.info('WorkerScheduler',
                `Auto-escalation: ${task.agentName} failed to resolve after ${currentIteration} feedback rounds. Summary: ${handoff.summary ?? 'no summary'}`);
              // Do not enqueue — escalation is logged for CTO review
            } else {
              // Dispatch to each target agent
              for (const targetAgent of handoff.to) {
                if (targetAgent === 'ESCALATE') {
                  // Guard: if the escalating agent IS pm, do NOT route back to pm (self-loop).
                  // Just log and wait for CTO intervention.
                  if (task.agentName === 'pm') {
                    await logger.warn('WorkerScheduler',
                      `ESCALATE from pm itself (task ${task.id}) — halting, CTO intervention required: ${handoff.summary ?? 'no summary'}`);
                  } else {
                    // Route escalation to PM for issue triage
                    const escalationPrompt = [
                      `## 上游問題上報（ESCALATE）`,
                      ``,
                      `上游 agent: ${task.agentName}`,
                      `上游 task ID: ${task.id}`,
                      handoff.artifactType ? `產出類型: ${handoff.artifactType}` : '',
                      handoff.summary ? `摘要: ${handoff.summary}` : '',
                    ].filter(Boolean).join('\n');
                    await enqueueTask('pm', escalationPrompt, Math.max(task.priority, 3), {
                      source: 'escalation',
                      parentTaskId: task.parentTaskId ?? task.id,
                      originAgent: task.agentName,
                    });
                    await logger.info('WorkerScheduler',
                      `ESCALATE → pm: ${task.agentName} reported issue (task ${task.id}): ${handoff.summary ?? 'no summary'}`);
                  }

                  // ESCALATE means "stop everything, management must intervene"
                  // Do NOT dispatch remaining targets in this HANDOFF
                  break;
                }

                const feedbackIterationTag = handoff.intent === 'feedback'
                  ? `[feedbackIteration: ${currentIteration + 1}]`
                  : '';

                // Read target agent config for per-agent handoff context cap
                const targetCfg = await loadAgentConfig(targetAgent);
                const handoffCap = targetCfg?.handoffContextCap ?? PIPELINE_CONTEXT_CAP;

                // Write artifact file for full output
                const { writeArtifact } = await import('./governance/handoff-artifact.js');
                const artifactPath = await writeArtifact({
                  taskId: task.id,
                  sourceAgent: task.agentName,
                  artifactType: handoff.artifactType,
                  content: task.result!,
                  worktreePath: task.worktreePath,
                  branchName: task.branchName,
                });

                const downstreamPrompt = [
                  feedbackIterationTag,
                  `## 上游任務交接`,
                  ``,
                  `上游 agent: ${task.agentName}`,
                  `交接類型: ${handoff.intent}`,
                  handoff.intent === 'feedback'
                    ? `⚠️ 這是退回修正（第 ${currentIteration + 1} 次，上限 ${MAX_FEEDBACK_ITERATIONS} 次）——請根據上游的回饋修改後重新交付`
                    : '',
                  `上游 task ID: ${task.id}`,
                  handoff.artifactType ? `產出類型: ${handoff.artifactType}` : '',
                  handoff.summary ? `摘要: ${handoff.summary}` : '',
                  task.worktreePath ? `Worktree 路徑: ${task.worktreePath}` : '',
                  task.branchName ? `Branch: ${task.branchName}` : '',
                  ``,
                  artifactPath
                    ? [
                        `### 上游完整產出`,
                        `上游的完整產出已存放在以下檔案，請用 Read tool 讀取：`,
                        `**路徑**: ${artifactPath}`,
                        `**大小**: ${task.result!.length} 字元`,
                        ``,
                        `如需了解上游做了什麼，請先讀取此檔案再開始工作。`,
                      ].join('\n')
                    : [
                        `### 上游產出`,
                        truncateWithMarker(task.result!, handoffCap),
                      ].join('\n'),
                ].filter(Boolean).join('\n');

                await enqueueTask(targetAgent, downstreamPrompt, task.priority, {
                  source: 'handoff',
                  parentTaskId: task.parentTaskId ?? task.id,
                  originAgent: task.agentName,
                  worktreePath: task.worktreePath,
                  branchName: task.branchName,
                  handoffIntent: handoff.intent,
                });

                await logger.info('WorkerScheduler',
                  `HANDOFF: ${task.agentName} → ${targetAgent} (task ${task.id}, ${handoff.intent}${handoff.intent === 'feedback' ? `, iteration ${currentIteration + 1}` : ''})`);
              }
            }
          }
        } catch (err) {
          await logger.warn('WorkerScheduler',
            `HANDOFF parsing failed for task ${task.id} (non-fatal)`, err);
        }
      }
    } else {
      // Record failure for circuit breaker (only transient errors trip the breaker)
      try { const { recordWorkerFailure } = await import('./monitoring/worker-circuit-breaker.js'); recordWorkerFailure(result.error ?? 'unknown'); } catch { /* non-critical */ }

      addTrace(task, 'cli-failed', `${result.error?.slice(0, 150) ?? 'unknown'}`);

      task.status = 'failed';
      task.error = result.error;
      task.completedAt = new Date().toISOString();
      updateTaskInDb(task);

      const failCat2 = classifyFailure(result.error);
      await recordAgentFailure(task.agentName, result.error, failCat2).catch((e) => {
        logger.debug('WorkerScheduler', `recordAgentFailure non-fatal: ${(e as Error).message}`);
      });

      await eventBus.emit('agent:task:failed', {
        agentName: task.agentName,
        taskId: task.id,
        error: result.error,
      });

      // Extract knowledge from costly failures (Phase 2)
      if ((task.costUsd ?? 0) > 0.15) {
        try {
          const { extractAndDeposit } = await import('./knowledge/knowledge-extractor.js');
          await extractAndDeposit(task, result.error ?? 'Task failed', 0, agentCfg, workerId);
        } catch (e) {
          logger.debug('WorkerScheduler', `failure knowledge extraction non-fatal: ${(e as Error).message}`);
        }
      }

      await logger.warn('WorkerScheduler', `Task ${task.id} failed (${failCat2}): ${result.error}`);
    }
  } catch (err) {
    addTrace(task, 'error', `Exception: ${(err as Error).message.slice(0, 150)}`);

    task.status = 'failed';
    task.error = (err as Error).message;
    task.completedAt = new Date().toISOString();
    updateTaskInDb(task);

    const failCat3 = classifyFailure(task.error ?? 'unknown error');
    await recordAgentFailure(task.agentName, task.error ?? 'unknown error', failCat3).catch((e) => {
      logger.debug('WorkerScheduler', `recordAgentFailure non-fatal: ${(e as Error).message}`);
    });

    await eventBus.emit('agent:task:failed', {
      agentName: task.agentName,
      taskId: task.id,
      error: task.error,
    });

    await logger.error('WorkerScheduler', `Task ${task.id} error`, err);
  } finally {
    // ── Worktree cleanup: DEFERRED to orphan cleanup ──
    // Worktree cleanup is intentionally NOT done here.
    // In pipeline scenarios (programmer → reviewer → secretary), downstream agents
    // inherit the worktree path. Cleaning up here would delete the worktree before
    // downstream agents can use it. Instead, worktrees are cleaned up by:
    // 1. Periodic orphan cleanup via heartbeat:tick (every 30 min)
    // 2. TTL-based expiration (2h) in cleanupOrphanWorktrees()
    if (isWorktreeCreator && task.worktreePath) {
      addTrace(task, 'worktree-deferred-cleanup', `Worktree ${task.worktreePath} cleanup deferred to orphan cleanup (pipeline may still need it)`);
    }
  }
}

// buildWorkerSystemPrompt() → extracted to prompt-builder.ts

// ── Schedule Constraints (SPEC-11) ───────────────────────────────────

/**
 * Check if an agent's schedule constraints allow it to run right now.
 * Returns true if all constraints are met (or no constraints defined).
 * Exported for testability.
 */
export function meetsScheduleConstraints(cfg: AgentConfig, now: Date = new Date()): boolean {
  const c = cfg.scheduleConstraints;
  if (!c) return true; // No constraints = always allowed (backward-compatible)

  // Convert to bot timezone for hour/day checks
  const local = new Date(now.toLocaleString('en-US', { timeZone: config.TIMEZONE }));
  const hour = local.getHours();
  const day = local.getDay() || 7; // Sunday 0 → 7 (ISO: 1=Mon..7=Sun)

  if (c.activeHours) {
    const [start, end] = c.activeHours;
    if (start < end) {
      // Normal window (e.g., [8, 22])
      if (hour < start || hour >= end) return false;
    } else {
      // Overnight window (e.g., [22, 6])
      if (hour < start && hour >= end) return false;
    }
  }

  if (c.activeDays && !c.activeDays.includes(day)) return false;

  if (c.costGate !== undefined) {
    const todaySpend = cfg.costResetDate === getTodayString(now)
      ? (cfg.totalCostToday ?? 0) : 0;
    if (todaySpend >= c.costGate) return false;
  }

  return true;
}

// ── Main Processing Loop ─────────────────────────────────────────────

/**
 * Process the task queue — called on each heartbeat tick.
 * Picks pending tasks by priority, assigns to free workers.
 */
async function processQueue(): Promise<void> {
  if (isProcessing) return; // Prevent re-entry
  isProcessing = true;

  try {
    // 0. Kill switch: skip processing if in emergency mode
    //    (RESTRICTED mode will filter out scheduled tasks later, but allow manual dispatch)
    let isRestrictedMode = false;
    try {
      const { isRestricted, isEmergency } = await import('../safety/kill-switch.js');
      if (isEmergency()) {
        await logger.debug('WorkerScheduler', 'Skipping queue processing — emergency mode active');
        return;
      }
      isRestrictedMode = isRestricted();
    } catch {
      // kill-switch unavailable — proceed normally
    }

    // 1. Check scheduled agents and enqueue if due (skip during startup grace period)
    if (Date.now() - startupTime >= STARTUP_GRACE_MS) {
      await checkScheduledAgents();
    }

    // 2. Load current queue
    const queue = await loadQueue();

    // 3. Clean up stale "running" tasks (worker might have crashed)
    for (const task of queue.tasks) {
      if (task.status === 'running' && task.workerId !== null) {
        if (!isBusy(task.workerId)) {
          // Worker is no longer busy but task still "running" → it crashed
          const retries = task.retryCount ?? 0;
          if (retries < MAX_TASK_RETRIES) {
            await logger.info('WorkerScheduler',
              `Task ${task.id} worker crashed, requeuing (retry ${retries + 1}/${MAX_TASK_RETRIES})`);
            requeueForRetry(task);
            updateTaskInDb(task);
          } else {
            task.status = 'failed';
            task.error = 'Worker process terminated unexpectedly (retries exhausted)';
            task.completedAt = new Date().toISOString();
            updateTaskInDb(task);
            await logger.warn('WorkerScheduler',
              `Task ${task.id} marked failed — worker ${task.workerId} crashed, retries exhausted`);
            // Write to Dead Letter Queue for post-mortem
            const errorTraces = (task.trace ?? []).filter(t => t.phase === 'error');
            await appendDeadLetter(buildDeadLetterEntry(
              task.id, task.agentName, task.prompt,
              errorTraces.map((t, i) => ({ attempt: i + 1, error: t.detail, timestamp: t.ts, duration: 0, costUsd: 0 })),
              'retry-exhausted',
              { pipelineRunId: task.pipelineRunId, parentTaskId: task.parentTaskId, totalCost: task.costUsd },
            ));
          }
        }
      }
    }

    // 3.5 Recover stalled pipelines (event delivery failures)
    try {
      const { recoverStalledPipelines } = await import('./pipeline-engine.js');
      const recovered = await recoverStalledPipelines();
      if (recovered > 0) {
        await logger.info('WorkerScheduler', `Recovered ${recovered} stalled pipeline stage(s)`);
      }
    } catch (e) {
      logger.debug('WorkerScheduler', `recoverStalledPipelines non-fatal: ${(e as Error).message}`);
    }

    // 4. Get pending tasks sorted by priority (desc) then createdAt (asc)
    //    Filter out tasks whose dependencies haven't been met.
    const completedIds = await getRecentCompletedIds();

    const now = new Date().toISOString();
    const pendingTasks = queue.tasks
      .filter((t) => t.status === 'pending')
      .filter((t) => {
        // In RESTRICTED mode, only allow manually dispatched tasks (filter out scheduled)
        if (isRestrictedMode && t.source === 'scheduled') return false;
        // Skip tasks in backoff period (exponential retry delay)
        if (t.retryAfter && t.retryAfter > now) return false;
        const depCheck = checkDependencies(t, queue.tasks, completedIds);
        if (depCheck.failedDep) {
          // Dependency permanently failed — propagate failure
          t.status = 'failed';
          t.error = `Dependency failed: ${depCheck.failedDep}`;
          t.completedAt = new Date().toISOString();
          addTrace(t, 'dep-failed', `Dependency ${depCheck.failedDep} failed, cascading`);
          updateTaskInDb(t);
          return false;
        }
        if (!depCheck.satisfied) {
          addTrace(t, 'blocked', `Waiting for: ${depCheck.blockedBy.join(', ')}`);
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt.localeCompare(b.createdAt);
      });

    if (pendingTasks.length === 0) {
      // No pending tasks — save any stale-task cleanups and return
      await saveQueue(queue);
      return;
    }

    // 5. Dispatch tasks to free workers
    let dispatched = 0;
    const reservedWorkers = new Set<number>(); // Prevent same-round race condition
    const reservedAgents = new Set<string>();  // Prevent same-agent concurrent execution (non-worktree agents only)
    let worktreeSlotsUsed = 0; // Track worktrees dispatched this round

    // Pre-load agent configs for concurrency decisions
    const allAgentConfigs = await loadAllAgentConfigs();
    const agentConfigMap = new Map(allAgentConfigs.map(c => [c.name, c]));

    for (const task of pendingTasks) {
      // ── Per-agent concurrency control ──
      // Worktree-isolated agents (either creating or inheriting a worktree) can run in parallel.
      // All others (shared-cwd agents) must serialize.
      const agentCfgForCheck = agentConfigMap.get(task.agentName);
      const isWorktreeIsolated = task.worktreePath != null ||
        (agentCfgForCheck != null && shouldUseWorktree(agentCfgForCheck, task));

      if (!isWorktreeIsolated) {
        // Non-worktree tasks: same-agent serialization (original behavior)
        const agentAlreadyRunning = reservedAgents.has(task.agentName) ||
          queue.tasks.some(t => t.agentName === task.agentName && t.status === 'running');
        if (agentAlreadyRunning) continue;
      }
      // Worktree tasks: skip serialization check — each gets its own isolated worktree

      // Worktree slot limit: prevent exceeding MAX_WORKTREES
      if (isWorktreeIsolated) {
        const runningWorktreeTasks = queue.tasks.filter(
          t => t.status === 'running' && t.worktreePath
        ).length;
        if (runningWorktreeTasks + worktreeSlotsUsed >= MAX_WORKTREES) {
          addTrace(task, 'worktree-limit', `Max worktrees reached (${runningWorktreeTasks} running + ${worktreeSlotsUsed} reserved)`);
          continue; // Skip — no worktree slots available
        }
      }

      const workerId = findFreeWorker(reservedWorkers);
      if (workerId === null) break; // No free workers

      // Pre-dispatch budget reservation (prevents race condition)
      const estimatedCost = ESTIMATED_COST_PER_TASK;
      if (!(await reserveBudget(task.agentName, estimatedCost))) {
        addTrace(task, 'budget-reserved-fail', `Pre-dispatch budget reservation failed for ${task.agentName}`);
        continue; // Skip this task, try next
      }

      reservedWorkers.add(workerId); // Reserve this worker for this round
      // Only reserve agent slot for non-worktree tasks (worktree tasks can run in parallel)
      if (!isWorktreeIsolated) {
        reservedAgents.add(task.agentName);
      } else {
        worktreeSlotsUsed++;
      }

      // Mark as running BEFORE async dispatch so saveQueue persists the correct status.
      // Without this, a reprocess triggered by reprocessCounter could reload the queue
      // from disk and see the task as still 'pending', causing duplicate dispatch.
      task.status = 'running';
      task.workerId = workerId;
      task.startedAt = new Date().toISOString();
      updateTaskInDb(task);

      // Dispatch — fire and forget, completion handler saves state + re-triggers queue
      executeTask(task, workerId).then(async () => {
        await releaseBudget(task.agentName, estimatedCost);
        // After completion, check if eligible for retry
        if (task.status === 'failed' && isTransientError(task.error)) {
          const retries = task.retryCount ?? 0;
          if (retries < MAX_TASK_RETRIES) {
            await logger.info('WorkerScheduler',
              `Task ${task.id} failed with transient error, requeuing (retry ${retries + 1}/${MAX_TASK_RETRIES})`);
            requeueForRetry(task);
            updateTaskInDb(task);
          } else {
            await logger.warn('WorkerScheduler',
              `Task ${task.id} exhausted retries (${MAX_TASK_RETRIES}), archiving as failed`);
            // Write to Dead Letter Queue for post-mortem
            const dlqTraces = (task.trace ?? []).filter(t => t.phase === 'error');
            await appendDeadLetter(buildDeadLetterEntry(
              task.id, task.agentName, task.prompt,
              dlqTraces.map((t, i) => ({ attempt: i + 1, error: t.detail, timestamp: t.ts, duration: task.duration, costUsd: task.costUsd })),
              'retry-exhausted',
              { pipelineRunId: task.pipelineRunId, parentTaskId: task.parentTaskId, totalCost: task.costUsd },
            ));
            await archiveTask(task);
          }
        } else if (task.status === 'failed' && !isTransientError(task.error)) {
          // Non-transient failure: only quality failures trigger reroute
          const failCat = classifyFailure(task.error ?? '');
          if (failCat === 'quality') {
            await attemptReroute(task);
          }
          // Always archive the original failed task (whether rerouted or not)
          await archiveTask(task);
        } else if (task.status === 'completed' || task.status === 'failed') {
          // Archive terminal tasks (completed, or failed with conditions not caught above)
          await archiveTask(task);
        }

        // Re-trigger queue processing to dispatch any waiting tasks
        processQueue().catch(() => {/* non-fatal */});
      }).catch(async (err) => {
        await releaseBudget(task.agentName, estimatedCost);
        await logger.error('WorkerScheduler', `Task ${task.id} dispatch error`, err);
      });
      dispatched++;
    }

    // Save queue state (tasks now marked as 'running')
    await saveQueue(queue);

    if (dispatched > 0) {
      await logger.info('WorkerScheduler',
        `Dispatched ${dispatched} task(s) to workers`);
    }
  } catch (err) {
    await logger.error('WorkerScheduler', 'processQueue error', err);
  } finally {
    isProcessing = false;

    // If new tasks were enqueued during this cycle (e.g. pipeline stage advancement),
    // immediately process them instead of waiting for the next heartbeat tick.
    if (reprocessCounter > 0) {
      reprocessCounter = 0; // Drain all pending — single reprocess handles all
      processQueue().catch(() => {/* non-fatal */});
    }
  }
}

/** Move completed/failed task to history JSONL and remove from queue. */
async function archiveTask(task: AgentTask): Promise<void> {
  try {
    // SQLite: task already updated with final status via updateTaskInDb()
    // JSONL backup: append to history for consumers that still read JSONL
    await writer.appendJsonl(HISTORY_PATH, task);

    // Remove from in-memory queue + JSON backup
    const queue = await loadQueue();
    queue.tasks = queue.tasks.filter((t) => t.id !== task.id);
    await saveQueue(queue);
    invalidateReportsCache();
  } catch (err) {
    await logger.warn('WorkerScheduler', `Failed to archive task ${task.id}`, err);
  }
}

// ── Heartbeat Integration ────────────────────────────────────────────

const WORKTREE_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let lastWorktreeCleanup = 0;
const REPORT_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let lastReportCleanup = 0;

async function handleTick(data: { timestamp: number; state: string }): Promise<void> {
  // Process queue in all states except dormant deep-sleep
  // (dormant = deep_night 2-6am, no scheduled tasks should run then)
  // Previously only ran in active/resting, which caused tasks to stall
  // after overnight dormant → morning transition if no user interaction woke the bot
  if (data.state === 'dormant') return;

  await processQueue();

  // ── Periodic worktree cleanup (every 30 minutes) ──
  const now = Date.now();
  if (now - lastWorktreeCleanup > WORKTREE_CLEANUP_INTERVAL_MS) {
    lastWorktreeCleanup = now;
    try {
      const { cleanupOrphanWorktrees } = await import('./governance/worktree-manager.js');
      await cleanupOrphanWorktrees();
    } catch (err) {
      await logger.warn('WorkerScheduler', `Worktree cleanup error: ${(err as Error).message}`);
    }
  }

  // ── Periodic report cleanup (every 30 minutes) ──
  if (now - lastReportCleanup > REPORT_CLEANUP_INTERVAL_MS) {
    lastReportCleanup = now;
    cleanupOldReports().catch(err =>
      logger.warn('WorkerScheduler', `Report cleanup error: ${(err as Error).message}`)
    );
  }
}

// ── Public: Start / Stop ─────────────────────────────────────────────

/**
 * Check for .dispatch signal file written by MCP dispatch_task tool.
 * If found, trigger immediate queue processing and remove the signal.
 */
async function checkDispatchSignal(): Promise<void> {
  try {
    await access(DISPATCH_SIGNAL, constants.F_OK);
  } catch {
    return; // No signal file — fast path, no Error object creation
  }
  // Signal exists — remove it and process queue
  try { await unlink(DISPATCH_SIGNAL); } catch { /* already removed by race */ }
  await logger.info('WorkerScheduler', 'Dispatch signal detected, processing queue...');
  await processQueue();
}

export function startWorkerScheduler(): void {
  if (tickHandler) return; // Already started

  // Auto-import JSONL data into SQLite if tables are empty (first boot after migration)
  // Then clean up stale tasks, rehydrate pipelines, and process pending tasks.
  autoImportIfNeeded()
    .then(() => cleanupStaleTasksOnStartup())
    .then(async () => {
      const { rehydratePipelines } = await import('./pipeline-engine.js');
      const count = await rehydratePipelines();
      if (count > 0) await logger.info('WorkerScheduler', `Rehydrated ${count} pipeline(s)`);
    })
    .then(() => processQueue())
    .catch((err) => {
      logger.warn('WorkerScheduler', 'Startup cleanup/dispatch failed (non-fatal)', err);
    });

  // Register pipeline event listeners (idempotent)
  import('./pipeline-engine.js')
    .then(({ registerPipelineListener }) => {
      registerPipelineListener();
      logger.info('WorkerScheduler', 'Pipeline engine listener registered');
    })
    .catch((err) => {
      logger.warn('WorkerScheduler', 'Pipeline engine not available (non-fatal)', err);
    });

  tickHandler = (data) => { handleTick(data); };
  eventBus.on('heartbeat:tick', tickHandler);

  // Poll for MCP dispatch signal every 60s (reduced from 10s to save idle CPU)
  dispatchPollTimer = setInterval(() => {
    checkDispatchSignal().catch(() => {/* non-fatal */});
  }, 60_000);

  logger.info('WorkerScheduler', 'Worker scheduler started (listening to heartbeat:tick + dispatch signal)');
}

/** Auto-import JSONL data into SQLite if tables are empty (first boot after Phase 3 migration). */
async function autoImportIfNeeded(): Promise<void> {
  try {
    const db = getDb();
    const taskCount = db.prepare('SELECT COUNT(*) as c FROM agent_tasks').get() as { c: number };
    if (taskCount.c === 0) {
      const { importAgentTasks } = await import('../core/db-import.js');
      const n = importAgentTasks(db);
      if (n > 0) await logger.info('WorkerScheduler', `Auto-imported ${n} tasks from JSONL into SQLite`);
    }

    const reportCount = db.prepare('SELECT COUNT(*) as c FROM agent_reports').get() as { c: number };
    if (reportCount.c === 0) {
      const { importAgentReports } = await import('../core/db-import.js');
      const n = importAgentReports(db);
      if (n > 0) await logger.info('WorkerScheduler', `Auto-imported ${n} reports from JSONL into SQLite`);
    }
  } catch (err) {
    await logger.warn('WorkerScheduler', `Auto-import failed (non-fatal): ${(err as Error).message}`);
  }
}

/** Archive any completed/failed tasks left in the queue (e.g. from a previous crash). */
async function cleanupStaleTasksOnStartup(): Promise<void> {
  const queue = await loadQueue();
  const stale = queue.tasks.filter((t) => t.status === 'completed' || t.status === 'failed');
  if (stale.length === 0) return;

  for (const task of stale) {
    await writer.appendJsonl(HISTORY_PATH, task);
  }

  queue.tasks = queue.tasks.filter((t) => t.status !== 'completed' && t.status !== 'failed');
  await saveQueue(queue);
  await logger.info('WorkerScheduler',
    `Startup cleanup: archived ${stale.length} stale task(s) from queue`);
}

export function stopWorkerScheduler(): void {
  if (tickHandler) {
    eventBus.off('heartbeat:tick', tickHandler);
    tickHandler = null;
  }
  if (dispatchPollTimer) {
    clearInterval(dispatchPollTimer);
    dispatchPollTimer = null;
  }
  logger.info('WorkerScheduler', 'Worker scheduler stopped');
}

// ── Testing Exports ──────────────────────────────────────────────────

export const __testing = {
  truncateWithMarker,
  PIPELINE_CONTEXT_CAP,
  extractFeedbackIteration,
  MAX_FEEDBACK_ITERATIONS,
  withBudgetLock,
  reserveBudget,
  releaseBudget,
  budgetReservations,
};
