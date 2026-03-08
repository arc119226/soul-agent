/**
 * Comment API for blog posts
 * GET /api/comments/:slug  — Fetch comments for a post
 * POST /api/comments/:slug — Submit a new comment
 */

import { jsonResponse, corsPreflightResponse, checkSpam } from '../_shared.js';

interface Env {
  DB: D1Database;
  IP_SALT: string;
}

interface CommentRow {
  id: number;
  post_slug: string;
  author_name: string;
  author_email: string | null;
  content: string;
  parent_id: number | null;
  ip_hash: string | null;
  created_at: string;
  approved: number;
  ai_replied: number;
}

// Privacy-preserving IP hash for rate limiting
async function hashIP(ip: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + '-' + salt);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Handle OPTIONS for CORS preflight
export const onRequestOptions: PagesFunction<Env> = async (context) => {
  return corsPreflightResponse(context.request);
};

// GET /api/comments/:slug
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const slug = context.params.slug as string;

  if (!slug) {
    return jsonResponse({ error: 'Missing slug' }, context.request, 400);
  }

  try {
    const { results } = await context.env.DB.prepare(
      `SELECT id, post_slug, author_name, content, parent_id, created_at, ai_replied
       FROM comments
       WHERE post_slug = ? AND approved = 1
       ORDER BY created_at ASC`
    )
      .bind(slug)
      .all<CommentRow>();

    // Build threaded structure
    const topLevel = results.filter(c => !c.parent_id);
    const replies = results.filter(c => c.parent_id);

    const threaded = topLevel.map(comment => ({
      ...comment,
      replies: replies.filter(r => r.parent_id === comment.id),
    }));

    return jsonResponse({
      slug,
      count: results.length,
      comments: threaded,
    }, context.request);
  } catch {
    return jsonResponse({ error: 'Database error' }, context.request, 500);
  }
};

// POST /api/comments/:slug
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const slug = context.params.slug as string;

  if (!slug) {
    return jsonResponse({ error: 'Missing slug' }, context.request, 400);
  }

  // Parse body
  let body: { author_name?: string; author_email?: string; content?: string; parent_id?: number; ai_reply?: boolean };
  try {
    body = await context.request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, context.request, 400);
  }

  // Validate required fields
  const authorName = (body.author_name ?? '').trim();
  const content = (body.content ?? '').trim();

  if (!authorName || authorName.length > 100) {
    return jsonResponse({ error: 'author_name is required (max 100 chars)' }, context.request, 400);
  }
  if (!content || content.length > 2000) {
    return jsonResponse({ error: 'content is required (max 2000 chars)' }, context.request, 400);
  }

  // Spam check — before any DB operations
  const spamCheck = checkSpam(authorName, content);
  if (!spamCheck.ok) {
    return jsonResponse({ error: spamCheck.reason }, context.request, 400);
  }

  // Rate limiting: max 5 comments per hour per IP
  const clientIP = context.request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const salt = context.env.IP_SALT || 'CHANGE_ME';
  const ipHash = await hashIP(clientIP, salt);

  try {
    const { results: recentComments } = await context.env.DB.prepare(
      `SELECT COUNT(*) as count FROM comments
       WHERE ip_hash = ? AND created_at > datetime('now', '-1 hour')`
    )
      .bind(ipHash)
      .all<{ count: number }>();

    if (recentComments[0] && recentComments[0].count >= 5) {
      return jsonResponse({ error: '留言太頻繁，請稍後再試' }, context.request, 429);
    }

    // Validate parent_id if provided
    if (body.parent_id) {
      const { results: parentCheck } = await context.env.DB.prepare(
        'SELECT id FROM comments WHERE id = ? AND post_slug = ?'
      )
        .bind(body.parent_id, slug)
        .all();

      if (parentCheck.length === 0) {
        return jsonResponse({ error: 'Invalid parent_id' }, context.request, 400);
      }
    }

    // Insert comment
    const result = await context.env.DB.prepare(
      `INSERT INTO comments (post_slug, author_name, author_email, content, parent_id, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        slug,
        authorName,
        body.author_email?.trim() || null,
        content,
        body.parent_id || null,
        ipHash,
      )
      .run();

    // If this is an AI reply, mark parent as ai_replied (non-blocking)
    if (body.parent_id && body.ai_reply) {
      context.waitUntil(
        context.env.DB.prepare(
          'UPDATE comments SET ai_replied = 1 WHERE id = ?'
        )
          .bind(body.parent_id)
          .run()
      );
    }

    return jsonResponse({
      success: true,
      comment: {
        id: result.meta.last_row_id,
        post_slug: slug,
        author_name: authorName,
        content,
        parent_id: body.parent_id || null,
        created_at: new Date().toISOString(),
      },
    }, context.request, 201);
  } catch {
    return jsonResponse({ error: 'Database error' }, context.request, 500);
  }
};
