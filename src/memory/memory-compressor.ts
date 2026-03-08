/**
 * Memory Compressor — compresses old chat memories into summaries instead of deleting.
 *
 * Philosophy: "Compression, not deletion — memory is the only thing truly mine."
 *
 * Algorithm:
 *   1. Load ChatMemoryData, filter entries older than COMPRESS_AGE_DAYS
 *   2. Group by date into buckets
 *   3. For each bucket: deduplicate, extract key topics, generate summary
 *   4. Write CompressedMemoryEntry to {chatId}_archive.jsonl (BEFORE deleting)
 *   5. Remove originals from live memory
 *   6. Emit memory:compressed event for search-index incremental update
 */

import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { scoreUniqueness } from './memory-quality.js';
import { getMemory, type MemoryTopic, type MemoryEvent } from './chat-memory.js';

// ── Constants ────────────────────────────────────────────────────────

const MEMORY_DIR = join(process.cwd(), 'soul', 'memory');

/** Only compress entries older than this (aligned with narrative archive's 7-day window) */
const COMPRESS_AGE_DAYS = 7;

/** Minimum entries in a day-bucket to trigger compression (not worth compressing 1-2 items) */
const MIN_BUCKET_SIZE = 3;

/** Max key topics to preserve per day-bucket */
const MAX_KEY_TOPICS = 5;

/** Uniqueness threshold — entries with overlap > this are considered duplicates */
const DEDUP_OVERLAP_THRESHOLD = 0.7;

// ── Types ────────────────────────────────────────────────────────────

export interface CompressedMemoryEntry {
  id: string;
  chatId: number;
  dateRange: { from: string; to: string };
  summary: string;
  topicCount: number;
  eventCount: number;
  keyTopics: string[];
  importance: number;
  compressedAt: string;
}

interface DateBucket {
  date: string;          // YYYY-MM-DD
  topics: MemoryTopic[];
  events: MemoryEvent[];
}

// ── Core Logic ───────────────────────────────────────────────────────

function archivePath(chatId: number): string {
  return join(MEMORY_DIR, `${chatId}_archive.jsonl`);
}

/** Group entries by ISO date string. */
function bucketByDate(topics: MemoryTopic[], events: MemoryEvent[]): DateBucket[] {
  const buckets = new Map<string, DateBucket>();

  for (const t of topics) {
    const date = t.lastMentioned.slice(0, 10);
    if (!buckets.has(date)) buckets.set(date, { date, topics: [], events: [] });
    buckets.get(date)!.topics.push(t);
  }

  for (const e of events) {
    const date = e.timestamp.slice(0, 10);
    if (!buckets.has(date)) buckets.set(date, { date, topics: [], events: [] });
    buckets.get(date)!.events.push(e);
  }

  // Sort by date ascending (oldest first)
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Deduplicate texts using scoreUniqueness. Returns unique texts. */
function deduplicateTexts(texts: string[]): string[] {
  if (texts.length <= 1) return texts;

  const unique: string[] = [];
  for (const text of texts) {
    const uniqueness = scoreUniqueness(text, unique);
    if (uniqueness > (1 - DEDUP_OVERLAP_THRESHOLD * 1.2)) {
      unique.push(text);
    }
  }
  return unique;
}

/** Generate a heuristic summary from a date bucket. */
function summarizeBucket(bucket: DateBucket): CompressedMemoryEntry {
  // Collect all texts
  const topicTexts = bucket.topics.map(t => t.topic);
  const eventTexts = bucket.events.map(e => e.event.replace(/^User message:\s*/i, ''));

  // Deduplicate across topics and events
  const allTexts = [...topicTexts, ...eventTexts];
  const uniqueTexts = deduplicateTexts(allTexts);

  // Pick key topics: sort by importance (desc), take top N
  const sortedTopics = [...bucket.topics]
    .sort((a, b) => b.importance - a.importance || b.accessCount - a.accessCount);
  const keyTopics = sortedTopics
    .slice(0, MAX_KEY_TOPICS)
    .map(t => t.topic);

  // Max importance across all entries
  const maxImportance = Math.max(
    ...bucket.topics.map(t => t.importance),
    ...bucket.events.map(e => e.importance),
    1,
  );

  // Build summary: "{date}：{key topics}（共 N 話題、M 事件）"
  const topicSummary = keyTopics.length > 0
    ? keyTopics.join('、')
    : uniqueTexts.slice(0, 3).join('、');

  const summary = `${bucket.date}：${topicSummary}（共 ${bucket.topics.length} 個話題、${bucket.events.length} 個事件）`;

  // Compute date range from actual timestamps
  const allTimestamps = [
    ...bucket.topics.map(t => t.firstMentioned),
    ...bucket.events.map(e => e.timestamp),
  ].sort();

  return {
    id: `cmp:${bucket.topics[0]?.topic ? bucket.date : bucket.date}:${Date.now()}`,
    chatId: 0, // Will be set by caller
    dateRange: {
      from: allTimestamps[0] ?? bucket.date,
      to: allTimestamps[allTimestamps.length - 1] ?? bucket.date,
    },
    summary,
    topicCount: bucket.topics.length,
    eventCount: bucket.events.length,
    keyTopics,
    importance: maxImportance,
    compressedAt: new Date().toISOString(),
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Compress old memories for a given chatId.
 * Returns the number of entries compressed.
 */
export async function compressOldMemories(chatId: number): Promise<number> {
  const mem = await getMemory(chatId);
  const cutoff = Date.now() - COMPRESS_AGE_DAYS * 24 * 60 * 60 * 1000;

  // Partition: old (compressible) vs recent (keep)
  const oldTopics = mem.topics.filter(t => new Date(t.lastMentioned).getTime() < cutoff);
  const recentTopics = mem.topics.filter(t => new Date(t.lastMentioned).getTime() >= cutoff);

  const oldEvents = mem.events.filter(e => new Date(e.timestamp).getTime() < cutoff);
  const recentEvents = mem.events.filter(e => new Date(e.timestamp).getTime() >= cutoff);

  // Also keep high-importance items regardless of age
  const highImportanceTopics = oldTopics.filter(t => t.importance >= 4);
  const lowTopics = oldTopics.filter(t => t.importance < 4);
  const highImportanceEvents = oldEvents.filter(e => e.importance >= 4);
  const lowEvents = oldEvents.filter(e => e.importance < 4);

  // Nothing to compress?
  if (lowTopics.length + lowEvents.length === 0) return 0;

  // Group by date
  const buckets = bucketByDate(lowTopics, lowEvents);

  // Compress each bucket that meets minimum size
  const compressed: CompressedMemoryEntry[] = [];
  const compressedTopicSet = new Set<MemoryTopic>();
  const compressedEventSet = new Set<MemoryEvent>();

  for (const bucket of buckets) {
    const totalEntries = bucket.topics.length + bucket.events.length;
    if (totalEntries < MIN_BUCKET_SIZE) {
      // Too small to compress — leave as-is
      continue;
    }

    const entry = summarizeBucket(bucket);
    entry.chatId = chatId;
    entry.id = `cmp:${chatId}:${bucket.date}`;
    compressed.push(entry);

    // Track which entries will be removed
    for (const t of bucket.topics) compressedTopicSet.add(t);
    for (const e of bucket.events) compressedEventSet.add(e);
  }

  if (compressed.length === 0) return 0;

  // Phase 1: Write archives FIRST (crash-safe: write before delete)
  for (const entry of compressed) {
    await writer.appendJsonl(archivePath(chatId), entry);
  }

  // Phase 2: Remove compressed entries from live memory
  mem.topics = [
    ...recentTopics,
    ...highImportanceTopics,
    ...lowTopics.filter(t => !compressedTopicSet.has(t)),
  ];
  mem.events = [
    ...recentEvents,
    ...highImportanceEvents,
    ...lowEvents.filter(e => !compressedEventSet.has(e)),
  ];

  // Persist slimmed-down memory (atomic write via writer.schedule)
  writer.schedule(join(MEMORY_DIR, `${chatId}_memory.json`), mem);

  const totalCompressed = compressedTopicSet.size + compressedEventSet.size;

  await logger.info('MemoryCompressor',
    `Compressed ${totalCompressed} entries into ${compressed.length} summaries for chat ${chatId}`);

  // Emit event for search-index incremental update
  await eventBus.emit('memory:compressed', { chatId, count: totalCompressed });

  return totalCompressed;
}
