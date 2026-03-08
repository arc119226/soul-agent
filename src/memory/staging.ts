/**
 * Memory Staging — buffer zone for new insights, patterns, and reflections.
 *
 * New knowledge enters staging/ with a TTL. On expiry the item is either
 * promoted to permanent memory or silently dropped. This prevents hasty
 * conclusions from becoming "true memory" immediately.
 *
 * Lifecycle:
 *   stage() → staging/.ttl-index.json
 *           ↓  (heartbeat tick)
 *   checkExpired() → review each expired item
 *           ↓
 *   promote() → learning-tracker.addInsight()
 *       or
 *   reject() → archived in staging/.ttl-index.json (status: 'rejected')
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { randomUUID } from 'node:crypto';

/* ── paths ─────────────────────────────────── */
const STAGING_DIR = join(process.cwd(), 'soul', 'staging');
const INDEX_PATH = join(STAGING_DIR, '.ttl-index.json');

/* ── types ─────────────────────────────────── */
export type StagingCategory = 'insight' | 'pattern' | 'reflection';
export type StagingStatus = 'pending' | 'promoted' | 'rejected';

export interface StagingEntry {
  id: string;
  category: StagingCategory;
  content: string;
  status: StagingStatus;
  createdAt: string;
  expiresAt: string;
  /** How many times this content was referenced while in staging */
  referenceCount: number;
  /** Optional source context (e.g. which module created it) */
  source?: string;
  /** Set when promoted or rejected */
  resolvedAt?: string;
}

interface StagingIndex {
  version: number;
  entries: StagingEntry[];
}

/* ── default TTLs (hours) ──────────────────── */
const DEFAULT_TTL: Record<StagingCategory, number> = {
  insight: 72,
  pattern: 48,
  reflection: 24,
};

/* ── in-memory cache ───────────────────────── */
let indexCache: StagingIndex | null = null;

/* ── load / persist ────────────────────────── */
async function loadIndex(): Promise<StagingIndex> {
  if (indexCache) return indexCache;
  try {
    const raw = await readFile(INDEX_PATH, 'utf-8');
    indexCache = JSON.parse(raw) as StagingIndex;
  } catch {
    indexCache = { version: 1, entries: [] };
  }
  return indexCache;
}

function persistIndex(): void {
  if (!indexCache) return;
  writer.schedule(INDEX_PATH, indexCache);
}

/* ── public API ────────────────────────────── */

/**
 * Stage a new piece of knowledge. It will remain in the buffer until its
 * TTL expires, at which point `checkExpired()` decides its fate.
 */
export async function stage(
  category: StagingCategory,
  content: string,
  opts?: { ttlHours?: number; source?: string },
): Promise<string> {
  const idx = await loadIndex();
  const ttlHours = opts?.ttlHours ?? DEFAULT_TTL[category];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  // Dedup: if identical content already staged and pending, skip
  const existing = idx.entries.find(
    (e) => e.status === 'pending' && e.content === content,
  );
  if (existing) {
    existing.referenceCount++;
    persistIndex();
    await logger.debug('Staging', `Duplicate staged content referenced again: ${existing.id}`);
    return existing.id;
  }

  const entry: StagingEntry = {
    id: randomUUID().slice(0, 8),
    category,
    content,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    referenceCount: 0,
    source: opts?.source,
  };

  idx.entries.push(entry);
  persistIndex();

  await logger.info(
    'Staging',
    `Staged [${category}] id=${entry.id}, TTL=${ttlHours}h: ${content.slice(0, 80)}`,
  );

  return entry.id;
}

/**
 * Bump the reference count of a staged item — signals that the knowledge
 * has been used / cited, making promotion more likely.
 */
export async function reference(id: string): Promise<boolean> {
  const idx = await loadIndex();
  const entry = idx.entries.find((e) => e.id === id && e.status === 'pending');
  if (!entry) return false;
  entry.referenceCount++;
  persistIndex();
  return true;
}

/**
 * Scan for expired items and decide their fate.
 * Called by heartbeat on every tick.
 */
export async function checkExpired(): Promise<{
  promoted: number;
  rejected: number;
}> {
  const idx = await loadIndex();
  const now = Date.now();
  let promoted = 0;
  let rejected = 0;

  for (const entry of idx.entries) {
    if (entry.status !== 'pending') continue;
    if (new Date(entry.expiresAt).getTime() > now) continue;

    // TTL expired — decide fate
    const verdict = review(entry);

    if (verdict === 'promote') {
      await promote(entry);
      promoted++;
    } else {
      reject(entry);
      rejected++;
    }
  }

  if (promoted > 0 || rejected > 0) {
    // Compact: keep only last 200 resolved entries
    compactResolved(idx);
    persistIndex();
    await logger.info(
      'Staging',
      `Expiry sweep: promoted=${promoted}, rejected=${rejected}`,
    );
  }

  return { promoted, rejected };
}

/**
 * Review a staging entry to decide whether to promote or reject.
 *
 * Promotion heuristics:
 * - referenceCount > 0  → content was used, likely valuable
 * - insight category    → lower bar (subjective, worth keeping)
 * - pattern category    → needs at least 1 reference
 * - reflection category → always promote (personal, low risk)
 */
function review(entry: StagingEntry): 'promote' | 'reject' {
  // Reflections are always personal — keep them
  if (entry.category === 'reflection') return 'promote';

  // Insights with any reference → promote
  if (entry.category === 'insight' && entry.referenceCount >= 0) return 'promote';

  // Patterns need evidence
  if (entry.category === 'pattern' && entry.referenceCount >= 1) return 'promote';

  // Default: reject patterns with zero references
  return 'reject';
}

/**
 * Promote a staging entry to permanent memory.
 */
async function promote(entry: StagingEntry): Promise<void> {
  entry.status = 'promoted';
  entry.resolvedAt = new Date().toISOString();

  // Write to permanent memory
  try {
    const { addInsightDirect } = await import(
      '../metacognition/learning-tracker.js'
    );
    await addInsightDirect(entry.content);
  } catch {
    // Fallback: direct import might not expose addInsightDirect yet
    // In that case, use the existing addInsight
    try {
      const { addInsight } = await import(
        '../metacognition/learning-tracker.js'
      );
      await addInsight(entry.content);
    } catch (err) {
      await logger.error('Staging', `Failed to promote entry ${entry.id}`, err);
      // Revert status so we retry next tick
      entry.status = 'pending';
      entry.expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // retry in 5min
      return;
    }
  }

  await eventBus.emit('staging:promoted', {
    id: entry.id,
    category: entry.category,
    content: entry.content,
  });

  await logger.info(
    'Staging',
    `Promoted [${entry.category}] ${entry.id}: ${entry.content.slice(0, 60)}`,
  );
}

/**
 * Reject a staging entry (keep in index for audit, mark as rejected).
 */
function reject(entry: StagingEntry): void {
  entry.status = 'rejected';
  entry.resolvedAt = new Date().toISOString();
}

/**
 * Remove old resolved entries to keep index lean.
 * Keeps at most 200 resolved (promoted + rejected) entries.
 */
function compactResolved(idx: StagingIndex): void {
  const resolved = idx.entries.filter((e) => e.status !== 'pending');
  if (resolved.length <= 200) return;

  // Sort by resolvedAt, keep newest 150
  resolved.sort(
    (a, b) =>
      new Date(b.resolvedAt ?? 0).getTime() -
      new Date(a.resolvedAt ?? 0).getTime(),
  );
  const keep = new Set(resolved.slice(0, 150).map((e) => e.id));
  const pending = idx.entries.filter((e) => e.status === 'pending');
  const kept = idx.entries.filter(
    (e) => e.status !== 'pending' && keep.has(e.id),
  );
  idx.entries = [...pending, ...kept];
}

/* ── query helpers ─────────────────────────── */

/** Get all pending entries (useful for context-weaver to inject staged knowledge). */
export async function getPending(): Promise<StagingEntry[]> {
  const idx = await loadIndex();
  return idx.entries.filter((e) => e.status === 'pending');
}

/** Get staging stats for status/debug display. */
export async function getStats(): Promise<{
  pending: number;
  promoted: number;
  rejected: number;
  total: number;
}> {
  const idx = await loadIndex();
  const pending = idx.entries.filter((e) => e.status === 'pending').length;
  const promoted = idx.entries.filter((e) => e.status === 'promoted').length;
  const rejected = idx.entries.filter((e) => e.status === 'rejected').length;
  return { pending, promoted, rejected, total: idx.entries.length };
}

/** Reset in-memory cache (for testing). */
export function resetCache(): void {
  indexCache = null;
}
