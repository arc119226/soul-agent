/**
 * Token-cost-aware retrieval scoring.
 * Scores memory items by relevance and selects within a token budget
 * using a greedy knapsack approach.
 */

export interface Scoreable {
  /** Estimated token cost of including this item */
  tokenCost: number;
  /** ISO timestamp of creation or last access */
  timestamp: string;
  /** Number of times accessed */
  accessCount: number;
  /** Importance rating 1-5 */
  importance: number;
  /** The content payload (opaque to scoring) */
  content: unknown;
}

export interface ScoredItem extends Scoreable {
  score: number;
}

const RECENCY_WEIGHT = 0.3;
const FREQUENCY_WEIGHT = 0.25;
const IMPORTANCE_WEIGHT = 0.45;

// Recency decays over 30 days
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

function computeRecency(timestamp: string): number {
  const age = Date.now() - new Date(timestamp).getTime();
  if (age <= 0) return 1;
  return Math.exp((-Math.LN2 * age) / RECENCY_HALF_LIFE_MS);
}

function computeFrequency(accessCount: number, maxAccess: number): number {
  if (maxAccess <= 0) return 0;
  return Math.min(accessCount / maxAccess, 1);
}

function computeImportance(importance: number): number {
  return Math.min(Math.max(importance, 1), 5) / 5;
}

export function scoreItem(item: Scoreable, maxAccess: number): number {
  const recency = computeRecency(item.timestamp);
  const frequency = computeFrequency(item.accessCount, maxAccess);
  const imp = computeImportance(item.importance);

  return (
    RECENCY_WEIGHT * recency +
    FREQUENCY_WEIGHT * frequency +
    IMPORTANCE_WEIGHT * imp
  );
}

/**
 * Select the most relevant items that fit within a token budget.
 * Uses greedy knapsack: sort by score/cost ratio, pick greedily.
 */
export function selectRelevantMemory(
  items: Scoreable[],
  budget: number,
): ScoredItem[] {
  if (items.length === 0) return [];

  const maxAccess = Math.max(...items.map((i) => i.accessCount), 1);

  const scored: ScoredItem[] = items.map((item) => ({
    ...item,
    score: scoreItem(item, maxAccess),
  }));

  // Sort by score-to-cost ratio (value density), descending
  scored.sort((a, b) => {
    const ratioA = a.tokenCost > 0 ? a.score / a.tokenCost : a.score;
    const ratioB = b.tokenCost > 0 ? b.score / b.tokenCost : b.score;
    return ratioB - ratioA;
  });

  const selected: ScoredItem[] = [];
  let remaining = budget;

  for (const item of scored) {
    if (item.tokenCost <= remaining) {
      selected.push(item);
      remaining -= item.tokenCost;
    }
    if (remaining <= 0) break;
  }

  // Return in score order (highest first)
  selected.sort((a, b) => b.score - a.score);
  return selected;
}

/** Rough token estimation: ~4 chars per token for CJK-heavy text */
export function estimateTokens(text: string): number {
  // CJK characters count ~2 tokens each, ASCII ~0.25 tokens per char
  let count = 0;
  for (const ch of text) {
    count += ch.charCodeAt(0) > 0x7f ? 2 : 0.25;
  }
  return Math.ceil(count);
}

/**
 * Quality-enhanced memory selection.
 * Wraps selectRelevantMemory with an additional quality dimension.
 * Falls back to basic selection if quality scoring fails.
 *
 * @param items - Scoreable items with optional contentText field
 * @param budget - Token budget
 * @returns Selected items sorted by adjusted score
 */
export async function selectQualityMemory(
  items: Array<Scoreable & { contentText?: string }>,
  budget: number,
): Promise<ScoredItem[]> {
  try {
    const { computeQualityScore, qualityAdjustedScore } = await import('./memory-quality.js');

    if (items.length === 0) return [];
    const maxAccess = Math.max(...items.map(i => i.accessCount), 1);

    // Extract text content for uniqueness scoring
    const contentTexts = items
      .map(i => i.contentText ?? (typeof i.content === 'string' ? i.content : ''))
      .filter(Boolean);

    const scored: ScoredItem[] = items.map((item, idx) => {
      const baseScore = scoreItem(item, maxAccess);
      const contentStr = item.contentText ?? (typeof item.content === 'string' ? item.content : '');

      // Quality score uses other items for uniqueness comparison
      const othersContent = contentTexts.filter((_, i) => i !== idx);
      const quality = computeQualityScore(contentStr, othersContent);
      const adjustedScore = qualityAdjustedScore(baseScore, quality.composite);

      return { ...item, score: adjustedScore };
    });

    // Same greedy knapsack as original
    scored.sort((a, b) => {
      const ratioA = a.tokenCost > 0 ? a.score / a.tokenCost : a.score;
      const ratioB = b.tokenCost > 0 ? b.score / b.tokenCost : b.score;
      return ratioB - ratioA;
    });

    const selected: ScoredItem[] = [];
    let remaining = budget;
    for (const item of scored) {
      if (item.tokenCost <= remaining) {
        selected.push(item);
        remaining -= item.tokenCost;
      }
      if (remaining <= 0) break;
    }

    selected.sort((a, b) => b.score - a.score);
    return selected;
  } catch {
    // Fallback to basic selection
    return selectRelevantMemory(items, budget);
  }
}
