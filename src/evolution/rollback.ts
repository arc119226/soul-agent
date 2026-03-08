/**
 * Git-based rollback — safety tags before evolution, revert on failure.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = process.cwd();

function gitExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd: PROJECT_ROOT, timeout: 30_000 });
}

/** Create a safety tag before evolution begins */
export async function createSafetyTag(goalId: string): Promise<Result<string>> {
  try {
    const tagName = `evolution-safety/${goalId}`;

    // Stage and commit any uncommitted changes first
    try {
      await gitExec(['add', '-A']);
      await gitExec(['commit', '-m', `pre-evolution checkpoint: ${goalId}`, '--allow-empty']);
    } catch {
      // It's ok if there's nothing to commit
    }

    // Create the tag
    await gitExec(['tag', '-f', tagName]);
    logger.info('rollback', `Created safety tag: ${tagName}`);
    return ok('Safety tag created', tagName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('rollback', `Failed to create safety tag for ${goalId}`, err);
    return fail(`Failed to create safety tag: ${msg}`);
  }
}

/** Rollback to a safety tag */
export async function rollback(goalId: string): Promise<Result> {
  try {
    const tagName = `evolution-safety/${goalId}`;

    // Check tag exists
    try {
      await gitExec(['rev-parse', tagName]);
    } catch {
      return fail(`Safety tag not found: ${tagName}`, 'Ensure createSafetyTag was called before evolution');
    }

    // Reset to the tagged state
    await gitExec(['reset', '--hard', tagName]);
    logger.warn('rollback', `Rolled back to safety tag: ${tagName}`);
    return ok('Rollback completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('rollback', `Rollback failed for ${goalId}`, err);
    return fail(`Rollback failed: ${msg}`, 'Manual intervention may be required');
  }
}

/** Get the current HEAD commit hash */
export async function getLatestCommitHash(): Promise<Result<string>> {
  try {
    const { stdout } = await gitExec(['rev-parse', 'HEAD']);
    return ok('Got commit hash', stdout.trim());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Failed to get commit hash: ${msg}`);
  }
}

/** Commit current changes with a custom commit message */
export async function commitEvolutionWithMessage(_goalId: string, message: string): Promise<Result<string>> {
  try {
    await gitExec(['add', '-A']);
    await gitExec(['commit', '-m', message]);
    const { stdout } = await gitExec(['rev-parse', 'HEAD']);
    logger.info('rollback', `Committed evolution: ${message.split('\n')[0]}`);
    return ok('Evolution committed', stdout.trim());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('nothing to commit')) {
      return ok('No changes to commit', '');
    }
    logger.error('rollback', `Failed to commit evolution`, err);
    return fail(`Failed to commit: ${msg}`);
  }
}

/** Commit current changes after successful evolution (backward-compatible wrapper) */
export async function commitEvolution(goalId: string, description: string): Promise<Result<string>> {
  const message = `evolution(${goalId}): ${description}`;
  return commitEvolutionWithMessage(goalId, message);
}

/** Clean up a safety tag after successful evolution */
export async function cleanupSafetyTag(goalId: string): Promise<void> {
  try {
    const tagName = `evolution-safety/${goalId}`;
    await gitExec(['tag', '-d', tagName]);
    logger.debug('rollback', `Cleaned up safety tag: ${tagName}`);
  } catch {
    // Non-critical if cleanup fails
  }
}
