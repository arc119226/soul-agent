/**
 * D1 comment client — fetch and manage blog comments via the Pages API.
 */

import { logger } from '../core/logger.js';
import { config } from '../config.js';

const BLOG_URL = config.BLOG_URL;

export interface Comment {
  id: number;
  post_slug: string;
  author_name: string;
  content: string;
  parent_id: number | null;
  created_at: string;
  ai_replied: number;
  replies?: Comment[];
}

export interface CommentListResult {
  slug: string;
  count: number;
  comments: Comment[];
}

export interface LatestResult {
  since: string;
  count: number;
  comments: Comment[];
}

// ── Retry utility ──

async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retries = 2,
  delayMs = 1000,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status < 500) return res; // Don't retry 4xx
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err as Error;
    }
    if (i < retries) {
      await new Promise(r => setTimeout(r, delayMs * (i + 1))); // Linear backoff
    }
  }
  throw lastError!;
}

/** Fetch comments for a specific post */
export async function getComments(slug: string): Promise<CommentListResult> {
  const url = `${BLOG_URL}/api/comments/${encodeURIComponent(slug)}`;
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      await logger.warn('comment-client', `Comments API returned ${res.status} for ${slug}: ${body.slice(0, 200)}`);
      return { slug, count: 0, comments: [] };
    }
    return await res.json() as CommentListResult;
  } catch (err) {
    await logger.error('comment-client', `Failed to reach comments API after retries for ${slug}: ${(err as Error).message}`);
    return { slug, count: 0, comments: [] };
  }
}

/** Fetch latest comments across all posts */
export async function getLatestComments(since = '2h', limit = 20): Promise<LatestResult> {
  const url = `${BLOG_URL}/api/comments/latest?since=${since}&limit=${limit}`;
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      await logger.warn('comment-client', `Latest comments API returned ${res.status}: ${body.slice(0, 200)}`);
      return { since, count: 0, comments: [] };
    }
    return await res.json() as LatestResult;
  } catch (err) {
    await logger.error('comment-client', `Failed to reach comments API after retries: ${(err as Error).message}`);
    return { since, count: 0, comments: [] };
  }
}

/** Post a reply comment (used by AI comment monitor) */
export async function postReply(
  slug: string,
  parentId: number,
  content: string,
  authorName = process.env.BOT_AUTHOR_NAME || 'Soul Agent',
): Promise<boolean> {
  const url = `${BLOG_URL}/api/comments/${encodeURIComponent(slug)}`;
  try {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author_name: authorName,
        content,
        parent_id: parentId,
        ai_reply: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      await logger.warn('comment-client', `Reply API returned ${res.status} for comment #${parentId}: ${body.slice(0, 200)}`);
      return false;
    }
    await logger.info('comment-client', `Replied to comment #${parentId} on ${slug}`);
    return true;
  } catch (err) {
    await logger.error('comment-client', `Failed to post reply after retries for comment #${parentId}: ${(err as Error).message}`);
    return false;
  }
}
