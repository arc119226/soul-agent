import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/config.js', () => ({
  config: { MODEL_TIER_HAIKU: 'claude-haiku-4-5' },
}));

vi.mock('../../src/claude/claude-code.js', () => ({
  askClaudeCode: vi.fn(),
  LIGHTWEIGHT_CWD: '/tmp/lightweight',
}));

import { assessHeuristic, assessResult } from '../../src/agents/monitoring/result-assessor.js';
import { askClaudeCode } from '../../src/claude/claude-code.js';

// ── Tests ───────────────────────────────────────────────────────────

describe('ResultAssessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('assessHeuristic()', () => {
    it('returns 0.05 for empty or very short result', () => {
      expect(assessHeuristic('')).toBe(0.05);
      expect(assessHeuristic('ok')).toBe(0.05);
    });

    it('returns 0.1 for JSON error responses', () => {
      const errJson = JSON.stringify({ is_error: true, message: 'failed' });
      expect(assessHeuristic(errJson)).toBe(0.1);
    });

    it('returns 0.1 for max_turns error', () => {
      const errJson = JSON.stringify({ subtype: 'error_max_turns' });
      expect(assessHeuristic(errJson)).toBe(0.1);
    });

    it('returns higher score for structured content with markers', () => {
      const result = '## 發現\n\n重要性：4/5\n\nhttps://example.com\n\n' + 'x'.repeat(600);
      const score = assessHeuristic(result);
      expect(score).toBeGreaterThan(0.4);
    });

    it('penalizes negative language', () => {
      const negative = 'I cannot complete this task. I don\'t have the ability.' + 'x'.repeat(200);
      const positive = '## 分析結果\n\n發現了重要的漏洞' + 'x'.repeat(200);
      expect(assessHeuristic(negative)).toBeLessThan(assessHeuristic(positive));
    });

    it('caps score between 0.05 and 1.0', () => {
      const longResult = '##\n###\n---\n發現\n結論\n重要性：5/5\nhttps://src\n來源\nSources\n延伸問題\n' + 'x'.repeat(2000);
      const score = assessHeuristic(longResult);
      expect(score).toBeLessThanOrEqual(1.0);
      expect(score).toBeGreaterThanOrEqual(0.05);
    });

    it('returns low score for short result under 100 chars', () => {
      const score = assessHeuristic('Some result text that is fairly short');
      expect(score).toBeLessThanOrEqual(0.15);
    });
  });

  describe('assessResult()', () => {
    it('uses heuristic when cost and failures are below thresholds', async () => {
      const res = await assessResult('A detailed report with findings ' + 'x'.repeat(300), 'prompt', 0.05, 0);
      expect(res.method).toBe('heuristic');
      expect(res.confidence).toBeGreaterThan(0);
    });

    it('invokes LLM judge when cost exceeds $0.10', async () => {
      vi.mocked(askClaudeCode).mockResolvedValueOnce({
        ok: true,
        value: {
          result: '{"relevance":0.8,"completeness":0.7,"accuracy":0.9,"structure":0.8,"reason":"good"}',
          costUsd: 0.001, duration: 500, numTurns: 1,
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const res = await assessResult('long result ' + 'x'.repeat(500), 'prompt', 0.15, 0);
      expect(res.method).toBe('llm-judge');
      expect(res.dimensions).toBeDefined();
      expect(res.confidence).toBeGreaterThan(0);
    });

    it('invokes LLM judge when failure count >= 2', async () => {
      vi.mocked(askClaudeCode).mockResolvedValueOnce({
        ok: false,
        error: 'API error',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const res = await assessResult('result text ' + 'x'.repeat(200), 'prompt', 0.01, 3);
      // Falls back to heuristic after judge failure
      expect(res.method).toBe('heuristic');
    });

    it('falls back to heuristic when LLM judge throws', async () => {
      vi.mocked(askClaudeCode).mockRejectedValueOnce(new Error('network error'));
      const res = await assessResult('result content here ' + 'x'.repeat(200), 'prompt', 0.20, 0);
      expect(res.method).toBe('heuristic');
      expect(res.confidence).toBeGreaterThan(0);
    });
  });
});
