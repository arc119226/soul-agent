/**
 * Pipeline state persistence — save/resume interrupted pipelines.
 * Stored at data/pipeline-state.json.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';

const STATE_FILE = join(process.cwd(), 'data', 'pipeline-state.json');

export type PipelineStep =
  | 'idle'
  | 'fetch_knowledge'
  | 'build_strategy'
  | 'record_intention'
  | 'build_prompt'
  | 'claude_exec'
  | 'type_check'
  | 'basic_validation'
  | 'run_tests'
  | 'layered_validation'
  | 'track_outcome'
  | 'post_actions';

const STEP_ORDER: PipelineStep[] = [
  'fetch_knowledge',
  'build_strategy',
  'record_intention',
  'build_prompt',
  'claude_exec',
  'type_check',
  'basic_validation',
  'run_tests',
  'layered_validation',
  'track_outcome',
  'post_actions',
];

export interface PipelineStateData {
  goalId: string;
  currentStep: PipelineStep;
  completedSteps: PipelineStep[];
  startedAt: string;
  lastUpdatedAt: string;
  error?: string;
  changedFiles?: string[];
}

interface PipelineStateFile {
  version: number;
  pipeline: PipelineStateData | null;
}

let stateCache: PipelineStateData | null = null;

/** Load pipeline state from disk */
export async function loadPipelineState(): Promise<void> {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    const data: PipelineStateFile = JSON.parse(raw);
    stateCache = data.pipeline;
    if (stateCache) {
      logger.info('pipeline-state', `Found interrupted pipeline for goal ${stateCache.goalId} at step ${stateCache.currentStep}`);
    }
  } catch {
    stateCache = null;
  }
}

function saveState(): void {
  const data: PipelineStateFile = { version: 1, pipeline: stateCache };
  writer.schedule(STATE_FILE, data);
}

async function saveStateNow(): Promise<void> {
  const data: PipelineStateFile = { version: 1, pipeline: stateCache };
  await writer.writeNow(STATE_FILE, data);
}

/** Start a new pipeline run */
export async function startPipeline(goalId: string): Promise<void> {
  stateCache = {
    goalId,
    currentStep: 'fetch_knowledge',
    completedSteps: [],
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
  await saveStateNow();
  logger.info('pipeline-state', `Pipeline started for goal ${goalId}`);
}

/** Mark the current step as completed and advance */
export async function advanceStep(changedFiles?: string[]): Promise<void> {
  if (!stateCache) return;

  stateCache.completedSteps.push(stateCache.currentStep);
  stateCache.lastUpdatedAt = new Date().toISOString();

  if (changedFiles) {
    stateCache.changedFiles = changedFiles;
  }

  // Find next step
  const currentIdx = STEP_ORDER.indexOf(stateCache.currentStep);
  if (currentIdx >= 0 && currentIdx < STEP_ORDER.length - 1) {
    stateCache.currentStep = STEP_ORDER[currentIdx + 1]!;
  } else {
    stateCache.currentStep = 'idle';
  }

  await saveStateNow();
}

/** Record an error in the current pipeline */
export async function recordPipelineError(error: string): Promise<void> {
  if (!stateCache) return;
  stateCache.error = error;
  stateCache.lastUpdatedAt = new Date().toISOString();
  await saveStateNow();
}

/** Clear pipeline state (on completion or abandon) */
export async function clearPipeline(): Promise<void> {
  stateCache = null;
  await saveStateNow();
  logger.info('pipeline-state', 'Pipeline state cleared');
}

/** Get current pipeline state */
export function getPipelineState(): PipelineStateData | null {
  return stateCache ? { ...stateCache } : null;
}

/** Check if there's an interrupted pipeline */
export function hasInterruptedPipeline(): boolean {
  return stateCache !== null && stateCache.currentStep !== 'idle';
}

/** Get the step that should be resumed from */
export function getResumeStep(): PipelineStep | null {
  if (!stateCache || stateCache.currentStep === 'idle') return null;
  return stateCache.currentStep;
}

/** Get ordered list of all pipeline steps */
export function getStepOrder(): PipelineStep[] {
  return [...STEP_ORDER];
}

/** Get step index (0-based) for progress display */
export function getStepIndex(step: PipelineStep): number {
  return STEP_ORDER.indexOf(step);
}

/** Get total number of steps */
export function getTotalSteps(): number {
  return STEP_ORDER.length;
}
