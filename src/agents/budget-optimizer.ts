/**
 * Budget Optimizer — adaptive daily cost allocation based on agent ROI.
 *
 * Computes an efficiency score for each agent and redistributes the total
 * daily budget accordingly, while enforcing per-agent min/max constraints.
 *
 * Runs once per day (or on-demand via /budget optimize).
 */

import { loadAllAgentConfigs, saveAgentConfig, type AgentConfig } from './config/agent-config.js';
import { logger } from '../core/logger.js';
import { writer } from '../core/debounced-writer.js';
import { getDb } from '../core/database.js';
import { join } from 'node:path';

// ── Constants ────────────────────────────────────────────────────────

const MIN_DAILY_BUDGET = 0.10;  // $0.10 floor per agent
const MAX_BUDGET_MULTIPLIER = 3; // Max 3x original allocation
const DEFAULT_VALUE_SCORE = 0.5;
const DEFAULT_AVG_COST = 0.15;  // assumed cost when no data today
const MIN_EFFICIENCY = 0.01;
const ENFORCEMENT_ROUNDS = 3;
const CHANGE_THRESHOLD = 0.01;  // minimum meaningful budget change
const NARRATIVE_PATH = join(process.cwd(), 'soul', 'narrative.jsonl');

// ── Types ────────────────────────────────────────────────────────────

interface AgentBudgetInfo {
  name: string;
  originalBudget: number;
  efficiencyScore: number;
  newBudget: number;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Optimize budget allocation across all enabled agents.
 * Returns the optimization result for display/logging.
 */
export async function optimizeBudgets(): Promise<{
  agents: AgentBudgetInfo[];
  totalBudget: number;
  changed: number;
}> {
  const configs = await loadAllAgentConfigs();
  const enabled = configs.filter((c) => c.enabled && c.dailyCostLimit > 0);

  if (enabled.length < 2) {
    return { agents: [], totalBudget: 0, changed: 0 };
  }

  // Separate locked agents (manual override) from optimizable ones
  const locked = enabled.filter((c) => c.budgetLocked);
  const optimizable = enabled.filter((c) => !c.budgetLocked);

  if (optimizable.length < 2) {
    return { agents: [], totalBudget: 0, changed: 0 };
  }

  // Calculate total budget EXCLUDING locked agents (they keep their budget as-is)
  const lockedBudget = locked.reduce((sum, c) => sum + c.dailyCostLimit, 0);
  const totalBudget = enabled.reduce((sum, c) => sum + c.dailyCostLimit, 0);
  const optimizableBudget = totalBudget - lockedBudget;

  if (lockedBudget > 0) {
    await logger.info('BudgetOptimizer',
      `Skipping ${locked.length} locked agent(s) ($${lockedBudget.toFixed(2)}): ${locked.map(c => c.name).join(', ')}`);
  }

  // Compute efficiency scores (only for optimizable agents)
  const scoredAgents: AgentBudgetInfo[] = optimizable.map((cfg) => ({
    name: cfg.name,
    originalBudget: cfg.dailyCostLimit,
    efficiencyScore: computeEfficiency(cfg),
    newBudget: 0,
  }));

  // Allocate optimizable budget proportionally to efficiency scores
  const totalScore = scoredAgents.reduce((sum, a) => sum + a.efficiencyScore, 0);

  if (totalScore <= 0) {
    // All agents have zero efficiency — distribute evenly
    const even = optimizableBudget / scoredAgents.length;
    for (const agent of scoredAgents) {
      agent.newBudget = even;
    }
  } else {
    for (const agent of scoredAgents) {
      const proportion = agent.efficiencyScore / totalScore;
      agent.newBudget = optimizableBudget * proportion;
    }
  }

  // Enforce constraints: min floor, max ceiling (within optimizable pool only)
  enforceConstraints(scoredAgents, optimizableBudget);

  // Apply changes
  let changed = 0;
  for (const agent of scoredAgents) {
    const roundedNew = Math.round(agent.newBudget * 100) / 100; // 2 decimal places
    if (Math.abs(roundedNew - agent.originalBudget) >= CHANGE_THRESHOLD) {
      const cfg = optimizable.find((c) => c.name === agent.name);
      if (cfg) {
        cfg.dailyCostLimit = roundedNew;
        await saveAgentConfig(cfg);
        changed++;
      }
      agent.newBudget = roundedNew;
    } else {
      agent.newBudget = agent.originalBudget; // No meaningful change
    }
  }

  // Log to narrative for transparency
  if (changed > 0) {
    const summary = scoredAgents
      .filter((a) => Math.abs(a.newBudget - a.originalBudget) >= CHANGE_THRESHOLD)
      .map((a) => `${a.name}: $${a.originalBudget.toFixed(2)} → $${a.newBudget.toFixed(2)}`)
      .join(', ');

    const narrativeEntry = {
      type: 'budget_optimization',
      timestamp: new Date().toISOString(),
      summary: `Budget optimized: ${summary}`,
      totalBudget,
      changed,
    };

    // 1. Write to SQLite
    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO narrative (timestamp, type, summary, emotion, significance, related_to, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        narrativeEntry.timestamp,
        narrativeEntry.type,
        narrativeEntry.summary,
        null,      // emotion
        3,         // significance
        null,      // related_to
        JSON.stringify({ totalBudget, changed }),
      );
    } catch {
      // SQLite write failure is non-critical
    }

    // 2. Write to JSONL (dual-write backup — removed in Phase 5)
    await writer.appendJsonl(NARRATIVE_PATH, narrativeEntry);

    await logger.info('BudgetOptimizer',
      `Optimized ${changed} agent(s) budget. Total: $${totalBudget.toFixed(2)}`);
  }

  return { agents: scoredAgents, totalBudget, changed };
}

// ── Internal ─────────────────────────────────────────────────────────

/**
 * Compute efficiency score for an agent.
 * Formula: valueScore × (1 - failureRate) / avgCostPerTask
 *
 * Uses same-window denominators: runsToday for avgCost, totalRuns for failureRate.
 */
function computeEfficiency(cfg: AgentConfig): number {
  const valueScore = cfg.valueScore ?? DEFAULT_VALUE_SCORE;

  // avgCost: today's cost ÷ today's runs (same time window)
  const runsToday = cfg.runsToday ?? 0;
  const avgCost = runsToday > 0
    ? Math.max(cfg.totalCostToday / runsToday, MIN_EFFICIENCY)
    : DEFAULT_AVG_COST;

  // failureRate: 7d failures ÷ total runs (bounded approximation)
  const failures7d = cfg.failureCount7d ?? 0;
  const failureRate = cfg.totalRuns > 0
    ? Math.min(failures7d / cfg.totalRuns, 1)
    : 0;

  return Math.max(valueScore * (1 - failureRate) / avgCost, MIN_EFFICIENCY);
}

/**
 * Enforce min/max constraints with iterative redistribution.
 * Ensures total budget is conserved (sum stays the same).
 */
function enforceConstraints(agents: AgentBudgetInfo[], totalBudget: number): void {
  // Up to 3 rounds of constraint enforcement
  for (let round = 0; round < ENFORCEMENT_ROUNDS; round++) {
    // surplus > 0: freed from capped agents, available to distribute
    // surplus < 0: spent on floored agents, must be reclaimed
    let surplus = 0;
    let adjustableCount = 0;

    for (const agent of agents) {
      const maxBudget = agent.originalBudget * MAX_BUDGET_MULTIPLIER;

      if (agent.newBudget < MIN_DAILY_BUDGET) {
        surplus -= (MIN_DAILY_BUDGET - agent.newBudget);
        agent.newBudget = MIN_DAILY_BUDGET;
      } else if (agent.newBudget > maxBudget) {
        surplus += (agent.newBudget - maxBudget);
        agent.newBudget = maxBudget;
      } else {
        adjustableCount++;
      }
    }

    if (Math.abs(surplus) < CHANGE_THRESHOLD || adjustableCount === 0) break;

    // Redistribute surplus (positive = give more, negative = take back)
    const perAgent = surplus / adjustableCount;
    for (const agent of agents) {
      const maxBudget = agent.originalBudget * MAX_BUDGET_MULTIPLIER;
      if (agent.newBudget > MIN_DAILY_BUDGET && agent.newBudget < maxBudget) {
        agent.newBudget += perAgent;
      }
    }
  }

  // Final normalization to ensure exact total conservation
  const currentTotal = agents.reduce((sum, a) => sum + a.newBudget, 0);
  if (Math.abs(currentTotal - totalBudget) > CHANGE_THRESHOLD) {
    const ratio = totalBudget / currentTotal;
    for (const agent of agents) {
      agent.newBudget *= ratio;
    }
  }
}
