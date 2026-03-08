import { mkdir } from 'node:fs/promises';
import { getSoulPath, readSoulJson, scheduleSoulJson } from '../core/soul-io.js';
import { eventBus } from '../core/event-bus.js';

const MEMORY_DIR = getSoulPath('memory');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface MemoryTopic {
  topic: string;
  firstMentioned: string;
  lastMentioned: string;
  accessCount: number;
  importance: number; // 1-5
}

export interface MemoryDecision {
  decision: string;
  context: string;
  timestamp: string;
  importance: number;
}

export interface MemoryEvent {
  event: string;
  timestamp: string;
  participants: number[];
  importance: number;
}

export interface ChatMemoryData {
  version: number;
  chatId: number;
  topics: MemoryTopic[];
  decisions: MemoryDecision[];
  events: MemoryEvent[];
  lastAccessed: string;
  accessCount: number;
}

interface CacheEntry {
  data: ChatMemoryData;
  loadedAt: number;
}

function emptyMemory(chatId: number): ChatMemoryData {
  return {
    version: 1,
    chatId,
    topics: [],
    decisions: [],
    events: [],
    lastAccessed: new Date().toISOString(),
    accessCount: 0,
  };
}

const cache = new Map<number, CacheEntry>();

async function loadFromDisk(chatId: number): Promise<ChatMemoryData> {
  try {
    return await readSoulJson<ChatMemoryData>('memory', `${chatId}_memory.json`);
  } catch {
    return emptyMemory(chatId);
  }
}

function isCacheFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.loadedAt < CACHE_TTL_MS;
}

export async function getMemory(chatId: number): Promise<ChatMemoryData> {
  const cached = cache.get(chatId);
  if (cached && isCacheFresh(cached)) {
    return cached.data;
  }
  const data = await loadFromDisk(chatId);
  data.lastAccessed = new Date().toISOString();
  data.accessCount++;
  cache.set(chatId, { data, loadedAt: Date.now() });
  return data;
}

function persist(chatId: number, data: ChatMemoryData): void {
  cache.set(chatId, { data, loadedAt: Date.now() });
  scheduleSoulJson(`memory/${chatId}_memory.json`, data);
}

export async function addTopic(
  chatId: number,
  topic: string,
  importance: number = 3,
): Promise<void> {
  const mem = await getMemory(chatId);
  const now = new Date().toISOString();
  const existingIdx = mem.topics.findIndex(
    (t) => t.topic.toLowerCase() === topic.toLowerCase(),
  );
  let topicIndex: number;
  if (existingIdx >= 0) {
    const existing = mem.topics[existingIdx]!;
    existing.lastMentioned = now;
    existing.accessCount++;
    if (importance > existing.importance) existing.importance = importance;
    topicIndex = existingIdx;
  } else {
    mem.topics.push({
      topic,
      firstMentioned: now,
      lastMentioned: now,
      accessCount: 1,
      importance,
    });
    topicIndex = mem.topics.length - 1;
  }
  persist(chatId, mem);
  await eventBus.emit('memory:updated', { chatId, type: 'topic', index: topicIndex });

  // Register topic as a knowledge graph node (fire-and-forget)
  import('./knowledge-graph.js').then(({ upsertNode }) =>
    upsertNode(topic, 'concept').catch(() => {}),
  );
}

export async function addDecision(
  chatId: number,
  decision: string,
  context: string,
  importance: number = 3,
): Promise<void> {
  const mem = await getMemory(chatId);
  mem.decisions.push({
    decision,
    context,
    timestamp: new Date().toISOString(),
    importance,
  });
  persist(chatId, mem);
  await eventBus.emit('memory:updated', { chatId, type: 'decision', index: mem.decisions.length - 1 });
}

export async function addEvent(
  chatId: number,
  event: string,
  participants: number[] = [],
  importance: number = 3,
): Promise<void> {
  const mem = await getMemory(chatId);
  mem.events.push({
    event,
    timestamp: new Date().toISOString(),
    participants,
    importance,
  });
  persist(chatId, mem);
  await eventBus.emit('memory:updated', { chatId, type: 'event', index: mem.events.length - 1 });
}

/**
 * Compress old memories into summaries (delegates to memory-compressor).
 * Unlike the old destructive compact(), this preserves data in archive files.
 */
export async function compact(chatId: number): Promise<number> {
  const { compressOldMemories } = await import('./memory-compressor.js');
  return compressOldMemories(chatId);
}

/** List all chatIds that have memory files. */
export async function getChatIds(): Promise<number[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    const files = await readdir(MEMORY_DIR);
    return files
      .filter(f => f.endsWith('_memory.json'))
      .map(f => parseInt(f.split('_')[0]!, 10))
      .filter(n => !isNaN(n));
  } catch {
    return [];
  }
}

export async function initMemoryDir(): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
}

export function clearCache(): void {
  cache.clear();
}
