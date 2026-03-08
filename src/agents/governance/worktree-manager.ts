/**
 * Worktree Manager — Git worktree lifecycle management for agent isolation.
 *
 * Phase 1: Create/remove/list worktrees with symlinks for shared resources.
 * Does NOT change any existing behavior — pure addition.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { symlink, rm, mkdir, readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../../core/logger.js';
import { ok, fail } from '../../result.js';
import type { Result } from '../../result.js';

const execFileAsync = promisify(execFile);

// ── Constants ──────────────────────────────────
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const WORKTREE_BASE = process.env.WORKTREE_BASE || join(homedir(), 'worktrees');
export const MAX_WORKTREES = parseInt(process.env.WORKTREE_MAX ?? '4', 10);
export const WORKTREE_TTL_MS = parseFloat(process.env.WORKTREE_TTL_HOURS ?? '2') * 3600_000;

// ── Symlink targets (shared resources) ─────────
const SYMLINK_TARGETS = [
  { name: 'soul', isDir: true },
  { name: 'node_modules', isDir: true },
  { name: 'data', isDir: true },
  { name: '.env', isDir: false },
] as const;

// ── Types ──────────────────────────────────────
export interface WorktreeInfo {
  taskId: string;        // 完整 taskId（建立時傳入的；listActiveWorktrees 時為空字串）
  shortId: string;       // 8 字元短 ID（用於路徑和 branch 名稱）
  path: string;           // e.g. ${WORKTREE_BASE}/task-abc12345
  branchName: string;     // e.g. agent/task-abc12345
  createdAt: string;      // ISO string
  status: 'active' | 'removing' | 'orphaned';
}

// ── Internal helpers ───────────────────────────

function getShortId(taskId: string): string {
  return taskId.slice(0, 8);
}

function getWorktreePath(taskId: string): string {
  return join(WORKTREE_BASE, `task-${getShortId(taskId)}`);
}

function getBranchName(taskId: string): string {
  return `agent/task-${getShortId(taskId)}`;
}

async function execGit(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd: PROJECT_ROOT,
    timeout: timeoutMs,
  });
}

// ── Public API ─────────────────────────────────

/**
 * Create a new git worktree for the given task, with symlinks for shared resources.
 */
export async function createTaskWorktree(taskId: string): Promise<Result<WorktreeInfo>> {
  const shortId = getShortId(taskId);
  const worktreePath = getWorktreePath(taskId);
  const branchName = getBranchName(taskId);

  try {
    // Check current worktree count
    const existing = await listActiveWorktrees();
    if (existing.length >= MAX_WORKTREES) {
      return fail(
        `Max worktrees reached (${MAX_WORKTREES}). Cannot create worktree for task ${shortId}.`,
        'Wait for existing tasks to complete or run cleanupOrphanWorktrees().',
      );
    }

    // Ensure base directory exists
    await mkdir(WORKTREE_BASE, { recursive: true });

    // Create worktree with a new branch based on current HEAD
    await execGit(['worktree', 'add', worktreePath, '-b', branchName]);

    // Create symlinks (remove git-checkout originals first, then symlink to shared resources)
    for (const { name, isDir } of SYMLINK_TARGETS) {
      const linkPath = join(worktreePath, name);
      const targetPath = join(PROJECT_ROOT, name);

      // Remove the git-checkout version (may be a dir or file)
      await rm(linkPath, { recursive: isDir, force: true });

      // Create symlink to shared resource
      await symlink(targetPath, linkPath);
    }

    const info: WorktreeInfo = {
      taskId,
      shortId,
      path: worktreePath,
      branchName,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    await logger.info('WorktreeManager', `Created worktree for task ${shortId}`, {
      path: worktreePath,
      branch: branchName,
    });

    return ok('Worktree created', info);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error('WorktreeManager', `Failed to create worktree for task ${shortId}: ${msg}`);
    return fail(`Failed to create worktree: ${msg}`);
  }
}

/**
 * Remove a worktree and its associated branch.
 * Falls back to rm -rf + git worktree prune if git worktree remove fails.
 */
export async function removeTaskWorktree(taskId: string): Promise<Result<void>> {
  const shortId = getShortId(taskId);
  const worktreePath = getWorktreePath(taskId);
  const branchName = getBranchName(taskId);

  try {
    // Attempt normal removal
    try {
      await execGit(['worktree', 'remove', worktreePath, '--force'], 15_000);
    } catch {
      // Fallback: manual cleanup + prune
      await rm(worktreePath, { recursive: true, force: true });
      await execGit(['worktree', 'prune'], 10_000);
    }

    // Attempt to delete the local branch (may already be gone after PR merge)
    try {
      await execGit(['branch', '-d', branchName], 5_000);
    } catch {
      // Branch may have been deleted by PR merge — that's fine
    }

    // Delete remote branch (non-blocking, best-effort)
    try {
      await execGit(['push', 'origin', '--delete', branchName], 10_000);
    } catch {
      // Remote branch may not exist or already deleted — that's fine
    }

    await logger.info('WorktreeManager', `Removed worktree for task ${shortId}`);
    return ok('Worktree removed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error('WorktreeManager', `Failed to remove worktree for task ${shortId}: ${msg}`);
    return fail(`Failed to remove worktree: ${msg}`);
  }
}

/**
 * List all active worktrees under WORKTREE_BASE.
 */
export async function listActiveWorktrees(): Promise<WorktreeInfo[]> {
  const results: WorktreeInfo[] = [];

  try {
    await mkdir(WORKTREE_BASE, { recursive: true });
    const entries = await readdir(WORKTREE_BASE);

    for (const entry of entries) {
      if (!entry.startsWith('task-')) continue;

      const fullPath = join(WORKTREE_BASE, entry);
      const entryStat = await stat(fullPath).catch(() => null);
      if (!entryStat?.isDirectory()) continue;

      // Parse .git file to extract branch info
      let branchName = 'unknown';
      try {
        const gitFilePath = join(fullPath, '.git');
        const gitContent = await readFile(gitFilePath, 'utf-8');
        // .git file contains: "gitdir: ${PROJECT_ROOT}/.git/worktrees/task-xxx"
        const match = gitContent.match(/worktrees\/(task-\w+)/);
        if (match?.[1]) {
          branchName = `agent/${match[1]}`;
        }
      } catch {
        // Cannot read .git file — possibly corrupted
      }

      // Derive shortId from directory name (task-{shortId} -> shortId)
      const shortId = entry.replace('task-', '');

      // Determine creation time from directory mtime
      const createdAt = entryStat.mtime.toISOString();

      // Determine status: orphaned if older than TTL
      const ageMs = Date.now() - entryStat.mtime.getTime();
      const status = ageMs > WORKTREE_TTL_MS ? 'orphaned' as const : 'active' as const;

      results.push({
        taskId: '',      // 從目錄名稱無法還原完整 taskId
        shortId,         // 從目錄名稱解析出的 8 字元 ID
        path: fullPath,
        branchName,
        createdAt,
        status,
      });
    }
  } catch (err) {
    await logger.warn('WorktreeManager', `Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}`);
  }

  return results;
}

/**
 * Clean up orphaned worktrees (those exceeding TTL or whose tasks have completed).
 */
export async function cleanupOrphanWorktrees(): Promise<void> {
  const worktrees = await listActiveWorktrees();
  let cleaned = 0;

  for (const wt of worktrees) {
    if (wt.status !== 'orphaned') continue;

    const result = await removeTaskWorktree(wt.shortId);
    if (result.ok) cleaned++;
  }

  // Prune any stale git worktree records
  try {
    await execGit(['worktree', 'prune'], 10_000);
  } catch {
    // Non-critical
  }

  // Batch cleanup stale remote agent branches
  try {
    const { stdout } = await execGit(['branch', '-r', '--list', 'origin/agent/task-*'], 10_000);
    const remoteBranches = stdout.trim().split('\n').map(b => b.trim()).filter(Boolean);
    const activeShortIds = new Set(worktrees.filter(w => w.status === 'active').map(w => w.shortId));
    for (const rb of remoteBranches) {
      const match = rb.match(/origin\/agent\/task-(\w+)/);
      const shortId = match?.[1];
      if (shortId && !activeShortIds.has(shortId)) {
        try {
          await execGit(['push', 'origin', '--delete', `agent/task-${shortId}`], 10_000);
        } catch { /* already gone */ }
      }
    }
  } catch { /* non-critical */ }

  if (cleaned > 0) {
    await logger.info('WorktreeManager', `Cleaned up ${cleaned} orphan worktree(s)`);
  }
}

/**
 * Quick lookup: does a worktree exist for the given taskId?
 */
export async function getWorktreeForTask(taskId: string): Promise<WorktreeInfo | null> {
  const worktreePath = getWorktreePath(taskId);

  try {
    const s = await stat(worktreePath);
    if (!s.isDirectory()) return null;

    return {
      taskId,
      shortId: getShortId(taskId),
      path: worktreePath,
      branchName: getBranchName(taskId),
      createdAt: s.mtime.toISOString(),
      status: (Date.now() - s.mtime.getTime()) > WORKTREE_TTL_MS ? 'orphaned' : 'active',
    };
  } catch {
    return null;
  }
}

// ── Exported constants (for testing) ───────────
export const _constants = {
  PROJECT_ROOT,
  WORKTREE_BASE,
  MAX_WORKTREES,
  WORKTREE_TTL_MS,
} as const;
