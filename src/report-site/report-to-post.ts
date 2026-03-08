/**
 * Report-to-Post converter — transforms AgentReport JSONL entries
 * into Hexo-compatible markdown files for the report site.
 *
 * Each report becomes an independent article with:
 * - YAML frontmatter (title, date, categories, tags)
 * - Metadata blockquote (agent, confidence, cost, duration)
 * - Original report content
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { agentLabel } from '../agents/config/agent-labels.js';

const REPORT_SITE_DIR = join(process.cwd(), 'report');
const POSTS_DIR = join(REPORT_SITE_DIR, 'source', '_posts');

export interface AgentReport {
  timestamp: string;
  agentName: string;
  taskId: string;
  prompt: string;
  result: string;
  costUsd: number;
  duration: number;
  confidence: number;
  traceSummary?: string;
}

function confidencePercent(c: number): string {
  return `${(c * 100).toFixed(0)}%`;
}

function durationStr(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/** Extract tags from report content via keyword detection */
function extractTags(report: AgentReport): string[] {
  const tags = new Set<string>([report.agentName]);
  const topicMap: Record<string, string[]> = {
    'AI': ['AI', 'LLM', 'Claude', 'GPT', 'Gemini', 'Anthropic'],
    'Security': ['安全', 'security', 'vulnerability', 'CVE', 'exploit'],
    'Crypto': ['crypto', 'USDT', 'Bitcoin', 'blockchain', 'BTC', 'ETH'],
    'TypeScript': ['TypeScript', 'Node.js', 'JavaScript'],
    'GitHub': ['GitHub', 'repository', 'PR', 'commit'],
    'Rust': ['Rust', 'cargo', 'crate'],
    'Python': ['Python', 'pip', 'pytorch'],
  };
  for (const [tag, keywords] of Object.entries(topicMap)) {
    if (keywords.some(kw => report.result.includes(kw))) {
      tags.add(tag);
    }
  }
  return [...tags];
}

/** Generate a title from the report content */
function generateTitle(report: AgentReport): string {
  // Try to extract first heading from result
  const headingMatch = report.result.match(/^#+\s+(.+)/m);
  if (headingMatch && headingMatch[1]!.length <= 80) {
    return headingMatch[1]!.replace(/[*_`]/g, '');
  }
  // Fallback: agent label + date
  const date = report.timestamp.slice(0, 10);
  return `${agentLabel(report.agentName)} — ${date}`;
}

/** Convert an AgentReport into a Hexo markdown post file. Returns the slug or null on failure. */
export async function reportToPost(report: AgentReport): Promise<string | null> {
  const taskShort = report.taskId.slice(0, 8);
  const date = report.timestamp.slice(0, 10);
  const slug = `${report.agentName}-${date}-${taskShort}`;
  const filePath = join(POSTS_DIR, `${slug}.md`);

  const title = generateTitle(report);
  const tags = extractTags(report);

  // Metadata blockquote
  const meta = [
    `> **Agent**: ${agentLabel(report.agentName)} (\`${report.agentName}\`)`,
    `> **Confidence**: ${confidencePercent(report.confidence)}`,
    `> **Cost**: $${report.costUsd.toFixed(4)}`,
    `> **Duration**: ${durationStr(report.duration)}`,
    `> **Task ID**: \`${report.taskId}\``,
  ].join('\n');

  // YAML frontmatter
  const frontMatter = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: ${report.timestamp.slice(0, 19).replace('T', ' ')}`,
    'categories:',
    `  - ${agentLabel(report.agentName)}`,
    'tags:',
    ...tags.map(t => `  - ${t}`),
    '---',
  ].join('\n');

  const content = `${frontMatter}\n\n${meta}\n\n---\n\n${report.result}\n`;

  try {
    await mkdir(POSTS_DIR, { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    logger.debug('report-to-post', `Created post: ${slug}`);
    return slug;
  } catch (err) {
    logger.error('report-to-post', `Failed to create post: ${(err as Error).message}`);
    return null;
  }
}
