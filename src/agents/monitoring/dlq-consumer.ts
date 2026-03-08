/**
 * DLQ Consumer — retries failed tasks from the Dead Letter Queue.
 *
 * Only retries tasks with transient failure sources (retry-exhausted).
 * Permanent failures (pipeline-abort, agent-disabled, chain-depth-exceeded) are skipped.
 *
 * Uses exponential backoff: first retry after 30min, then 1h, then 2h, max 3 retries.
 * Called periodically from daily-maintenance or via /retry command.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../core/logger.js';
import { queryDeadLetters, type DeadLetterEntry } from './dead-letter.js';

// ── Constants ────────────────────────────────────────────────────────

const DLQ_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'dead-letter.jsonl');
const MAX_DLQ_RETRIES = 3;

/** Sources eligible for automatic retry. */
const RETRYABLE_SOURCES: Set<DeadLetterEntry['source']> = new Set([
  'retry-exhausted',
  'reroute-exhausted',
]);

// ── Public API ───────────────────────────────────────────────────────

export interface DLQRetryResult {
  processed: number;
  retried: number;
  skipped: number;
  resolved: number;
  errors: string[];
}

/**
 * Process DLQ entries and retry eligible ones.
 * Returns summary of actions taken.
 */
export async function processDLQ(opts?: {
  agentName?: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<DLQRetryResult> {
  const limit = opts?.limit ?? 20;
  const result: DLQRetryResult = { processed: 0, retried: 0, skipped: 0, resolved: 0, errors: [] };

  // Load recent DLQ entries
  const entries = await queryDeadLetters({
    agentName: opts?.agentName,
    limit,
  });

  if (entries.length === 0) {
    return result;
  }

  // Dynamic import to avoid circular dependency
  const { enqueueTask } = await import('../worker-scheduler.js');
  const { loadAgentConfig } = await import('../config/agent-config.js');

  for (const entry of entries) {
    result.processed++;

    // Skip already resolved entries
    if (entry.resolution) {
      result.resolved++;
      continue;
    }

    // Skip non-retryable sources
    if (!RETRYABLE_SOURCES.has(entry.source)) {
      result.skipped++;
      continue;
    }

    // Skip if too many prior attempts
    if (entry.failureHistory.length >= MAX_DLQ_RETRIES) {
      result.skipped++;
      continue;
    }

    // Skip if agent is disabled
    const agentCfg = await loadAgentConfig(entry.agentName);
    if (!agentCfg?.enabled) {
      result.skipped++;
      continue;
    }

    // Check age — don't retry entries older than 24h (stale context)
    const ageMs = Date.now() - new Date(entry.createdAt).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      result.skipped++;
      continue;
    }

    if (opts?.dryRun) {
      result.retried++;
      continue;
    }

    // Re-enqueue the task
    try {
      await enqueueTask(entry.agentName, entry.prompt, 3, {
        source: 'escalation',
        parentTaskId: entry.parentTaskId,
      });

      // Mark as resolved in DLQ
      await markResolved(entry.id, 'resolved');
      result.retried++;

      await logger.info('DLQConsumer',
        `Retried DLQ entry ${entry.id} (agent: ${entry.agentName}, source: ${entry.source})`);
    } catch (err) {
      result.errors.push(`${entry.id}: ${(err as Error).message}`);
    }
  }

  if (result.retried > 0) {
    await logger.info('DLQConsumer',
      `DLQ processing complete: ${result.retried} retried, ${result.skipped} skipped, ${result.resolved} already resolved`);
  }

  return result;
}

/**
 * Mark a DLQ entry as resolved (rewrites the JSONL file).
 * This is expensive but DLQ is small and rarely modified.
 */
async function markResolved(entryId: string, resolution: 'resolved' | 'wontfix'): Promise<void> {
  try {
    const raw = await readFile(DLQ_PATH, 'utf-8');
    const lines = raw.split('\n');
    const updated: string[] = [];

    for (const line of lines) {
      if (!line.trim()) {
        updated.push(line);
        continue;
      }
      try {
        const entry: DeadLetterEntry = JSON.parse(line);
        if (entry.id === entryId) {
          entry.resolution = resolution;
          updated.push(JSON.stringify(entry));
        } else {
          updated.push(line);
        }
      } catch {
        updated.push(line); // Preserve malformed lines
      }
    }

    await writeFile(DLQ_PATH, updated.join('\n'), 'utf-8');
  } catch {
    // Non-fatal — entry stays unresolved
  }
}
