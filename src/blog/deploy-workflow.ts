/**
 * Blog deploy workflow — hexo generate + wrangler pages deploy.
 *
 * Uses execFile (not exec) — arguments passed as arrays, no shell injection.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { writer } from '../core/debounced-writer.js';
import { generate } from './hexo-manager.js';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);
const BLOG_DIR = join(process.cwd(), 'blog');
const STATS_PATH = join(process.cwd(), 'soul', 'blog', 'blog-stats.json');

export interface DeployResult {
  ok: boolean;
  message: string;
  url?: string;
}

/** Full deploy pipeline: generate → deploy */
export async function deployBlog(): Promise<DeployResult> {
  // Step 1: Hexo generate
  const genResult = await generate();
  if (!genResult.ok) {
    return { ok: false, message: `生成失敗: ${genResult.message}` };
  }

  // Step 2: Wrangler pages deploy
  try {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (process.env.CLOUDFLARE_API_TOKEN) {
      env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
    }
    if (process.env.CLOUDFLARE_ACCOUNT_ID) {
      env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
    }

    const { stdout } = await execFileAsync(
      'wrangler',
      ['pages', 'deploy', 'public/', '--project-name', config.CF_BLOG_PROJECT, '--branch', 'main', '--commit-dirty=true'],
      { cwd: BLOG_DIR, timeout: 120_000, env },
    );

    // Extract deploy URL
    const projectSlug = config.CF_BLOG_PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const urlMatch = stdout.match(new RegExp(`https://\\S+\\.${projectSlug}\\.pages\\.dev`));
    const deployUrl = urlMatch ? urlMatch[0] : config.BLOG_URL;

    await logger.info('deploy-workflow', `Deployed successfully: ${deployUrl}`);

    // Update stats
    await updateDeployStats();

    return {
      ok: true,
      message: `部署成功！`,
      url: config.BLOG_URL,
    };
  } catch (err) {
    const msg = `部署失敗: ${(err as Error).message}`;
    await logger.error('deploy-workflow', msg);
    return { ok: false, message: msg };
  }
}

async function updateDeployStats(): Promise<void> {
  try {
    const raw = await readFile(STATS_PATH, 'utf-8');
    const stats = JSON.parse(raw);
    stats.deployments = (stats.deployments ?? 0) + 1;
    stats.lastDeployAt = new Date().toISOString();
    writer.schedule(STATS_PATH, stats);
  } catch {
    // Stats file may not exist yet
  }
}
