/**
 * Pattern learning — track successes and failures to identify patterns.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';

const PATTERNS_PATH = join(process.cwd(), 'soul', 'learning-patterns.json');

export interface PatternRecord {
  category: string;
  details: string;
  timestamp: string;
}

interface PatternsFile {
  version: number;
  patterns: {
    successes: PatternRecord[];
    failures: PatternRecord[];
    insights: string[];
  };
}

let patternsData: PatternsFile | null = null;

async function load(): Promise<PatternsFile> {
  if (patternsData) return patternsData;
  try {
    const raw = await readFile(PATTERNS_PATH, 'utf-8');
    patternsData = JSON.parse(raw) as PatternsFile;
  } catch {
    patternsData = {
      version: 1,
      patterns: { successes: [], failures: [], insights: [] },
    };
  }
  return patternsData;
}

function persist(): void {
  if (!patternsData) return;
  writer.schedule(PATTERNS_PATH, patternsData);
}

const MAX_RECORDS = 200;

export async function recordSuccess(category: string, details: string): Promise<void> {
  const data = await load();
  data.patterns.successes.push({
    category,
    details,
    timestamp: new Date().toISOString(),
  });

  // Cap records
  while (data.patterns.successes.length > MAX_RECORDS) {
    data.patterns.successes.shift();
  }

  // Auto-generate insight on milestones
  const categoryCount = data.patterns.successes.filter(
    (s) => s.category === category,
  ).length;
  if (categoryCount % 10 === 0) {
    const insight = `在「${category}」方面已累積 ${categoryCount} 次成功經驗。`;
    if (!data.patterns.insights.includes(insight)) {
      data.patterns.insights.push(insight);
    }
  }

  persist();
  await logger.debug('LearningTracker', `Success: [${category}] ${details}`);
}

export async function recordFailure(category: string, details: string): Promise<void> {
  const data = await load();
  data.patterns.failures.push({
    category,
    details,
    timestamp: new Date().toISOString(),
  });

  // Cap records
  while (data.patterns.failures.length > MAX_RECORDS) {
    data.patterns.failures.shift();
  }

  // Check for repeated failures
  const recentFailures = data.patterns.failures
    .filter((f) => f.category === category)
    .slice(-5);
  if (recentFailures.length >= 3) {
    const insight = `在「${category}」方面連續出現失敗，需要調整方法。`;
    if (!data.patterns.insights.includes(insight)) {
      data.patterns.insights.push(insight);
      await logger.warn('LearningTracker', insight);
    }
  }

  persist();
  await logger.debug('LearningTracker', `Failure: [${category}] ${details}`);
}

/**
 * Add an insight via the staging buffer.
 * The insight will be held in staging/ for its TTL period before
 * being promoted to permanent memory. This prevents hasty conclusions
 * from becoming "true memory" immediately.
 */
export async function addInsight(insight: string, source?: string): Promise<void> {
  // Dedup check: don't stage if already in permanent memory
  const data = await load();
  if (data.patterns.insights.includes(insight)) return;

  try {
    const { stage } = await import('../memory/staging.js');
    await stage('insight', insight, { source });
  } catch {
    // Fallback: if staging module unavailable, write directly
    await addInsightDirect(insight);
  }
}

/**
 * Write an insight directly to permanent memory (bypass staging).
 * Used by: staging.ts promote(), and as fallback when staging is unavailable.
 */
export async function addInsightDirect(insight: string): Promise<void> {
  const data = await load();
  if (data.patterns.insights.includes(insight)) return;
  data.patterns.insights.push(insight);

  // Cap insights
  while (data.patterns.insights.length > 100) {
    data.patterns.insights.shift();
  }

  persist();
}

export async function getPatterns(): Promise<{
  successes: PatternRecord[];
  failures: PatternRecord[];
  insights: string[];
}> {
  const data = await load();
  return { ...data.patterns };
}

export async function getPatternsByCategory(category: string): Promise<{
  successes: PatternRecord[];
  failures: PatternRecord[];
  successRate: number;
}> {
  const data = await load();
  const successes = data.patterns.successes.filter((s) => s.category === category);
  const failures = data.patterns.failures.filter((f) => f.category === category);
  const total = successes.length + failures.length;
  return {
    successes,
    failures,
    successRate: total > 0 ? successes.length / total : 0,
  };
}

/**
 * Compact old patterns by summarizing them into insights.
 * Keeps only the most recent 30 records per category when totals exceed 50.
 * Returns the number of records compacted.
 */
export async function compactPatterns(): Promise<number> {
  const data = await load();
  let compacted = 0;

  // Compact successes
  if (data.patterns.successes.length > 50) {
    const byCategory = new Map<string, number>();
    for (const s of data.patterns.successes) {
      byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1);
    }

    // Generate summary insights for compacted categories
    for (const [category, count] of byCategory) {
      if (count > 10) {
        const insight = `學習摘要：在「${category}」方面累積了 ${count} 次成功經驗（已壓縮）`;
        if (!data.patterns.insights.includes(insight)) {
          data.patterns.insights.push(insight);
        }
      }
    }

    // Keep only the most recent 30
    const removed = data.patterns.successes.length - 30;
    data.patterns.successes = data.patterns.successes.slice(-30);
    compacted += removed;
  }

  // Compact failures
  if (data.patterns.failures.length > 50) {
    const byCategory = new Map<string, number>();
    for (const f of data.patterns.failures) {
      byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
    }

    for (const [category, count] of byCategory) {
      if (count > 5) {
        const insight = `學習摘要：在「${category}」方面遇到了 ${count} 次失敗，需要特別注意（已壓縮）`;
        if (!data.patterns.insights.includes(insight)) {
          data.patterns.insights.push(insight);
        }
      }
    }

    const removed = data.patterns.failures.length - 30;
    data.patterns.failures = data.patterns.failures.slice(-30);
    compacted += removed;
  }

  // Cap insights too
  if (data.patterns.insights.length > 100) {
    data.patterns.insights = data.patterns.insights.slice(-80);
  }

  if (compacted > 0) {
    persist();
    await logger.info('LearningTracker', `Compacted ${compacted} old pattern records into insights`);
  }

  return compacted;
}

export function resetCache(): void {
  patternsData = null;
}
