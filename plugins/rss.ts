import type { Plugin } from '../src/plugins/plugin-api.js';

// ── Types ───────────────────────────────────────────────────────────

interface FeedEntry {
  title: string;
  link: string;
  date: string;
}

interface FeedConfig {
  name: string;
  url: string;
}

interface FeedState {
  feeds: FeedConfig[];
  seenIds: Record<string, string[]>; // feedUrl → array of seen link/guids
  pollInterval: ReturnType<typeof setInterval> | null;
}

// ── Constants ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SEEN_PER_FEED = 100;
const MAX_NEW_ITEMS = 5; // max items to notify per poll cycle
const FETCH_TIMEOUT = 15_000;

// ── State ───────────────────────────────────────────────────────────

const state: FeedState = {
  feeds: [],
  seenIds: {},
  pollInterval: null,
};

// Saved context from the last handler call (used for sending notifications)
let lastCtx: { sendMarkdown: (text: string) => Promise<void> } | null = null;

// ── RSS/Atom Parsing (regex-based, no dependencies) ─────────────────

function parseRssFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];

  // Try RSS <item> format
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractGuid(block);
    const date = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || '';

    if (title || link) {
      entries.push({ title: title || '(無標題)', link: link || '', date });
    }
  }

  // Try Atom <entry> format
  if (entries.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1]!;
      const title = extractTag(block, 'title');
      const link = extractAtomLink(block);
      const date = extractTag(block, 'updated') || extractTag(block, 'published') || '';

      if (title || link) {
        entries.push({ title: title || '(無標題)', link: link || '', date });
      }
    }
  }

  return entries;
}

function extractTag(block: string, tag: string): string {
  // Handle CDATA
  const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const cdataMatch = block.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1]!.trim();

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(regex);
  return m ? decodeXmlEntities(m[1]!.trim()) : '';
}

function extractGuid(block: string): string {
  return extractTag(block, 'guid');
}

function extractAtomLink(block: string): string {
  // <link href="..." /> or <link rel="alternate" href="..." />
  const linkMatch = block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i);
  return linkMatch ? linkMatch[1]! : '';
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ── Feed ID (unique identifier for dedup) ───────────────────────────

function getEntryId(entry: FeedEntry): string {
  return entry.link || entry.title;
}

// ── Fetch & Check ───────────────────────────────────────────────────

async function fetchFeed(url: string): Promise<FeedEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MetacognitiveBot/1.0 (RSS Monitor)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();
    return parseRssFeed(xml);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function checkFeed(feed: FeedConfig): Promise<FeedEntry[]> {
  const entries = await fetchFeed(feed.url);

  // Initialize seen list if needed
  if (!state.seenIds[feed.url]) {
    // First time: mark all current entries as seen (don't flood notifications)
    state.seenIds[feed.url] = entries.map(getEntryId).slice(0, MAX_SEEN_PER_FEED);
    return [];
  }

  const seen = new Set(state.seenIds[feed.url]);
  const newEntries = entries.filter((e) => !seen.has(getEntryId(e)));

  // Update seen list
  for (const entry of newEntries) {
    state.seenIds[feed.url]!.push(getEntryId(entry));
  }

  // Cap seen list
  while ((state.seenIds[feed.url]?.length ?? 0) > MAX_SEEN_PER_FEED) {
    state.seenIds[feed.url]!.shift();
  }

  return newEntries.slice(0, MAX_NEW_ITEMS);
}

async function pollAllFeeds(): Promise<void> {
  if (!lastCtx || state.feeds.length === 0) return;

  for (const feed of state.feeds) {
    try {
      const newEntries = await checkFeed(feed);
      if (newEntries.length === 0) continue;

      const lines = [
        `📡 *${feed.name}* 有 ${newEntries.length} 篇新文章：`,
        '',
      ];

      for (const entry of newEntries) {
        if (entry.link) {
          lines.push(`• [${escapeMarkdown(entry.title)}](${entry.link})`);
        } else {
          lines.push(`• ${escapeMarkdown(entry.title)}`);
        }
      }

      await lastCtx.sendMarkdown(lines.join('\n'));
    } catch {
      // Silently skip failed feeds — will retry next cycle
    }
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ── Plugin ──────────────────────────────────────────────────────────

const plugin: Plugin = {
  meta: {
    name: 'rss',
    description: 'RSS 訂閱監控',
    icon: '📡',
    aliases: ['rss', '訂閱', 'feed', 'subscribe'],
  },

  init: () => {
    // Start polling timer
    state.pollInterval = setInterval(() => {
      pollAllFeeds().catch(() => {});
    }, POLL_INTERVAL_MS);
  },

  dispose: () => {
    if (state.pollInterval) {
      clearInterval(state.pollInterval);
      state.pollInterval = null;
    }
  },

  handler: async (ctx, args) => {
    // Save context for background notifications
    lastCtx = ctx;

    const parts = args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() || '';

    switch (sub) {
      case 'add':
      case '新增': {
        const url = parts[1];
        const name = parts.slice(2).join(' ') || extractDomain(url);

        if (!url || !url.startsWith('http')) {
          await ctx.sendMarkdown(
            '用法：`/rss add <URL> [名稱]`\n\n' +
            '範例：`/rss add https://blog.example.com/rss.xml 技術部落格`'
          );
          return;
        }

        // Verify feed is reachable
        try {
          const entries = await fetchFeed(url);
          if (entries.length === 0) {
            await ctx.sendMarkdown('⚠️ 可以連線但解析不到文章，請確認這是有效的 RSS/Atom feed。');
            return;
          }

          // Check for duplicates
          if (state.feeds.some((f) => f.url === url)) {
            await ctx.sendMarkdown('⚠️ 這個 feed 已經在追蹤清單中了。');
            return;
          }

          state.feeds.push({ name, url });
          // Mark current entries as seen
          state.seenIds[url] = entries.map(getEntryId).slice(0, MAX_SEEN_PER_FEED);

          await ctx.sendMarkdown(
            `✅ 已新增 RSS 訂閱\n\n` +
            `📡 *${name}*\n` +
            `🔗 ${url}\n` +
            `📝 目前有 ${entries.length} 篇文章\n` +
            `⏱ 每 ${POLL_INTERVAL_MS / 60000} 分鐘檢查一次`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.sendMarkdown(`❌ 無法連線到 feed：${msg}`);
        }
        return;
      }

      case 'remove':
      case 'del':
      case '移除':
      case '刪除': {
        const target = parts.slice(1).join(' ');
        if (!target) {
          await ctx.sendMarkdown('用法：`/rss remove <名稱或URL>`');
          return;
        }

        const lower = target.toLowerCase();
        const idx = state.feeds.findIndex(
          (f) => f.name.toLowerCase() === lower || f.url.toLowerCase() === lower
        );

        if (idx === -1) {
          await ctx.sendMarkdown('❌ 找不到這個訂閱。用 `/rss list` 查看目前追蹤的 feed。');
          return;
        }

        const removed = state.feeds.splice(idx, 1)[0]!;
        delete state.seenIds[removed.url];
        await ctx.sendMarkdown(`✅ 已移除：*${removed.name}*`);
        return;
      }

      case 'list':
      case '列表':
      case '': {
        if (state.feeds.length === 0) {
          await ctx.sendMarkdown(
            '📡 *RSS 訂閱監控*\n\n' +
            '目前沒有追蹤任何 feed。\n\n' +
            '*指令：*\n' +
            '`/rss add <URL> [名稱]` — 新增訂閱\n' +
            '`/rss remove <名稱>` — 移除訂閱\n' +
            '`/rss list` — 查看追蹤清單\n' +
            '`/rss check` — 立即檢查所有 feed'
          );
          return;
        }

        const lines = ['📡 *RSS 訂閱清單*', ''];
        for (let i = 0; i < state.feeds.length; i++) {
          const f = state.feeds[i]!;
          const seenCount = state.seenIds[f.url]?.length ?? 0;
          lines.push(`${i + 1}. *${f.name}*`);
          lines.push(`   ${f.url}`);
          lines.push(`   已追蹤 ${seenCount} 篇文章`);
          lines.push('');
        }
        lines.push(`⏱ 每 ${POLL_INTERVAL_MS / 60000} 分鐘自動檢查`);

        await ctx.sendMarkdown(lines.join('\n'));
        return;
      }

      case 'check':
      case '檢查': {
        if (state.feeds.length === 0) {
          await ctx.sendMarkdown('目前沒有追蹤任何 feed。');
          return;
        }

        await ctx.sendMarkdown('🔍 正在檢查所有 feed...');

        let totalNew = 0;
        for (const feed of state.feeds) {
          try {
            const newEntries = await checkFeed(feed);
            if (newEntries.length > 0) {
              totalNew += newEntries.length;
              const lines = [
                `📡 *${feed.name}* — ${newEntries.length} 篇新文章：`,
                '',
              ];
              for (const entry of newEntries) {
                if (entry.link) {
                  lines.push(`• [${escapeMarkdown(entry.title)}](${entry.link})`);
                } else {
                  lines.push(`• ${escapeMarkdown(entry.title)}`);
                }
              }
              await ctx.sendMarkdown(lines.join('\n'));
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.sendMarkdown(`⚠️ *${feed.name}* 檢查失敗：${msg}`);
          }
        }

        if (totalNew === 0) {
          await ctx.sendMarkdown('✅ 所有 feed 都沒有新文章。');
        }
        return;
      }

      default:
        await ctx.sendMarkdown(
          '📡 *RSS 訂閱監控*\n\n' +
          '*指令：*\n' +
          '`/rss add <URL> [名稱]` — 新增訂閱\n' +
          '`/rss remove <名稱>` — 移除訂閱\n' +
          '`/rss list` — 查看追蹤清單\n' +
          '`/rss check` — 立即檢查所有 feed'
        );
    }
  },
};

function extractDomain(url?: string): string {
  if (!url) return 'Unknown Feed';
  try {
    return new URL(url).hostname;
  } catch {
    return 'Unknown Feed';
  }
}

export default plugin;
