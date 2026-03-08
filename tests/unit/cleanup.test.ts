import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanupPipelineState, checkDataDirSize, runPostEvolutionCleanup } from '../../src/evolution/cleanup.js';

// Mock fs operations
vi.mock('node:fs/promises', () => ({
  unlink: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
}));

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock debounced writer
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn(), writeNow: vi.fn() },
}));

describe('cleanup module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cleanupPipelineState', () => {
    it('returns ok when file is successfully deleted', async () => {
      const { unlink } = await import('node:fs/promises');
      (unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await cleanupPipelineState();
      expect(result.ok).toBe(true);
    });

    it('returns ok when file does not exist (ENOENT)', async () => {
      const { unlink } = await import('node:fs/promises');
      const enoent = Object.assign(new Error('file not found'), { code: 'ENOENT' });
      (unlink as ReturnType<typeof vi.fn>).mockRejectedValue(enoent);

      const result = await cleanupPipelineState();
      expect(result.ok).toBe(true);
    });

    it('returns fail on other errors', async () => {
      const { unlink } = await import('node:fs/promises');
      (unlink as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('permission denied'));

      const result = await cleanupPipelineState();
      expect(result.ok).toBe(false);
    });
  });

  describe('checkDataDirSize', () => {
    it('returns ok with 0 when data dir does not exist', async () => {
      const { stat } = await import('node:fs/promises');
      (stat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

      const result = await checkDataDirSize();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });
  });

  describe('runPostEvolutionCleanup', () => {
    it('returns ok even if individual steps fail', async () => {
      const { unlink, stat } = await import('node:fs/promises');
      (unlink as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      (stat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

      const result = await runPostEvolutionCleanup();
      expect(result.ok).toBe(true);
    });
  });
});
