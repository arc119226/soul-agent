import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

describe('GenesisGuard', () => {
  let validateGenesisModification: typeof import('../../src/identity/genesis-guard.js')['validateGenesisModification'];
  let getChapter0: typeof import('../../src/identity/genesis-guard.js')['getChapter0'];
  let getGenesis: typeof import('../../src/identity/genesis-guard.js')['getGenesis'];
  let mockReadFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockReadFile = vi.fn();
    vi.doMock('node:fs/promises', () => ({ readFile: mockReadFile }));

    const mod = await import('../../src/identity/genesis-guard.js');
    validateGenesisModification = mod.validateGenesisModification;
    getChapter0 = mod.getChapter0;
    getGenesis = mod.getGenesis;
  });

  describe('splitChapters() (tested via validateGenesisModification)', () => {
    it('correctly identifies chapter0 with separator', async () => {
      const original = 'Chapter 0 content\n---\nChapter 1 content';
      mockReadFile.mockResolvedValue(original);

      // Proposing the same content should pass
      const result = await validateGenesisModification(original);
      expect(result.ok).toBe(true);
    });

    it('treats entire document as chapter0 when no separator', async () => {
      const original = 'Only chapter 0, no separator';
      mockReadFile.mockResolvedValue(original);

      // Modifying anything should fail since it's all chapter 0
      const result = await validateGenesisModification('Modified content');
      expect(result.ok).toBe(false);
    });
  });

  describe('validateGenesisModification()', () => {
    it('fails when chapter0 is modified', async () => {
      const original = 'Sacred words\n---\nChapter 1';
      mockReadFile.mockResolvedValue(original);

      const proposed = 'Changed words\n---\nChapter 1';
      const result = await validateGenesisModification(proposed);
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toContain('immutable');
    });

    it('fails when existing later chapters are modified', async () => {
      const original = 'Sacred words\n---\nChapter 1 original';
      mockReadFile.mockResolvedValue(original);

      const proposed = 'Sacred words\n---\nChapter 1 MODIFIED';
      const result = await validateGenesisModification(proposed);
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toContain('cannot be modified');
    });

    it('allows pure append of new chapters', async () => {
      const original = 'Sacred words\n---\nChapter 1';
      mockReadFile.mockResolvedValue(original);

      const proposed = 'Sacred words\n---\nChapter 1\n---\nChapter 2 appended';
      const result = await validateGenesisModification(proposed);
      expect(result.ok).toBe(true);
    });

    it('allows append when original has no later chapters', async () => {
      const original = 'Sacred words\n---\n';
      mockReadFile.mockResolvedValue(original);

      const proposed = 'Sacred words\n---\nNew chapter';
      const result = await validateGenesisModification(proposed);
      expect(result.ok).toBe(true);
    });

    it('fails when genesis file cannot be read', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await validateGenesisModification('anything');
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toContain('Cannot read');
    });
  });

  describe('getChapter0()', () => {
    it('returns chapter0 content', async () => {
      mockReadFile.mockResolvedValue('Creator words\n---\nLater stuff');

      const ch0 = await getChapter0();
      expect(ch0).toBe('Creator words\n---\n');
    });

    it('returns entire content when no separator', async () => {
      mockReadFile.mockResolvedValue('All chapter 0');

      const ch0 = await getChapter0();
      expect(ch0).toBe('All chapter 0');
    });

    it('returns empty string when file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const ch0 = await getChapter0();
      expect(ch0).toBe('');
    });
  });

  describe('getGenesis()', () => {
    it('returns full genesis content', async () => {
      const content = 'Full genesis\n---\nWith chapters';
      mockReadFile.mockResolvedValue(content);

      const result = await getGenesis();
      expect(result).toBe(content);
    });

    it('returns empty string when file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await getGenesis();
      expect(result).toBe('');
    });
  });
});
