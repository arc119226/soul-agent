import { describe, it, expect, vi } from 'vitest';
import {
  classifyComplexity,
  inferAffectedAreas,
} from '../../src/evolution/intention-recorder.js';
import type { Goal } from '../../src/evolution/goals.js';

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'test-goal-1',
    description: 'Test goal',
    priority: 3,
    status: 'pending',
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Intention Recorder — classifyComplexity', () => {
  it('returns "high" for refactoring goals', () => {
    expect(classifyComplexity(makeGoal({ description: 'Refactor the core module' }))).toBe('high');
  });

  it('returns "high" for architecture goals', () => {
    expect(classifyComplexity(makeGoal({ description: 'Redesign architecture' }))).toBe('high');
  });

  it('returns "high" for 重構 keyword', () => {
    expect(classifyComplexity(makeGoal({ description: '重構記憶系統' }))).toBe('high');
  });

  it('returns "high" for refactor tag', () => {
    expect(classifyComplexity(makeGoal({ tags: ['refactor'] }))).toBe('high');
  });

  it('returns "high" for core tag', () => {
    expect(classifyComplexity(makeGoal({ tags: ['core'] }))).toBe('high');
  });

  it('returns "medium" for new feature goals', () => {
    expect(classifyComplexity(makeGoal({ description: 'Add new plugin system' }))).toBe('medium');
  });

  it('returns "medium" for 新增 keyword', () => {
    expect(classifyComplexity(makeGoal({ description: '新增功能：記憶搜尋' }))).toBe('medium');
  });

  it('returns "medium" for feature tag', () => {
    expect(classifyComplexity(makeGoal({ tags: ['feature'] }))).toBe('medium');
  });

  it('returns "low" for simple goals', () => {
    expect(classifyComplexity(makeGoal({ description: 'Fix a typo in greeting' }))).toBe('low');
  });

  it('high takes priority over medium keywords', () => {
    // "refactor" + "add" → should be "high"
    expect(classifyComplexity(makeGoal({ description: 'Refactor and add new core module' }))).toBe('high');
  });
});

describe('Intention Recorder — inferAffectedAreas', () => {
  it('detects plugin area', () => {
    const areas = inferAffectedAreas(makeGoal({ description: 'Update plugin loader' }));
    expect(areas).toContain('plugins');
  });

  it('detects memory area from Chinese keyword', () => {
    const areas = inferAffectedAreas(makeGoal({ description: '改善記憶系統的搜尋' }));
    expect(areas).toContain('memory');
  });

  it('detects lifecycle area', () => {
    const areas = inferAffectedAreas(makeGoal({ description: 'Fix heartbeat timing' }));
    expect(areas).toContain('lifecycle');
  });

  it('detects identity area from 身份', () => {
    const areas = inferAffectedAreas(makeGoal({ description: '更新身份系統' }));
    expect(areas).toContain('identity');
  });

  it('detects evolution area', () => {
    const areas = inferAffectedAreas(makeGoal({ description: '改進進化管道' }));
    expect(areas).toContain('evolution');
  });

  it('detects agent area', () => {
    const areas = inferAffectedAreas(makeGoal({ description: 'Add new agent worker' }));
    expect(areas).toContain('agents');
  });

  it('detects metacognition area', () => {
    const areas = inferAffectedAreas(makeGoal({ description: '深化反思機制' }));
    expect(areas).toContain('metacognition');
  });

  it('detects telegram area', () => {
    const areas = inferAffectedAreas(makeGoal({ description: 'Add new bot command' }));
    expect(areas).toContain('telegram');
  });

  it('detects planning area', () => {
    const areas = inferAffectedAreas(makeGoal({ description: '改善計劃管理' }));
    expect(areas).toContain('planning');
  });

  it('returns multiple areas for cross-cutting changes', () => {
    const areas = inferAffectedAreas(makeGoal({ description: 'Refactor memory and identity core modules' }));
    expect(areas).toContain('core');
    expect(areas).toContain('memory');
    expect(areas).toContain('identity');
    expect(areas.length).toBeGreaterThanOrEqual(3);
  });

  it('returns "general" when no area matches', () => {
    const areas = inferAffectedAreas(makeGoal({ description: 'Something completely unrelated' }));
    expect(areas).toEqual(['general']);
  });
});

describe('Intention Recorder — findPrecedents', () => {
  it('returns empty array when intentions file does not exist', async () => {
    // Must reset modules and re-import with mocked fs to isolate from actual disk state
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    }));
    vi.doMock('../../src/core/debounced-writer.js', () => ({
      writer: { appendJsonl: vi.fn() },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const { findPrecedents } = await import('../../src/evolution/intention-recorder.js');
    const result = await findPrecedents(makeGoal({ description: 'Test goal' }));
    expect(result).toEqual([]);
  });
});
