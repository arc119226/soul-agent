import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const MODULE = 'web-search';
const DDG_URL = 'https://html.duckduckgo.com/html/';
const TIMEOUT_MS = 10_000;
const MAX_RESULTS = 8;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search the web via DuckDuckGo HTML (no API key required).
 * Uses html.duckduckgo.com which doesn't trigger CAPTCHA for bots.
 */
export async function searchWeb(query: string): Promise<Result<SearchResult[]>> {
  if (!query.trim()) {
    return fail('Empty search query');
  }

  logger.info(MODULE, `Search query: ${query}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const body = new URLSearchParams({ q: query });

    const response = await fetch(DDG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: body.toString(),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return fail(`DuckDuckGo returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const results = parseDDGHtml(html);

    logger.info(MODULE, `Found ${results.length} result(s) for: ${query}`);
    return ok(`Found ${results.length} results`, results);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return fail('Search timed out');
    }
    logger.error(MODULE, `Search failed: ${msg}`);
    return fail(`Search failed: ${msg}`);
  }
}

/**
 * Parse DuckDuckGo HTML response into SearchResult[].
 * DDG HTML uses: <a class="result__a" href="URL">TITLE</a>
 *            and: <a class="result__snippet" href="URL">SNIPPET</a>
 */
export function parseDDGHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result links: <a ... class="result__a" ... href="URL">TITLE</a>
  const linkTagRegex = /<a\s[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
  const hrefRegex = /href="([^"]*)"/i;

  // Match snippets: <a class="result__snippet" ...>SNIPPET</a>
  const snippetRegex = /<a\s[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkTagRegex.exec(html)) !== null) {
    const fullTag = match[0];
    const hrefMatch = hrefRegex.exec(fullTag);
    const url = hrefMatch?.[1]?.trim() ?? '';
    const title = stripHtml(match[1] ?? '').trim();
    if (url && title) {
      links.push({ url, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1] ?? '').trim());
  }

  for (let i = 0; i < Math.min(links.length, MAX_RESULTS); i++) {
    const link = links[i]!;
    results.push({
      title: link.title,
      url: link.url,
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

/** Strip HTML tags and decode common entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Format search results for Telegram */
export function formatSearchResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No results found for: "${query}"`;
  }

  const lines = [`*Search results for:* "${query}"`, ''];

  for (const [i, result] of results.entries()) {
    lines.push(`*${i + 1}.* [${result.title}](${result.url})`);
    if (result.snippet) {
      lines.push(`   ${result.snippet}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
