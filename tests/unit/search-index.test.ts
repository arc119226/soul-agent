import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies to avoid side effects from singleton
vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), clear: vi.fn() },
}));
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { tokenize } from '../../src/memory/text-relevance.js';
import type { IndexDocument } from '../../src/memory/search-index.js';

function makeDoc(id: string, text: string, source: IndexDocument['source'] = 'fact'): IndexDocument {
  return { id, source, text, tokens: tokenize(text) };
}

describe('MemorySearchIndex', () => {
  let searchIndex: typeof import('../../src/memory/search-index.js')['searchIndex'];

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../src/core/event-bus.js', () => ({
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), clear: vi.fn() },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod = await import('../../src/memory/search-index.js');
    searchIndex = mod.searchIndex;
  });

  describe('upsert()', () => {
    it('adds a new document', () => {
      searchIndex.upsert(makeDoc('d1', 'hello world'));
      expect(searchIndex.documentCount).toBe(1);
    });

    it('updates an existing document with same id', () => {
      searchIndex.upsert(makeDoc('d1', 'old text'));
      searchIndex.upsert(makeDoc('d1', 'new text'));
      expect(searchIndex.documentCount).toBe(1);

      const results = searchIndex.search('new text');
      expect(results.length).toBe(1);
      expect(results[0]!.doc.text).toBe('new text');
    });

    it('handles multiple documents', () => {
      searchIndex.upsert(makeDoc('d1', 'alpha'));
      searchIndex.upsert(makeDoc('d2', 'beta'));
      searchIndex.upsert(makeDoc('d3', 'gamma'));
      expect(searchIndex.documentCount).toBe(3);
    });
  });

  describe('remove()', () => {
    it('removes a document from the index', () => {
      searchIndex.upsert(makeDoc('d1', 'findable text'));
      searchIndex.remove('d1');
      expect(searchIndex.documentCount).toBe(0);
      expect(searchIndex.search('findable')).toEqual([]);
    });

    it('does nothing for nonexistent id', () => {
      searchIndex.upsert(makeDoc('d1', 'text'));
      searchIndex.remove('nonexistent');
      expect(searchIndex.documentCount).toBe(1);
    });
  });

  describe('search()', () => {
    it('returns empty array for empty index', () => {
      expect(searchIndex.search('anything')).toEqual([]);
    });

    it('returns empty array for empty query tokens', () => {
      searchIndex.upsert(makeDoc('d1', 'some text'));
      // Single character ASCII — filtered by tokenize
      expect(searchIndex.search('a')).toEqual([]);
    });

    it('finds a matching document', () => {
      searchIndex.upsert(makeDoc('d1', 'TypeScript is great'));
      const results = searchIndex.search('typescript');
      expect(results.length).toBe(1);
      expect(results[0]!.doc.id).toBe('d1');
    });

    it('ranks higher-relevance documents first', () => {
      // d1 mentions "machine learning" twice in different forms
      searchIndex.upsert(makeDoc('d1', 'machine learning is a subset of machine intelligence'));
      // d2 mentions it once
      searchIndex.upsert(makeDoc('d2', 'machine tools are useful'));
      // d3 has no overlap
      searchIndex.upsert(makeDoc('d3', 'cooking recipes are fun'));

      const results = searchIndex.search('machine learning');
      expect(results.length).toBeGreaterThanOrEqual(1);
      // d1 should score highest (more overlapping terms)
      expect(results[0]!.doc.id).toBe('d1');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 20; i++) {
        searchIndex.upsert(makeDoc(`d${i}`, `document number ${i} about testing`));
      }
      const results = searchIndex.search('testing', 5);
      expect(results.length).toBe(5);
    });

    it('handles CJK search', () => {
      searchIndex.upsert(makeDoc('d1', '機器學習是人工智慧的一個分支'));
      searchIndex.upsert(makeDoc('d2', '今天天氣很好'));

      const results = searchIndex.search('機器學習');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.doc.id).toBe('d1');
    });

    it('scores are positive numbers', () => {
      searchIndex.upsert(makeDoc('d1', 'test document'));
      const results = searchIndex.search('test');
      expect(results[0]!.score).toBeGreaterThan(0);
    });
  });

  describe('documentCount', () => {
    it('starts at 0', () => {
      expect(searchIndex.documentCount).toBe(0);
    });

    it('tracks upserts and removes', () => {
      searchIndex.upsert(makeDoc('d1', 'one'));
      searchIndex.upsert(makeDoc('d2', 'two'));
      expect(searchIndex.documentCount).toBe(2);

      searchIndex.remove('d1');
      expect(searchIndex.documentCount).toBe(1);
    });
  });

  describe('isInitialized', () => {
    it('starts as false', () => {
      expect(searchIndex.isInitialized).toBe(false);
    });
  });
});
