/**
 * Auto git push after successful evolution — with approval gating.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import { config } from '../config.js';
import { ok, fail, type Result } from '../result.js';
import type { Goal } from './goals.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = process.cwd();

/** Determine whether approval is needed based on config and complexity */
function needsApproval(complexity: string): boolean {
  const policy = config.AUTO_PUSH_REQUIRE_APPROVAL;
  if (policy === 'never') return false;
  if (policy === 'all') return true;
  if (policy === 'high') return complexity === 'high';
  if (policy === 'medium') return complexity === 'medium' || complexity === 'high';
  return false;
}

/** Wait for push approval via EventBus (timeout-based) */
async function waitForApproval(goalId: string, complexity: string, summary: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = config.APPROVAL_TIMEOUT || 120_000;

    const timer = setTimeout(() => {
      cleanup();
      logger.warn('git-push', `Push approval timed out for ${goalId}`);
      resolve(false);
    }, timeout);

    const onApproved = (data: { goalId: string }) => {
      if (data.goalId === goalId) {
        cleanup();
        resolve(true);
      }
    };

    const onDenied = (data: { goalId: string; reason: string }) => {
      if (data.goalId === goalId) {
        cleanup();
        logger.info('git-push', `Push denied for ${goalId}: ${data.reason}`);
        resolve(false);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      eventBus.off('evolution:push:approved', onApproved);
      eventBus.off('evolution:push:denied', onDenied);
    };

    eventBus.on('evolution:push:approved', onApproved);
    eventBus.on('evolution:push:denied', onDenied);

    // Emit request
    eventBus.emit('evolution:push:request', { goalId, complexity, summary }).catch(() => {});
  });
}

/** Get current git branch name */
async function getCurrentBranch(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: PROJECT_ROOT,
    timeout: 5_000,
  });
  return stdout.trim();
}

/** Push evolution changes after successful pipeline */
export async function pushAfterEvolution(
  goal: Goal,
  complexity: string,
  commitHash: string,
): Promise<Result<string>> {
  if (!config.AUTO_PUSH_ENABLED) {
    return ok('Auto push disabled', 'disabled');
  }

  if (!commitHash) {
    return ok('No commit to push', 'no-commit');
  }

  // Check if approval is needed
  if (needsApproval(complexity)) {
    logger.info('git-push', `Requesting push approval for ${goal.id} (${complexity})`);
    const approved = await waitForApproval(
      goal.id,
      complexity,
      `${goal.description} (${goal.tags.join(', ')})`,
    );

    if (!approved) {
      await eventBus.emit('evolution:push:failed', {
        goalId: goal.id,
        error: 'Approval denied or timed out',
      });
      return ok('Push skipped (not approved)', 'not-approved');
    }
  }

  // Execute push
  try {
    const branch = await getCurrentBranch();
    await execFileAsync('git', ['push', 'origin', branch], {
      cwd: PROJECT_ROOT,
      timeout: 30_000,
    });

    logger.info('git-push', `Pushed ${commitHash.slice(0, 7)} to origin/${branch}`);
    await eventBus.emit('evolution:push:success', { goalId: goal.id, commitHash });
    return ok('Push successful', commitHash);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('git-push', `Push failed: ${msg}`);
    await eventBus.emit('evolution:push:failed', { goalId: goal.id, error: msg });
    return fail(`Push failed: ${msg}`);
  }
}
