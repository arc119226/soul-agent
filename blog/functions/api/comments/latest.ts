/**
 * Latest comments API
 * GET /api/comments/latest?since=2h&limit=20
 *
 * Used by the comment-monitor agent to fetch new comments.
 */

import { jsonResponse, corsPreflightResponse } from '../_shared.js';

interface Env {
  DB: D1Database;
}

export const onRequestOptions: PagesFunction<Env> = async (context) => {
  return corsPreflightResponse(context.request);
};

// Parse duration string like "2h", "30m", "1d" to minutes
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)([mhd])$/);
  if (!match) return 120; // default 2h
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  switch (unit) {
    case 'm': return value;
    case 'h': return value * 60;
    case 'd': return value * 1440;
    default: return 120;
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const since = url.searchParams.get('since') ?? '2h';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
  const minutes = parseDuration(since);

  try {
    const { results } = await context.env.DB.prepare(
      `SELECT id, post_slug, author_name, content, parent_id, created_at, ai_replied
       FROM comments
       WHERE approved = 1
         AND created_at > datetime('now', ? || ' minutes')
       ORDER BY created_at DESC
       LIMIT ?`
    )
      .bind(-minutes, limit)
      .all();

    return jsonResponse({
      since: `${minutes}m`,
      count: results.length,
      comments: results,
    }, context.request);
  } catch {
    return jsonResponse({ error: 'Database error' }, context.request, 500);
  }
};
