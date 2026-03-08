/**
 * Team template CRUD — reads/writes soul/teams/{name}.json.
 *
 * Defines multi-agent team compositions, workflow stages, budget limits,
 * and governance rules. Inspired by CrewAI's declarative definitions +
 * LangGraph's stage DAG + OpenAI SDK's input filters.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../../core/debounced-writer.js';
import { logger } from '../../core/logger.js';

const TEAMS_DIR = join(process.cwd(), 'soul', 'teams');

// ── Types ────────────────────────────────────────────────────────────

export interface TeamMember {
  /** Agent name (must match soul/agents/{name}.json) */
  agentName: string;
  /** Role within the team (researcher, writer, scanner, investigator, etc.) */
  teamRole: string;
  /** What this agent should accomplish in this team context */
  goal: string;
  /** Optional backstory for richer prompt context (CrewAI-inspired) */
  backstory?: string;
}

export interface TeamStage {
  /** Unique stage identifier within the workflow */
  id: string;
  /** Which agent executes this stage */
  agentName: string;
  /** Stage IDs whose outputs feed into this stage */
  inputFrom?: string[];
  /** Named output schema to validate against (from output-schemas registry) */
  outputSchema?: string;
  /** Named input filter to apply to upstream outputs */
  inputFilter?: string;
  /** If true, pipeline continues even if this stage fails */
  optional?: boolean;
  /** Override workflow-level contextTokenBudget for this specific stage */
  contextTokenBudget?: number;
  /** Validation mode: 'advisory' (log only, default) or 'blocking' (abort pipeline on validation failure) */
  validationMode?: 'advisory' | 'blocking';

  /** stateMachine mode: transition rules based on HANDOFF intent */
  transitions?: {
    /** Map from HANDOFF intent ('handoff' | 'feedback' | 'escalate') or 'default' to next stage ID(s) */
    [intentOrDefault: string]: string | string[];
  };
  /** stateMachine mode: if true, wait for ALL inputFrom stages to complete before starting */
  waitForAll?: boolean;
  /** stateMachine mode: max times this stage can execute in a loop (default 1) */
  maxIterations?: number;
}

export interface TeamWorkflow {
  /** Execution mode: sequential stages, all-parallel, mixed (parallel groups + sequential deps), or stateMachine (HANDOFF-driven routing) */
  mode: 'sequential' | 'parallel' | 'mixed' | 'stateMachine';
  /** Ordered list of stages. Stages with no inputFrom can run in parallel in 'mixed' mode */
  stages: TeamStage[];
  /** Override the default token budget (8000) for the token-budget input filter */
  contextTokenBudget?: number;
}

export interface TeamBudget {
  /** Maximum total cost for one pipeline run in USD */
  maxTotalCostUsd: number;
  /** Per-stage cost limits in USD (keyed by stage ID) */
  perStageLimits?: Record<string, number>;
}

export interface TeamGovernance {
  /** Whether a review stage is required before pipeline completion */
  requireReviewStage: boolean;
  /** Minimum confidence score (0-1) for inter-stage handoff */
  minConfidence: number;
  /** What to do when a stage fails: retry, skip (if optional), or abort */
  escalateOnFailure: 'retry' | 'skip' | 'abort';
}

export interface TeamTemplate {
  /** Team name (filename stem) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Schema version for future migrations */
  version: number;
  /** Team members with roles and goals */
  members: TeamMember[];
  /** Workflow definition with stages */
  workflow: TeamWorkflow;
  /** Budget constraints */
  budget: TeamBudget;
  /** Governance rules */
  governance: TeamGovernance;
}

// ── CRUD ─────────────────────────────────────────────────────────────

function teamPath(name: string): string {
  const safe = name.replace(/[^a-z0-9_-]/gi, '');
  if (!safe) throw new Error(`Invalid team name: ${name}`);
  return join(TEAMS_DIR, `${safe}.json`);
}

/** Load a single team template by name. Returns null if not found. */
export async function loadTeamTemplate(name: string): Promise<TeamTemplate | null> {
  try {
    const raw = await readFile(teamPath(name), 'utf-8');
    return JSON.parse(raw) as TeamTemplate;
  } catch {
    return null;
  }
}

/** Save (create or update) a team template. */
export async function saveTeamTemplate(template: TeamTemplate): Promise<void> {
  await writer.writeNow(teamPath(template.name), template);
  await logger.info('TeamConfig', `Saved team template: ${template.name}`);
}

/** List all team template names (from soul/teams/*.json). */
export async function listTeamNames(): Promise<string[]> {
  try {
    const files = await readdir(TEAMS_DIR);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/** Load all team templates. */
export async function loadAllTeamTemplates(): Promise<TeamTemplate[]> {
  const names = await listTeamNames();
  const templates: TeamTemplate[] = [];
  for (const name of names) {
    const t = await loadTeamTemplate(name);
    if (t) templates.push(t);
  }
  return templates;
}

/** Resolve which stages can run in parallel (no inputFrom dependencies). */
export function getParallelStages(template: TeamTemplate): TeamStage[][] {
  const stages = template.workflow.stages;
  const layers: TeamStage[][] = [];
  const completed = new Set<string>();

  while (completed.size < stages.length) {
    const ready = stages.filter(
      (s) =>
        !completed.has(s.id) &&
        (!s.inputFrom || s.inputFrom.every((dep) => completed.has(dep))),
    );
    if (ready.length === 0) break; // circular dependency guard
    layers.push(ready);
    for (const s of ready) completed.add(s.id);
  }

  return layers;
}
