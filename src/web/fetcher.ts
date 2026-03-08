import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const MODULE = 'web-fetcher';

/** Default fetch timeout in ms */
const DEFAULT_TIMEOUT = 10_000;
/** Max response size in bytes */
const MAX_SIZE = 1024 * 1024; // 1MB
/** Max redirects to follow */
const MAX_REDIRECTS = 5;

export interface FetchResult {
  content: string;
  title: string;
  statusCode: number;
  url: string;
  contentLength: number;
}

/** Fetch a URL and convert HTML to clean text/markdown */
export async function fetchUrl(
  url: string,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<Result<FetchResult>> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return fail('Invalid URL: must start with http:// or https://');
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let currentUrl = url;
    let response: Response | undefined;
    let redirectCount = 0;

    // Manual redirect following to count redirects
    while (redirectCount <= MAX_REDIRECTS) {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'MetacognitiveBot/1.0 (Web Intelligence)',
          'Accept': 'text/html,application/xhtml+xml,text/plain,application/json',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        currentUrl = new URL(location, currentUrl).toString();
        redirectCount++;
        continue;
      }
      break;
    }

    clearTimeout(timer);

    if (!response) {
      return fail('No response received');
    }

    if (redirectCount > MAX_REDIRECTS) {
      return fail(`Too many redirects (max ${MAX_REDIRECTS})`);
    }

    if (!response.ok) {
      return fail(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check content length
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_SIZE) {
      return fail(`Response too large: ${(contentLength / 1024 / 1024).toFixed(1)}MB (max 1MB)`);
    }

    const rawText = await response.text();
    if (rawText.length > MAX_SIZE) {
      return fail(`Response too large after download`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    let content: string;
    let title: string;

    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      const parsed = htmlToMarkdown(rawText);
      content = parsed.content;
      title = parsed.title;
    } else if (contentType.includes('application/json')) {
      content = formatJson(rawText);
      title = '';
    } else {
      content = rawText;
      title = '';
    }

    logger.info(MODULE, `Fetched ${currentUrl}: ${response.status}, ${content.length} chars`);

    return ok('URL fetched', {
      content,
      title,
      statusCode: response.status,
      url: currentUrl,
      contentLength: content.length,
    });
  } catch (err) {
    const error = err as Error;
    if (error.name === 'AbortError') {
      return fail(`Request timed out after ${timeout / 1000}s`);
    }
    logger.error(MODULE, `Fetch failed: ${url}`, err);
    return fail(`Fetch failed: ${error.message}`);
  }
}

/** Convert HTML to clean markdown-like text */
function htmlToMarkdown(html: string): { content: string; title: string } {
  let text = html;

  // Extract title
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.trim()) : '';

  // Remove script, style, nav, footer, header tags and their content
  text = text.replace(/<(script|style|nav|footer|header|aside|iframe|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Convert headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n');

  // Convert links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Convert lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');

  // Convert paragraphs and divs
  text = text.replace(/<\/(p|div)>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Convert bold and italic
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '_$2_');

  // Convert code
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = decodeEntities(text);

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.split('\n').map((line) => line.trim()).join('\n');
  text = text.trim();

  return { content: text, title };
}

/** Decode common HTML entities */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&mdash;/g, '---')
    .replace(/&ndash;/g, '--')
    .replace(/&hellip;/g, '...')
    .replace(/&copy;/g, '(c)')
    .replace(/&reg;/g, '(R)');
}

/** Format JSON for readability */
function formatJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}
