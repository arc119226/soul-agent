/**
 * Autonomous Upgrade Loop — automatically decides when to upgrade skills.
 *
 * Combines usage frequency (skill-usage-tracker) + effectiveness score
 * (skill-effectiveness) to autonomously trigger the evolution pipeline.
 *
 * Decision matrix:
 * | Usage | Effectiveness | Action |
 * |-------|---------------|--------|
 * | High  | High          | Auto-upgrade to Plugin (create goal) |
 * | High  | Low           | Auto-modify skill (improve it) |
 * | Low   | High          | Keep as-is (efficient enough) |
 * | Low   | Low           | Consider deletion |
 *
 * Integration: Called from daily reflection or scheduler.
 * NOT directly connected to evolution pipeline — it creates goals,
 * which the pipeline picks up on its own schedule.
 */

import { logger } from '../core/logger.js';

// ── Configuration ───────────────────────────────────────────────────

/** Minimum activations to make any autonomous decision */
const MIN_ACTIVATIONS = 10;

/** High usage: weekly count above this */
const HIGH_USAGE_WEEKLY = 15;

/** High effectiveness: score above this */
const HIGH_EFFECTIVENESS = 0.65;

/** Low effectiveness: score below this */
const LOW_EFFECTIVENESS = 0.35;

/** Maximum auto-goals per cycle to prevent goal flooding */
const MAX_GOALS_PER_CYCLE = 2;

/** Cooldown between autonomous decisions per skill (7 days) */
const DECISION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// ── State ───────────────────────────────────────────────────────────

const lastDecisionTime = new Map<string, number>();

// ── Types ───────────────────────────────────────────────────────────

export interface AutonomousDecision {
  skillName: string;
  action: 'upgrade' | 'improve' | 'keep' | 'deprecate';
  reason: string;
  usageWeekly: number;
  effectivenessScore: number;
}

export interface AutonomousUpgradeResult {
  decisions: AutonomousDecision[];
  goalsCreated: number;
  skillsModified: number;
}

// ── Core Logic ──────────────────────────────────────────────────────

/**
 * Evaluate all skills and make autonomous upgrade decisions.
 * Creates goals for the evolution pipeline to act on.
 */
export async function runAutonomousUpgradeCheck(): Promise<AutonomousUpgradeResult> {
  logger.info('autonomous-upgrade', 'Running autonomous upgrade evaluation...');

  const result: AutonomousUpgradeResult = {
    decisions: [],
    goalsCreated: 0,
    skillsModified: 0,
  };

  try {
    // Load usage stats and effectiveness data
    const { getAllUsageStats } = await import('./skill-usage-tracker.js');
    const { getAllEffectiveness } = await import('./skill-effectiveness.js');

    const usageStats = await getAllUsageStats();
    const effectivenessData = await getAllEffectiveness();

    // Merge data for skills that have BOTH usage and effectiveness data
    const skillNames = new Set([
      ...Object.keys(usageStats),
      ...Object.keys(effectivenessData),
    ]);

    let goalsCreated = 0;

    for (const name of skillNames) {
      if (goalsCreated >= MAX_GOALS_PER_CYCLE) break;

      const usage = usageStats[name];
      const effectiveness = effectivenessData[name];

      // Skip if insufficient data
      if (!usage || !effectiveness || effectiveness.activations < MIN_ACTIVATIONS) {
        continue;
      }

      // Check cooldown
      const lastDecision = lastDecisionTime.get(name) ?? 0;
      if (Date.now() - lastDecision < DECISION_COOLDOWN_MS) {
        continue;
      }

      // Decision matrix
      const isHighUsage = usage.weeklyCount >= HIGH_USAGE_WEEKLY;
      const isHighEffective = effectiveness.score >= HIGH_EFFECTIVENESS;
      const isLowEffective = effectiveness.score <= LOW_EFFECTIVENESS;

      let decision: AutonomousDecision;

      if (isHighUsage && isHighEffective) {
        // AUTO-UPGRADE: High usage + high effectiveness → Plugin
        decision = {
          skillName: name,
          action: 'upgrade',
          reason: `高頻使用（${usage.weeklyCount}/週）且效果優良（${(effectiveness.score * 100).toFixed(0)}%）`,
          usageWeekly: usage.weeklyCount,
          effectivenessScore: effectiveness.score,
        };
        await createUpgradeGoal(name, decision);
        goalsCreated++;
      } else if (isHighUsage && isLowEffective) {
        // AUTO-IMPROVE: High usage but low effectiveness → needs fixing
        decision = {
          skillName: name,
          action: 'improve',
          reason: `高頻使用（${usage.weeklyCount}/週）但效果不佳（${(effectiveness.score * 100).toFixed(0)}%），需要改進`,
          usageWeekly: usage.weeklyCount,
          effectivenessScore: effectiveness.score,
        };
        await createImproveGoal(name, decision);
        goalsCreated++;
      } else if (!isHighUsage && isLowEffective) {
        // DEPRECATE: Low usage + low effectiveness → consider removing
        decision = {
          skillName: name,
          action: 'deprecate',
          reason: `使用率低（${usage.weeklyCount}/週）且效果不佳（${(effectiveness.score * 100).toFixed(0)}%）`,
          usageWeekly: usage.weeklyCount,
          effectivenessScore: effectiveness.score,
        };
        // Don't create goals for deprecation — just log it
        logger.info('autonomous-upgrade', `Deprecation candidate: ${name} (${decision.reason})`);
      } else {
        // KEEP: Everything else
        decision = {
          skillName: name,
          action: 'keep',
          reason: `穩定運行（使用 ${usage.weeklyCount}/週，效果 ${(effectiveness.score * 100).toFixed(0)}%）`,
          usageWeekly: usage.weeklyCount,
          effectivenessScore: effectiveness.score,
        };
      }

      lastDecisionTime.set(name, Date.now());
      result.decisions.push(decision);
    }

    result.goalsCreated = goalsCreated;

    if (result.decisions.length > 0) {
      logger.info(
        'autonomous-upgrade',
        `Evaluated ${result.decisions.length} skills: ${result.goalsCreated} goals created`,
      );
    }
  } catch (err) {
    logger.warn('autonomous-upgrade', 'Evaluation failed', err);
  }

  return result;
}

// ── Goal Creation ───────────────────────────────────────────────────

/**
 * Create a goal to upgrade a skill to Plugin.
 */
async function createUpgradeGoal(skillName: string, decision: AutonomousDecision): Promise<void> {
  try {
    const { addGoal, getAllGoals } = await import('../evolution/goals.js');

    // Check if a similar goal already exists
    const existing = getAllGoals();
    const hasSimilar = existing.some(
      (g) =>
        (g.status === 'pending' || g.status === 'in_progress') &&
        g.description.includes(skillName) &&
        g.description.includes('升級'),
    );
    if (hasSimilar) {
      logger.info('autonomous-upgrade', `Upgrade goal for ${skillName} already exists, skipping`);
      return;
    }

    const desc = `升級技能「${skillName}」為 TypeScript Plugin（${decision.reason}）`;
    addGoal(desc, 3, ['auto', 'upgrade', skillName]);

    // Record in narrative
    const { appendNarrative } = await import('../identity/narrator.js');
    await appendNarrative('evolution', `自主決策：準備升級技能「${skillName}」為 Plugin`, {
      significance: 3,
      emotion: '自信',
    });

    logger.info('autonomous-upgrade', `Created upgrade goal for: ${skillName}`);
  } catch (err) {
    logger.warn('autonomous-upgrade', `Failed to create upgrade goal for ${skillName}`, err);
  }
}

/**
 * Create a goal to improve a skill's effectiveness.
 */
async function createImproveGoal(skillName: string, decision: AutonomousDecision): Promise<void> {
  try {
    const { addGoal, getAllGoals } = await import('../evolution/goals.js');

    const existing = getAllGoals();
    const hasSimilar = existing.some(
      (g) =>
        (g.status === 'pending' || g.status === 'in_progress') &&
        g.description.includes(skillName) &&
        g.description.includes('改進'),
    );
    if (hasSimilar) {
      logger.info('autonomous-upgrade', `Improve goal for ${skillName} already exists, skipping`);
      return;
    }

    const desc = `改進技能「${skillName}」的效果（${decision.reason}）`;
    addGoal(desc, 4, ['auto', 'improve', skillName]);

    logger.info('autonomous-upgrade', `Created improve goal for: ${skillName}`);
  } catch (err) {
    logger.warn('autonomous-upgrade', `Failed to create improve goal for ${skillName}`, err);
  }
}

/**
 * Reset decision cooldown for a skill (for testing).
 */
export function resetDecisionCooldown(skillName: string): void {
  lastDecisionTime.delete(skillName);
}
