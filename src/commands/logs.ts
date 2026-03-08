/**
 * Logs handler — narrative history.
 * Registered as /sys logs via sys.ts.
 *
 * Subcommands:
 *   /sys logs           — Recent 10 entries
 *   /sys logs search X  — Full-text search
 *   /sys logs stats     — Aggregate statistics
 *   /sys logs date YYYY-MM-DD — Entries for a date
 */

import { getRecentNarrative } from '../identity/narrator.js';
import {
  searchAllNarrative,
  getNarrativeByDate,
  getNarrativeStats,
  formatStats,
} from '../identity/narrative-analyzer.js';
import type { BotContext } from '../bot.js';

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function typeIcon(type: string): string {
  const icons: Record<string, string> = {
    interaction: '💬', evolution: '🧬', reflection: '🪞',
    milestone: '🏆', identity_change: '🔄', boot: '🟢', shutdown: '🔴',
  };
  return icons[type] ?? '📝';
}

async function showRecent(ctx: BotContext): Promise<void> {
  const entries = await getRecentNarrative(10);

  if (entries.length === 0) {
    await ctx.reply('暫無 narrative 記錄。');
    return;
  }

  const lines = [`📜 *最近 ${entries.length} 條記錄*`, ``];
  for (const e of entries.reverse()) {
    const emotion = e.emotion ? ` (${e.emotion})` : '';
    lines.push(`${typeIcon(e.type)} ${formatTime(e.timestamp)}${emotion}`);
    lines.push(`   ${e.summary.slice(0, 80)}${e.summary.length > 80 ? '...' : ''}`);
  }

  lines.push(``);
  lines.push(`_💡 /sys logs stats | /sys logs search <關鍵字> | /sys logs date YYYY-MM-DD_`);

  const text = lines.join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/[*_]/g, ''));
  }
}

async function showSearch(ctx: BotContext, keyword: string): Promise<void> {
  if (!keyword) {
    await ctx.reply('請提供搜尋關鍵字: /sys logs search <關鍵字>');
    return;
  }

  const results = await searchAllNarrative(keyword, 10);

  if (results.length === 0) {
    await ctx.reply(`🔍 找不到包含「${keyword}」的記錄。`);
    return;
  }

  const lines = [`🔍 *搜尋「${keyword}」* — ${results.length} 筆結果`, ``];
  for (const e of results) {
    lines.push(`${typeIcon(e.type)} ${formatTime(e.timestamp)}`);
    lines.push(`   ${e.summary.slice(0, 100)}${e.summary.length > 100 ? '...' : ''}`);
  }

  const text = lines.join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/[*_]/g, ''));
  }
}

async function showByDate(ctx: BotContext, date: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    await ctx.reply('日期格式錯誤，請使用 YYYY-MM-DD');
    return;
  }

  const entries = await getNarrativeByDate(date);

  if (entries.length === 0) {
    await ctx.reply(`📅 ${date} 無記錄。`);
    return;
  }

  const lines = [`📅 *${date}* — ${entries.length} 條記錄`, ``];
  for (const e of entries) {
    const time = new Date(e.timestamp).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
    });
    const emotion = e.emotion ? ` (${e.emotion})` : '';
    lines.push(`${typeIcon(e.type)} ${time}${emotion} — ${e.summary.slice(0, 80)}`);
  }

  const text = lines.join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/[*_]/g, ''));
  }
}

async function showStatsView(ctx: BotContext): Promise<void> {
  const stats = await getNarrativeStats();

  if (stats.totalEntries === 0) {
    await ctx.reply('暫無足夠資料進行統計分析。');
    return;
  }

  const text = formatStats(stats);
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/[*_]/g, ''));
  }
}

/** Logs handler (parses subcommands) */
export async function handleLogs(ctx: BotContext): Promise<void> {
  const args = (ctx.message?.text ?? '').replace(/^\/(?:sys\s+)?logs\s*/i, '').trim();

  try {
    if (args.startsWith('search ') || args.startsWith('搜尋 ')) {
      const keyword = args.replace(/^(?:search|搜尋)\s+/, '');
      await showSearch(ctx, keyword);
    } else if (args === 'stats' || args === '統計') {
      await showStatsView(ctx);
    } else if (args.startsWith('date ') || args.startsWith('日期 ')) {
      const date = args.replace(/^(?:date|日期)\s+/, '');
      await showByDate(ctx, date);
    } else {
      await showRecent(ctx);
    }
  } catch (err) {
    await ctx.reply(`日誌查詢失敗: ${(err as Error).message}`);
  }
}
