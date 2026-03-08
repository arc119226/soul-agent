/**
 * Conventional Commit message generator for evolution pipeline.
 * Format: type(evolution): description
 */

import type { Goal } from './goals.js';

type CommitType = 'feat' | 'fix' | 'refactor' | 'docs' | 'test';

/** Infer conventional commit type from goal metadata */
function inferCommitType(goal: Goal): CommitType {
  const tags = goal.tags.map((t) => t.toLowerCase());
  const desc = goal.description.toLowerCase();

  // Priority-ordered matching
  if (tags.some((t) => t === 'bug' || t === 'fix')) return 'fix';
  if (tags.some((t) => t === 'feature' || t === 'new')) return 'feat';
  if (tags.some((t) => t === 'refactor')) return 'refactor';
  if (tags.some((t) => t === 'docs')) return 'docs';
  if (tags.some((t) => t === 'test')) return 'test';
  if (desc.includes('refactor') || desc.includes('重構')) return 'refactor';

  return 'feat';
}

/** Build a conventional commit message from goal context */
export function buildConventionalCommitMessage(
  goal: Goal,
  complexity: string,
  claudeMdUpdated: boolean,
): string {
  const type = inferCommitType(goal);

  // Keep subject line concise (max ~72 chars after type prefix)
  const subject = goal.description.length > 60
    ? goal.description.slice(0, 57) + '...'
    : goal.description;

  const headline = `${type}(evolution): ${subject}`;

  // High complexity or CLAUDE.md updated → add body
  const isHighComplexity = complexity === 'high';
  if (isHighComplexity || claudeMdUpdated) {
    const bodyLines: string[] = [];
    bodyLines.push(`Goal: ${goal.id}`);
    bodyLines.push(`Complexity: ${complexity}`);
    if (claudeMdUpdated) {
      bodyLines.push('CLAUDE.md: auto-synced');
    }
    return `${headline}\n\n${bodyLines.join('\n')}`;
  }

  return headline;
}
