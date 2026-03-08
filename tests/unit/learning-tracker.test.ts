import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn() },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('LearningTracker', () => {
  let recordSuccess: typeof import('../../src/metacognition/learning-tracker.js')['recordSuccess'];
  let recordFailure: typeof import('../../src/metacognition/learning-tracker.js')['recordFailure'];
  let addInsight: typeof import('../../src/metacognition/learning-tracker.js')['addInsight'];
  let getPatterns: typeof import('../../src/metacognition/learning-tracker.js')['getPatterns'];
  let getPatternsByCategory: typeof import('../../src/metacognition/learning-tracker.js')['getPatternsByCategory'];
  let compactPatterns: typeof import('../../src/metacognition/learning-tracker.js')['compactPatterns'];
  let resetCache: typeof import('../../src/metacognition/learning-tracker.js')['resetCache'];
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockSchedule: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockReadFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    mockSchedule = vi.fn();

    vi.doMock('node:fs/promises', () => ({ readFile: mockReadFile }));
    vi.doMock('../../src/core/debounced-writer.js', () => ({ writer: { schedule: mockSchedule } }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    // Mock staging module so addInsight falls back to addInsightDirect
    vi.doMock('../../src/memory/staging.js', () => ({
      stage: vi.fn().mockRejectedValue(new Error('staging unavailable in test')),
    }));

    const mod = await import('../../src/metacognition/learning-tracker.js');
    recordSuccess = mod.recordSuccess;
    recordFailure = mod.recordFailure;
    addInsight = mod.addInsight;
    getPatterns = mod.getPatterns;
    getPatternsByCategory = mod.getPatternsByCategory;
    compactPatterns = mod.compactPatterns;
    resetCache = mod.resetCache;
  });

  describe('recordSuccess()', () => {
    it('adds a success record', async () => {
      await recordSuccess('conversation', 'Good reply');
      const patterns = await getPatterns();
      expect(patterns.successes).toHaveLength(1);
      expect(patterns.successes[0]!.category).toBe('conversation');
      expect(patterns.successes[0]!.details).toBe('Good reply');
    });

    it('caps records at 200', async () => {
      for (let i = 0; i < 205; i++) {
        await recordSuccess('cat', `record-${i}`);
      }
      const patterns = await getPatterns();
      expect(patterns.successes.length).toBeLessThanOrEqual(200);
    });

    it('generates insight on every 10th success in same category', async () => {
      for (let i = 0; i < 10; i++) {
        await recordSuccess('coding', `success-${i}`);
      }
      const patterns = await getPatterns();
      expect(patterns.insights.some((ins) => ins.includes('coding') && ins.includes('10'))).toBe(true);
    });

    it('does not generate insight before 10th success', async () => {
      for (let i = 0; i < 9; i++) {
        await recordSuccess('coding', `success-${i}`);
      }
      const patterns = await getPatterns();
      expect(patterns.insights.some((ins) => ins.includes('coding'))).toBe(false);
    });
  });

  describe('recordFailure()', () => {
    it('adds a failure record', async () => {
      await recordFailure('api', 'Timeout error');
      const patterns = await getPatterns();
      expect(patterns.failures).toHaveLength(1);
      expect(patterns.failures[0]!.category).toBe('api');
    });

    it('generates warning insight after 3+ failures in same category', async () => {
      for (let i = 0; i < 3; i++) {
        await recordFailure('parsing', `fail-${i}`);
      }
      const patterns = await getPatterns();
      expect(patterns.insights.some((ins) => ins.includes('parsing') && ins.includes('失敗'))).toBe(true);
    });

    it('does not generate warning for fewer than 3 failures', async () => {
      await recordFailure('parsing', 'fail-1');
      await recordFailure('parsing', 'fail-2');
      const patterns = await getPatterns();
      expect(patterns.insights.some((ins) => ins.includes('parsing'))).toBe(false);
    });

    it('caps failure records at 200', async () => {
      for (let i = 0; i < 205; i++) {
        await recordFailure('cat', `fail-${i}`);
      }
      const patterns = await getPatterns();
      expect(patterns.failures.length).toBeLessThanOrEqual(200);
    });
  });

  describe('addInsight()', () => {
    it('adds a new insight', async () => {
      await addInsight('New discovery');
      const patterns = await getPatterns();
      expect(patterns.insights).toContain('New discovery');
    });

    it('deduplicates insights', async () => {
      await addInsight('Same insight');
      await addInsight('Same insight');
      const patterns = await getPatterns();
      expect(patterns.insights.filter((i) => i === 'Same insight')).toHaveLength(1);
    });

    it('caps insights at 100', async () => {
      for (let i = 0; i < 105; i++) {
        await addInsight(`insight-${i}`);
      }
      const patterns = await getPatterns();
      expect(patterns.insights.length).toBeLessThanOrEqual(100);
    });
  });

  describe('getPatterns()', () => {
    it('returns all patterns', async () => {
      await recordSuccess('a', 'detail');
      await recordFailure('b', 'detail');
      await addInsight('some insight');

      const patterns = await getPatterns();
      expect(patterns.successes).toHaveLength(1);
      expect(patterns.failures).toHaveLength(1);
      expect(patterns.insights).toContain('some insight');
    });
  });

  describe('getPatternsByCategory()', () => {
    it('filters by category and calculates success rate', async () => {
      await recordSuccess('coding', 'ok');
      await recordSuccess('coding', 'ok2');
      await recordFailure('coding', 'fail');

      const result = await getPatternsByCategory('coding');
      expect(result.successes).toHaveLength(2);
      expect(result.failures).toHaveLength(1);
      expect(result.successRate).toBeCloseTo(2 / 3);
    });

    it('returns 0 success rate when no records', async () => {
      const result = await getPatternsByCategory('nonexistent');
      expect(result.successRate).toBe(0);
    });
  });

  describe('compactPatterns()', () => {
    it('compacts when successes exceed 50', async () => {
      for (let i = 0; i < 55; i++) {
        await recordSuccess('coding', `success-${i}`);
      }

      const compacted = await compactPatterns();
      expect(compacted).toBeGreaterThan(0);

      const patterns = await getPatterns();
      expect(patterns.successes.length).toBe(30);
      expect(patterns.insights.some((ins) => ins.includes('學習摘要'))).toBe(true);
    });

    it('does not compact when below threshold', async () => {
      for (let i = 0; i < 10; i++) {
        await recordSuccess('coding', `s-${i}`);
      }
      const compacted = await compactPatterns();
      expect(compacted).toBe(0);
    });

    it('compacts both successes and failures', async () => {
      for (let i = 0; i < 55; i++) {
        await recordSuccess('a', `s-${i}`);
        await recordFailure('b', `f-${i}`);
      }

      const compacted = await compactPatterns();
      expect(compacted).toBeGreaterThan(0);

      const patterns = await getPatterns();
      expect(patterns.successes.length).toBe(30);
      expect(patterns.failures.length).toBe(30);
    });
  });

  describe('resetCache()', () => {
    it('clears the cache so next load re-reads from disk', async () => {
      await recordSuccess('a', 'detail');
      resetCache();

      // After reset, load should try to read from disk again
      const patterns = await getPatterns();
      // Since mockReadFile rejects (ENOENT), it starts fresh
      expect(patterns.successes).toHaveLength(0);
    });
  });
});
