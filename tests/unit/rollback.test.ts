import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:util', () => ({
  promisify: () => mockExecFile,
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  createSafetyTag,
  rollback,
  getLatestCommitHash,
  commitEvolutionWithMessage,
  commitEvolution,
  cleanupSafetyTag,
} from '../../src/evolution/rollback.js';

/** Helper: check if any call's argv array matches expected args */
function hasCallWithArgs(args: string[]): boolean {
  return mockExecFile.mock.calls.some(
    (c: unknown[]) => Array.isArray(c[1]) && JSON.stringify(c[1]) === JSON.stringify(args),
  );
}

/** Helper: find a call whose argv array contains a specific element */
function findCallContaining(arg: string): unknown[] | undefined {
  return mockExecFile.mock.calls.find(
    (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes(arg),
  );
}

describe('Rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createSafetyTag()', () => {
    it('creates a tag with correct naming convention', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await createSafetyTag('goal-001');
      expect(result.ok).toBe(true);

      // Should call: git add -A, git commit ..., git tag -f <tagName>
      expect(hasCallWithArgs(['add', '-A'])).toBe(true);
      expect(findCallContaining('commit')).toBeTruthy();
      expect(hasCallWithArgs(['tag', '-f', 'evolution-safety/goal-001'])).toBe(true);
    });

    it('returns ok even if nothing to commit', async () => {
      mockExecFile
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockRejectedValueOnce(new Error('nothing to commit')) // git commit
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git tag

      const result = await createSafetyTag('goal-002');
      expect(result.ok).toBe(true);
    });

    it('returns fail when tag creation fails', async () => {
      mockExecFile
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
        .mockRejectedValueOnce(new Error('git tag failed')); // git tag

      const result = await createSafetyTag('goal-003');
      expect(result.ok).toBe(false);
    });
  });

  describe('rollback()', () => {
    it('resets to the correct safety tag', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await rollback('goal-004');
      expect(result.ok).toBe(true);

      expect(hasCallWithArgs(['rev-parse', 'evolution-safety/goal-004'])).toBe(true);
      expect(hasCallWithArgs(['reset', '--hard', 'evolution-safety/goal-004'])).toBe(true);
    });

    it('returns fail when tag does not exist', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('unknown revision'));

      const result = await rollback('no-such-goal');
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain('Safety tag not found');
    });

    it('returns fail when reset fails', async () => {
      mockExecFile
        .mockResolvedValueOnce({ stdout: 'abc123', stderr: '' }) // rev-parse OK
        .mockRejectedValueOnce(new Error('reset failed')); // reset --hard fails

      const result = await rollback('goal-005');
      expect(result.ok).toBe(false);
    });
  });

  describe('getLatestCommitHash()', () => {
    it('returns ok with trimmed hash', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: 'abc123def456\n', stderr: '' });

      const result = await getLatestCommitHash();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('abc123def456');
      }
    });

    it('returns fail on error', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('not a git repo'));

      const result = await getLatestCommitHash();
      expect(result.ok).toBe(false);
    });
  });

  describe('commitEvolutionWithMessage()', () => {
    it('commits with provided message', async () => {
      mockExecFile
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' }); // rev-parse

      const result = await commitEvolutionWithMessage('goal-006', 'feat: add feature');
      expect(result.ok).toBe(true);

      // commit call args: ['commit', '-m', message]
      const commitCall = findCallContaining('commit');
      expect(commitCall).toBeTruthy();
      const args = commitCall![1] as string[];
      expect(args).toContain('feat: add feature');
    });

    it('returns ok with empty string when nothing to commit', async () => {
      mockExecFile
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockRejectedValueOnce(new Error('nothing to commit')); // git commit

      const result = await commitEvolutionWithMessage('goal-007', 'no changes');
      expect(result.ok).toBe(true);
    });

    it('passes message directly without shell escaping', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'abc\n', stderr: '' });

      await commitEvolutionWithMessage('goal-008', 'fix "bug"');

      // With execFile, the message is passed as-is (no shell escaping needed)
      const commitCall = findCallContaining('commit');
      const args = commitCall![1] as string[];
      expect(args).toContain('fix "bug"');
    });
  });

  describe('commitEvolution()', () => {
    it('uses conventional commit format', async () => {
      mockExecFile.mockResolvedValue({ stdout: 'abc\n', stderr: '' });

      await commitEvolution('goal-009', 'add logging');

      const commitCall = findCallContaining('commit');
      const args = commitCall![1] as string[];
      expect(args).toContain('evolution(goal-009): add logging');
    });
  });

  describe('cleanupSafetyTag()', () => {
    it('deletes the tag', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await cleanupSafetyTag('goal-010');

      expect(hasCallWithArgs(['tag', '-d', 'evolution-safety/goal-010'])).toBe(true);
    });

    it('does not throw if tag deletion fails', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('tag not found'));

      await expect(cleanupSafetyTag('no-tag')).resolves.not.toThrow();
    });
  });
});
