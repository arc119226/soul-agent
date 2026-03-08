import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    schedule: vi.fn(),
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock fs to control what the module reads
let mockFileContent: string | null = null;

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => {
    if (mockFileContent === null) throw new Error('ENOENT');
    return mockFileContent;
  }),
}));

describe('Curiosity tracking', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockFileContent = null;

    // Reset module cache so each test starts fresh
    vi.resetModules();
  });

  async function loadModule() {
    return import('../../src/metacognition/curiosity.js');
  }

  it('starts with empty topics when file does not exist', async () => {
    const mod = await loadModule();
    mod.resetCache();

    const topics = await mod.getCuriosityTopics();
    expect(topics).toEqual([]);
  });

  it('loads topics from file', async () => {
    mockFileContent = JSON.stringify({
      version: 1,
      topics: [
        { topic: 'AI safety', reason: 'important', addedAt: '2026-01-01T00:00:00Z', explored: false },
      ],
      questions: [],
    });

    const mod = await loadModule();
    mod.resetCache();

    const topics = await mod.getCuriosityTopics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.topic).toBe('AI safety');
  });

  it('trackCuriosityTopic adds a new topic', async () => {
    const mod = await loadModule();
    mod.resetCache();

    await mod.trackCuriosityTopic('quantum computing', '聽主人提起');
    const topics = await mod.getCuriosityTopics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.topic).toBe('quantum computing');
    expect(topics[0]!.reason).toBe('聽主人提起');
    expect(topics[0]!.explored).toBe(false);
  });

  it('avoids duplicate topics (case insensitive)', async () => {
    const mod = await loadModule();
    mod.resetCache();

    await mod.trackCuriosityTopic('AI safety', 'reason 1');
    await mod.trackCuriosityTopic('ai safety', 'reason 2');
    const topics = await mod.getCuriosityTopics();
    expect(topics).toHaveLength(1);
  });

  it('markExplored marks topic as explored', async () => {
    const mod = await loadModule();
    mod.resetCache();

    await mod.trackCuriosityTopic('topic1', 'r1');
    const result = await mod.markExplored('topic1');
    expect(result).toBe(true);

    // getCuriosityTopics filters out explored ones
    const topics = await mod.getCuriosityTopics();
    expect(topics).toHaveLength(0);
  });

  it('markExplored returns false for non-existent topic', async () => {
    const mod = await loadModule();
    mod.resetCache();

    const result = await mod.markExplored('nonexistent');
    expect(result).toBe(false);
  });

  it('trackQuestion adds questions', async () => {
    const mod = await loadModule();
    mod.resetCache();

    await mod.trackQuestion('What is consciousness?');
    const data = await mod.getAllCuriosityData();
    expect(data.questions).toContain('What is consciousness?');
  });

  it('trackQuestion avoids duplicates', async () => {
    const mod = await loadModule();
    mod.resetCache();

    await mod.trackQuestion('Q1');
    await mod.trackQuestion('Q1');
    const data = await mod.getAllCuriosityData();
    expect(data.questions.filter((q) => q === 'Q1')).toHaveLength(1);
  });

  it('caps topics at 50, removing explored ones first', async () => {
    const mod = await loadModule();
    mod.resetCache();

    // Add 50 topics, mark first one as explored
    for (let i = 0; i < 50; i++) {
      await mod.trackCuriosityTopic(`topic-${i}`, 'r');
    }
    await mod.markExplored('topic-0');

    // Add one more — should evict explored topic-0
    await mod.trackCuriosityTopic('topic-50', 'r');
    const data = await mod.getAllCuriosityData();
    expect(data.topics.length).toBeLessThanOrEqual(50);
    expect(data.topics.find((t) => t.topic === 'topic-0')).toBeUndefined();
    expect(data.topics.find((t) => t.topic === 'topic-50')).toBeDefined();
  });

  it('handles legacy string-format topics', async () => {
    mockFileContent = JSON.stringify({
      version: 1,
      topics: ['old string topic'],
      questions: [],
    });

    const mod = await loadModule();
    mod.resetCache();

    const topics = await mod.getCuriosityTopics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.topic).toBe('old string topic');
    expect(topics[0]!.explored).toBe(false);
  });
});
