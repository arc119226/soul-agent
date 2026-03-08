/**
 * Report site deploy workflow — hexo generate + wrangler pages deploy.
 *
 * Mirrors src/blog/deploy-workflow.ts but targets report/ directory
 * and the Cloudflare Pages report project.
 *
 * Uses execFile (not exec) — no shell injection.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);
const REPORT_DIR = join(process.cwd(), 'report');

export interface DeployResult {
  ok: boolean;
  message: string;
  url?: string;
}

/** Run hexo generate for the report site */
async function generate(): Promise<DeployResult> {
  try {
    const { stdout } = await execFileAsync('npx', ['hexo', 'generate'], {
      cwd: REPORT_DIR,
      timeout: 120_000,
    });
    const fileCount = (stdout.match(/Generated:/g) ?? []).length;
    return { ok: true, message: `Generated ${fileCount} files` };
  } catch (err) {
    return { ok: false, message: `Generate failed: ${(err as Error).message}` };
  }
}

/** Full deploy pipeline: hexo generate → wrangler pages deploy */
export async function deployReportSite(): Promise<DeployResult> {
  const genResult = await generate();
  if (!genResult.ok) {
    return genResult;
  }

  try {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (process.env.CLOUDFLARE_API_TOKEN) {
      env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
    }
    if (process.env.CLOUDFLARE_ACCOUNT_ID) {
      env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
    }

    await execFileAsync(
      'wrangler',
      ['pages', 'deploy', 'public/', '--project-name', config.CF_REPORT_PROJECT, '--branch', 'main', '--commit-dirty=true'],
      { cwd: REPORT_DIR, timeout: 120_000, env },
    );

    logger.info('report-deploy', 'Report site deployed successfully');
    return { ok: true, message: 'Report site deployed', url: config.REPORT_URL };
  } catch (err) {
    const msg = `Deploy failed: ${(err as Error).message}`;
    logger.error('report-deploy', msg);
    return { ok: false, message: msg };
  }
}
