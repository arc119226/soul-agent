/**
 * Pipeline Engine — orchestrates multi-stage team workflows.
 *
 * Core design: the pipeline does NOT directly execute agents. It enqueues
 * tasks via the existing `enqueueTask()` and listens for `agent:task:completed`
 * events to advance stages. This ensures all safety mechanisms (budget, kill-switch,
 * circuit-breaker, tool isolation) apply automatically.
 *
 * Inspired by:
 *   - LangGraph's Stage DAG (multi-stage with dependencies)
 *   - OpenAI SDK's input filters (context control on handoff)
 *   - CrewAI's declarative team definitions
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { tailReadJsonl } from '../core/tail-read.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { appendDeadLetter, buildDeadLetterEntry } from './monitoring/dead-letter.js';
import { writer } from '../core/debounced-writer.js';
import { loadTeamTemplate, getParallelStages, type TeamTemplate, type TeamStage } from './config/team-config.js';
import { applyFilter } from './input-filters.js';
import { validateAgentOutput } from './governance/output-schemas.js';

// ── Constants ────────────────────────────────────────────────────────

const PIPELINES_DIR = join(process.cwd(), 'soul', 'agent-tasks', 'pipelines');

// ── Types ────────────────────────────────────────────────────────────

export type PipelineStatus = 'running' | 'completed' | 'aborted';
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** Parsed HANDOFF directive from agent output. */
export interface HandoffDirective {
  /** Target agent name(s), or 'ESCALATE' for management notification */
  to: string[];
  /** Communication intent */
  intent: 'handoff' | 'feedback' | 'escalate';
  /** Type of artifact being passed */
  artifactType?: 'code-change' | 'report' | 'review' | 'test-result' | 'analysis';
  /** One-line summary of what's being handed off */
  summary?: string;
  /** Raw text of the HANDOFF section (for logging) */
  raw: string;
}

export interface StageResult {
  stageId: string;
  agentName: string;
  status: StageStatus;
  taskId: string | null;
  output: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  validation?: { valid: boolean; errors?: string[] };
  /** How many times this stage has been retried (0 = first attempt) */
  retryCount?: number;
  /** Parsed handoff directive from agent output (if any) */
  handoff?: HandoffDirective;
}

export interface PipelineRun {
  id: string;
  teamName: string;
  prompt: string;
  status: PipelineStatus;
  createdAt: string;
  completedAt: string | null;
  /** Stage execution results keyed by stage ID */
  stages: Record<string, StageResult>;
  /** Parallel layer index currently being executed */
  currentLayerIndex: number;
  /** Total cost accumulated */
  totalCostUsd: number;
  /** Per-stage iteration counter (stateMachine mode) */
  iterationCounts?: Record<string, number>;
  /** Original run ID this pipeline was resumed from (if any) */
  resumedFrom?: string;
}

// ── HANDOFF Parsing ─────────────────────────────────────────────────

const HANDOFF_MARKER = '---HANDOFF---';
// Tolerates Markdown-split markers like "---\nHANDOFF---" produced by LLMs after tables
const HANDOFF_MARKER_RE = /---\s*HANDOFF\s*---/g;

/** Find last match of HANDOFF_MARKER_RE, returning index + matched length (or null). */
function findLastHandoffMarker(output: string): { idx: number; matchLen: number } | null {
  let last: { idx: number; matchLen: number } | null = null;
  HANDOFF_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HANDOFF_MARKER_RE.exec(output)) !== null) {
    last = { idx: m.index, matchLen: m[0].length };
  }
  return last;
}

/**
 * Parse HANDOFF directive from agent output.
 * Returns null if no valid HANDOFF section found.
 *
 * Expected format (at the end of agent output):
 * ---HANDOFF---
 * TO: reviewer, qa
 * INTENT: handoff
 * ARTIFACT_TYPE: code-change
 * SUMMARY: one line summary
 *
 * Also tolerates Markdown-split variant: "---\nHANDOFF---"
 */
export function parseHandoff(output: string): HandoffDirective | null {
  const match = findLastHandoffMarker(output);
  if (!match) return null;

  const handoffSection = output.slice(match.idx + match.matchLen).trim();
  if (!handoffSection) return null;

  // Parse key-value pairs
  const fields = new Map<string, string>();
  for (const line of handoffSection.split('\n')) {
    const match = line.match(/^([A-Z_]+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      fields.set(match[1].toLowerCase(), match[2].trim());
    }
  }

  // TO is required
  const toRaw = fields.get('to');
  if (!toRaw) return null;

  const to = toRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (to.length === 0) return null;

  // INTENT with validation
  const intentRaw = fields.get('intent') ?? 'handoff';
  const validIntents = ['handoff', 'feedback', 'escalate'] as const;
  const intent = (validIntents as readonly string[]).includes(intentRaw)
    ? intentRaw as HandoffDirective['intent']
    : 'handoff';

  // ARTIFACT_TYPE (optional)
  const artifactRaw = fields.get('artifact_type');
  const validArtifacts = ['code-change', 'report', 'review', 'test-result', 'analysis'] as const;
  const artifactType = artifactRaw && (validArtifacts as readonly string[]).includes(artifactRaw)
    ? artifactRaw as HandoffDirective['artifactType']
    : undefined;

  return {
    to,
    intent,
    artifactType,
    summary: fields.get('summary'),
    raw: handoffSection.slice(0, 500), // cap for logging
  };
}

/** Remove HANDOFF section from agent output (to avoid passing it as content to downstream). */
export function stripHandoff(output: string): string {
  const match = findLastHandoffMarker(output);
  if (!match) return output;
  return output.slice(0, match.idx).trimEnd();
}

// ── Active Pipeline Tracking ─────────────────────────────────────────

/** Active pipeline runs indexed by run ID */
const activePipelines = new Map<string, PipelineRun>();

/** Map from taskId → { runId, stageId } for event correlation */
const taskToPipeline = new Map<string, { runId: string; stageId: string }>();

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start a pipeline from a team template.
 * Loads the template, creates a PipelineRun, and dispatches the first layer of stages.
 */
export async function startPipeline(
  teamName: string,
  prompt: string,
): Promise<PipelineRun | null> {
  const template = await loadTeamTemplate(teamName);
  if (!template) {
    await logger.warn('PipelineEngine', `Team template not found: ${teamName}`);
    return null;
  }

  const run: PipelineRun = {
    id: randomUUID(),
    teamName,
    prompt,
    status: 'running',
    createdAt: new Date().toISOString(),
    completedAt: null,
    stages: {},
    currentLayerIndex: 0,
    totalCostUsd: 0,
  };

  // Initialize stage results
  for (const stage of template.workflow.stages) {
    run.stages[stage.id] = {
      stageId: stage.id,
      agentName: stage.agentName,
      status: 'pending',
      taskId: null,
      output: null,
      error: null,
      startedAt: null,
      completedAt: null,
    };
  }

  // Initialize iterationCounts for stateMachine mode
  if (template.workflow.mode === 'stateMachine') {
    run.iterationCounts = {};
    for (const stage of template.workflow.stages) {
      run.iterationCounts[stage.id] = 0;
    }
  }

  activePipelines.set(run.id, run);
  cacheTemplate(template);
  await savePipelineRun(run);

  await eventBus.emit('team:pipeline:started', {
    teamName,
    runId: run.id,
    prompt,
  });

  await logger.info('PipelineEngine',
    `Pipeline started: ${run.id} (team: ${teamName}, mode: ${template.workflow.mode}, ${template.workflow.stages.length} stages)`);

  // Dispatch first stage(s) based on workflow mode
  if (template.workflow.mode === 'stateMachine') {
    await dispatchStateMachineEntry(run, template);
  } else {
    await dispatchLayer(run, template);
  }

  return run;
}

/**
 * Abort a running pipeline.
 */
export async function abortPipeline(runId: string, reason: string): Promise<boolean> {
  const run = activePipelines.get(runId);
  if (!run || run.status !== 'running') return false;

  run.status = 'aborted';
  run.completedAt = new Date().toISOString();

  // Mark pending stages as skipped
  for (const stage of Object.values(run.stages)) {
    if (stage.status === 'pending') {
      stage.status = 'skipped';
    }
  }

  activePipelines.delete(runId);
  cleanupTaskMappings(runId);
  await savePipelineRun(run);

  await eventBus.emit('team:pipeline:aborted', {
    teamName: run.teamName,
    runId,
    reason,
  });

  await logger.info('PipelineEngine', `Pipeline aborted: ${runId} — ${reason}`);
  return true;
}

/**
 * Resume an aborted/completed pipeline from a specific stage.
 * Creates a new PipelineRun that inherits completed stages before fromStageId
 * and re-executes from fromStageId onward.
 *
 * Only supports layer mode (sequential/mixed/parallel). StateMachine mode is TODO.
 */
export async function resumePipeline(
  originalRunId: string,
  fromStageId: string,
): Promise<PipelineRun | null> {
  // 1. Load original run from disk
  let originalRun: PipelineRun;
  try {
    const raw = await readFile(join(PIPELINES_DIR, `${originalRunId}.json`), 'utf-8');
    originalRun = JSON.parse(raw) as PipelineRun;
  } catch {
    await logger.warn('PipelineEngine', `Resume: pipeline not found: ${originalRunId}`);
    return null;
  }

  // 2. Validate status — cannot resume a running pipeline
  if (originalRun.status !== 'aborted' && originalRun.status !== 'completed') {
    await logger.warn('PipelineEngine', `Resume: pipeline ${originalRunId} is still ${originalRun.status}`);
    return null;
  }

  // 3. Load team template
  const template = await loadTeamTemplate(originalRun.teamName);
  if (!template) {
    await logger.warn('PipelineEngine', `Resume: team template not found: ${originalRun.teamName}`);
    return null;
  }

  // 4. Validate fromStageId exists in template
  const stageTemplate = template.workflow.stages.find(s => s.id === fromStageId);
  if (!stageTemplate) {
    await logger.warn('PipelineEngine', `Resume: stage "${fromStageId}" not found in template ${originalRun.teamName}`);
    return null;
  }

  // 5. StateMachine mode not yet supported
  if (template.workflow.mode === 'stateMachine') {
    await logger.warn('PipelineEngine', 'Resume: stateMachine mode not yet supported');
    return null; // TODO: support in Phase 2
  }

  // 6. Find layer index for fromStageId
  const layers = getParallelStages(template);
  let fromLayerIndex = -1;
  for (let i = 0; i < layers.length; i++) {
    if (layers[i]!.some(s => s.id === fromStageId)) {
      fromLayerIndex = i;
      break;
    }
  }
  if (fromLayerIndex === -1) {
    await logger.warn('PipelineEngine', `Resume: stage "${fromStageId}" not found in any layer`);
    return null;
  }

  // 7. Validate dependencies: all inputFrom of fromStageId must be completed in original run
  if (stageTemplate.inputFrom?.length) {
    for (const depId of stageTemplate.inputFrom) {
      const depResult = originalRun.stages[depId];
      if (!depResult || depResult.status !== 'completed') {
        await logger.warn('PipelineEngine',
          `Resume: dependency "${depId}" for stage "${fromStageId}" was not completed in original run`);
        return null;
      }
    }
  }

  // 8. Build new PipelineRun
  const run: PipelineRun = {
    id: randomUUID(),
    teamName: originalRun.teamName,
    prompt: originalRun.prompt,
    status: 'running',
    createdAt: new Date().toISOString(),
    completedAt: null,
    stages: {},
    currentLayerIndex: fromLayerIndex,
    totalCostUsd: 0,
    resumedFrom: originalRunId,
  };

  // Copy stages: layers before fromLayerIndex → deep copy from original; fromLayerIndex onward → reset to pending
  for (const stage of template.workflow.stages) {
    const layerIndex = layers.findIndex(layer => layer.some(s => s.id === stage.id));

    if (layerIndex < fromLayerIndex) {
      const original = originalRun.stages[stage.id];
      run.stages[stage.id] = original
        ? { ...original }
        : {
            stageId: stage.id,
            agentName: stage.agentName,
            status: 'skipped' as StageStatus,
            taskId: null,
            output: null,
            error: null,
            startedAt: null,
            completedAt: null,
          };
    } else {
      run.stages[stage.id] = {
        stageId: stage.id,
        agentName: stage.agentName,
        status: 'pending',
        taskId: null,
        output: null,
        error: null,
        startedAt: null,
        completedAt: null,
      };
    }
  }

  // 9. Activate and save
  activePipelines.set(run.id, run);
  cacheTemplate(template);
  await savePipelineRun(run);

  await eventBus.emit('team:pipeline:started', {
    teamName: run.teamName,
    runId: run.id,
    prompt: run.prompt,
    resumedFrom: originalRunId,
  });

  await logger.info('PipelineEngine',
    `Pipeline resumed: ${run.id} from ${originalRunId} at stage ${fromStageId} (layer ${fromLayerIndex})`);

  // 10. Dispatch the target layer
  await dispatchLayer(run, template);

  return run;
}

/** Get a pipeline run by ID (active or null). */
export function getPipelineRun(runId: string): PipelineRun | null {
  return activePipelines.get(runId) ?? null;
}

/** Get all active pipeline runs. */
export function getActivePipelines(): PipelineRun[] {
  return Array.from(activePipelines.values());
}

// ── Event Listener ───────────────────────────────────────────────────

let listenerRegistered = false;

/** Register the pipeline event listener (idempotent). */
export function registerPipelineListener(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;

  eventBus.on('agent:task:completed', handleTaskCompleted);
  eventBus.on('agent:task:failed', handleTaskFailed);

  logger.info('PipelineEngine', 'Pipeline event listeners registered');
}

async function handleTaskCompleted(data: {
  agentName: string;
  taskId: string;
  result: string;
  costUsd?: number;
}): Promise<void> {
  const mapping = taskToPipeline.get(data.taskId);
  if (!mapping) {
    // Log for debugging pipeline stall issues
    await logger.debug('PipelineEngine',
      `handleTaskCompleted: no pipeline mapping for task ${data.taskId} (agent: ${data.agentName})`);
    return; // Not a pipeline task
  }

  const run = activePipelines.get(mapping.runId);
  if (!run || run.status !== 'running') return;

  const stage = run.stages[mapping.stageId];
  if (!stage) return;

  stage.status = 'completed';
  stage.output = data.result;
  stage.completedAt = new Date().toISOString();

  // Accumulate cost (money spent regardless of outcome)
  if (data.costUsd) {
    run.totalCostUsd += data.costUsd;
  }

  // Check total budget
  const template = getCachedTemplate(run.teamName) ?? await loadTeamTemplate(run.teamName);
  if (template && run.totalCostUsd > template.budget.maxTotalCostUsd) {
    await logger.warn('PipelineEngine',
      `Pipeline ${run.id} budget exceeded: $${run.totalCostUsd.toFixed(4)} > $${template.budget.maxTotalCostUsd}`);
    await abortPipeline(run.id, `Budget exceeded: $${run.totalCostUsd.toFixed(4)} > $${template.budget.maxTotalCostUsd}`);
    return;
  }

  // Validate output against registered schema
  const stageSchema = getStageSchema(run.teamName, mapping.stageId);
  if (stageSchema) {
    stage.validation = validateAgentOutput(stageSchema.schema, data.result);
    if (!stage.validation.valid) {
      if (stageSchema.blocking) {
        await logger.warn('PipelineEngine',
          `Stage ${mapping.stageId} output validation BLOCKED: ${stage.validation.errors?.join(', ')}`);

        // Write to DLQ for post-mortem
        const dlqEntry = buildDeadLetterEntry(
          data.taskId,
          data.agentName,
          run.prompt.slice(0, 500),
          [{
            attempt: 1,
            error: `Output validation failed: ${stage.validation.errors?.join('; ') ?? 'unknown'}`,
            timestamp: new Date().toISOString(),
            duration: 0,
            costUsd: data.costUsd ?? 0,
          }],
          'pipeline-abort',
          { pipelineRunId: run.id, stageId: mapping.stageId, totalCost: run.totalCostUsd },
        );
        await appendDeadLetter(dlqEntry);

        // Abort pipeline
        await abortPipeline(run.id, `Stage ${mapping.stageId} output validation failed (blocking)`);
        return;
      }
      await logger.warn('PipelineEngine',
        `Stage ${mapping.stageId} output validation failed (advisory): ${stage.validation.errors?.join(', ')}`);
    }
  }

  // Parse HANDOFF directive for routing hints (Phase B)
  const handoff = parseHandoff(data.result);
  if (handoff) {
    stage.handoff = handoff;
    // Strip HANDOFF from the stored output (downstream sees clean content)
    stage.output = stripHandoff(data.result);

    await logger.info('PipelineEngine',
      `HANDOFF parsed in stage ${mapping.stageId}: TO=${handoff.to.join(',')} INTENT=${handoff.intent}` +
      (handoff.summary ? ` SUMMARY=${handoff.summary.slice(0, 80)}` : ''));
  }

  taskToPipeline.delete(data.taskId);
  await savePipelineRun(run);

  await eventBus.emit('team:pipeline:stage:completed', {
    teamName: run.teamName,
    runId: run.id,
    stageId: mapping.stageId,
    agentName: data.agentName,
  });

  await logger.info('PipelineEngine',
    `Stage completed: ${mapping.stageId} in pipeline ${run.id} (cost so far: $${run.totalCostUsd.toFixed(4)})`);

  // Try to advance to next layer
  await advancePipeline(run);
}

async function handleTaskFailed(data: {
  agentName: string;
  taskId: string;
  error: string;
  costUsd?: number;
}): Promise<void> {
  const mapping = taskToPipeline.get(data.taskId);
  if (!mapping) {
    // Log for debugging pipeline stall issues
    await logger.debug('PipelineEngine',
      `handleTaskFailed: no pipeline mapping for task ${data.taskId} (agent: ${data.agentName})`);
    return;
  }

  const run = activePipelines.get(mapping.runId);
  if (!run || run.status !== 'running') return;

  const stage = run.stages[mapping.stageId];
  if (!stage) return;

  stage.status = 'failed';
  stage.error = data.error;
  stage.completedAt = new Date().toISOString();

  // Accumulate cost even on failure (money already spent)
  if (data.costUsd) {
    run.totalCostUsd += data.costUsd;
  }

  taskToPipeline.delete(data.taskId);

  await eventBus.emit('team:pipeline:stage:failed', {
    teamName: run.teamName,
    runId: run.id,
    stageId: mapping.stageId,
    agentName: data.agentName,
    error: data.error,
  });

  await logger.warn('PipelineEngine',
    `Stage failed: ${mapping.stageId} in pipeline ${run.id} — ${data.error}`);

  // Check governance policy
  const template = await loadTeamTemplate(run.teamName);
  if (!template) {
    await abortPipeline(run.id, 'Team template not found');
    return;
  }

  const stageTemplate = template.workflow.stages.find((s) => s.id === mapping.stageId);
  const isOptional = stageTemplate?.optional ?? false;

  if (isOptional) {
    stage.status = 'skipped';
    await advancePipeline(run);
  } else {
    const policy = template.governance.escalateOnFailure;
    if (policy === 'abort') {
      await abortPipeline(run.id, `Stage ${mapping.stageId} failed: ${data.error}`);
    } else if (policy === 'skip') {
      stage.status = 'skipped';
      await advancePipeline(run);
    } else {
      // 'retry' — re-enqueue the same stage (up to 1 retry)
      const stageRetries = stage.retryCount ?? 0;
      if (stageRetries < 1) {
        stage.retryCount = stageRetries + 1;
        stage.status = 'pending';
        stage.error = null;
        await dispatchStage(run, stageTemplate!, template);
      } else {
        // Stage exhausted retries → write to DLQ before aborting
        const dlqEntry = buildDeadLetterEntry(
          data.taskId,
          data.agentName,
          run.prompt.slice(0, 500),
          [{
            attempt: 1,
            error: data.error,
            timestamp: new Date().toISOString(),
            duration: 0,
            costUsd: data.costUsd ?? 0,
          }],
          'pipeline-abort',
          {
            pipelineRunId: run.id,
            stageId: mapping.stageId,
            totalCost: run.totalCostUsd,
          },
        );
        await appendDeadLetter(dlqEntry);

        await abortPipeline(run.id, `Stage ${mapping.stageId} failed after retry`);
      }
    }
  }
}

// ── Internal: Pipeline Advancement ───────────────────────────────────

async function advancePipeline(run: PipelineRun): Promise<void> {
  const template = await loadTeamTemplate(run.teamName);
  if (!template) {
    await abortPipeline(run.id, 'Team template not found during advancement');
    return;
  }

  // StateMachine mode uses its own advancement logic
  if (template.workflow.mode === 'stateMachine') {
    await advanceStateMachine(run, template);
    return;
  }

  const layers = getParallelStages(template);

  // Check if current layer is fully done
  const currentLayer = layers[run.currentLayerIndex];
  if (!currentLayer) {
    await completePipeline(run);
    return;
  }

  const allDone = currentLayer.every((s) => {
    const result = run.stages[s.id];
    return result && (result.status === 'completed' || result.status === 'skipped' || result.status === 'failed');
  });

  if (!allDone) return; // Still waiting for stages in current layer

  // Move to next layer
  run.currentLayerIndex++;

  if (run.currentLayerIndex >= layers.length) {
    await completePipeline(run);
  } else {
    await dispatchLayer(run, template);
  }
}

// ── StateMachine Mode ─────────────────────────────────────────────

/** Dispatch entry stages for stateMachine mode (stages with no inputFrom). */
async function dispatchStateMachineEntry(run: PipelineRun, template: TeamTemplate): Promise<void> {
  const entryStages = template.workflow.stages.filter(
    (s) => !s.inputFrom || s.inputFrom.length === 0,
  );

  if (entryStages.length === 0) {
    await abortPipeline(run.id, 'StateMachine: no entry stages found (all stages have inputFrom)');
    return;
  }

  for (const stage of entryStages) {
    await dispatchStateMachineStage(run, stage, template);
  }

  await savePipelineRun(run);
}

/** Dispatch a single stage in stateMachine mode with iteration tracking. */
async function dispatchStateMachineStage(
  run: PipelineRun,
  stage: TeamStage,
  template: TeamTemplate,
): Promise<void> {
  const maxIter = stage.maxIterations ?? 1;
  const currentIter = run.iterationCounts?.[stage.id] ?? 0;

  if (currentIter >= maxIter) {
    await logger.warn('PipelineEngine',
      `StateMachine: stage ${stage.id} hit maxIterations (${maxIter}), skipping`);
    const stageResult = run.stages[stage.id];
    if (stageResult && stageResult.status !== 'completed') {
      stageResult.status = 'skipped';
      stageResult.completedAt = new Date().toISOString();
      stageResult.error = `maxIterations (${maxIter}) exceeded`;
    }
    return;
  }

  // Increment iteration counter
  if (!run.iterationCounts) run.iterationCounts = {};
  run.iterationCounts[stage.id] = currentIter + 1;

  // Reset stage result for re-execution (feedback loops)
  run.stages[stage.id] = {
    stageId: stage.id,
    agentName: stage.agentName,
    status: 'pending',
    taskId: null,
    output: null,
    error: null,
    startedAt: null,
    completedAt: null,
  };

  await dispatchStage(run, stage, template);
}

/**
 * Resolve next stage IDs from a transition map.
 * Returns an array of stage IDs (normalizes string | string[]).
 */
function resolveTransition(
  transitions: Record<string, string | string[]> | undefined,
  intent: string,
): string[] {
  if (!transitions) return [];

  const target = transitions[intent] ?? transitions['default'];
  if (!target) return [];

  return Array.isArray(target) ? target : [target];
}

/** Check if a stage is terminal (completed/skipped/failed). */
function isStageTerminal(result: StageResult): boolean {
  return result.status === 'completed' || result.status === 'skipped' || result.status === 'failed';
}

/**
 * Advance a stateMachine pipeline after a stage completes.
 * Uses HANDOFF directives and transition maps to determine next stages.
 */
async function advanceStateMachine(run: PipelineRun, template: TeamTemplate): Promise<void> {
  // Find the stage(s) that just completed
  const justCompleted = Object.values(run.stages).filter(
    (s) => s.status === 'completed' && s.completedAt !== null,
  );

  if (justCompleted.length === 0) return;

  // Find the most recently completed stage
  const latestCompleted = justCompleted.reduce((latest, s) =>
    (s.completedAt! > latest.completedAt!) ? s : latest,
  );

  const completedStageTemplate = template.workflow.stages.find(
    (s) => s.id === latestCompleted.stageId,
  );
  if (!completedStageTemplate) return;

  const handoff = latestCompleted.handoff;

  // Determine next stage IDs based on HANDOFF intent or default transitions
  let nextStageIds: string[];

  if (handoff) {
    if (handoff.intent === 'escalate') {
      // Emit escalation event (Phase E will wire to Telegram)
      await eventBus.emit('team:pipeline:escalation', {
        teamName: run.teamName,
        runId: run.id,
        stageId: latestCompleted.stageId,
        agentName: latestCompleted.agentName,
        summary: handoff.summary ?? 'Agent requested escalation',
        to: handoff.to,
      });

      await logger.warn('PipelineEngine',
        `StateMachine: ESCALATE from stage ${latestCompleted.stageId} — ${handoff.summary ?? 'no summary'}`);

      // Only follow explicit 'escalate' transition if configured;
      // otherwise STOP the pipeline — do NOT fallback to 'default'.
      // Escalation means "I can't handle this, management must intervene."
      nextStageIds = resolveTransition(completedStageTemplate.transitions, 'escalate');
      if (nextStageIds.length === 0) {
        // No explicit escalate transition → abort pipeline, wait for CTO/PM
        await abortPipeline(run.id,
          `ESCALATE from ${latestCompleted.stageId} (${latestCompleted.agentName}): ${handoff.summary ?? 'no summary'}`);
        return;
      }
    } else {
      // 'handoff' or 'feedback' intent
      nextStageIds = resolveTransition(completedStageTemplate.transitions, handoff.intent);
      if (nextStageIds.length === 0) {
        nextStageIds = resolveTransition(completedStageTemplate.transitions, 'default');
      }
    }
  } else {
    // No HANDOFF — use default transition
    nextStageIds = resolveTransition(completedStageTemplate.transitions, 'default');
  }

  // Fallback: if no transitions configured, go to next stage in array order
  if (nextStageIds.length === 0) {
    const stageIndex = template.workflow.stages.findIndex(
      (s) => s.id === latestCompleted.stageId,
    );
    const nextInOrder = template.workflow.stages[stageIndex + 1];
    if (nextInOrder) {
      nextStageIds = [nextInOrder.id];
    }
  }

  // No next stages → check if all stages are terminal → complete pipeline
  if (nextStageIds.length === 0) {
    const allTerminal = Object.values(run.stages).every(isStageTerminal);
    if (allTerminal) {
      await completePipeline(run);
    }
    return;
  }

  // Dispatch each next stage (may be parallel, e.g., ["review", "test"])
  let dispatched = false;
  for (const nextId of nextStageIds) {
    const nextStageTemplate = template.workflow.stages.find((s) => s.id === nextId);
    if (!nextStageTemplate) {
      await logger.warn('PipelineEngine',
        `StateMachine: transition target stage "${nextId}" not found in template`);
      continue;
    }

    // Check waitForAll: all inputFrom stages must be terminal
    if (nextStageTemplate.waitForAll && nextStageTemplate.inputFrom?.length) {
      const allInputsDone = nextStageTemplate.inputFrom.every((depId) => {
        const depResult = run.stages[depId];
        return depResult && isStageTerminal(depResult);
      });

      if (!allInputsDone) {
        await logger.info('PipelineEngine',
          `StateMachine: stage ${nextId} waiting for all inputs (waitForAll)`);
        continue;
      }
    }

    await dispatchStateMachineStage(run, nextStageTemplate, template);
    dispatched = true;
  }

  if (dispatched) {
    await savePipelineRun(run);
  } else {
    // Nothing dispatched — check if pipeline is done
    const allTerminal = Object.values(run.stages).every(isStageTerminal);
    if (allTerminal) {
      await completePipeline(run);
    }
  }
}

async function completePipeline(run: PipelineRun): Promise<void> {
  run.status = 'completed';
  run.completedAt = new Date().toISOString();

  const completedStages = Object.values(run.stages).filter((s) => s.status === 'completed').length;

  activePipelines.delete(run.id);
  cleanupTaskMappings(run.id);
  await savePipelineRun(run);

  await eventBus.emit('team:pipeline:completed', {
    teamName: run.teamName,
    runId: run.id,
    stages: completedStages,
  });

  await logger.info('PipelineEngine',
    `Pipeline completed: ${run.id} (${completedStages}/${Object.keys(run.stages).length} stages succeeded)`);
}

// ── Internal: Stage Dispatch ─────────────────────────────────────────

async function dispatchLayer(run: PipelineRun, template: TeamTemplate): Promise<void> {
  const layers = getParallelStages(template);
  const layer = layers[run.currentLayerIndex];
  if (!layer) return;

  for (const stage of layer) {
    await dispatchStage(run, stage, template);
  }

  await savePipelineRun(run);
}

async function dispatchStage(
  run: PipelineRun,
  stage: TeamStage,
  template: TeamTemplate,
): Promise<void> {
  const stageResult = run.stages[stage.id];
  if (!stageResult) return;

  // Pre-dispatch budget check: don't dispatch if budget exhausted
  const remaining = template.budget.maxTotalCostUsd - run.totalCostUsd;
  if (remaining <= 0) {
    await abortPipeline(run.id, `Budget exhausted before stage ${stage.id}: $${run.totalCostUsd.toFixed(4)}`);
    return;
  }

  // Build prompt with upstream context
  const prompt = await buildStagePrompt(run, stage, template);

  // Dynamic import to avoid circular dependency
  const { enqueueTask } = await import('./worker-scheduler.js');
  const taskId = await enqueueTask(stage.agentName, prompt, 7); // priority 7 (above default 5)

  stageResult.status = 'running';
  stageResult.taskId = taskId;
  stageResult.startedAt = new Date().toISOString();

  // Track for event correlation
  taskToPipeline.set(taskId, { runId: run.id, stageId: stage.id });

  await logger.info('PipelineEngine',
    `Stage dispatched: ${stage.id} → agent ${stage.agentName} (task: ${taskId})`);
}

async function buildStagePrompt(run: PipelineRun, stage: TeamStage, template: TeamTemplate): Promise<string> {
  const lines: string[] = [];

  // Base prompt
  lines.push(run.prompt);

  // StateMachine mode: inject iteration info and feedback context
  if (template.workflow.mode === 'stateMachine' && run.iterationCounts) {
    const iteration = run.iterationCounts[stage.id] ?? 1;
    const maxIter = stage.maxIterations ?? 1;

    if (iteration > 1 || maxIter > 1) {
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push(`## 迭代資訊`);
      lines.push(`本階段第 ${iteration} 次執行（最多 ${maxIter} 次）`);

      // If this is a feedback loop re-entry, inject the feedback source's HANDOFF summary
      for (const otherResult of Object.values(run.stages)) {
        if (otherResult.handoff?.intent === 'feedback' && otherResult.status === 'completed') {
          // Check if this stage was the feedback target
          const otherStageTemplate = template.workflow.stages.find(
            (s) => s.id === otherResult.stageId,
          );
          const feedbackTargets = resolveTransition(otherStageTemplate?.transitions, 'feedback');
          if (feedbackTargets.includes(stage.id)) {
            lines.push('');
            lines.push(`### 來自 ${otherResult.agentName} 的回饋`);
            if (otherResult.handoff.summary) {
              lines.push(otherResult.handoff.summary);
            }
            // Include the reviewer's output as feedback context
            if (otherResult.output) {
              const filterName = stage.inputFilter ?? 'token-budget';
              const budget = stage.contextTokenBudget ?? template.workflow.contextTokenBudget;
              const filtered = applyFilter(filterName, otherResult.output, budget);
              lines.push('');
              lines.push(filtered);
            }
          }
        }
      }
    }
  }

  // Inject upstream context if this stage has dependencies
  if (stage.inputFrom?.length) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 上游階段輸出');
    lines.push('');

    const { writeArtifact } = await import('./governance/handoff-artifact.js');

    for (const depStageId of stage.inputFrom) {
      const depResult = run.stages[depStageId];
      if (!depResult?.output) continue;

      // Write artifact for upstream stage output
      const artifactPath = depResult.taskId
        ? await writeArtifact({
            taskId: depResult.taskId,
            sourceAgent: depResult.agentName,
            content: depResult.output,
          })
        : null;

      lines.push(`### Stage: ${depStageId} (${depResult.agentName})`);
      lines.push('');
      if (artifactPath) {
        lines.push(`完整產出: ${artifactPath} (${depResult.output.length} 字元)`);
        lines.push(`請用 Read tool 讀取上述檔案以獲得完整內容。`);
      } else {
        const filterName = stage.inputFilter ?? 'token-budget';
        const budget = stage.contextTokenBudget ?? template.workflow.contextTokenBudget;
        const filtered = applyFilter(filterName, depResult.output, budget);
        lines.push(filtered);
      }
      lines.push('');
    }
  }

  // Inject team role context
  const member = template.members.find((m) => m.agentName === stage.agentName);
  if (member) {
    lines.push('');
    lines.push(`## 你的團隊角色：${member.teamRole}`);
    lines.push(`**目標**：${member.goal}`);
    if (member.backstory) {
      lines.push(`**背景**：${member.backstory}`);
    }
  }

  return lines.join('\n');
}

// ── Rehydration: Restore Pipelines After Restart ────────────────────

const HISTORY_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'history.jsonl');
const QUEUE_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'queue.json');

/**
 * Rehydrate running pipelines from disk after process restart.
 *
 * Scans pipelines/*.json, restores in-memory Maps, and handles the "crash window"
 * where a task may have completed but the pipeline didn't advance.
 *
 * Returns the number of pipelines rehydrated.
 */
export async function rehydratePipelines(): Promise<number> {
  let files: string[];
  try {
    files = await readdir(PIPELINES_DIR);
  } catch {
    return 0; // Directory doesn't exist — no pipelines
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  if (jsonFiles.length === 0) return 0;

  // Load queue + history for cross-referencing task states
  const queueTasks = await loadQueueTasks();
  const completedTaskIds = await loadCompletedTaskIds();

  let rehydrated = 0;

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(PIPELINES_DIR, file), 'utf-8');
      const run = JSON.parse(raw) as PipelineRun;

      if (run.status !== 'running') continue;

      // Check that the team template still exists
      const template = await loadTeamTemplate(run.teamName);
      if (!template) {
        await logger.warn('PipelineEngine',
          `Rehydration: aborting pipeline ${run.id} — team template "${run.teamName}" not found`);
        run.status = 'aborted';
        run.completedAt = new Date().toISOString();
        await savePipelineRun(run);
        continue;
      }

      // Restore in-memory state
      activePipelines.set(run.id, run);
      cacheTemplate(template);

      // Process each running stage
      for (const stage of Object.values(run.stages)) {
        if (stage.status !== 'running' || !stage.taskId) continue;

        // Rebuild taskToPipeline mapping
        taskToPipeline.set(stage.taskId, { runId: run.id, stageId: stage.stageId });

        // Check if the task already completed (crash window)
        const queueTask = queueTasks.get(stage.taskId);
        if (queueTask?.status === 'completed' && queueTask.result) {
          // Task completed but pipeline didn't advance — replay completion
          await logger.info('PipelineEngine',
            `Rehydration: replaying completed task ${stage.taskId} for stage ${stage.stageId}`);
          stage.status = 'completed';
          stage.output = queueTask.result;
          stage.completedAt = queueTask.completedAt ?? new Date().toISOString();
          if (queueTask.costUsd) run.totalCostUsd += queueTask.costUsd;
          taskToPipeline.delete(stage.taskId);
        } else if (queueTask?.status === 'failed') {
          // Task failed but pipeline didn't process it
          stage.status = 'failed';
          stage.error = queueTask.error ?? 'Failed during crash recovery';
          stage.completedAt = queueTask.completedAt ?? new Date().toISOString();
          taskToPipeline.delete(stage.taskId);
        } else if (completedTaskIds.has(stage.taskId)) {
          // Task archived to history — mark as completed (no result available)
          await logger.info('PipelineEngine',
            `Rehydration: task ${stage.taskId} found in history for stage ${stage.stageId}`);
          stage.status = 'completed';
          stage.completedAt = new Date().toISOString();
          taskToPipeline.delete(stage.taskId);
        } else if (!queueTask) {
          // Task not in queue and not in history — lost; re-dispatch
          await logger.warn('PipelineEngine',
            `Rehydration: re-dispatching lost task for stage ${stage.stageId}`);
          const lostTaskId = stage.taskId;
          stage.status = 'pending';
          stage.taskId = null;
          stage.startedAt = null;
          if (lostTaskId) taskToPipeline.delete(lostTaskId);

          const stageTemplate = template.workflow.stages.find((s) => s.id === stage.stageId);
          if (stageTemplate) {
            await dispatchStage(run, stageTemplate, template);
          }
        }
        // else: task is still pending/running in queue — keep mapping, it'll complete naturally
      }

      // Try to advance pipeline (handles replayed completions)
      await advancePipeline(run);
      await savePipelineRun(run);

      rehydrated++;
      await logger.info('PipelineEngine',
        `Rehydrated pipeline ${run.id} (team: ${run.teamName}, cost: $${run.totalCostUsd.toFixed(4)})`);
    } catch (err) {
      await logger.warn('PipelineEngine', `Failed to rehydrate pipeline from ${file}`, err);
    }
  }

  return rehydrated;
}

/** Load queue tasks into a Map for O(1) lookup during rehydration. */
async function loadQueueTasks(): Promise<Map<string, { status: string; result?: string; error?: string; completedAt?: string; costUsd?: number }>> {
  const map = new Map<string, { status: string; result?: string; error?: string; completedAt?: string; costUsd?: number }>();
  try {
    const raw = await readFile(QUEUE_PATH, 'utf-8');
    const data = JSON.parse(raw) as { tasks?: Array<{ id: string; status: string; result?: string; error?: string; completedAt?: string; costUsd?: number }> };
    for (const task of data.tasks ?? []) {
      map.set(task.id, task);
    }
  } catch { /* queue doesn't exist */ }
  return map;
}

/** Load completed task IDs from history JSONL. */
async function loadCompletedTaskIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const entries = await tailReadJsonl<{ id?: string; status?: string }>(HISTORY_PATH, 100, 131072);
  for (const entry of entries) {
    if (entry.status === 'completed' && entry.id) ids.add(entry.id);
  }
  return ids;
}

/**
 * Scan active pipelines for stalled stages — where a stage is marked 'running'
 * but the corresponding task has already completed in the queue or history.
 * This recovers from event delivery failures (e.g., race conditions, lost mappings).
 *
 * Called periodically from the worker scheduler's poll loop.
 */
export async function recoverStalledPipelines(): Promise<number> {
  if (activePipelines.size === 0) return 0;

  let recovered = 0;

  for (const run of activePipelines.values()) {
    if (run.status !== 'running') continue;

    for (const stage of Object.values(run.stages)) {
      if (stage.status !== 'running' || !stage.taskId) continue;

      // Check if this task's mapping is missing (which would cause stall)
      if (!taskToPipeline.has(stage.taskId)) {
        await logger.warn('PipelineEngine',
          `Stall detected: stage ${stage.stageId} in pipeline ${run.id} has taskId ${stage.taskId} but no mapping`);

        // Try to find the task result from the queue
        const queueTasks = await loadQueueTasks();
        const queueTask = queueTasks.get(stage.taskId);

        if (queueTask?.status === 'completed' && queueTask.result) {
          // Task completed but pipeline didn't advance — replay completion
          stage.status = 'completed';
          stage.output = queueTask.result;
          stage.completedAt = queueTask.completedAt ?? new Date().toISOString();
          if (queueTask.costUsd) run.totalCostUsd += queueTask.costUsd;
          recovered++;

          await logger.info('PipelineEngine',
            `Recovered stalled stage ${stage.stageId}: task ${stage.taskId} was completed`);
        } else if (queueTask?.status === 'failed') {
          stage.status = 'failed';
          stage.error = queueTask.error ?? 'Failed (recovered from stall)';
          stage.completedAt = queueTask.completedAt ?? new Date().toISOString();
          recovered++;
        } else {
          // Check history
          const completedIds = await loadCompletedTaskIds();
          if (completedIds.has(stage.taskId)) {
            stage.status = 'completed';
            stage.completedAt = new Date().toISOString();
            // No result available from history, but at least unblock the pipeline
            recovered++;

            await logger.info('PipelineEngine',
              `Recovered stalled stage ${stage.stageId}: task ${stage.taskId} found in history`);
          }
        }
      }
    }

    // If any stages were recovered, try to advance
    if (recovered > 0) {
      await advancePipeline(run);
      await savePipelineRun(run);
    }
  }

  return recovered;
}

// ── Internal: Helpers ────────────────────────────────────────────────

async function savePipelineRun(run: PipelineRun): Promise<void> {
  await mkdir(PIPELINES_DIR, { recursive: true });
  const filePath = join(PIPELINES_DIR, `${run.id}.json`);
  await writer.writeNow(filePath, run);
}

function cleanupTaskMappings(runId: string): void {
  for (const [taskId, mapping] of taskToPipeline) {
    if (mapping.runId === runId) {
      taskToPipeline.delete(taskId);
    }
  }
}

// ── Template Cache (for synchronous schema lookup) ───────────────────

const TEMPLATE_CACHE_TTL = 30 * 60 * 1000; // 30 min
const TEMPLATE_CACHE_MAX = 20;
const templateCache = new Map<string, { template: TeamTemplate; expireAt: number }>();

/** Cache a template for synchronous lookups (called during pipeline start/advance). */
function cacheTemplate(template: TeamTemplate): void {
  // Evict oldest if at capacity
  if (templateCache.size >= TEMPLATE_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, val] of templateCache) {
      if (val.expireAt < oldestTime) { oldestTime = val.expireAt; oldestKey = key; }
    }
    if (oldestKey) templateCache.delete(oldestKey);
  }
  templateCache.set(template.name, { template, expireAt: Date.now() + TEMPLATE_CACHE_TTL });
}

/** Get cached template with TTL check */
function getCachedTemplate(teamName: string): TeamTemplate | undefined {
  const entry = templateCache.get(teamName);
  if (!entry) return undefined;
  if (Date.now() > entry.expireAt) {
    templateCache.delete(teamName);
    return undefined;
  }
  return entry.template;
}

/** Look up the output schema name and validation mode for a stage from the cached template. */
function getStageSchema(teamName: string, stageId: string): { schema: string; blocking: boolean } | null {
  const template = getCachedTemplate(teamName);
  if (!template) return null;

  const stage = template.workflow.stages.find((s) => s.id === stageId);
  if (!stage?.outputSchema) return null;
  return { schema: stage.outputSchema, blocking: stage.validationMode === 'blocking' };
}
