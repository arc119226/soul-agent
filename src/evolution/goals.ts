/**
 * Goal CRUD + priority queue for evolution planning.
 * Persists to soul/evolution/goals.json.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const GOALS_FILE = join(process.cwd(), 'soul', 'evolution', 'goals.json');

export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Goal {
  id: string;
  description: string;
  priority: number; // 1-5, higher = more important
  status: GoalStatus;
  tags: string[];
  createdAt: string;
  completedAt?: string;
  failReason?: string;
  failCount?: number; // Track how many times this goal has failed
  lastFailedAt?: string; // Timestamp of last failure (for retry cooldown)
  lastFailedPath?: 'research' | 'skill' | 'code'; // Which route path failed last (for retry loop prevention)
}

interface GoalsFile {
  version: number;
  goals: Goal[];
}

let goalsCache: Goal[] = [];

function defaultGoalsFile(): GoalsFile {
  return { version: 1, goals: [] };
}

/** Load goals from disk into cache */
export async function loadGoals(): Promise<void> {
  try {
    const raw = await readFile(GOALS_FILE, 'utf-8');
    const data: GoalsFile = JSON.parse(raw);
    goalsCache = data.goals ?? [];
    logger.info('goals', `Loaded ${goalsCache.length} goal(s)`);
  } catch {
    goalsCache = [];
    logger.info('goals', 'No existing goals file, starting fresh');
  }
}

/** Persist goals to disk */
function saveGoals(): void {
  const data: GoalsFile = { version: 1, goals: goalsCache };
  writer.schedule(GOALS_FILE, data);
}

/** Persist goals immediately */
export async function flushGoals(): Promise<void> {
  const data: GoalsFile = { version: 1, goals: goalsCache };
  await writer.writeNow(GOALS_FILE, data);
}

/** Add a new goal */
export function addGoal(
  description: string,
  priority: number = 3,
  tags: string[] = [],
): Result<string> {
  const clamped = Math.max(1, Math.min(5, Math.round(priority)));
  const goal: Goal = {
    id: randomUUID().slice(0, 8),
    description,
    priority: clamped,
    status: 'pending',
    tags,
    createdAt: new Date().toISOString(),
  };
  goalsCache.push(goal);
  saveGoals();
  logger.info('goals', `Added goal: ${goal.id} — ${description}`);
  return ok('Goal added', goal.id);
}

/** Remove a goal by id */
export function removeGoal(id: string): Result {
  const idx = goalsCache.findIndex((g) => g.id === id);
  if (idx === -1) return fail(`Goal not found: ${id}`);
  goalsCache.splice(idx, 1);
  saveGoals();
  logger.info('goals', `Removed goal: ${id}`);
  return ok('Goal removed');
}

/** Mark a goal as completed */
export function completeGoal(id: string): Result {
  const goal = goalsCache.find((g) => g.id === id);
  if (!goal) return fail(`Goal not found: ${id}`);
  goal.status = 'completed';
  goal.completedAt = new Date().toISOString();
  saveGoals();
  logger.info('goals', `Completed goal: ${id}`);
  return ok('Goal completed');
}

/** Maximum attempts before a goal is permanently abandoned */
const MAX_GOAL_ATTEMPTS = 3;

/** Minimum cooldown (ms) before retrying a failed goal */
const RETRY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum time a goal can stay in_progress before being considered stale */
const STALE_IN_PROGRESS_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Mark a goal as failed */
export function failGoal(id: string, reason: string, failedPath?: 'research' | 'skill' | 'code'): Result {
  const goal = goalsCache.find((g) => g.id === id);
  if (!goal) return fail(`Goal not found: ${id}`);
  goal.failCount = (goal.failCount ?? 0) + 1;
  goal.failReason = reason;
  goal.lastFailedAt = new Date().toISOString();
  if (failedPath) {
    goal.lastFailedPath = failedPath;
  }

  if (goal.failCount >= MAX_GOAL_ATTEMPTS) {
    // Permanently abandon — too many attempts
    goal.status = 'failed';
    goal.completedAt = new Date().toISOString();
    logger.warn('goals', `Abandoned goal after ${goal.failCount} attempts: ${id} — ${reason}`);
  } else {
    // Return to pending for retry (with cooldown enforced by getNextGoal)
    goal.status = 'pending';
    logger.warn('goals', `Failed goal (attempt ${goal.failCount}/${MAX_GOAL_ATTEMPTS}): ${id} — ${reason}`);
  }

  saveGoals();
  return ok('Goal marked as failed');
}

/** Mark a goal as in_progress */
export function startGoal(id: string): Result {
  const goal = goalsCache.find((g) => g.id === id);
  if (!goal) return fail(`Goal not found: ${id}`);
  goal.status = 'in_progress';
  saveGoals();
  return ok('Goal started');
}

/** Reset stale in_progress goals back to pending */
function resetStaleGoals(): void {
  const now = Date.now();
  for (const g of goalsCache) {
    if (g.status !== 'in_progress') continue;
    // Use lastFailedAt as proxy for last activity; fall back to createdAt
    const lastActivity = g.lastFailedAt ?? g.createdAt;
    const elapsed = now - new Date(lastActivity).getTime();
    if (elapsed > STALE_IN_PROGRESS_MS) {
      logger.warn('goals', `Resetting stale in_progress goal: ${g.id} (stuck for ${Math.round(elapsed / 60000)} min)`);
      g.status = 'pending';
      g.failCount = (g.failCount ?? 0) + 1;
      g.failReason = `Auto-reset: stuck in_progress for ${Math.round(elapsed / 60000)} minutes`;
      g.lastFailedAt = new Date().toISOString();
    }
  }
}

/** Get next highest-priority uncompleted goal (respects retry cooldown) */
export function getNextGoal(): Goal | null {
  // Clean up stale in_progress goals first
  resetStaleGoals();

  const now = Date.now();
  const pending = goalsCache.filter((g) => {
    if (g.status !== 'pending') return false;
    // Enforce retry cooldown: skip goals that failed recently
    if (g.lastFailedAt) {
      const timeSinceFailure = now - new Date(g.lastFailedAt).getTime();
      if (timeSinceFailure < RETRY_COOLDOWN_MS) {
        return false; // Still in cooldown
      }
    }
    // Skip goals that have reached max attempts (shouldn't happen, but safety check)
    if ((g.failCount ?? 0) >= MAX_GOAL_ATTEMPTS) {
      return false;
    }
    return true;
  });
  if (pending.length === 0) return null;
  // Sort by priority desc, then by createdAt asc (oldest first)
  pending.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return pending[0] ?? null;
}

/** Get a goal by id */
export function getGoal(id: string): Goal | undefined {
  return goalsCache.find((g) => g.id === id);
}

/** Get all goals */
export function getAllGoals(): Goal[] {
  return [...goalsCache];
}

/** Get goals by status */
export function getGoalsByStatus(status: GoalStatus): Goal[] {
  return goalsCache.filter((g) => g.status === status);
}
