import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises — readFile
const mockReadFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Mock writer
const mockAppendJsonl = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { appendJsonl: (...args: unknown[]) => mockAppendJsonl(...args) },
}));

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  appendChangelog,
  getRecentChanges,
  getChangesForGoal,
  getSuccessRate,
} from '../../src/evolution/changelog.js';

const sampleEntry = (goalId: string, success: boolean, ts?: string) =>
  JSON.stringify({
    timestamp: ts ?? '2026-01-01T00:00:00.000Z',
    goalId,
    description: `Test change for ${goalId}`,
    filesChanged: ['src/test.ts'],
    success,
    lessonsLearned: 'learned something',
  });

describe('Changelog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('appendChangelog()', () => {
    it('calls writer.appendJsonl with entry including timestamp', async () => {
      await appendChangelog({
        goalId: 'g1',
        description: 'test change',
        filesChanged: ['a.ts'],
        success: true,
        lessonsLearned: 'none',
      });

      expect(mockAppendJsonl).toHaveBeenCalledTimes(1);
      const [, data] = mockAppendJsonl.mock.calls[0]!;
      expect(data).toHaveProperty('timestamp');
      expect(data.goalId).toBe('g1');
      expect(data.success).toBe(true);
    });

    it('does not throw when writer fails', async () => {
      mockAppendJsonl.mockRejectedValueOnce(new Error('write error'));
      await expect(
        appendChangelog({
          goalId: 'g1',
          description: 'x',
          filesChanged: [],
          success: false,
          lessonsLearned: '',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('getRecentChanges()', () => {
    it('parses JSONL and returns newest first', async () => {
      const lines = [
        sampleEntry('g1', true, '2026-01-01T00:00:00.000Z'),
        sampleEntry('g2', false, '2026-01-02T00:00:00.000Z'),
        sampleEntry('g3', true, '2026-01-03T00:00:00.000Z'),
      ].join('\n');
      mockReadFile.mockResolvedValueOnce(lines);

      const results = await getRecentChanges(10);
      expect(results).toHaveLength(3);
      // Reversed: newest (g3) first
      expect(results[0]!.goalId).toBe('g3');
      expect(results[2]!.goalId).toBe('g1');
    });

    it('limits to N entries', async () => {
      const lines = [
        sampleEntry('g1', true),
        sampleEntry('g2', true),
        sampleEntry('g3', true),
      ].join('\n');
      mockReadFile.mockResolvedValueOnce(lines);

      const results = await getRecentChanges(2);
      expect(results).toHaveLength(2);
    });

    it('returns empty array when file does not exist', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const results = await getRecentChanges();
      expect(results).toEqual([]);
    });

    it('skips malformed JSON lines', async () => {
      const lines = [
        sampleEntry('g1', true),
        'not valid json {{{',
        sampleEntry('g2', false),
      ].join('\n');
      mockReadFile.mockResolvedValueOnce(lines);

      const results = await getRecentChanges(10);
      expect(results).toHaveLength(2);
    });
  });

  describe('getChangesForGoal()', () => {
    it('filters entries by goalId', async () => {
      const lines = [
        sampleEntry('g1', true),
        sampleEntry('g2', false),
        sampleEntry('g1', false),
      ].join('\n');
      mockReadFile.mockResolvedValueOnce(lines);

      const results = await getChangesForGoal('g1');
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.goalId === 'g1')).toBe(true);
    });
  });

  describe('getSuccessRate()', () => {
    it('computes ratio of successes', async () => {
      const lines = [
        sampleEntry('g1', true),
        sampleEntry('g2', false),
        sampleEntry('g3', true),
        sampleEntry('g4', true),
      ].join('\n');
      mockReadFile.mockResolvedValueOnce(lines);

      const rate = await getSuccessRate(10);
      expect(rate).toBe(0.75);
    });

    it('returns 0 when no entries', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const rate = await getSuccessRate();
      expect(rate).toBe(0);
    });
  });
});
