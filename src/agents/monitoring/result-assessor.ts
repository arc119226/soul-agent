/**
 * Result Assessor — dual-layer result quality evaluation.
 *
 * Layer 1: Fast heuristic (free) — existing text analysis
 * Layer 2: LLM Judge (Haiku) — triggered for costly or unreliable agents
 *
 * The LLM Judge evaluates on five dimensions:
 *   - relevance: Does the output address the prompt?
 *   - completeness: Is the response thorough?
 *   - accuracy: Are claims supported?
 *   - structure: Is the output well-organized?
 *   - actionability: Can someone act on this? Does it produce real user value?
 */

import { logger } from '../../core/logger.js';
import { config } from '../../config.js';

// ── Types ────────────────────────────────────────────────────────────

export interface AssessmentResult {
  confidence: number; // 0-1, final score
  method: 'heuristic' | 'llm-judge';
  dimensions?: {
    relevance: number;
    completeness: number;
    accuracy: number;
    structure: number;
    actionability: number;
  };
  reason?: string;
}

// ── Thresholds ───────────────────────────────────────────────────────

const LLM_JUDGE_COST_THRESHOLD = 0.10;  // $0.10 — trigger judge for costly tasks
const LLM_JUDGE_FAILURE_THRESHOLD = 2;  // trigger judge for unreliable agents

/**
 * Dedicated channel ID for the LLM Judge.
 * Separate from real user IDs (positive) and worker IDs (-1 through -8).
 */
const JUDGE_CHANNEL_ID = 0;

// ── Heuristic Scoring Constants ──────────────────────────────────────

const HEURISTIC = {
  MIN_LENGTH: 20,
  ERROR_SCORE: 0.1,
  BASE_SCORE: 0.1,
  SHORT_THRESHOLD: 100,
  SHORT_MAX: 0.15,
  NEGATIVE_PENALTY: -0.1,
  ERROR_WORD_PENALTY: -0.05,
  MARKER_BONUS: 0.07,
  MARKER_CAP: 0.25,
  NO_MARKER_PENALTY: -0.05,
  LEN_200_BONUS: 0.1,
  LEN_500_BONUS: 0.1,
  LEN_1500_BONUS: 0.1,
  IMPORTANCE_FACTOR: 0.02,
  SOURCE_BONUS: 0.1,
  MIN_SCORE: 0.05,
} as const;

// ── LLM Judge Dimension Weights ──────────────────────────────────────

const JUDGE_WEIGHTS = {
  RELEVANCE: 0.25,
  COMPLETENESS: 0.2,
  ACCURACY: 0.25,
  STRUCTURE: 0.1,
  ACTIONABILITY: 0.2,  // Does it produce value for users or the project?
} as const;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Assess result quality using dual-layer evaluation.
 * Falls back to heuristic if LLM Judge fails.
 */
export async function assessResult(
  result: string,
  prompt: string,
  taskCostUsd: number,
  agentFailureCount7d: number,
): Promise<AssessmentResult> {
  // Always compute heuristic first (free, fast)
  const heuristicScore = assessHeuristic(result);

  // Decide whether to invoke LLM Judge
  const shouldJudge = taskCostUsd > LLM_JUDGE_COST_THRESHOLD ||
                      agentFailureCount7d >= LLM_JUDGE_FAILURE_THRESHOLD;

  if (!shouldJudge) {
    return { confidence: heuristicScore, method: 'heuristic' };
  }

  // Try LLM Judge
  try {
    const llmResult = await invokeLlmJudge(result, prompt);
    if (llmResult) return llmResult;
  } catch (err) {
    await logger.debug('ResultAssessor',
      `LLM Judge failed, falling back to heuristic: ${(err as Error).message}`);
  }

  // Fallback to heuristic
  return { confidence: heuristicScore, method: 'heuristic' };
}

// ── Heuristic Assessment ─────────────────────────────────────────────

/**
 * Fast heuristic assessment (extracted from original assessResultConfidence).
 * No external API calls. Cost: $0.
 */
export function assessHeuristic(result: string): number {
  if (!result || result.length < HEURISTIC.MIN_LENGTH) return HEURISTIC.MIN_SCORE;

  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.is_error === true || parsed.subtype === 'error_max_turns') {
        return HEURISTIC.ERROR_SCORE;
      }
    } catch { /* not JSON */ }
  }

  let score = HEURISTIC.BASE_SCORE;

  if (result.length < HEURISTIC.SHORT_THRESHOLD) return Math.min(score, HEURISTIC.SHORT_MAX);

  const negativePatterns = [/I don't have/i, /I can't/i, /I cannot/i, /無法完成/, /找不到/];
  if (negativePatterns.some(p => p.test(result))) score += HEURISTIC.NEGATIVE_PENALTY;
  if (/\berror\b/i.test(result) || /\bfailed\b/i.test(result)) score += HEURISTIC.ERROR_WORD_PENALTY;

  const markers = ['##', '###', '---', '發現', '結論', '重要性', '延伸問題', 'Sources'];
  const found = markers.filter((m) => result.includes(m));
  score += Math.min(found.length * HEURISTIC.MARKER_BONUS, HEURISTIC.MARKER_CAP);

  if (found.length === 0) score += HEURISTIC.NO_MARKER_PENALTY;

  if (result.length > 200) score += HEURISTIC.LEN_200_BONUS;
  if (result.length > 500) score += HEURISTIC.LEN_500_BONUS;
  if (result.length > 1500) score += HEURISTIC.LEN_1500_BONUS;

  const importanceMatch = result.match(/重要性[：:]\s*(\d)\/5/);
  if (importanceMatch) {
    const importance = parseInt(importanceMatch[1]!, 10);
    score += importance * HEURISTIC.IMPORTANCE_FACTOR;
  }

  if (result.includes('http') || result.includes('來源')) {
    score += HEURISTIC.SOURCE_BONUS;
  }

  return Math.max(Math.min(score, 1.0), HEURISTIC.MIN_SCORE);
}

// ── LLM Judge ────────────────────────────────────────────────────────

async function invokeLlmJudge(
  result: string,
  prompt: string,
): Promise<AssessmentResult | null> {
  const { askClaudeCode, LIGHTWEIGHT_CWD } = await import('../../claude/claude-code.js');

  const judgePrompt = `You are a quality assessor. Evaluate this agent output on five dimensions (0.0-1.0 each).

## Original Task
${prompt.slice(0, 500)}

## Agent Output (first 2000 chars)
${result.slice(0, 2000)}

## Dimensions
- relevance: Does the output address the prompt?
- completeness: Is the response thorough?
- accuracy: Are claims supported and correct?
- structure: Is the output well-organized?
- actionability: Can someone ACT on this output? Does it produce value for real users or improve the project? Score LOW if the output is self-referential (e.g. "how to verify my own identity") or purely theoretical with no practical application.

## Respond in EXACTLY this JSON format (no other text):
{"relevance":0.0,"completeness":0.0,"accuracy":0.0,"structure":0.0,"actionability":0.0,"reason":"brief explanation"}`;

  // Use a dedicated worker channel (-9 style approach — use userId 0 for judge)
  const judgeResult = await askClaudeCode(judgePrompt, JUDGE_CHANNEL_ID, {
    model: config.MODEL_TIER_HAIKU,
    maxTurns: 1,
    timeout: 30_000,
    skipResume: true,
    cwd: LIGHTWEIGHT_CWD,
    systemPrompt: 'You are a concise JSON evaluator. Only output valid JSON, no markdown or explanations.',
  });

  if (!judgeResult.ok) return null;

  // Parse the JSON response
  const text = judgeResult.value.result.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      relevance?: number;
      completeness?: number;
      accuracy?: number;
      structure?: number;
      actionability?: number;
      reason?: string;
    };

    const dims = {
      relevance: clamp(parsed.relevance ?? 0.5),
      completeness: clamp(parsed.completeness ?? 0.5),
      accuracy: clamp(parsed.accuracy ?? 0.5),
      structure: clamp(parsed.structure ?? 0.5),
      actionability: clamp(parsed.actionability ?? 0.3), // Default low — must earn it
    };

    // Weighted average
    const confidence = dims.relevance * JUDGE_WEIGHTS.RELEVANCE +
                       dims.completeness * JUDGE_WEIGHTS.COMPLETENESS +
                       dims.accuracy * JUDGE_WEIGHTS.ACCURACY +
                       dims.structure * JUDGE_WEIGHTS.STRUCTURE +
                       dims.actionability * JUDGE_WEIGHTS.ACTIONABILITY;

    return {
      confidence: clamp(confidence),
      method: 'llm-judge',
      dimensions: dims,
      reason: parsed.reason?.slice(0, 200),
    };
  } catch {
    return null;
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}
