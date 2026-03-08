/**
 * Dead Letter Queue — persistent store for tasks that failed after all retries.
 *
 * Append-only JSONL at soul/agent-tasks/dead-letter.jsonl.
 * Provides post-mortem context for debugging recurring failures.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../core/logger.js';
import { tailReadJsonl } from '../../core/tail-read.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DeadLetterFailure {
  attempt: number;
  error: string;
  timestamp: string;
  duration: number;
  costUsd: number;
}

export interface DeadLetterEntry {
  id: string;
  taskId: string;
  agentName: string;
  prompt: string;                       // truncated to 500 chars
  failureHistory: DeadLetterFailure[];
  source: 'retry-exhausted' | 'pipeline-abort' | 'agent-disabled' | 'chain-depth-exceeded' | 'reroute-exhausted';
  pipelineRunId?: string;
  stageId?: string;
  parentTaskId?: string;
  totalCost: number;
  createdAt: string;
  resolution?: 'resolved' | 'wontfix' | null;
}

// ── Constants ────────────────────────────────────────────────────────

const DLQ_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'dead-letter.jsonl');

// ── Public API ───────────────────────────────────────────────────────

/** Append a dead letter entry to the DLQ file (atomic: mkdir + appendFile). */
export async function appendDeadLetter(entry: DeadLetterEntry): Promise<void> {
  await mkdir(dirname(DLQ_PATH), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  await appendFile(DLQ_PATH, line, 'utf-8');
  await logger.warn('DeadLetter', `Task ${entry.taskId} (${entry.agentName}) → DLQ: ${entry.source}`);
  eventBus.emit('agent:dead-letter', {
    agentName: entry.agentName,
    taskId: entry.taskId,
    source: entry.source,
    totalCost: entry.totalCost,
  });
}

/** Query dead letter entries with optional filters. */
export async function queryDeadLetters(opts?: {
  agentName?: string;
  since?: string;
  limit?: number;
}): Promise<DeadLetterEntry[]> {
  const limit = opts?.limit ?? 50;

  // Use tailRead for recent entries (default path); fall back to full read if filtering by date
  let entries: DeadLetterEntry[];
  if (opts?.since) {
    // Need full scan when filtering by date range
    let raw: string;
    try {
      raw = await readFile(DLQ_PATH, 'utf-8');
    } catch {
      return [];
    }
    entries = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as DeadLetterEntry); } catch { /* skip malformed */ }
    }
  } else {
    entries = await tailReadJsonl<DeadLetterEntry>(DLQ_PATH, limit * 2);
  }

  // Apply filters
  if (opts?.agentName) {
    entries = entries.filter(e => e.agentName === opts.agentName);
  }
  if (opts?.since) {
    entries = entries.filter(e => e.createdAt >= opts.since!);
  }

  // Return most recent first, capped at limit
  return entries.slice(-limit).reverse();
}

/** Create a DeadLetterEntry from a failed task and its error history. */
export function buildDeadLetterEntry(
  taskId: string,
  agentName: string,
  prompt: string,
  failureHistory: DeadLetterFailure[],
  source: DeadLetterEntry['source'],
  opts?: {
    pipelineRunId?: string;
    stageId?: string;
    parentTaskId?: string | null;
    totalCost?: number;
  },
): DeadLetterEntry {
  return {
    id: randomUUID(),
    taskId,
    agentName,
    prompt: prompt.slice(0, 500),
    failureHistory,
    source,
    pipelineRunId: opts?.pipelineRunId,
    stageId: opts?.stageId,
    parentTaskId: opts?.parentTaskId ?? undefined,
    totalCost: opts?.totalCost ?? failureHistory.reduce((sum, f) => sum + f.costUsd, 0),
    createdAt: new Date().toISOString(),
    resolution: null,
  };
}
