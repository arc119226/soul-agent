/**
 * Planning-First Workflow — records intentions, not just steps.
 * Plans live in soul/plans/ as JSON files, with a JSONL index for quick lookup.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import { ok, fail, type Result } from '../result.js';

const PLANS_DIR = join(process.cwd(), 'soul', 'plans');
const PLANS_INDEX = join(PLANS_DIR, '_index.jsonl');

export type PlanStatus = 'draft' | 'active' | 'completed' | 'abandoned';

export interface PlanStep {
  id: number;
  description: string;
  completed: boolean;
  completedAt?: string;
  notes?: string;
}

export interface Plan {
  id: string;
  title: string;

  // The Three Layers
  intention: string;        // Why this matters
  approach: string;         // How to achieve it
  steps: PlanStep[];        // What to do

  // Context
  triggeredBy: string;      // Who/what triggered this plan
  triggerContext: string;    // What was happening when it was created
  successCriteria: string;  // How do we know it's done

  // Lifecycle
  status: PlanStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  // Reflection (filled after completion)
  retrospective?: string;
  lessonsLearned?: string;
  satisfactionLevel?: number; // 1-5
}

interface PlanIndexEntry {
  id: string;
  title: string;
  status: PlanStatus;
  intention: string;
  createdAt: string;
  completedAt?: string;
}

function planPath(planId: string): string {
  return join(PLANS_DIR, `${planId}.json`);
}

export async function createPlan(params: {
  title: string;
  intention: string;
  approach: string;
  steps: string[];
  triggeredBy: string;
  triggerContext: string;
  successCriteria: string;
}): Promise<Result<Plan>> {
  const planId = randomUUID().slice(0, 8);

  const plan: Plan = {
    id: planId,
    title: params.title,
    intention: params.intention,
    approach: params.approach,
    steps: params.steps.map((desc, i) => ({
      id: i + 1,
      description: desc,
      completed: false,
    })),
    triggeredBy: params.triggeredBy,
    triggerContext: params.triggerContext,
    successCriteria: params.successCriteria,
    status: 'draft',
    createdAt: new Date().toISOString(),
  };

  await writer.writeNow(planPath(planId), plan);

  const indexEntry: PlanIndexEntry = {
    id: planId,
    title: plan.title,
    status: plan.status,
    intention: plan.intention,
    createdAt: plan.createdAt,
  };
  await writer.appendJsonl(PLANS_INDEX, indexEntry);

  await eventBus.emit('plan:created', {
    planId: plan.id,
    title: plan.title,
    intention: plan.intention,
  });

  await logger.info('PlanManager', `Created plan ${planId}: ${params.title}`);
  return ok('Plan created', plan);
}

export async function activatePlan(planId: string): Promise<Result<Plan>> {
  const plan = await loadPlan(planId);
  if (!plan) return fail(`Plan not found: ${planId}`);

  plan.status = 'active';
  plan.startedAt = new Date().toISOString();

  await writer.writeNow(planPath(planId), plan);
  await logger.info('PlanManager', `Activated plan ${planId}`);
  return ok('Plan activated', plan);
}

export async function completeStep(
  planId: string,
  stepId: number,
  notes?: string,
): Promise<Result<Plan>> {
  const plan = await loadPlan(planId);
  if (!plan) return fail(`Plan not found: ${planId}`);

  const step = plan.steps.find(s => s.id === stepId);
  if (!step) return fail(`Step ${stepId} not found in plan ${planId}`);

  step.completed = true;
  step.completedAt = new Date().toISOString();
  if (notes) step.notes = notes;

  // Check if all steps are done
  const allDone = plan.steps.every(s => s.completed);
  if (allDone && plan.status === 'active') {
    plan.status = 'completed';
    plan.completedAt = new Date().toISOString();
    await logger.info('PlanManager', `Plan ${planId} auto-completed (all steps done)`);
  }

  await writer.writeNow(planPath(planId), plan);
  return ok('Step completed', plan);
}

export async function completePlan(
  planId: string,
  retrospective: string,
  lessonsLearned: string,
  satisfactionLevel: number,
): Promise<Result<Plan>> {
  const plan = await loadPlan(planId);
  if (!plan) return fail(`Plan not found: ${planId}`);

  plan.status = 'completed';
  plan.completedAt = new Date().toISOString();
  plan.retrospective = retrospective;
  plan.lessonsLearned = lessonsLearned;
  plan.satisfactionLevel = Math.max(1, Math.min(5, satisfactionLevel));

  await writer.writeNow(planPath(planId), plan);

  // Narrative integration
  try {
    const { appendNarrative } = await import('../identity/narrator.js');
    await appendNarrative('reflection',
      `完成計劃「${plan.title}」— ${retrospective}`,
      { significance: plan.satisfactionLevel >= 4 ? 4 : 3, emotion: '成就' },
    );
  } catch { /* non-critical */ }

  // Learning tracker integration
  try {
    const { recordSuccess, addInsight } = await import('../metacognition/learning-tracker.js');
    await recordSuccess('planning', `Completed: ${plan.title}`);
    if (lessonsLearned) {
      await addInsight(`計劃「${plan.title}」的教訓：${lessonsLearned}`);
    }
  } catch { /* non-critical */ }

  await eventBus.emit('plan:completed', {
    planId: plan.id,
    title: plan.title,
    satisfactionLevel: plan.satisfactionLevel,
  });

  await logger.info('PlanManager',
    `Plan ${planId} completed with retrospective (satisfaction: ${plan.satisfactionLevel}/5)`,
  );

  return ok('Plan completed with retrospective', plan);
}

export async function abandonPlan(planId: string, reason: string): Promise<Result<Plan>> {
  const plan = await loadPlan(planId);
  if (!plan) return fail(`Plan not found: ${planId}`);

  plan.status = 'abandoned';
  plan.completedAt = new Date().toISOString();
  plan.retrospective = `放棄原因：${reason}`;

  await writer.writeNow(planPath(planId), plan);

  try {
    const { recordFailure } = await import('../metacognition/learning-tracker.js');
    await recordFailure('planning', `Abandoned: ${plan.title} — ${reason}`);
  } catch { /* non-critical */ }

  await eventBus.emit('plan:abandoned', {
    planId: plan.id,
    title: plan.title,
    reason,
  });

  await logger.info('PlanManager', `Plan ${planId} abandoned: ${reason}`);
  return ok('Plan abandoned', plan);
}

export async function loadPlan(planId: string): Promise<Plan | null> {
  try {
    const raw = await readFile(planPath(planId), 'utf-8');
    return JSON.parse(raw) as Plan;
  } catch {
    return null;
  }
}

export async function getActivePlans(): Promise<Plan[]> {
  try {
    const files = await readdir(PLANS_DIR);
    const plans: Plan[] = [];

    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      try {
        const raw = await readFile(join(PLANS_DIR, file), 'utf-8');
        const plan = JSON.parse(raw) as Plan;
        if (plan.status === 'active' || plan.status === 'draft') {
          plans.push(plan);
        }
      } catch { /* skip malformed */ }
    }

    return plans;
  } catch {
    return [];
  }
}

export async function getRecentPlans(n: number = 10): Promise<Plan[]> {
  try {
    const files = await readdir(PLANS_DIR);
    const plans: Plan[] = [];

    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      try {
        const raw = await readFile(join(PLANS_DIR, file), 'utf-8');
        plans.push(JSON.parse(raw) as Plan);
      } catch { /* skip */ }
    }

    plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return plans.slice(0, n);
  } catch {
    return [];
  }
}

/**
 * Get a summary of active plans for context injection.
 */
export async function getPlansSummary(): Promise<string> {
  const active = await getActivePlans();
  if (active.length === 0) return '';

  const lines: string[] = ['你目前的計劃：'];
  for (const plan of active) {
    const completed = plan.steps.filter(s => s.completed).length;
    const total = plan.steps.length;
    lines.push(`- [${plan.status}] ${plan.title}（${completed}/${total} 步驟完成）`);
    lines.push(`  意圖：${plan.intention}`);
  }

  return lines.join('\n');
}
