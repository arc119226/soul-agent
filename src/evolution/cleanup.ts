/**
 * Post-evolution environment cleanup — removes stale state files, old safety tags, and monitors data dir size.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlink, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = process.cwd();
const PIPELINE_STATE_FILE = join(PROJECT_ROOT, 'data', 'pipeline-state.json');

/** Cross-platform directory size in MB (replaces Unix-only `du -sm`) */
async function getDirSizeMB(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirSizeMB(full);
    } else {
      try { total += (await stat(full)).size; } catch { /* skip */ }
    }
  }
  return Math.round(total / (1024 * 1024));
}

/** Remove the pipeline state file after a completed pipeline run */
export async function cleanupPipelineState(): Promise<Result> {
  try {
    await unlink(PIPELINE_STATE_FILE);
    logger.debug('cleanup', 'Removed pipeline-state.json');
    return ok('Pipeline state cleaned');
  } catch (err) {
    // File doesn't exist — that's fine
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok('Pipeline state already clean');
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('cleanup', `Failed to remove pipeline-state.json: ${msg}`);
    return fail(`Cleanup failed: ${msg}`);
  }
}

/** Remove safety tags older than retentionDays */
export async function cleanupOldSafetyTags(retentionDays = 7): Promise<Result<number>> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['tag', '-l', 'evolution-safety/*', '--format=%(refname:short) %(creatordate:unix)'],
      { cwd: PROJECT_ROOT, timeout: 10_000 },
    );

    if (!stdout.trim()) {
      return ok('No safety tags found', 0);
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const lines = stdout.trim().split('\n');
    let deleted = 0;

    for (const line of lines) {
      const parts = line.trim().split(' ');
      const tagName = parts[0];
      const timestamp = Number(parts[1]) * 1000; // unix seconds → ms

      if (!tagName || isNaN(timestamp)) continue;

      if (timestamp < cutoff) {
        try {
          await execFileAsync('git', ['tag', '-d', tagName], { cwd: PROJECT_ROOT, timeout: 5_000 });
          deleted++;
        } catch {
          logger.warn('cleanup', `Failed to delete tag: ${tagName}`);
        }
      }
    }

    if (deleted > 0) {
      logger.info('cleanup', `Cleaned up ${deleted} old safety tag(s)`);
    }
    return ok(`Cleaned ${deleted} tags`, deleted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('cleanup', `Failed to cleanup old safety tags: ${msg}`);
    return fail(`Tag cleanup failed: ${msg}`);
  }
}

/** Check data directory size and warn if it exceeds threshold */
export async function checkDataDirSize(warnMB = 100): Promise<Result<number>> {
  try {
    const dataDir = join(PROJECT_ROOT, 'data');
    // Check if data dir exists
    try {
      await stat(dataDir);
    } catch {
      return ok('No data directory', 0);
    }

    const sizeMB = await getDirSizeMB(dataDir);

    if (sizeMB > warnMB) {
      logger.warn('cleanup', `Data directory is ${sizeMB}MB (threshold: ${warnMB}MB)`);
    }
    return ok(`Data dir: ${sizeMB}MB`, sizeMB);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('cleanup', `Failed to check data dir size: ${msg}`);
    return fail(`Size check failed: ${msg}`);
  }
}

/** Main entry: run all post-evolution cleanup steps */
export async function runPostEvolutionCleanup(): Promise<Result> {
  logger.info('cleanup', 'Running post-evolution cleanup...');

  await cleanupPipelineState();
  await cleanupOldSafetyTags();
  await checkDataDirSize();

  logger.info('cleanup', 'Post-evolution cleanup complete');
  return ok('Cleanup complete');
}
