/**
 * JSONL evolution history — append-only changelog.
 * Stored at soul/evolution/changelog.jsonl.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';

const CHANGELOG_FILE = join(process.cwd(), 'soul', 'evolution', 'changelog.jsonl');

export interface ChangelogEntry {
  timestamp: string;
  goalId: string;
  description: string;
  filesChanged: string[];
  success: boolean;
  lessonsLearned: string;
}

/** Append a new entry to the changelog */
export async function appendChangelog(entry: Omit<ChangelogEntry, 'timestamp'>): Promise<void> {
  const full: ChangelogEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  try {
    await writer.appendJsonl(CHANGELOG_FILE, full);
    logger.info('changelog', `Recorded ${entry.success ? 'success' : 'failure'} for goal ${entry.goalId}`);
  } catch (err) {
    logger.error('changelog', 'Failed to append changelog entry', err);
  }
}

/** Get the last N changelog entries (newest first) */
export async function getRecentChanges(n: number = 10): Promise<ChangelogEntry[]> {
  try {
    const raw = await readFile(CHANGELOG_FILE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries: ChangelogEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    // Return newest first, limited to n
    return entries.reverse().slice(0, n);
  } catch {
    return [];
  }
}

/** Get all changelog entries for a specific goal */
export async function getChangesForGoal(goalId: string): Promise<ChangelogEntry[]> {
  const all = await getRecentChanges(1000);
  return all.filter((e) => e.goalId === goalId);
}

/** Get success rate from recent changes */
export async function getSuccessRate(lastN: number = 20): Promise<number> {
  const recent = await getRecentChanges(lastN);
  if (recent.length === 0) return 0;
  const successes = recent.filter((e) => e.success).length;
  return successes / recent.length;
}
