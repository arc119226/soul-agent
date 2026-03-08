/**
 * Route Decision — Determines whether a goal should use "Skill path" or "Code path".
 *
 * Design: Hybrid approach
 * 1. Pattern-based fast path (rule engine)
 * 2. LLM classifier for ambiguous cases (Claude API)
 *
 * Integration point: Called in evolution/pipeline.ts → stepBuildStrategy
 *
 * Decision criteria:
 * - Skill path: Repeating queries, knowledge-driven, no code changes needed
 * - Code path: Architecture changes, new features, performance optimization
 */

import { logger } from '../core/logger.js';
import type { Goal } from './goals.js';
import { config } from '../config.js';

export type RoutePath = 'skill' | 'code' | 'research';

export interface RouteDecision {
  path: RoutePath;
  confidence: number; // 0.0–1.0
  reason: string;
}

/**
 * CODE_FIRST_PATTERNS — checked before research patterns.
 * These override research classification for goals that need actual code changes,
 * even if they contain research-like keywords (e.g., "策略檢視" about the evolution system).
 */
const CODE_FIRST_PATTERNS = [
  /策略.*調整.*方法/,    // "策略檢視...需要調整方法" — meta-improvement, needs code
  /調整.*進化/,          // "調整進化策略" — evolution system changes
  /修復.*進化/,          // "修復進化系統"
  /改善.*pipeline/i,     // "改善 pipeline"
  /fix.*evolution/i,     // "fix evolution"
  /improve.*evolution/i, // "improve evolution"
  /修.*失敗/,            // "修復反覆失敗" — repair failures
  /升級.*系統/,          // "升級系統"
  /幫我升級/,            // "幫我升級"
];

/** Pattern-based rules for obvious cases */
const CODE_PATTERNS = [
  /add.*command/i,
  /create.*plugin/i,
  /refactor/i,
  /optimize.*performance/i,
  /fix.*bug/i,
  /implement.*feature/i,
  /upgrade.*dependency/i,
  /migrate/i,
  /架構/,
  /重構/,
  /新功能/,
  /優化效能/,
  /修.*bug/i,
];

const RESEARCH_PATTERNS = [
  /深入研究/,
  /深入了解/,
  /探索報告/,
  /研究.*報告/,
  /deep.*research/i,
  /investigate/i,
  /research.*topic/i,
  /市場.*調查/,
  /技術.*調研/,
  /competitive.*analysis/i,
  /探索好奇心/,
  /探索.*話題/,
];

const SKILL_PATTERNS = [
  /how.*to/i,
  /explain/i,
  /guide/i,
  /workflow/i,
  /automation.*(?:without code|no code)/i,
  /教學/,
  /說明/,
  /流程/,
  /自動化.*(?:不用|免|無需).*程式/,
];

/**
 * Fast path: Rule-based classification for obvious cases.
 * Returns null if ambiguous (needs LLM classifier).
 *
 * Priority order: CODE_FIRST > RESEARCH > CODE > SKILL
 * CODE_FIRST catches meta-goals (about the evolution system itself) that
 * would otherwise be misrouted to the research path.
 */
function classifyByPatterns(description: string): RouteDecision | null {
  // Check CODE_FIRST patterns (highest priority — prevents research loop for meta-goals)
  for (const pattern of CODE_FIRST_PATTERNS) {
    if (pattern.test(description)) {
      return {
        path: 'code',
        confidence: 0.95,
        reason: `Code-first override: "${description.slice(0, 50)}" → self-improvement/meta goal requiring code changes`,
      };
    }
  }

  // Check RESEARCH patterns
  for (const pattern of RESEARCH_PATTERNS) {
    if (pattern.test(description)) {
      return {
        path: 'research',
        confidence: 0.9,
        reason: `Pattern match: "${description.slice(0, 50)}" → research/investigation task`,
      };
    }
  }

  // Check CODE patterns
  for (const pattern of CODE_PATTERNS) {
    if (pattern.test(description)) {
      return {
        path: 'code',
        confidence: 0.85,
        reason: `Pattern match: "${description.slice(0, 50)}" → typical code change request`,
      };
    }
  }

  // Check SKILL patterns
  for (const pattern of SKILL_PATTERNS) {
    if (pattern.test(description)) {
      return {
        path: 'skill',
        confidence: 0.8,
        reason: `Pattern match: "${description.slice(0, 50)}" → knowledge/workflow guidance`,
      };
    }
  }

  return null; // Ambiguous — needs LLM
}

/**
 * LLM-based classifier for ambiguous cases.
 * Uses a lightweight Haiku call for classification.
 */
async function classifyByLLM(description: string): Promise<RouteDecision> {
  logger.info('route-decision', 'Using LLM classifier for ambiguous goal...');

  // Guard: skip SDK call if no API key configured (CLI-only deployments)
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.info('route-decision', 'ANTHROPIC_API_KEY not set, skipping LLM classifier');
    return { path: 'code', confidence: 0.5, reason: 'LLM classifier unavailable (no API key), defaulting to code path' };
  }

  try {
    // Import Anthropic SDK lazily (only when needed)
    // @ts-ignore — SDK may not be installed, handled by try/catch
    const { Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are a decision router for an AI bot's evolution system.

Given this goal description, decide whether it should be handled via:
- **research** path: Deep investigation requiring web search, source synthesis, and report generation (e.g. "深入研究", "research topic", "investigate")
- **skill** path: Creating/updating a Markdown skill (knowledge guide, workflow automation without code)
- **code** path: Writing/modifying TypeScript code (new features, architecture changes, bug fixes)

Goal: "${description}"

Respond in JSON format:
{
  "path": "research" | "skill" | "code",
  "confidence": 0.0–1.0,
  "reason": "brief explanation"
}`;

    const response = await client.messages.create({
      model: config.MODEL_TIER_HAIKU,
      max_tokens: 200,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM did not return valid JSON');
    }

    const result = JSON.parse(jsonMatch[0]) as RouteDecision;
    logger.info('route-decision', `LLM classified: ${result.path} (confidence: ${result.confidence})`);

    return result;
  } catch (err) {
    logger.warn('route-decision', 'LLM classifier failed, defaulting to code path', err);
    return {
      path: 'code',
      confidence: 0.5,
      reason: 'LLM classifier unavailable, defaulting to code path (safe fallback)',
    };
  }
}

/**
 * Main entry point: Decide whether goal should use skill or code path.
 *
 * Retry-aware: If a goal has previously failed on a specific path,
 * we avoid sending it down the same path again (breaks timeout loops).
 */
export async function decideRoute(goal: Goal): Promise<RouteDecision> {
  logger.info('route-decision', `Deciding route for goal: ${goal.id} — ${goal.description}`);

  // Retry loop prevention: if last attempt failed on a specific path, avoid it
  if (goal.failCount && goal.failCount > 0 && goal.lastFailedPath) {
    const avoidPath = goal.lastFailedPath;
    logger.info('route-decision', `Retry #${goal.failCount}: last failed on "${avoidPath}" path, will avoid it`);

    // Try pattern-based first
    const patternResult = classifyByPatterns(goal.description);
    if (patternResult && patternResult.path !== avoidPath) {
      logger.info('route-decision', `Fast path decision: ${patternResult.path} (retry-safe)`);
      return patternResult;
    }

    // If pattern result matches the failed path, or no pattern match — force code path
    // Code path is the safest fallback: it runs locally with full validation pipeline
    if (!patternResult || patternResult.path === avoidPath) {
      const fallback: RouteDecision = {
        path: avoidPath === 'code' ? 'skill' : 'code',
        confidence: 0.8,
        reason: `Retry fallback: previous attempt failed on "${avoidPath}" path, switching to "${avoidPath === 'code' ? 'skill' : 'code'}" path`,
      };
      logger.info('route-decision', `Retry fallback: ${fallback.path} (avoiding ${avoidPath})`);
      return fallback;
    }
  }

  // Try pattern-based fast path first
  const patternResult = classifyByPatterns(goal.description);
  if (patternResult) {
    logger.info('route-decision', `Fast path decision: ${patternResult.path} (${patternResult.confidence})`);
    return patternResult;
  }

  // Ambiguous — use LLM classifier
  const llmResult = await classifyByLLM(goal.description);
  return llmResult;
}

/**
 * Check if a goal should skip code evolution and use skill creation instead.
 * Called in pipeline.ts before stepClaudeExec.
 */
export async function shouldUseSkillPath(goal: Goal): Promise<boolean> {
  const decision = await decideRoute(goal);
  return decision.path === 'skill' && decision.confidence > 0.6;
}

/**
 * Check if a goal should be dispatched to the research agent instead of code evolution.
 * Research goals need web search + source synthesis, not code changes.
 */
export async function shouldUseResearchPath(goal: Goal): Promise<boolean> {
  const decision = await decideRoute(goal);
  return decision.path === 'research' && decision.confidence > 0.6;
}
