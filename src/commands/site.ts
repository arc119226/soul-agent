/**
 * /site command — Manage example.com from Telegram.
 *
 * Usage:
 *   /site         — Show site status
 *   /site deploy  — Build + deploy to Cloudflare Pages
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { commandRegistry } from '../telegram/command-registry.js';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);

/** Absolute path to the my-site project */
const SITE_DIR = join(process.cwd(), '..', 'my-site');
const SITE_URL = 'https://example.com';

// ── Deploy ──────────────────────────────────────────────────────────

async function handleDeploy(ctx: import('../bot.js').BotContext): Promise<void> {
  await ctx.reply('⏳ 正在構建 example.com ...');

  const env: Record<string, string> = { ...process.env as Record<string, string> };

  try {
    // Step 1: Build (reads soul/ data → generates static site)
    const buildResult = await execFileAsync(
      'npm', ['run', 'build'],
      { cwd: SITE_DIR, timeout: 60_000, env },
    );
    await logger.info('site-deploy', `Build output: ${buildResult.stdout.trim()}`);

    // Step 2: Deploy via wrangler
    await ctx.reply('📦 構建完成，正在部署到 Cloudflare Pages...');

    const deployResult = await execFileAsync(
      'npx', ['wrangler', 'pages', 'deploy', 'dist', '--project-name', 'my-site'],
      { cwd: SITE_DIR, timeout: 120_000, env },
    );

    // Extract deploy URL
    const urlMatch = deployResult.stdout.match(/https:\/\/\S+\.my-site\.pages\.dev/);
    const previewUrl = urlMatch ? urlMatch[0] : null;

    const lines = [
      '✅ example.com 部署成功！',
      '',
      `🌐 ${SITE_URL}`,
    ];
    if (previewUrl) {
      lines.push(`🔗 Preview: ${previewUrl}`);
    }

    await ctx.reply(lines.join('\n'));
    await logger.info('site-deploy', `Deployed successfully`);
  } catch (err) {
    const msg = (err as Error).message;
    await logger.error('site-deploy', `Deploy failed: ${msg}`);
    await ctx.reply(`❌ 部署失敗: ${msg.slice(0, 300)}`);
  }
}

// ── Status ──────────────────────────────────────────────────────────

async function showStatus(ctx: import('../bot.js').BotContext): Promise<void> {
  const lines = [
    '🌐 *example.com*',
    '',
    `連結: ${SITE_URL}`,
    `RSS: ${SITE_URL}/feed.xml`,
    `API: ${SITE_URL}/api/vitals`,
    '',
    '── 可用操作 ──',
    '/site deploy — 構建並部署最新版本',
  ];

  const text = lines.join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/[*_]/g, ''));
  }
}

// ── Registration ────────────────────────────────────────────────────

/** Site handler — handles args from /site or /content site */
export async function handleSite(ctx: Parameters<typeof showStatus>[0]): Promise<void> {
  const text = ctx.message?.text || '';
  const args = text.replace(/^\/(?:content\s+)?site\s*/i, '').trim();

  if (args === 'deploy' || args === '部署') {
    await handleDeploy(ctx);
  } else {
    await showStatus(ctx);
  }
}

/** Register site callback handlers (called from content.ts) */
export function registerSiteCallbacks(): void {
  commandRegistry.registerCallback('site:deploy', async (ctx) => {
    await handleDeploy(ctx);
  });
}
