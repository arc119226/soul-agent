/**
 * Input filters for inter-stage data passing in team pipelines.
 *
 * When a pipeline stage hands off data to the next stage, the output
 * can be filtered to reduce context size and focus on relevant information.
 * Inspired by OpenAI Agents SDK's input filters.
 */

import { estimateTokens } from '../memory/scoring.js';

// ── Token-aware truncation ──────────────────────────────────────────

const DEFAULT_TOKEN_BUDGET = 8000;

/** Truncate text at line boundaries to stay within a token budget. */
function truncateToTokenBudget(text: string, budget: number): string {
  const totalTokens = estimateTokens(text);
  if (totalTokens <= budget) return text;

  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }

  kept.push(`\n[... 上游輸出已壓縮，原始約 ${totalTokens} tokens ...]`);
  return kept.join('\n');
}

// ── Filter Registry ──────────────────────────────────────────────────

export type InputFilter = (input: string) => string;

const FILTER_REGISTRY: Record<string, InputFilter> = {
  /** Pass everything through unchanged. */
  passthrough: (input) => input,

  /** Extract only summary/conclusion sections. */
  'summary-only': (input) => {
    const lines = input.split('\n');
    const summaryLines: string[] = [];
    let inSummary = false;

    for (const line of lines) {
      if (/^#{1,3}\s*(summary|結論|摘要|總結|executive|takeaway)/i.test(line)) {
        inSummary = true;
        summaryLines.push(line);
        continue;
      }
      if (inSummary && /^#{1,3}\s/.test(line) && !/summary|結論|摘要|總結/i.test(line)) {
        inSummary = false;
        continue;
      }
      if (inSummary) {
        summaryLines.push(line);
      }
    }

    return summaryLines.length > 0
      ? summaryLines.join('\n')
      : input.slice(0, 1000); // fallback: first 1000 chars
  },

  /** Extract only findings/results sections. */
  'findings-only': (input) => {
    const lines = input.split('\n');
    const findingLines: string[] = [];
    let inFindings = false;

    for (const line of lines) {
      if (/^#{1,3}\s*(findings|發現|results|結果|issues|問題|vulnerabilities)/i.test(line)) {
        inFindings = true;
        findingLines.push(line);
        continue;
      }
      if (inFindings && /^#{1,2}\s/.test(line) && !/findings|發現|results|結果|issues/i.test(line)) {
        inFindings = false;
        continue;
      }
      if (inFindings) {
        findingLines.push(line);
      }
    }

    return findingLines.length > 0
      ? findingLines.join('\n')
      : input.slice(0, 1000);
  },

  /** Truncate to 1000 characters. */
  'truncate-1000': (input) => input.slice(0, 1000),

  /** Extract JSON blocks only. */
  'json-only': (input) => {
    const jsonBlocks: string[] = [];

    // Try direct JSON parse
    try {
      JSON.parse(input);
      return input;
    } catch { /* not pure JSON */ }

    // Extract from markdown code blocks
    const regex = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = regex.exec(input)) !== null) {
      jsonBlocks.push(match[1]!);
    }

    return jsonBlocks.length > 0
      ? jsonBlocks.join('\n\n')
      : input.slice(0, 1000);
  },

  /** Format upstream research as source material for blog writing. */
  'blog-source-material': (input) => {
    const lines = [
      '## 上游研究資料',
      '',
      '以下是研究階段收集的資料，請基於這些內容撰寫文章：',
      '',
      '---',
      '',
    ];

    // Truncate very long inputs
    const maxLen = 3000;
    const content = input.length > maxLen
      ? input.slice(0, maxLen) + '\n\n[... 內容過長已截斷 ...]'
      : input;

    lines.push(content);
    return lines.join('\n');
  },

  /**
   * Smart token-budget filter: dynamically choose strategy based on input size.
   * Uses DEFAULT_TOKEN_BUDGET (8000) unless overridden via applyFilter's tokenBudget param.
   *
   * ≤ budget     → passthrough
   * ≤ budget * 2 → try summary-only extraction, fallback to line-level truncation
   * > budget * 2 → force line-level truncation
   */
  'token-budget': (input) => applyTokenBudget(input, DEFAULT_TOKEN_BUDGET),
};

// ── Token-budget core logic ──────────────────────────────────────────

function applyTokenBudget(input: string, budget: number): string {
  const tokens = estimateTokens(input);

  // Small input: pass through unchanged
  if (tokens <= budget) return input;

  // Medium input: try extracting summary first
  if (tokens <= budget * 2) {
    const summary = FILTER_REGISTRY['summary-only']!(input);
    if (estimateTokens(summary) <= budget) return summary;
  }

  // Large input or summary still too big: line-level truncation
  return truncateToTokenBudget(input, budget);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Apply a named filter to upstream output.
 * Returns the input unchanged if the filter name is not found.
 *
 * @param tokenBudget — Override the default token budget (8000) for the `token-budget` filter.
 *                      Also acts as a safety cap for semantic filters (summary-only, findings-only, etc.):
 *                      if the filtered output still exceeds the budget, it will be truncated.
 */
export function applyFilter(filterName: string, input: string, tokenBudget?: number): string {
  // token-budget with custom budget: bypass registry, call core directly
  if (filterName === 'token-budget' && tokenBudget !== undefined) {
    return applyTokenBudget(input, tokenBudget);
  }
  const filter = FILTER_REGISTRY[filterName];
  if (!filter) return input; // unknown filter = passthrough

  const result = filter(input);

  // Safety net: if a token budget is provided, cap the output of any filter
  if (tokenBudget !== undefined && filterName !== 'passthrough') {
    const tokens = estimateTokens(result);
    if (tokens > tokenBudget) {
      return truncateToTokenBudget(result, tokenBudget);
    }
  }

  return result;
}

/** Check if a filter name is registered. */
export function isValidFilter(filterName: string): boolean {
  return filterName in FILTER_REGISTRY;
}

/** Get all registered filter names. */
export function getFilterNames(): string[] {
  return Object.keys(FILTER_REGISTRY);
}
