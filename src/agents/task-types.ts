/**
 * Shared type definitions for the agent task system.
 *
 * Extracted from worker-scheduler.ts to reduce module size
 * and provide a clean import target for consumers.
 */

// ── Task Types ───────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** A single trace point in task execution for observability. */
export interface ExecutionTrace {
  phase: string;   // dispatch, config-loaded, cost-check, prompt-built, cli-started, cli-completed, error, etc.
  ts: string;      // ISO timestamp
  detail: string;  // max 200 chars
}

export interface AgentTask {
  id: string;
  agentName: string;
  prompt: string;
  status: TaskStatus;
  priority: number;       // 1-10, higher = more urgent
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  workerId: number | null; // negative userId
  result: string | null;
  error: string | null;
  costUsd: number;
  duration: number;        // ms
  retryCount?: number;     // number of times this task has been retried
  retryAfter?: string;     // ISO timestamp — do not dispatch before this time (exponential backoff)
  dependsOn?: string[];    // task IDs that must complete before this task starts
  source?: 'manual' | 'scheduled' | 'agent-dispatch' | 'handoff' | 'escalation';  // task origin
  trace?: ExecutionTrace[];  // structured execution trace for observability
  parentTaskId?: string | null;  // task that spawned this one; null = CTO direct dispatch
  originAgent?: string | null;   // agent name that dispatched this sub-task
  chainDepth?: number;           // depth from root task (CTO direct = 0, agent dispatch = parent.depth + 1)
  pipelineRunId?: string;  // if this task is part of a pipeline run
  pipelineContext?: Array<{ stageId: string; agentName: string; output: string; artifactPath?: string }>;  // upstream stage outputs
  worktreePath?: string;     // git worktree path for code-modifying agents
  branchName?: string;       // git branch name within the worktree
  rerouteCount?: number;     // number of times this task has been rerouted (max 1)
  reroutedFrom?: string;     // original agent name before reroute (ping-pong guard)
  handoffIntent?: 'handoff' | 'feedback' | 'escalate';  // HANDOFF intent from upstream task
  taskScope?: import('./governance/agent-permissions.js').TaskScope;  // pipeline-scoped permission narrowing
}

export interface TaskQueue {
  version: number;
  tasks: AgentTask[];
}

// ── Report Types ─────────────────────────────────────────────────────

/** Prompt assembly metrics for observability. */
export interface PromptMetrics {
  totalChars: number;
  sections: Record<string, number>;  // section name → char count
  knowledgeBaseChars: number;
  sharedKnowledgeChars: number;
  pipelineContextChars: number;
  taskAnchorChars: number;
}

export interface AgentReport {
  timestamp: string;
  agentName: string;
  taskId: string;
  prompt: string;
  result: string;
  costUsd: number;
  duration: number;
  confidence: number;    // 0-1, self-assessed
  traceSummary?: string; // concise execution trace for report consumers
}
