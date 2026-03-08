import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  symlink: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
  },
}));

import { execFile } from 'node:child_process';
import { symlink, rm, mkdir, readdir, stat, readFile } from 'node:fs/promises';
import {
  createTaskWorktree,
  removeTaskWorktree,
  listActiveWorktrees,
  cleanupOrphanWorktrees,
  getWorktreeForTask,
  _constants,
} from '../../src/agents/governance/worktree-manager.js';

// ── Helpers ─────────────────────────────────────────────────────────

const mockExecFile = execFile as unknown as Mock;

/** Make promisified execFile resolve successfully */
function mockExecFileSuccess(stdout = '', stderr = '') {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      if (cb) {
        cb(null, { stdout, stderr });
      }
      // Return a fake ChildProcess to satisfy promisify
      return { pid: 1234 };
    },
  );
}

/** Make promisified execFile reject */
function mockExecFileError(message = 'git error') {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) {
        cb(new Error(message));
      }
      return { pid: 1234 };
    },
  );
}

const TASK_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SHORT_ID = 'a1b2c3d4';

// ── Tests ───────────────────────────────────────────────────────────

describe('WorktreeManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: readdir returns no task directories (empty worktree base)
    (readdir as Mock).mockResolvedValue([]);
  });

  describe('createTaskWorktree()', () => {
    it('creates worktree with correct git command and symlinks', async () => {
      mockExecFileSuccess();

      const result = await createTaskWorktree(TASK_ID);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.taskId).toBe(TASK_ID);
      expect(result.value.shortId).toBe(SHORT_ID);
      expect(result.value.path).toBe(join(_constants.WORKTREE_BASE, `task-${SHORT_ID}`));
      expect(result.value.branchName).toBe(`agent/task-${SHORT_ID}`);
      expect(result.value.status).toBe('active');

      // Verify git worktree add was called
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'add', join(_constants.WORKTREE_BASE, `task-${SHORT_ID}`), '-b', `agent/task-${SHORT_ID}`],
        expect.objectContaining({ cwd: _constants.PROJECT_ROOT }),
        expect.any(Function),
      );

      // Verify symlinks were created (4 symlinks: soul, node_modules, data, .env)
      expect(rm).toHaveBeenCalledTimes(4);
      expect(symlink).toHaveBeenCalledTimes(4);

      // Verify soul symlink
      expect(symlink).toHaveBeenCalledWith(
        join(_constants.PROJECT_ROOT, 'soul'),
        join(_constants.WORKTREE_BASE, `task-${SHORT_ID}`, 'soul'),
      );

      // Verify node_modules symlink
      expect(symlink).toHaveBeenCalledWith(
        join(_constants.PROJECT_ROOT, 'node_modules'),
        join(_constants.WORKTREE_BASE, `task-${SHORT_ID}`, 'node_modules'),
      );
    });

    it('fails when MAX_WORKTREES limit is reached', async () => {
      // Use actual MAX_WORKTREES value so test works regardless of env
      const fakeDirs = Array.from({ length: _constants.MAX_WORKTREES }, (_, i) => `task-${String(i).padStart(8, '0')}`);
      (readdir as Mock).mockResolvedValue(fakeDirs);
      (stat as Mock).mockResolvedValue({
        isDirectory: () => true,
        mtime: new Date(), // recent — not orphaned
      });
      (readFile as Mock).mockResolvedValue('gitdir: /mnt/d/gitcode/mybotteam/.git/worktrees/task-00000000');

      const result = await createTaskWorktree(TASK_ID);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Max worktrees reached');
    });

    it('returns fail on git command error', async () => {
      mockExecFileError('fatal: branch already exists');

      const result = await createTaskWorktree(TASK_ID);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('branch already exists');
    });

    it('ensures WORKTREE_BASE directory exists via mkdir', async () => {
      mockExecFileSuccess();

      await createTaskWorktree(TASK_ID);

      expect(mkdir).toHaveBeenCalledWith(_constants.WORKTREE_BASE, { recursive: true });
    });
  });

  describe('removeTaskWorktree()', () => {
    it('removes worktree and branch successfully', async () => {
      mockExecFileSuccess();

      const result = await removeTaskWorktree(TASK_ID);

      expect(result.ok).toBe(true);

      // Verify git worktree remove was called
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'remove', join(_constants.WORKTREE_BASE, `task-${SHORT_ID}`), '--force'],
        expect.objectContaining({ cwd: _constants.PROJECT_ROOT }),
        expect.any(Function),
      );

      // Verify branch deletion was attempted
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['branch', '-d', `agent/task-${SHORT_ID}`],
        expect.objectContaining({ cwd: _constants.PROJECT_ROOT }),
        expect.any(Function),
      );
    });

    it('falls back to rm + prune when git worktree remove fails', async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
          callCount++;
          if (cb) {
            // First call (worktree remove) fails, subsequent calls succeed
            if (args[0] === 'worktree' && args[1] === 'remove') {
              cb(new Error('worktree locked'));
            } else {
              cb(null, { stdout: '', stderr: '' });
            }
          }
          return { pid: 1234 };
        },
      );

      const result = await removeTaskWorktree(TASK_ID);

      expect(result.ok).toBe(true);

      // Verify fallback: rm was called
      expect(rm).toHaveBeenCalledWith(
        join(_constants.WORKTREE_BASE, `task-${SHORT_ID}`),
        { recursive: true, force: true },
      );

      // Verify fallback: git worktree prune was called
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'prune'],
        expect.objectContaining({ cwd: _constants.PROJECT_ROOT }),
        expect.any(Function),
      );
    });

    it('succeeds even if branch deletion fails (already merged)', async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
          callCount++;
          if (cb) {
            // Branch delete fails, everything else succeeds
            if (args[0] === 'branch') {
              cb(new Error('branch not found'));
            } else {
              cb(null, { stdout: '', stderr: '' });
            }
          }
          return { pid: 1234 };
        },
      );

      const result = await removeTaskWorktree(TASK_ID);
      expect(result.ok).toBe(true);
    });
  });

  describe('listActiveWorktrees()', () => {
    it('returns empty array when no worktrees exist', async () => {
      (readdir as Mock).mockResolvedValue([]);

      const result = await listActiveWorktrees();
      expect(result).toEqual([]);
    });

    it('lists task directories and parses .git file for branch info', async () => {
      (readdir as Mock).mockResolvedValue(['task-abcd1234', 'not-a-task', 'task-efgh5678']);
      (stat as Mock).mockResolvedValue({
        isDirectory: () => true,
        mtime: new Date(),
      });
      (readFile as Mock).mockResolvedValue(
        'gitdir: /mnt/d/gitcode/mybotteam/.git/worktrees/task-abcd1234\n',
      );

      const result = await listActiveWorktrees();

      expect(result).toHaveLength(2);
      expect(result[0]!.taskId).toBe('');
      expect(result[0]!.shortId).toBe('abcd1234');
      expect(result[0]!.branchName).toBe('agent/task-abcd1234');
      expect(result[0]!.status).toBe('active');
    });

    it('marks worktrees older than TTL as orphaned', async () => {
      const oldDate = new Date(Date.now() - _constants.WORKTREE_TTL_MS - 60_000); // TTL + 1 min
      (readdir as Mock).mockResolvedValue(['task-old12345']);
      (stat as Mock).mockResolvedValue({
        isDirectory: () => true,
        mtime: oldDate,
      });
      (readFile as Mock).mockResolvedValue(
        'gitdir: /mnt/d/gitcode/mybotteam/.git/worktrees/task-old12345\n',
      );

      const result = await listActiveWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe('orphaned');
    });

    it('skips non-directory entries', async () => {
      (readdir as Mock).mockResolvedValue(['task-file1234']);
      (stat as Mock).mockResolvedValue({
        isDirectory: () => false,
        mtime: new Date(),
      });

      const result = await listActiveWorktrees();
      expect(result).toHaveLength(0);
    });
  });

  describe('cleanupOrphanWorktrees()', () => {
    it('removes orphaned worktrees and prunes git', async () => {
      const oldDate = new Date(Date.now() - _constants.WORKTREE_TTL_MS - 60_000);
      (readdir as Mock).mockResolvedValueOnce(['task-orphan01']);
      (stat as Mock).mockResolvedValue({
        isDirectory: () => true,
        mtime: oldDate,
      });
      (readFile as Mock).mockResolvedValue(
        'gitdir: /mnt/d/gitcode/mybotteam/.git/worktrees/task-orphan01\n',
      );
      mockExecFileSuccess();

      await cleanupOrphanWorktrees();

      // Verify remove was called for the orphaned worktree
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object),
        expect.any(Function),
      );

      // Verify prune was called at the end
      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['worktree', 'prune'],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('does nothing when no orphaned worktrees exist', async () => {
      (readdir as Mock).mockResolvedValue(['task-active01']);
      (stat as Mock).mockResolvedValue({
        isDirectory: () => true,
        mtime: new Date(), // recent — not orphaned
      });
      (readFile as Mock).mockResolvedValue('gitdir: ...');
      mockExecFileSuccess();

      await cleanupOrphanWorktrees();

      // Only the final prune call, no worktree remove
      const removeCalls = mockExecFile.mock.calls.filter(
        (c: string[][]) => c[1]?.[0] === 'worktree' && c[1]?.[1] === 'remove',
      );
      expect(removeCalls).toHaveLength(0);
    });
  });

  describe('getWorktreeForTask()', () => {
    it('returns WorktreeInfo when worktree exists', async () => {
      (stat as Mock).mockResolvedValue({
        isDirectory: () => true,
        mtime: new Date(),
      });

      const result = await getWorktreeForTask(TASK_ID);

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe(TASK_ID);
      expect(result!.shortId).toBe(SHORT_ID);
      expect(result!.path).toBe(join(_constants.WORKTREE_BASE, `task-${SHORT_ID}`));
      expect(result!.branchName).toBe(`agent/task-${SHORT_ID}`);
      expect(result!.status).toBe('active');
    });

    it('returns null when worktree does not exist', async () => {
      (stat as Mock).mockRejectedValue(new Error('ENOENT'));

      const result = await getWorktreeForTask(TASK_ID);
      expect(result).toBeNull();
    });

    it('returns orphaned status for old worktrees', async () => {
      const oldDate = new Date(Date.now() - _constants.WORKTREE_TTL_MS - 60_000);
      (stat as Mock).mockResolvedValue({
        isDirectory: () => true,
        mtime: oldDate,
      });

      const result = await getWorktreeForTask(TASK_ID);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('orphaned');
    });
  });
});
