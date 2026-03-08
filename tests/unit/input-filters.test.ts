import { describe, it, expect } from 'vitest';
import {
  applyFilter,
  isValidFilter,
  getFilterNames,
} from '../../src/agents/input-filters.js';

describe('Input Filters', () => {
  describe('applyFilter()', () => {
    it('passthrough returns input unchanged', () => {
      const input = 'hello world';
      expect(applyFilter('passthrough', input)).toBe(input);
    });

    it('truncate-1000 truncates long input', () => {
      const input = 'x'.repeat(2000);
      const result = applyFilter('truncate-1000', input);
      expect(result).toHaveLength(1000);
    });

    it('truncate-1000 leaves short input unchanged', () => {
      const input = 'short text';
      expect(applyFilter('truncate-1000', input)).toBe(input);
    });

    it('summary-only extracts summary section', () => {
      const input = [
        '# Report',
        '',
        '## Findings',
        'Some findings here.',
        '',
        '## 結論',
        'This is the conclusion.',
        'More conclusion text.',
        '',
        '## References',
        'Some references.',
      ].join('\n');

      const result = applyFilter('summary-only', input);
      expect(result).toContain('結論');
      expect(result).toContain('This is the conclusion.');
      expect(result).not.toContain('Some findings');
      expect(result).not.toContain('References');
    });

    it('summary-only falls back to first 1000 chars when no summary found', () => {
      const input = '# Title\n\nJust some content without summary.';
      const result = applyFilter('summary-only', input);
      expect(result).toBe(input);
    });

    it('findings-only extracts findings section', () => {
      const input = [
        '# Security Report',
        '',
        '## Overview',
        'We scanned the code.',
        '',
        '## 發現',
        'Critical: SQL injection in api.ts',
        'High: XSS in frontend.tsx',
        '',
        '## Recommendations',
        'Fix all issues.',
      ].join('\n');

      const result = applyFilter('findings-only', input);
      expect(result).toContain('發現');
      expect(result).toContain('SQL injection');
      expect(result).not.toContain('Overview');
    });

    it('json-only extracts JSON from markdown', () => {
      const input = 'Some text\n\n```json\n{"key":"value"}\n```\n\nMore text.';
      const result = applyFilter('json-only', input);
      expect(result).toBe('{"key":"value"}');
    });

    it('json-only returns pure JSON unchanged', () => {
      const input = '{"key":"value"}';
      const result = applyFilter('json-only', input);
      expect(result).toBe(input);
    });

    it('blog-source-material wraps content with header', () => {
      const input = 'Research findings about AI.';
      const result = applyFilter('blog-source-material', input);
      expect(result).toContain('上游研究資料');
      expect(result).toContain('Research findings about AI.');
    });

    it('blog-source-material truncates very long input', () => {
      const input = 'x'.repeat(5000);
      const result = applyFilter('blog-source-material', input);
      expect(result).toContain('內容過長已截斷');
      expect(result.length).toBeLessThan(4000);
    });

    it('unknown filter name returns input unchanged', () => {
      const input = 'some text';
      expect(applyFilter('nonexistent-filter', input)).toBe(input);
    });

    // ── token-budget filter ────────────────────────────────────────
    // estimateTokens: ASCII char = 0.25 tokens, CJK = 2 tokens
    // DEFAULT_TOKEN_BUDGET = 8000 → need > 32000 ASCII chars to exceed

    it('token-budget passes input under 8000 tokens unchanged', () => {
      // ~5000 tokens (20000 ASCII chars) — under default budget of 8000
      const input = Array.from({ length: 400 }, (_, i) =>
        `Line ${i}: ${'x'.repeat(44)}`
      ).join('\n');
      expect(applyFilter('token-budget', input)).toBe(input);
    });

    it('token-budget truncates very long input via line-level cut', () => {
      // ~5000 lines * ~50 chars = ~250000 chars ≈ 62500 tokens → far over 16000
      const input = Array.from({ length: 5000 }, (_, i) =>
        `Line ${i}: ${'x'.repeat(44)}`
      ).join('\n');
      const result = applyFilter('token-budget', input);
      expect(result).toContain('上游輸出已壓縮');
      expect(result.length).toBeLessThan(input.length);
      expect(result).toContain('Line 0');
    });

    it('token-budget with custom budget override truncates at lower threshold', () => {
      // Use custom budget of 500 tokens → 2000 ASCII chars should trigger truncation
      const input = Array.from({ length: 200 }, (_, i) =>
        `Line ${i}: ${'x'.repeat(44)}`
      ).join('\n');
      const result = applyFilter('token-budget', input, 500);
      expect(result).toContain('上游輸出已壓縮');
      expect(result).toContain('Line 0');
      expect(result.length).toBeLessThan(input.length);
    });

    // ── safety-net: tokenBudget caps semantic filters ─────────────

    it('summary-only output is capped by tokenBudget safety net', () => {
      // Build a long summary section that exceeds 500 tokens
      const summaryLines = Array.from({ length: 100 }, (_, i) =>
        `Summary point ${i}: ${'important '.repeat(10)}`
      );
      const input = [
        '# Report',
        '',
        '## Summary',
        ...summaryLines,
        '',
        '## Details',
        'Not included.',
      ].join('\n');

      // Without budget: full summary passes through
      const noBudget = applyFilter('summary-only', input);
      expect(noBudget).toContain('Summary point 99');

      // With budget of 200 tokens: summary gets truncated
      const withBudget = applyFilter('summary-only', input, 200);
      expect(withBudget).toContain('Summary point 0');
      expect(withBudget).toContain('上游輸出已壓縮');
      expect(withBudget.length).toBeLessThan(noBudget.length);
    });

    it('passthrough is never capped by tokenBudget', () => {
      const input = 'x'.repeat(5000);
      const result = applyFilter('passthrough', input, 100);
      expect(result).toBe(input);
    });

    it('token-budget extracts summary when available in medium input', () => {
      // Use custom budget of 1000 to test medium range without massive input
      // 100 lines × ~14 tokens/line ≈ 1400 tokens → medium range (1000-2000)
      const filler = Array.from({ length: 100 }, (_, i) =>
        `Detail line ${i}: ${'data '.repeat(8)}`
      ).join('\n');
      const input = [
        '# Report',
        '',
        filler,
        '',
        '## 結論',
        'This is the key conclusion.',
        'Important takeaway here.',
      ].join('\n');

      const result = applyFilter('token-budget', input, 1000);
      expect(result).toContain('結論');
      expect(result).toContain('key conclusion');
      expect(result).not.toContain('Detail line 100');
    });
  });

  describe('isValidFilter()', () => {
    it('returns true for registered filters', () => {
      expect(isValidFilter('passthrough')).toBe(true);
      expect(isValidFilter('summary-only')).toBe(true);
      expect(isValidFilter('findings-only')).toBe(true);
      expect(isValidFilter('truncate-1000')).toBe(true);
      expect(isValidFilter('json-only')).toBe(true);
      expect(isValidFilter('blog-source-material')).toBe(true);
      expect(isValidFilter('token-budget')).toBe(true);
    });

    it('returns false for unknown filters', () => {
      expect(isValidFilter('unknown')).toBe(false);
    });
  });

  describe('getFilterNames()', () => {
    it('returns all registered filter names', () => {
      const names = getFilterNames();
      expect(names).toContain('passthrough');
      expect(names).toContain('summary-only');
      expect(names).toContain('findings-only');
      expect(names).toContain('truncate-1000');
      expect(names).toContain('json-only');
      expect(names).toContain('blog-source-material');
      expect(names).toContain('token-budget');
      expect(names).toHaveLength(7);
    });
  });
});
