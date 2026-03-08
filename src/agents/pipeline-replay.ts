/**
 * Pipeline Event Replay — reconstructs a pipeline's execution timeline.
 *
 * Combines data from:
 *   - pipelines/{id}.json (pipeline run state)
 *   - history.jsonl (completed tasks)
 *   - agent-reports/{agentName}/{date}.jsonl (detailed results)
 *
 * Outputs a Markdown timeline for debugging and post-mortem analysis.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { tailReadJsonl } from '../core/tail-read.js';
import type { PipelineRun } from './pipeline-engine.js';

// ── Constants ────────────────────────────────────────────────────────

const PIPELINES_DIR = join(process.cwd(), 'soul', 'agent-tasks', 'pipelines');
const HISTORY_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'history.jsonl');
const REPORTS_DIR = join(process.cwd(), 'soul', 'agent-reports');

// ── Types ────────────────────────────────────────────────────────────

interface TimelineEvent {
  timestamp: string;
  type: 'pipeline' | 'stage' | 'task' | 'report';
  label: string;
  detail: string;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Replay a pipeline's execution and return a Markdown timeline.
 */
export async function replayPipeline(runId: string): Promise<string> {
  // 1. Load pipeline run
  const run = await loadPipelineRun(runId);
  if (!run) return `Pipeline not found: ${runId}`;

  const events: TimelineEvent[] = [];

  // 2. Pipeline lifecycle events
  events.push({
    timestamp: run.createdAt,
    type: 'pipeline',
    label: 'Pipeline Started',
    detail: `Team: ${run.teamName}, Prompt: "${run.prompt.slice(0, 100)}"`,
  });

  // 3. Stage events
  for (const [stageId, stage] of Object.entries(run.stages)) {
    if (stage.startedAt) {
      events.push({
        timestamp: stage.startedAt,
        type: 'stage',
        label: `Stage Started: ${stageId}`,
        detail: `Agent: ${stage.agentName}, Task: ${stage.taskId ?? 'N/A'}`,
      });
    }

    if (stage.completedAt) {
      events.push({
        timestamp: stage.completedAt,
        type: 'stage',
        label: `Stage ${stage.status}: ${stageId}`,
        detail: stage.error
          ? `Error: ${stage.error.slice(0, 150)}`
          : `Output: ${(stage.output ?? '').slice(0, 150)}...`,
      });
    }

    // 4. Look up task trace from history
    if (stage.taskId) {
      const taskTrace = await findTaskTrace(stage.taskId);
      if (taskTrace) {
        for (const trace of taskTrace) {
          events.push({
            timestamp: trace.ts,
            type: 'task',
            label: `[${stage.agentName}] ${trace.phase}`,
            detail: trace.detail,
          });
        }
      }
    }

    // 5. Look up agent report
    if (stage.completedAt && stage.status === 'completed') {
      const report = await findReport(stage.agentName, stage.completedAt, stage.taskId ?? '');
      if (report) {
        events.push({
          timestamp: stage.completedAt,
          type: 'report',
          label: `Report: ${stage.agentName}`,
          detail: `Confidence: ${report.confidence}, Cost: $${report.costUsd?.toFixed(4) ?? '?'}`,
        });
      }
    }
  }

  if (run.completedAt) {
    events.push({
      timestamp: run.completedAt,
      type: 'pipeline',
      label: `Pipeline ${run.status}`,
      detail: `Total cost: $${run.totalCostUsd.toFixed(4)}, Stages: ${Object.keys(run.stages).length}`,
    });
  }

  // 6. Sort by timestamp
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // 7. Format as Markdown
  return formatTimeline(run, events);
}

// ── Internal ─────────────────────────────────────────────────────────

async function loadPipelineRun(runId: string): Promise<PipelineRun | null> {
  try {
    const raw = await readFile(join(PIPELINES_DIR, `${runId}.json`), 'utf-8');
    return JSON.parse(raw) as PipelineRun;
  } catch {
    return null;
  }
}

async function findTaskTrace(taskId: string): Promise<Array<{ phase: string; ts: string; detail: string }> | null> {
  const entries = await tailReadJsonl<{ id?: string; trace?: Array<{ phase: string; ts: string; detail: string }> }>(HISTORY_PATH, 100, 131072);
  // Search from newest to oldest
  for (let i = entries.length - 1; i >= 0; i--) {
    const task = entries[i]!;
    if (task.id === taskId && task.trace) return task.trace;
  }
  return null;
}

async function findReport(
  agentName: string,
  completedAt: string,
  taskId: string,
): Promise<{ confidence: number; costUsd?: number } | null> {
  const date = completedAt.slice(0, 10);
  const filePath = join(REPORTS_DIR, agentName, `${date}.jsonl`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    for (const line of raw.trim().split('\n').reverse()) {
      try {
        const report = JSON.parse(line) as { taskId?: string; confidence?: number; costUsd?: number };
        if (report.taskId === taskId) {
          return { confidence: report.confidence ?? 0, costUsd: report.costUsd };
        }
      } catch { /* skip */ }
    }
  } catch { /* file not found */ }
  return null;
}

function formatTimeline(run: PipelineRun, events: TimelineEvent[]): string {
  const lines: string[] = [];

  lines.push(`# Pipeline Replay: ${run.id}`);
  lines.push('');
  lines.push(`| 屬性 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| Team | ${run.teamName} |`);
  lines.push(`| Status | ${run.status} |`);
  lines.push(`| Created | ${run.createdAt} |`);
  lines.push(`| Completed | ${run.completedAt ?? 'N/A'} |`);
  lines.push(`| Total Cost | $${run.totalCostUsd.toFixed(4)} |`);
  lines.push(`| Stages | ${Object.keys(run.stages).length} |`);
  lines.push('');
  lines.push('## Timeline');
  lines.push('');

  const icons: Record<string, string> = {
    pipeline: '[P]',
    stage: '[S]',
    task: '[T]',
    report: '[R]',
  };

  for (const event of events) {
    const time = event.timestamp.slice(11, 19); // HH:MM:SS
    const icon = icons[event.type] ?? '[?]';
    lines.push(`- \`${time}\` ${icon} **${event.label}** — ${event.detail}`);
  }

  lines.push('');
  lines.push('---');
  lines.push(`*Generated at ${new Date().toISOString()}*`);

  return lines.join('\n');
}
