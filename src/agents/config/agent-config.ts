/**
 * Agent configuration CRUD — reads/writes soul/agents/{name}.json.
 *
 * Bot can create, update, list, and delete agent configs at runtime.
 * Each config defines an agent's persona, schedule, model, and cost limits.
 */

import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writer } from '../../core/debounced-writer.js';
import { logger } from '../../core/logger.js';
import { getTodayString } from '../../core/timezone.js';
import type { AgentRole, AgentPermissions } from '../governance/agent-permissions.js';

// ── Zod Schema (runtime validation for agent configs) ────────────────

const AgentPermissionsSchema = z.object({
  read: z.array(z.string()).optional(),
  write: z.array(z.string()).optional(),
  execute: z.array(z.string()).optional(),
});

const ScheduleConstraintsSchema = z.object({
  activeHours: z.tuple([z.number(), z.number()]).optional(),
  activeDays: z.array(z.number()).optional(),
  costGate: z.number().optional(),
});

const FailureBreakdownSchema = z.object({
  transient: z.number(),
  budget: z.number(),
  quality: z.number(),
});

const PersonalitySchema = z.object({
  tagline: z.string().max(100),
  tone: z.string().max(50),
  opinionated: z.number().min(0).max(1).optional(),
  verbosity: z.number().min(0).max(1).optional(),
});

export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: z.string().optional(),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  timeout: z.number().positive().optional(),
  dailyCostLimit: z.number().nonnegative().optional(),
  budgetLocked: z.boolean().optional(),
  scheduleLocked: z.boolean().optional(),
  notifyChat: z.boolean().optional(),
  targets: z.record(z.unknown()).optional(),
  role: z.enum(['observer', 'executor', 'guardian']).optional(),
  permissions: AgentPermissionsSchema.optional(),
  scheduleConstraints: ScheduleConstraintsSchema.optional(),
  capabilities: z.array(z.string()).optional(),
  dependsOnAgents: z.array(z.string()).optional(),
  maxCostPerTask: z.number().nonnegative().optional(),
  handoffContextCap: z.number().int().positive().optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  lastRun: z.string().nullable().optional(),
  totalCostToday: z.number().optional(),
  costResetDate: z.string().optional(),
  totalRuns: z.number().optional(),
  runsToday: z.number().optional(),
  createdAt: z.string().optional(),
  failureCount7d: z.number().optional(),
  lastFailedAt: z.string().nullable().optional(),
  lastFailureReason: z.string().nullable().optional(),
  valueScore: z.number().optional(),
  failureBreakdown: FailureBreakdownSchema.optional(),
  pauseUntil: z.string().optional(),
  valueNote: z.string().optional(),
  fallbackAgents: z.array(z.string()).optional(),
  avgDurationMs: z.number().optional(),
  totalDurationMs: z.number().optional(),
  personality: PersonalitySchema.optional(),
}).passthrough();

const AGENTS_DIR = join(process.cwd(), 'soul', 'agents');

// ── Config Cache ─────────────────────────────────────────────────────

const CONFIG_CACHE_TTL = 30_000; // 30 seconds
let configCache: { data: AgentConfig[]; expireAt: number } | null = null;

export function invalidateConfigCache(): void {
  configCache = null;
}

// ── Types ────────────────────────────────────────────────────────────

export interface AgentConfig {
  /** Unique agent name (filename stem, e.g. "github-patrol") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Whether this agent is active */
  enabled: boolean;
  /**
   * Schedule expression:
   *   "every:5m" | "every:2h" | "daily@08:00" | "manual"
   */
  schedule: string;
  /** System prompt injected into the worker CLI call */
  systemPrompt: string;
  /** Model override (e.g. "claude-haiku-4-5-20251001"). Empty = scheduler default */
  model: string;
  /** Max CLI turns per execution */
  maxTurns: number;
  /** Timeout per execution in ms */
  timeout: number;
  /** Daily cost limit in USD. 0 = unlimited */
  dailyCostLimit: number;
  /** If true, budget optimizer will not overwrite dailyCostLimit */
  budgetLocked?: boolean;
  /** If true, agent-tuner will not overwrite schedule */
  scheduleLocked?: boolean;
  /** If true, prompt-optimizer will not modify systemPrompt */
  promptLocked?: boolean;
  /** Whether to push results to admin chat on completion */
  notifyChat: boolean;
  /** Arbitrary agent-specific config (e.g. target repos, keywords) */
  targets: Record<string, unknown>;

  // ── Role & permissions (optional, defaults to 'observer') ──
  /** Agent role: observer (read-only), executor (can modify code), guardian (monitor-only) */
  role?: AgentRole;
  /** Explicit permission overrides (merged with role defaults) */
  permissions?: Partial<AgentPermissions>;

  // ── Schedule constraints (optional, SPEC-11) ──
  /** Time/day/cost constraints for scheduled execution */
  scheduleConstraints?: {
    /** [startHour, endHour) in bot timezone (24h format). Agent only runs within window. */
    activeHours?: [number, number];
    /** ISO day numbers (1=Monday..7=Sunday). Agent only runs on listed days. */
    activeDays?: number[];
    /** Agent only runs if totalCostToday < costGate */
    costGate?: number;
  };

  // ── Swarm improvements (optional) ──
  /** Structured capability tags for routing (e.g. ["research", "blog", "security"]) */
  capabilities?: string[];
  /** Agent-level dependencies — scheduled task deferred until these agents have run today */
  dependsOnAgents?: string[];
  /** Max cost per single task in USD (0 = no limit). Inspired by SDK's maxBudgetUsd */
  maxCostPerTask?: number;
  /** Max characters for HANDOFF context truncation (overrides PIPELINE_CONTEXT_CAP) */
  handoffContextCap?: number;
  /** Allowed tools list — agent can only use these (prompt-level enforcement) */
  allowedTools?: string[];
  /** Denied tools list — agent cannot use these (prompt-level enforcement) */
  deniedTools?: string[];

  // ── Runtime stats (updated by scheduler) ──
  lastRun: string | null;
  totalCostToday: number;
  costResetDate: string;
  totalRuns: number;
  /** Runs completed on costResetDate (reset alongside totalCostToday) */
  runsToday?: number;
  createdAt: string;

  // ── Feedback stats (updated on failure, used by agent-tuner for ROI decisions) ──
  /** Rolling count of failures in the last 7 days (reset daily) */
  failureCount7d?: number;
  /** ISO timestamp of the last failure */
  lastFailedAt?: string | null;
  /** Error message from the most recent failure */
  lastFailureReason?: string | null;
  /** Computed value score 0-1 (weighted combination of success rate and report quality) */
  valueScore?: number;

  // ── Failure classification (managed by worker-scheduler + graduated-response) ──
  /** Breakdown of failure types for observability and graduated response */
  failureBreakdown?: {
    transient: number;
    budget: number;
    quality: number;
  };

  // ── Graduated Response (managed by graduated-response.ts) ──
  /** ISO timestamp — agent is paused until this time */
  pauseUntil?: string;
  /** Human-readable note about why the agent was paused/throttled */
  valueNote?: string;

  // ── Reroute (fault tolerance) ──
  /** Ordered list of fallback agent names for rerouting on quality failure */
  fallbackAgents?: string[];

  // ── Duration tracking ──
  /** Average task duration in milliseconds (rolling average) */
  avgDurationMs?: number;
  /** Cumulative total duration in milliseconds */
  totalDurationMs?: number;

  // ── Personality (separate from systemPrompt job responsibilities) ──
  /** Character/tone/style traits — injected as `## 你的性格` in worker prompts */
  personality?: {
    tagline: string;
    tone: string;
    opinionated?: number;
    verbosity?: number;
  };
}

// ── Defaults ─────────────────────────────────────────────────────────

function defaultConfig(name: string): AgentConfig {
  const now = new Date().toISOString();
  return {
    name,
    description: '',
    enabled: true,
    schedule: 'manual',
    systemPrompt: '',
    model: '',
    maxTurns: 100, // High ceiling — let agents complete naturally without truncation
    timeout: 120_000,
    dailyCostLimit: 0.50,
    notifyChat: false,
    targets: {},
    lastRun: null,
    totalCostToday: 0,
    costResetDate: now.slice(0, 10),
    totalRuns: 0,
    createdAt: now,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────

function agentPath(name: string): string {
  // Sanitize: only allow a-z, 0-9, hyphen, underscore
  const safe = name.replace(/[^a-z0-9_-]/gi, '');
  if (!safe) throw new Error(`Invalid agent name: ${name}`);
  return join(AGENTS_DIR, `${safe}.json`);
}

/** Load a single agent config by name. Returns null if not found or invalid. */
export async function loadAgentConfig(name: string): Promise<AgentConfig | null> {
  try {
    const raw = await readFile(agentPath(name), 'utf-8');
    const json = JSON.parse(raw);

    // Runtime schema validation
    const parsed = AgentConfigSchema.safeParse(json);
    if (!parsed.success) {
      await logger.error('agent-config', `Invalid config for "${name}": ${parsed.error.message}`);
      return null;
    }

    // Merge with defaults to handle schema evolution
    const data = parsed.data as Partial<AgentConfig>;
    return { ...defaultConfig(name), ...data, name };
  } catch {
    return null;
  }
}

/** Save (create or update) an agent config. */
export async function saveAgentConfig(cfg: AgentConfig): Promise<void> {
  await writer.writeNow(agentPath(cfg.name), cfg);
  invalidateConfigCache();
  await logger.info('AgentConfig', `Saved agent config: ${cfg.name}`);
}

/** List all agent config names (from soul/agents/*.json). */
export async function listAgentNames(): Promise<string[]> {
  try {
    const files = await readdir(AGENTS_DIR);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/** Load all agent configs (cached, parallel I/O). */
export async function loadAllAgentConfigs(): Promise<AgentConfig[]> {
  if (configCache && Date.now() < configCache.expireAt) return configCache.data;
  const names = await listAgentNames();
  const results = await Promise.all(names.map(name => loadAgentConfig(name)));
  const configs = results.filter((c): c is AgentConfig => c !== null);
  configCache = { data: configs, expireAt: Date.now() + CONFIG_CACHE_TTL };
  return configs;
}

/** Delete an agent config. */
export async function deleteAgentConfig(name: string): Promise<boolean> {
  try {
    await unlink(agentPath(name));
    invalidateConfigCache();
    await logger.info('AgentConfig', `Deleted agent config: ${name}`);
    return true;
  } catch {
    return false;
  }
}

/** Create a new agent with defaults, merging provided overrides. */
export async function createAgent(
  name: string,
  overrides: Partial<Omit<AgentConfig, 'name' | 'createdAt'>>,
): Promise<AgentConfig> {
  const cfg: AgentConfig = { ...defaultConfig(name), ...overrides, name };
  await saveAgentConfig(cfg);
  return cfg;
}

/** Update runtime stats after a task execution. */
export async function recordAgentRun(
  name: string,
  costUsd: number,
  durationMs?: number,
): Promise<void> {
  const cfg = await loadAgentConfig(name);
  if (!cfg) return;

  const today = getTodayString();

  // Snapshot yesterday's stats before cost reset (SPEC-08)
  if (cfg.costResetDate && cfg.costResetDate !== today) {
    // Capture this agent's data BEFORE resetting (fixes race condition:
    // concurrent agents resetting costResetDate would make them invisible
    // to the old snapshotDailyStats filter)
    try {
      const { addAgentToSnapshot } = await import('../monitoring/stats-snapshot.js');
      await addAgentToSnapshot(cfg.costResetDate, cfg.name, {
        runs: cfg.runsToday ?? 0,
        failures: cfg.failureCount7d ?? 0,
        totalCost: cfg.totalCostToday ?? 0,
        avgConfidence: cfg.valueScore ?? 0,
        avgDuration: cfg.avgDurationMs ?? 0,
        topFailureReason: cfg.lastFailureReason ?? undefined,
      });
      await logger.info('StatsSnapshot',
        `Captured ${cfg.name} data for ${cfg.costResetDate} before reset (runs=${cfg.runsToday ?? 0}, cost=$${(cfg.totalCostToday ?? 0).toFixed(4)})`);
    } catch (e) {
      // non-fatal — snapshot failure must not block agent runs
      await logger.warn('StatsSnapshot',
        `Failed to capture ${cfg.name} snapshot: ${(e as Error).message}`);
    }
    cfg.totalCostToday = 0;
    cfg.runsToday = 0;
    cfg.costResetDate = today;
  }

  cfg.totalCostToday += costUsd;
  cfg.totalRuns += 1;
  cfg.runsToday = (cfg.runsToday ?? 0) + 1;
  cfg.lastRun = new Date().toISOString();

  // Update duration tracking
  if (durationMs !== undefined && durationMs > 0) {
    cfg.totalDurationMs = (cfg.totalDurationMs ?? 0) + durationMs;
    cfg.avgDurationMs = cfg.totalDurationMs / cfg.totalRuns;
  }

  await saveAgentConfig(cfg);
}

/** Failure category for graduated response classification */
export type FailureCategory = 'transient' | 'budget' | 'quality';

/** Update failure stats after a task failure. */
export async function recordAgentFailure(
  name: string,
  reason: string,
  category: FailureCategory = 'quality',
): Promise<void> {
  const cfg = await loadAgentConfig(name);
  if (!cfg) return;

  const today = getTodayString();

  // Reset 7d counter if date changed (approximation: reset at day boundary)
  if (cfg.costResetDate !== today) {
    cfg.failureCount7d = 0;
    cfg.failureBreakdown = { transient: 0, budget: 0, quality: 0 };
    cfg.totalCostToday = 0;
    cfg.costResetDate = today;
  }

  // Initialize breakdown if missing
  if (!cfg.failureBreakdown) {
    cfg.failureBreakdown = { transient: 0, budget: 0, quality: 0 };
  }

  cfg.failureCount7d = (cfg.failureCount7d ?? 0) + 1;
  cfg.failureBreakdown[category] += 1;
  cfg.lastFailedAt = new Date().toISOString();
  cfg.lastFailureReason = reason.slice(0, 200); // cap length

  await saveAgentConfig(cfg);
}

/** Check if an agent has exceeded its daily cost limit. */
export async function isOverDailyLimit(name: string): Promise<boolean> {
  const cfg = await loadAgentConfig(name);
  if (!cfg) return true;
  if (cfg.dailyCostLimit <= 0) return false; // unlimited

  const today = getTodayString();
  if (cfg.costResetDate !== today) return false; // new day, cost is 0

  return cfg.totalCostToday >= cfg.dailyCostLimit;
}

/** Parse schedule expression into milliseconds interval. Returns null for 'manual' or 'daily@...' patterns. */
export function parseScheduleInterval(schedule: string): number | null {
  if (schedule === 'manual') return null;

  // "every:Xm" → minutes
  const minuteMatch = schedule.match(/^every:(\d+)m$/);
  if (minuteMatch) return parseInt(minuteMatch[1]!, 10) * 60 * 1000;

  // "every:Xh" → hours
  const hourMatch = schedule.match(/^every:(\d+)h$/);
  if (hourMatch) return parseInt(hourMatch[1]!, 10) * 60 * 60 * 1000;

  // "daily@HH:MM" → handled by scheduler, not interval
  if (schedule.startsWith('daily@')) return null;

  return null;
}

/**
 * Check if a daily@HH:MM schedule is due.
 *
 * Returns true once current time >= target time (no upper window limit).
 * De-duplication ("already ran today") is handled by the caller
 * (checkScheduledAgents → alreadyRanToday + lastScheduledCheck map).
 */
export function isDailyScheduleDue(schedule: string, now: Date = new Date()): boolean {
  const match = schedule.match(/^daily@(\d{2}):(\d{2})$/);
  if (!match) return false;

  const targetHour = parseInt(match[1]!, 10);
  const targetMin = parseInt(match[2]!, 10);

  // Convert to Taipei time
  const taipei = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const currentHour = taipei.getHours();
  const currentMin = taipei.getMinutes();

  const targetTotal = targetHour * 60 + targetMin;
  const currentTotal = currentHour * 60 + currentMin;

  return currentTotal >= targetTotal;
}
