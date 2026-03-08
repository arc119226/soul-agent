/**
 * Analyst agent — analyzes usage statistics, suggests evolution strategies,
 * references bot's success/failure patterns.
 */

import { type Agent, type AgentMessage, type AgentResponse, AgentRole } from './types.js';
import { logger } from '../core/logger.js';

export const analyst: Agent = {
  role: AgentRole.Analyst,

  async handle(msg: AgentMessage): Promise<AgentResponse> {
    switch (msg.type) {
      case 'suggest_strategy':
        return handleSuggestStrategy(msg);
      case 'analyze':
        return handleAnalyze(msg);
      case 'query':
        return handleQuery(msg);
      default:
        return { success: false, error: `Analyst cannot handle: ${msg.type}` };
    }
  },
};

/** Suggest an evolution strategy based on goal and historical patterns */
async function handleSuggestStrategy(msg: AgentMessage): Promise<AgentResponse> {
  const { goalId, description } = msg.payload as { goalId: string; description: string };
  await logger.info('analyst', `Analyzing strategy for goal: ${description}`);

  // Load learning patterns
  let patterns: { successes: Array<{ pattern: string }>; failures: Array<{ pattern: string }> } = {
    successes: [],
    failures: [],
  };
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const raw = await readFile(join(process.cwd(), 'soul', 'learning-patterns.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    patterns = parsed.patterns ?? patterns;
  } catch {
    // No patterns yet — this is fine
  }

  // Load recent changelog for context
  let successRate = 0;
  let recentLessons: string[] = [];
  try {
    const { getRecentChanges, getSuccessRate } = await import('../evolution/changelog.js');
    successRate = await getSuccessRate(20);
    const recent = await getRecentChanges(5);
    recentLessons = recent
      .filter((c) => c.lessonsLearned)
      .map((c) => c.lessonsLearned);
  } catch {
    // Evolution module might not be loaded yet
  }

  // Determine approach based on history
  let approach: 'incremental' | 'standard' | 'aggressive' = 'standard';
  if (successRate < 0.3) {
    approach = 'incremental'; // Be more cautious
  } else if (successRate > 0.8 && patterns.successes.length > 3) {
    approach = 'aggressive'; // Can be bolder
  }

  // Build recommendations
  const recommendations: string[] = [
    'Make small, focused changes',
    'Ensure type safety with strict TypeScript',
    'Add error handling for edge cases',
    'Use Result<T> pattern for fallible operations',
  ];

  if (approach === 'incremental') {
    recommendations.unshift('Start with the simplest possible implementation');
    recommendations.push('Add extra validation before committing');
  }
  if (approach === 'aggressive') {
    recommendations.push('Consider refactoring related code for consistency');
  }

  // Check for common failure patterns
  const failurePatterns = patterns.failures.map((f) => f.pattern?.toLowerCase() ?? '');
  if (failurePatterns.some((p) => p.includes('import'))) {
    recommendations.push('Double-check all import paths use .js extensions');
  }
  if (failurePatterns.some((p) => p.includes('type'))) {
    recommendations.push('Run tsc --noEmit before finalizing');
  }

  const strategy = {
    approach,
    priority: 'safety_first',
    successRate: Math.round(successRate * 100),
    historicalSuccesses: patterns.successes.length,
    historicalFailures: patterns.failures.length,
    recommendations,
    recentLessons: recentLessons.slice(0, 3),
    notes: `Goal: ${description}. Success rate: ${Math.round(successRate * 100)}%. Approach: ${approach}.`,
  };

  return { success: true, data: strategy };
}

/** Analyze a question or situation */
async function handleAnalyze(msg: AgentMessage): Promise<AgentResponse> {
  const { question, context } = msg.payload as { question: string; context?: Record<string, unknown> };
  await logger.info('analyst', `Analyzing: ${question}`);

  // Gather metrics from various sources
  const metrics: Record<string, number> = {};
  const analysisPatterns: string[] = [];
  const suggestions: string[] = [];

  // Load goals data
  try {
    const { getAllGoals } = await import('../evolution/goals.js');
    const goals = getAllGoals();
    metrics['totalGoals'] = goals.length;
    metrics['pendingGoals'] = goals.filter((g) => g.status === 'pending').length;
    metrics['completedGoals'] = goals.filter((g) => g.status === 'completed').length;
    metrics['failedGoals'] = goals.filter((g) => g.status === 'failed').length;

    if (metrics['failedGoals']! > metrics['completedGoals']!) {
      analysisPatterns.push('More failures than successes — consider simplifying goals');
      suggestions.push('Review and break down complex goals into smaller pieces');
    }
    if (metrics['pendingGoals'] === 0) {
      suggestions.push('No pending goals — add new evolution targets');
    }
  } catch {
    // Goals module not available
  }

  // Load changelog data
  try {
    const { getSuccessRate, getRecentChanges } = await import('../evolution/changelog.js');
    const rate = await getSuccessRate(20);
    metrics['successRate'] = Math.round(rate * 100);
    const recent = await getRecentChanges(10);
    metrics['recentChanges'] = recent.length;

    if (rate < 0.5) {
      analysisPatterns.push('Low overall success rate');
      suggestions.push('Focus on fixing existing issues before adding new features');
    }
  } catch {
    // Changelog module not available
  }

  // Load circuit breaker state
  try {
    const { getCircuitBreakerInfo } = await import('../evolution/circuit-breaker.js');
    const cbInfo = getCircuitBreakerInfo();
    metrics['consecutiveFailures'] = cbInfo.consecutiveFailures;
    metrics['totalSuccesses'] = cbInfo.totalSuccesses;
    metrics['totalFailures'] = cbInfo.totalFailures;

    if (cbInfo.state === 'open') {
      analysisPatterns.push('Circuit breaker is OPEN — evolution blocked');
      suggestions.push('Wait for cooldown or manually investigate and reset');
    }
  } catch {
    // Circuit breaker not available
  }

  return {
    success: true,
    data: {
      question,
      metrics,
      patterns: analysisPatterns,
      suggestions,
      analyzedAt: new Date().toISOString(),
    },
  };
}

/** Handle direct metric queries */
async function handleQuery(msg: AgentMessage): Promise<AgentResponse> {
  const { metric } = msg.payload as { metric: string };

  // Re-use analyze to get all metrics
  const analysis = await handleAnalyze({
    ...msg,
    type: 'analyze',
    payload: { question: `Query: ${metric}` },
  });

  if (analysis.success && analysis.data) {
    const data = analysis.data as { metrics: Record<string, number> };
    const value = data.metrics[metric];
    return {
      success: true,
      data: value !== undefined ? { [metric]: value } : data.metrics,
    };
  }

  return analysis;
}
