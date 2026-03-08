/**
 * Knowledge Lifecycle — Phase 3 self-maintenance.
 *
 * Runs once daily via worker-scheduler's budget optimization tick:
 *   1. Auto-archive stale LOW/MEDIUM entries (90 days without a query hit)
 *   2. Merge duplicate entries (same category + Jaccard tag similarity > 0.6)
 *   3. Flag high-frequency HIGH/CRITICAL entries as skill promotion candidates
 *
 * HIGH/CRITICAL entries are never auto-archived — manual only via archiveEntry().
 * Promotion candidates are logged but not acted upon; CTO/pm decides.
 */

import { logger } from '../../core/logger.js';
import {
  loadIndex,
  saveIndex,
  archiveEntry,
  type KnowledgeIndexEntry,
} from './knowledge-base.js';

// ── Result Type ───────────────────────────────────────────────────────

export interface ReviewResult {
  archived: string[];              // entry IDs that were archived
  merged: string[];                // entry IDs marked as superseded
  promotionCandidates: string[];   // entry IDs suggested for skill promotion
  internalized: string[];           // entry IDs successfully internalized into agent prompts
  skipped: number;                 // entries with no action needed
}

// ── Constants ─────────────────────────────────────────────────────────

const STALE_DAYS = 90;
const PROMOTION_MIN_HIT_COUNT = 10;
const PROMOTION_MIN_AGE_DAYS = 14;
const JACCARD_THRESHOLD = 0.6;

// ── Helpers ───────────────────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersectionSize = [...setA].filter(t => setB.has(t)).length;
  const unionSize = new Set([...a, ...b]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// ── Rule 1: Auto-Archive ──────────────────────────────────────────────

export function shouldAutoArchive(entry: KnowledgeIndexEntry, now: Date): boolean {
  // HIGH/CRITICAL entries are never auto-archived — manual only
  if (entry.severity === 'HIGH' || entry.severity === 'CRITICAL') return false;

  // Internalized entries are actively in use in systemPrompts — never auto-archive
  if (entry.status === 'internalized') return false;

  if (!entry.lastHitAt) {
    // Never queried — archive if created more than STALE_DAYS ago
    const age = daysBetween(new Date(entry.date), now);
    return age > STALE_DAYS;
  }

  // Has been queried — archive if last hit was more than STALE_DAYS ago
  const daysSinceHit = daysBetween(new Date(entry.lastHitAt), now);
  return daysSinceHit > STALE_DAYS;
}

// ── Rule 2: Duplicate Detection ───────────────────────────────────────

export function findDuplicates(
  entries: KnowledgeIndexEntry[],
): Array<[newer: string, older: string]> {
  const pairs: Array<[string, string]> = [];
  const active = entries.filter(e => e.status === 'active');

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;

      if (a.category !== b.category) continue;

      const similarity = jaccardSimilarity(a.tags, b.tags);
      if (similarity <= JACCARD_THRESHOLD) continue;

      // Keep newer (by date string), supersede older
      const newer = a.date >= b.date ? a : b;
      const older = a.date >= b.date ? b : a;
      pairs.push([newer.id, older.id]);
    }
  }

  return pairs;
}

// ── Rule 3: Promotion Candidates ──────────────────────────────────────

function isPromotionCandidate(entry: KnowledgeIndexEntry, now: Date): boolean {
  if ((entry.hitCount ?? 0) < PROMOTION_MIN_HIT_COUNT) return false;
  if (entry.severity !== 'HIGH' && entry.severity !== 'CRITICAL') return false;
  const age = daysBetween(new Date(entry.date), now);
  return age > PROMOTION_MIN_AGE_DAYS;
}

// ── Main Review Function ───────────────────────────────────────────────

/**
 * Daily knowledge base review — archive stale entries, merge duplicates,
 * flag high-frequency entries for skill promotion.
 * Called by worker-scheduler's daily budget optimization tick.
 */
export async function reviewKnowledgeBase(): Promise<ReviewResult> {
  const now = new Date();
  const result: ReviewResult = {
    archived: [],
    merged: [],
    promotionCandidates: [],
    internalized: [],
    skipped: 0,
  };

  // Snapshot of active entries at review start (for skipped count)
  const initialIndex = await loadIndex();
  const initialActiveCount = initialIndex.entries.filter(e => e.status === 'active').length;

  // ── Phase 1: Auto-archive stale LOW/MEDIUM entries ────────────────
  for (const entry of initialIndex.entries.filter(e => e.status === 'active')) {
    if (shouldAutoArchive(entry, now)) {
      const archiveResult = await archiveEntry(entry.id, 'auto-archive: stale (90d)');
      if (archiveResult.archived) {
        result.archived.push(entry.id);
      }
    }
  }

  // ── Phase 2: Merge duplicates ─────────────────────────────────────
  // Reload after archives so we only see current active entries
  const postArchiveIndex = await loadIndex();
  const duplicatePairs = findDuplicates(postArchiveIndex.entries);
  let phase2Modified = false;

  if (duplicatePairs.length > 0) {
    const supersededInBatch = new Set<string>();

    for (const [newerId, olderId] of duplicatePairs) {
      // Skip if either entry was already processed in this batch
      if (supersededInBatch.has(olderId) || supersededInBatch.has(newerId)) continue;

      const newer = postArchiveIndex.entries.find(e => e.id === newerId);
      const older = postArchiveIndex.entries.find(e => e.id === olderId);

      if (!newer || !older) continue;
      if (newer.status !== 'active' || older.status !== 'active') continue;

      // Merge older's unique tags into newer (cap at 10)
      newer.tags = [...new Set([...newer.tags, ...older.tags])].slice(0, 10);

      // Merge older's relatedAgents into newer
      newer.relatedAgents = [...new Set([...newer.relatedAgents, ...older.relatedAgents])];

      // Mark older as superseded
      older.status = 'superseded';
      older.supersededBy = newerId;

      supersededInBatch.add(olderId);
      result.merged.push(olderId);
    }

    if (supersededInBatch.size > 0) {
      await saveIndex(postArchiveIndex);
      phase2Modified = true;
      for (const id of supersededInBatch) {
        await logger.info('KnowledgeLifecycle', `Merged duplicate: ${id} → superseded`);
      }
    }
  }

  // ── Phase 3: Flag skill promotion candidates ──────────────────────
  // Reuse index if Phase 2 didn't save, otherwise reload
  const phase3Index = phase2Modified ? await loadIndex() : postArchiveIndex;
  for (const entry of phase3Index.entries.filter(e => e.status === 'active')) {
    if (isPromotionCandidate(entry, now)) {
      result.promotionCandidates.push(entry.id);
      await logger.info(
        'KnowledgeLifecycle',
        `Skill promotion candidate: ${entry.id} "${entry.title}" ` +
          `(hits=${entry.hitCount}, severity=${entry.severity}, ` +
          `age=${daysBetween(new Date(entry.date), now)}d)`,
      );
    }
  }

  // ── Phase 4: Auto-internalize promotion candidates ──────────────
  result.internalized = [];
  if (result.promotionCandidates.length > 0) {
    try {
      const { internalizePromotionCandidates } = await import('./prompt-optimizer.js');
      const internalizeResult = await internalizePromotionCandidates(result.promotionCandidates);
      result.internalized = internalizeResult.internalized;
    } catch (e) {
      await logger.warn('KnowledgeLifecycle', `Phase 4 internalization failed: ${(e as Error).message}`);
    }
  }

  result.skipped = Math.max(
    0,
    initialActiveCount - result.archived.length - result.merged.length,
  );

  return result;
}
