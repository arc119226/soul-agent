/**
 * Shared utilities for comment API — CORS, JSON response helpers.
 * Underscore-prefixed file: NOT treated as a Pages Functions route.
 */

const ALLOWED_ORIGINS = [
  'https://blog.example.com',
  'https://example.com',
  'https://report.example.com',
];

/** Build CORS headers, restricting to known origins */
export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]!;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/** JSON response with CORS headers */
export function jsonResponse(data: unknown, request: Request, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request),
    },
  });
}

/** CORS preflight response */
export function corsPreflightResponse(request: Request): Response {
  return new Response(null, { status: 204, headers: getCorsHeaders(request) });
}

// ── Spam Detection ──

interface SpamCheckResult {
  ok: boolean;
  reason?: string;
}

const SPAM_PATTERNS = [
  /\b(casino|poker|slot|betting)\b/i,
  /\b(viagra|cialis|pharmacy)\b/i,
  /\b(SEO|backlink|buy.*followers)\b/i,
  /\b(free.*money|earn.*fast|click.*here)\b/i,
];

/** Basic spam content validation */
export function checkSpam(authorName: string, content: string): SpamCheckResult {
  // 1. URL flood: more than 2 links
  const urlCount = (content.match(/https?:\/\//gi) ?? []).length;
  if (urlCount > 2) {
    return { ok: false, reason: '連結數量過多' };
  }

  // 2. Known spam patterns
  const text = authorName + ' ' + content;
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: '內容含有不允許的關鍵字' };
    }
  }

  // 3. All-caps abuse (>80% uppercase in content longer than 20 chars)
  if (content.length > 20) {
    const upperCount = (content.match(/[A-Z]/g) ?? []).length;
    if (upperCount / content.length > 0.8) {
      return { ok: false, reason: '請勿全部使用大寫' };
    }
  }

  // 4. Repetitive character flood (same char 10+ times in a row)
  if (/(.)\1{9,}/.test(content)) {
    return { ok: false, reason: '內容含有過多重複字元' };
  }

  return { ok: true };
}
