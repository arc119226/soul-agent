import { fetchUrl, type FetchResult } from './fetcher.js';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const MODULE = 'doc-analyzer';

/** Max content length to process for analysis */
const MAX_ANALYSIS_LENGTH = 8000;

export interface DocumentAnalysis {
  url: string;
  title: string;
  summary: string;
  keyPoints: string[];
  wordCount: number;
  fetchedAt: string;
}

/** Analyze a URL by fetching and extracting key information */
export async function analyzeUrl(url: string): Promise<Result<DocumentAnalysis>> {
  const fetchResult = await fetchUrl(url);
  if (!fetchResult.ok) {
    return fail(`Failed to fetch URL: ${fetchResult.error}`, fetchResult.fixHint);
  }

  try {
    const analysis = analyzeContent(fetchResult.value, url);
    logger.info(MODULE, `Analyzed: ${url} (${analysis.keyPoints.length} key points)`);
    return ok('Document analyzed', analysis);
  } catch (err) {
    logger.error(MODULE, `Analysis failed: ${url}`, err);
    return fail(`Analysis failed: ${(err as Error).message}`);
  }
}

/** Analyze fetched content and extract structure */
function analyzeContent(fetched: FetchResult, url: string): DocumentAnalysis {
  let content = fetched.content;

  // Truncate for analysis
  if (content.length > MAX_ANALYSIS_LENGTH) {
    content = content.slice(0, MAX_ANALYSIS_LENGTH);
  }

  const title = fetched.title || extractTitle(content) || url;
  const keyPoints = extractKeyPoints(content);
  const summary = generateSummary(content);
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  return {
    url,
    title,
    summary,
    keyPoints,
    wordCount,
    fetchedAt: new Date().toISOString(),
  };
}

/** Extract title from content if not found in HTML */
function extractTitle(content: string): string {
  // Try to find a heading-like first line
  const lines = content.split('\n').filter((l) => l.trim());
  const firstLine = lines[0]?.trim() ?? '';

  // If it looks like a heading (starts with # or is short enough)
  if (firstLine.startsWith('#')) {
    return firstLine.replace(/^#+\s*/, '');
  }
  if (firstLine.length < 100 && firstLine.length > 0) {
    return firstLine;
  }

  return '';
}

/** Extract key points from content */
function extractKeyPoints(content: string): string[] {
  const points: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Extract headings as key points
    if (trimmed.startsWith('#')) {
      const heading = trimmed.replace(/^#+\s*/, '');
      if (heading.length > 2 && heading.length < 200) {
        points.push(heading);
      }
    }

    // Extract bold text as potential key points
    const boldMatches = trimmed.match(/\*\*([^*]+)\*\*/g);
    if (boldMatches) {
      for (const match of boldMatches) {
        const text = match.replace(/\*\*/g, '').trim();
        if (text.length > 3 && text.length < 200 && !points.includes(text)) {
          points.push(text);
        }
      }
    }

    // Limit key points
    if (points.length >= 10) break;
  }

  return points;
}

/** Generate a brief summary from content */
function generateSummary(content: string): string {
  // Take the first meaningful paragraphs
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => {
      // Filter out headings, very short lines, and navigation-like content
      if (p.startsWith('#')) return false;
      if (p.length < 20) return false;
      if (p.startsWith('-') && p.length < 50) return false;
      return true;
    });

  // Take first 2-3 paragraphs or up to ~500 chars
  let summary = '';
  for (const para of paragraphs) {
    if (summary.length + para.length > 500) {
      if (summary.length === 0) {
        // First paragraph is already long, truncate it
        summary = para.slice(0, 500) + '...';
      }
      break;
    }
    summary += (summary ? '\n\n' : '') + para;
  }

  if (!summary) {
    summary = content.slice(0, 300).trim() + '...';
  }

  return summary;
}

/** Format document analysis for Telegram */
export function formatAnalysis(analysis: DocumentAnalysis): string {
  const lines = [
    `*Document Analysis*`,
    '',
    `*Title:* ${analysis.title}`,
    `*URL:* ${analysis.url}`,
    `*Words:* ~${analysis.wordCount}`,
    '',
  ];

  if (analysis.keyPoints.length > 0) {
    lines.push('*Key Points:*');
    for (const point of analysis.keyPoints.slice(0, 8)) {
      lines.push(`  - ${point}`);
    }
    lines.push('');
  }

  lines.push('*Summary:*');
  lines.push(analysis.summary);

  return lines.join('\n');
}
