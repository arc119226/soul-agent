import { describe, it, expect } from 'vitest';
import { tokenize, computeRelevance } from '../../src/memory/text-relevance.js';

describe('tokenize()', () => {
  describe('ASCII text', () => {
    it('splits by whitespace and lowercases', () => {
      const tokens = tokenize('Hello World');
      expect(tokens).toContain('hello');
      expect(tokens).toContain('world');
    });

    it('filters out single-character words', () => {
      const tokens = tokenize('I am a test');
      expect(tokens).not.toContain('i');
      expect(tokens).not.toContain('a');
      expect(tokens).toContain('am');
      expect(tokens).toContain('test');
    });

    it('handles underscores and hyphens within tokens', () => {
      const tokens = tokenize('my_var some-thing');
      expect(tokens).toContain('my_var');
      expect(tokens).toContain('some-thing');
    });
  });

  describe('CJK text', () => {
    it('extracts unigrams for each CJK character', () => {
      const tokens = tokenize('機器學習');
      expect(tokens).toContain('機');
      expect(tokens).toContain('器');
      expect(tokens).toContain('學');
      expect(tokens).toContain('習');
    });

    it('extracts bigrams from consecutive CJK characters', () => {
      const tokens = tokenize('機器學習');
      expect(tokens).toContain('機器');
      expect(tokens).toContain('器學');
      expect(tokens).toContain('學習');
    });

    it('does not create bigrams from a single CJK character', () => {
      // A single CJK char surrounded by ASCII — no bigram possible from run of length 1
      const tokens = tokenize('test 中 test');
      expect(tokens).toContain('中');
      // No bigrams from a run of length 1
      const bigrams = tokens.filter((t) => t.length === 2 && /[\u4e00-\u9fff]/.test(t));
      expect(bigrams).toHaveLength(0);
    });
  });

  describe('mixed CJK + ASCII', () => {
    it('extracts both ASCII words and CJK tokens', () => {
      const tokens = tokenize('TypeScript 開發者');
      expect(tokens).toContain('typescript');
      expect(tokens).toContain('開');
      expect(tokens).toContain('發');
      expect(tokens).toContain('者');
      expect(tokens).toContain('開發');
      expect(tokens).toContain('發者');
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty string', () => {
      expect(tokenize('')).toEqual([]);
    });

    it('returns empty array for only short ASCII words', () => {
      expect(tokenize('a b c')).toEqual([]);
    });
  });
});

describe('computeRelevance()', () => {
  it('returns high score for exact match', () => {
    const score = computeRelevance('hello world', 'hello world');
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  it('returns partial score for partial overlap', () => {
    const score = computeRelevance('hello world', 'hello there friend');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('adds substring bonus (+0.2) when query is literal substring of document', () => {
    const scoreSub = computeRelevance('test', 'this is a test case');
    const scoreNoSub = computeRelevance('test', 'testing things here');
    // "test" is literally in "this is a test case" → substring bonus
    expect(scoreSub).toBeGreaterThan(scoreNoSub);
  });

  it('returns 0 for empty query', () => {
    expect(computeRelevance('', 'some document')).toBe(0);
  });

  it('returns 0 for empty document', () => {
    expect(computeRelevance('some query', '')).toBe(0);
  });

  it('returns 0 when both are empty', () => {
    expect(computeRelevance('', '')).toBe(0);
  });

  it('handles CJK relevance', () => {
    const score = computeRelevance('機器學習', '我在學機器學習的課程');
    expect(score).toBeGreaterThan(0.5);
  });

  it('caps at 1.0 maximum', () => {
    const score = computeRelevance('hello', 'hello');
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0 when no tokens overlap', () => {
    const score = computeRelevance('alpha beta', 'gamma delta');
    expect(score).toBe(0);
  });
});
