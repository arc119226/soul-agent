/**
 * /search — unified search & knowledge command.
 *
 * Subcommands:
 *   /search <query>       — Web search (default)
 *   /search learn <url>   — Fetch URL into knowledge base
 *   /search kb            — List knowledge sources
 */

import { registerParentCommand } from '../telegram/command-registry.js';
import { config } from '../config.js';
import { fetchUrl } from '../web/fetcher.js';
import { analyzeUrl, formatAnalysis } from '../web/document-analyzer.js';
import { searchWeb, formatSearchResults } from '../web/search.js';
import { logger } from '../core/logger.js';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BotContext } from '../bot.js';

const MODULE = 'search-cmd';
const KNOWLEDGE_DIR = join(process.cwd(), 'data', 'knowledge');

async function ensureKnowledgeDir(): Promise<void> {
  await mkdir(KNOWLEDGE_DIR, { recursive: true });
}

async function handleLearn(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text ?? '';
  const url = text.replace(/^\/(?:search\s+)?learn\s*/i, '').trim();

  if (!url) {
    await ctx.reply(
      'Usage: `/search learn <url>`\n\nFetches a URL and stores the content in the knowledge base.',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    await ctx.reply('Please provide a valid URL starting with http:// or https://');
    return;
  }

  await ctx.reply(`Fetching: ${url} ...`);

  const analysisResult = await analyzeUrl(url);
  if (!analysisResult.ok) {
    await ctx.reply(`Failed to fetch URL: ${analysisResult.error}`);
    return;
  }

  const analysis = analysisResult.value;

  try {
    await ensureKnowledgeDir();

    const filename = urlToFilename(url);
    const filePath = join(KNOWLEDGE_DIR, filename);

    const content = [
      `# ${analysis.title}`,
      '',
      `Source: ${analysis.url}`,
      `Fetched: ${analysis.fetchedAt}`,
      `Words: ~${analysis.wordCount}`,
      '',
      '## Key Points',
      ...analysis.keyPoints.map((p) => `- ${p}`),
      '',
      '## Summary',
      analysis.summary,
      '',
      '## Full Content',
      '',
    ].join('\n');

    const fullFetch = await fetchUrl(url);
    const fullContent = fullFetch.ok ? fullFetch.value.content.slice(0, 50000) : '';
    const finalContent = content + fullContent;

    await writeFile(filePath, finalContent, 'utf-8');
    logger.info(MODULE, `Knowledge stored: ${filename}`);

    const formatted = formatAnalysis(analysis);
    const response = formatted + `\n\nStored as: \`${filename}\``;

    try {
      await ctx.reply(response, { parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(response.replace(/[*`]/g, ''));
    }
  } catch (err) {
    logger.error(MODULE, `Failed to store knowledge: ${url}`, err);
    await ctx.reply(`Fetched successfully but failed to store: ${(err as Error).message}`);
  }
}

async function handleKb(ctx: BotContext): Promise<void> {
  await ensureKnowledgeDir();

  const lines: string[] = ['*Knowledge Base*', ''];

  if (config.KNOWLEDGE_URLS.length > 0) {
    lines.push('*Configured URLs:*');
    for (const url of config.KNOWLEDGE_URLS) {
      lines.push(`  - ${url}`);
    }
    lines.push('');
  }

  try {
    const files = await readdir(KNOWLEDGE_DIR);
    const mdFiles = files.filter((f) => f.endsWith('.md') || f.endsWith('.txt'));

    if (mdFiles.length > 0) {
      lines.push('*Stored Documents:*');
      for (const file of mdFiles) {
        lines.push(`  - \`${file}\``);
      }
    } else {
      lines.push('No stored documents yet.');
    }
  } catch {
    lines.push('No stored documents yet.');
  }

  lines.push('');
  lines.push('Use `/search learn <url>` to fetch and store a URL.');
  lines.push('Use `/search <query>` to search the web.');

  try {
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(lines.join('\n').replace(/[*`]/g, ''));
  }
}

/** Register /search parent command */
export function registerKnowledgeCommands(): void {
  registerParentCommand({
    name: 'search',
    description: '搜尋網路 & 知識庫',
    aliases: ['搜尋', '搜索', 'websearch', 'knowledge', '知識', '知識庫', 'kb'],
    adminOnly: true,
    subcommands: [
      { name: 'learn', aliases: ['學習', '讀取', 'fetch'], description: '從 URL 學習知識', handler: handleLearn },
      { name: 'kb', aliases: ['知識庫', 'knowledge'], description: '知識來源列表', handler: handleKb },
    ],
    defaultHandler: async (ctx) => {
      // Default: web search with full args
      const text = ctx.message?.text ?? '';
      const query = text.replace(/^\/search\s*/i, '').trim();

      if (!query) {
        await ctx.reply(
          '*🔍 搜尋 & 知識庫*\n\n' +
          '`/search <query>` — 搜尋網路\n' +
          '`/search learn <url>` — 學習 URL\n' +
          '`/search kb` — 知識庫列表',
          { parse_mode: 'Markdown' },
        );
        return;
      }

      const result = await searchWeb(query);
      if (!result.ok) {
        await ctx.reply(`Search error: ${result.error}`);
        return;
      }

      const formatted = formatSearchResults(result.value, query);

      try {
        await ctx.reply(formatted, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(formatted.replace(/[*`]/g, ''));
      }
    },
  });

  logger.info('commands', 'Registered /search with 2 subcommands');
}

/** Convert a URL to a safe filename */
function urlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname
      .replace(/\//g, '_')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 50);

    const name = `${host}${path || '_index'}`;
    return `${name}.md`;
  } catch {
    const safe = url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
    return `${safe}.md`;
  }
}
