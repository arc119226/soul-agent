/**
 * Handoff Artifact — two-layer progressive disclosure for HANDOFF outputs.
 *
 * Envelope (~300-500 chars) is always inlined in downstream prompts.
 * Full output is written to data/handoff-artifacts/{taskId}.md for on-demand Read.
 */

import { writeFile, readFile, readdir, unlink, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../core/logger.js';

const ARTIFACT_DIR = join(process.cwd(), 'data', 'handoff-artifacts');
const ARTIFACT_TTL_MS = 24 * 3600_000; // 24 hours

async function ensureDir(): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
}

/** Write artifact file. Returns relative path on success, null on failure. */
export async function writeArtifact(opts: {
  taskId: string;
  sourceAgent: string;
  artifactType?: string;
  content: string;
  worktreePath?: string;
  branchName?: string;
}): Promise<string | null> {
  try {
    await ensureDir();
    const filename = `${opts.taskId}.md`;
    const absPath = join(ARTIFACT_DIR, filename);
    const relPath = `data/handoff-artifacts/${filename}`;

    const frontmatter = [
      '---',
      `source_agent: ${opts.sourceAgent}`,
      `task_id: ${opts.taskId}`,
      opts.artifactType ? `artifact_type: ${opts.artifactType}` : null,
      `timestamp: ${new Date().toISOString()}`,
      opts.worktreePath ? `worktree_path: ${opts.worktreePath}` : null,
      opts.branchName ? `branch_name: ${opts.branchName}` : null,
      '---',
      '',
    ].filter((line) => line !== null).join('\n');

    await writeFile(absPath, frontmatter + opts.content, 'utf-8');
    return relPath;
  } catch (err) {
    await logger.warn('HandoffArtifact',
      `Failed to write artifact for task ${opts.taskId}: ${(err as Error).message}`);
    return null;
  }
}

/** Read artifact file content (for fallback/testing). */
export async function readArtifact(taskId: string): Promise<string | null> {
  try {
    const absPath = join(ARTIFACT_DIR, `${taskId}.md`);
    return await readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/** Clean up expired artifacts (called from daily maintenance). */
export async function cleanupArtifacts(): Promise<{ removed: number; errors: number }> {
  let removed = 0;
  let errors = 0;
  try {
    await ensureDir();
    const files = await readdir(ARTIFACT_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const absPath = join(ARTIFACT_DIR, file);
        const fileStat = await stat(absPath);
        if (now - fileStat.mtimeMs > ARTIFACT_TTL_MS) {
          await unlink(absPath);
          removed++;
        }
      } catch {
        errors++;
      }
    }
  } catch (err) {
    await logger.warn('HandoffArtifact',
      `Artifact cleanup error: ${(err as Error).message}`);
    errors++;
  }
  return { removed, errors };
}
