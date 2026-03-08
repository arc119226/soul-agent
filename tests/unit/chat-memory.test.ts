import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    schedule: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock fs to avoid real disk I/O
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('not found')),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { getMemory, addTopic, addEvent, addDecision, clearCache } from '../../src/memory/chat-memory.js';

describe('ChatMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it('getMemory returns empty memory for new chat', async () => {
    const mem = await getMemory(12345);
    expect(mem.chatId).toBe(12345);
    expect(mem.topics).toEqual([]);
    expect(mem.decisions).toEqual([]);
    expect(mem.events).toEqual([]);
  });

  it('addTopic adds a new topic', async () => {
    await addTopic(100, 'TypeScript testing', 3);
    const mem = await getMemory(100);
    expect(mem.topics).toHaveLength(1);
    expect(mem.topics[0]!.topic).toBe('TypeScript testing');
    expect(mem.topics[0]!.importance).toBe(3);
  });

  it('addTopic deduplicates same topic (case-insensitive)', async () => {
    await addTopic(101, 'Bot Development', 2);
    await addTopic(101, 'bot development', 4);
    const mem = await getMemory(101);
    expect(mem.topics).toHaveLength(1);
    expect(mem.topics[0]!.accessCount).toBe(2);
    expect(mem.topics[0]!.importance).toBe(4); // Upgraded
  });

  it('addEvent adds events with participants', async () => {
    await addEvent(102, 'deployment completed', [1, 2], 4);
    const mem = await getMemory(102);
    expect(mem.events).toHaveLength(1);
    expect(mem.events[0]!.event).toBe('deployment completed');
    expect(mem.events[0]!.participants).toEqual([1, 2]);
  });

  it('addDecision records a decision', async () => {
    await addDecision(103, 'Use DuckDuckGo for search', 'No API key needed', 3);
    const mem = await getMemory(103);
    expect(mem.decisions).toHaveLength(1);
    expect(mem.decisions[0]!.decision).toBe('Use DuckDuckGo for search');
    expect(mem.decisions[0]!.context).toBe('No API key needed');
  });
});

describe('ChatMemoryListener helpers', () => {
  it('extractTopic returns null for short text', async () => {
    const { extractTopic } = await import('../../src/memory/chat-memory-listener.js');
    expect(extractTopic('hi')).toBe(null);
    expect(extractTopic('ok')).toBe(null);
  });

  it('extractTopic extracts first sentence', async () => {
    const { extractTopic } = await import('../../src/memory/chat-memory-listener.js');
    const topic = extractTopic('This is a test sentence. And another one.');
    expect(topic).toBe('This is a test sentence');
  });

  it('extractTopic truncates at 60 chars', async () => {
    const { extractTopic } = await import('../../src/memory/chat-memory-listener.js');
    const long = 'A'.repeat(100);
    const topic = extractTopic(long);
    expect(topic).not.toBeNull();
    expect(topic!.length).toBeLessThanOrEqual(60);
  });

  it('estimateImportance returns 4 for high-priority keywords', async () => {
    const { estimateImportance } = await import('../../src/memory/chat-memory-listener.js');
    expect(estimateImportance('This is very 重要')).toBe(4);
    expect(estimateImportance('Found a bug in the code')).toBe(4);
  });

  it('estimateImportance returns 3 for medium keywords', async () => {
    const { estimateImportance } = await import('../../src/memory/chat-memory-listener.js');
    expect(estimateImportance('請幫我看一下')).toBe(3);
    expect(estimateImportance('Please add this feature')).toBe(3);
  });

  it('estimateImportance returns 2 for normal text', async () => {
    const { estimateImportance } = await import('../../src/memory/chat-memory-listener.js');
    expect(estimateImportance('Today the weather is nice')).toBe(2);
  });
});
