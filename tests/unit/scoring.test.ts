import { describe, it, expect } from 'vitest';
import { estimateTokens, scoreItem, selectRelevantMemory, type Scoreable } from '../../src/memory/scoring.js';

describe('Memory Scoring', () => {
  it('estimates tokens from text length', () => {
    const tokens = estimateTokens('Hello world');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it('scores items by composite factors', () => {
    const item: Scoreable = {
      tokenCost: 10,
      timestamp: new Date().toISOString(),
      accessCount: 5,
      importance: 3,
      content: 'test',
    };
    const score = scoreItem(item, 10);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('higher importance yields higher score', () => {
    const base = {
      tokenCost: 10,
      timestamp: new Date().toISOString(),
      accessCount: 5,
      content: 'test',
    };
    const low = scoreItem({ ...base, importance: 1 }, 10);
    const high = scoreItem({ ...base, importance: 5 }, 10);
    expect(high).toBeGreaterThan(low);
  });

  it('selects items within token budget', () => {
    const items: Scoreable[] = [
      { tokenCost: 50, timestamp: new Date().toISOString(), accessCount: 10, importance: 5, content: 'important' },
      { tokenCost: 50, timestamp: new Date(Date.now() - 86400000).toISOString(), accessCount: 1, importance: 1, content: 'less important' },
      { tokenCost: 50, timestamp: new Date().toISOString(), accessCount: 5, importance: 3, content: 'medium' },
    ];

    const selected = selectRelevantMemory(items, 100);
    expect(selected.length).toBeLessThanOrEqual(items.length);
    expect(selected.length).toBeGreaterThan(0);
    // Should pick the most important items first
    expect(selected.length).toBe(2); // Budget 100 fits 2 items at 50 each
  });
});
