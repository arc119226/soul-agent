/**
 * Channel publisher — formats blog posts for Telegram channel and sends them.
 *
 * Shared by: proactive/engine.ts (auto cross-post) + plugins/channel.ts (manual)
 *
 * Flow: extractPostInfo(slug) → pickReferral(tags) → formatChannelPost() → postToChannel()
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface ReferralEntry {
  id: string;
  name: string;
  url: string;
  code: string;
  bonus: string;
  tags: string[];
  active: boolean;
}

interface ReferralConfig {
  version: number;
  updatedAt: string;
  referrals: ReferralEntry[];
}

interface PostInfo {
  title: string;
  excerpt: string;
  tags: string[];
  blogUrl: string;
}

// ── Constants ─────────────────────────────────────────────────────────

const REFERRAL_PATH = join(process.cwd(), 'soul', 'config', 'referral.json');
const BLOG_BASE_URL = config.BLOG_URL;

// ── Referral ──────────────────────────────────────────────────────────

/**
 * Load active referral entries from soul/config/referral.json.
 */
export async function loadReferrals(): Promise<ReferralEntry[]> {
  try {
    const raw = await readFile(REFERRAL_PATH, 'utf-8');
    const data = JSON.parse(raw) as ReferralConfig;
    return data.referrals.filter((r) => r.active);
  } catch {
    return [];
  }
}

/**
 * Pick the best referral based on post tags overlap.
 * Falls back to first active referral if no tag match.
 */
export function pickReferral(postTags: string[], referrals: ReferralEntry[]): ReferralEntry | null {
  if (referrals.length === 0) return null;

  const lowerTags = postTags.map((t) => t.toLowerCase());
  let bestScore = -1;
  let best = referrals[0]!;

  for (const ref of referrals) {
    const score = ref.tags.filter((t) => lowerTags.includes(t.toLowerCase())).length;
    if (score > bestScore) {
      bestScore = score;
      best = ref;
    }
  }

  return best;
}

// ── Post Extraction ───────────────────────────────────────────────────

/**
 * Extract title, excerpt, tags, and blog URL from a published Markdown file.
 */
export async function extractPostInfo(slug: string): Promise<PostInfo | null> {
  const postsDir = join(process.cwd(), 'blog', 'source', '_posts');
  const mdName = slug.endsWith('.md') ? slug : `${slug}.md`;

  try {
    const raw = await readFile(join(postsDir, mdName), 'utf-8');

    // Parse YAML front matter
    if (!raw.startsWith('---')) return null;
    const fmEnd = raw.indexOf('---', 3);
    if (fmEnd === -1) return null;
    const fm = raw.slice(3, fmEnd).trim();

    // Title
    const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    const title = titleMatch?.[1]?.trim() ?? slug;

    // Tags (YAML list format)
    const tags: string[] = [];
    const tagsMatch = fm.match(/^tags:\n((?:\s+-\s+.+\n?)+)/m);
    if (tagsMatch?.[1]) {
      for (const line of tagsMatch[1].split('\n')) {
        const t = line.replace(/^\s*-\s*/, '').trim();
        if (t) tags.push(t);
      }
    }
    // Tags (inline format: tags: [a, b, c])
    if (tags.length === 0) {
      const inlineMatch = fm.match(/^tags:\s*\[(.+?)\]/m);
      if (inlineMatch?.[1]) {
        tags.push(...inlineMatch[1].split(',').map((t) => t.trim()).filter(Boolean));
      }
    }

    // Excerpt: content before <!-- more -->, or first paragraph
    const body = raw.slice(fmEnd + 3).trim();
    const moreIdx = body.indexOf('<!-- more -->');
    const excerptRaw = moreIdx > 0
      ? body.slice(0, moreIdx).trim()
      : body.split('\n\n')[0]?.trim() ?? '';

    // Strip markdown formatting for plain text
    const excerpt = excerptRaw
      .replace(/^#+\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .slice(0, 200);

    // Build blog URL from date in front matter
    const dateMatch = fm.match(/^date:\s*(\d{4})-(\d{2})-(\d{2})/m);
    const slugBase = mdName.replace('.md', '');
    const blogUrl = dateMatch
      ? `${BLOG_BASE_URL}/${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}/${slugBase}/`
      : BLOG_BASE_URL;

    return { title, excerpt, tags, blogUrl };
  } catch {
    return null;
  }
}

// ── Formatting ────────────────────────────────────────────────────────

/** Escape text for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Format a blog post as an HTML channel message with referral footer.
 */
export async function formatChannelPost(slug: string): Promise<string | null> {
  const info = await extractPostInfo(slug);
  if (!info) return null;

  const referrals = await loadReferrals();
  const referral = pickReferral(info.tags, referrals);

  const lines: string[] = [
    `<b>${escapeHtml(info.title)}</b>`,
    '',
    escapeHtml(info.excerpt) + (info.excerpt.length >= 200 ? '...' : ''),
    '',
    `<a href="${info.blogUrl}">閱讀全文 →</a>`,
  ];

  if (referral) {
    lines.push('');
    lines.push('─────────────');
    lines.push(`💱 <a href="${referral.url}">${escapeHtml(referral.name)} — ${escapeHtml(referral.bonus)}</a>`);
  }

  return lines.join('\n');
}

// ── Sending ───────────────────────────────────────────────────────────

/**
 * Post a formatted message to the Telegram channel.
 */
export async function postToChannel(
  bot: Bot<BotContext>,
  text: string,
): Promise<boolean> {
  const channelId = config.TELEGRAM_CHANNEL_ID;
  try {
    await bot.api.sendMessage(channelId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false },
    });
    await logger.info('channel-publisher', `Posted to ${channelId}`);
    return true;
  } catch (err) {
    await logger.warn('channel-publisher', `Failed to post to ${channelId}`, err);
    return false;
  }
}

/**
 * Full pipeline: extract posts → format → post to channel.
 * Called by autoPushBlogPost() after successful deploy.
 */
export async function crossPostBlogToChannel(
  bot: Bot<BotContext>,
  slugs: string[],
): Promise<void> {
  for (const slug of slugs) {
    try {
      const text = await formatChannelPost(slug);
      if (!text) {
        await logger.warn('channel-publisher', `Could not extract info for: ${slug}`);
        continue;
      }
      await postToChannel(bot, text);
    } catch (err) {
      await logger.warn('channel-publisher', `Cross-post failed for ${slug}`, err);
    }
  }
}
