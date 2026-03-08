/**
 * Diary handlers.
 * Registered as /soul diary via soul.ts.
 *
 * Callbacks:
 *   diary:list          — Show diary list
 *   diary:view:{N}      — View entry at reverse index N
 *   diary:back          — Return to latest entry
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry } from '../telegram/command-registry.js';
import { sendLongMessage } from '../telegram/helpers.js';
import { getRecentDiary, type DiaryEntry } from '../metacognition/diary-writer.js';
import type { BotContext } from '../bot.js';

// ── Display helpers ──────────────────────────────────────────────────

function formatDiaryEntry(entry: DiaryEntry): string {
  const lines: string[] = [];
  lines.push(`📔 ${entry.date} 的日記`);
  lines.push('');
  lines.push(entry.content);

  if (entry.themes.length > 0) {
    lines.push('');
    lines.push(entry.themes.map((t) => `#${t}`).join(' '));
  }

  lines.push('');
  lines.push(`── ${entry.wordCount} 字`);

  return lines.join('\n');
}

// ── Handlers ─────────────────────────────────────────────────────────

/** Show latest diary entry */
export async function handleDiaryDefault(ctx: BotContext): Promise<void> {
  const entries = await getRecentDiary(1);

  if (entries.length === 0) {
    await ctx.reply('我還沒有開始寫日記。每天晚上九點，反思完成後我會寫下當天的日記。');
    return;
  }

  const entry = entries[0]!;
  const text = formatDiaryEntry(entry);

  const keyboard = new InlineKeyboard()
    .text('📖 回顧過去的日記', 'diary:list');

  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('想做什麼？', { reply_markup: keyboard });
}

/** List recent diary entries */
export async function handleDiaryList(ctx: BotContext): Promise<void> {
  const entries = await getRecentDiary(5);

  if (entries.length === 0) {
    await ctx.reply('我還沒有開始寫日記。每天晚上九點，反思完成後我會寫下當天的日記。');
    return;
  }

  const lines: string[] = [`📔 最近的日記（共 ${entries.length} 篇）`, ''];
  const keyboard = new InlineKeyboard();

  const chronological = [...entries].reverse();
  chronological.forEach((entry, i) => {
    const idx = entries.length - 1 - i;
    const preview = entry.content.length > 50
      ? entry.content.slice(0, 47) + '...'
      : entry.content;
    const themes = entry.themes.slice(0, 3).map((t) => `#${t}`).join(' ');
    lines.push(`${entry.date}`);
    lines.push(`  ${preview}`);
    if (themes) lines.push(`  ${themes}`);
    lines.push('');

    keyboard.text(`${entry.date}`, `diary:view:${idx}`).row();
  });

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('點選查看完整日記：', { reply_markup: keyboard });
}

/** View a specific diary entry by index */
async function handleDiaryView(ctx: BotContext, index: number): Promise<void> {
  const entries = await getRecentDiary(index + 1);
  const entry = entries[index];

  if (!entry) {
    await ctx.reply('找不到那篇日記。');
    return;
  }

  const text = formatDiaryEntry(entry);

  const keyboard = new InlineKeyboard()
    .text('📔 返回列表', 'diary:list')
    .text('📝 最新日記', 'diary:back');

  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('想做什麼？', { reply_markup: keyboard });
}

/** View diary by date string */
export async function handleDiaryByDate(ctx: BotContext, date: string): Promise<void> {
  const entries = await getRecentDiary(30);
  const match = entries.find((e) => e.date === date);

  if (!match) {
    await ctx.reply(`找不到 ${date} 的日記。可能那天還沒有寫。`);
    return;
  }

  const text = formatDiaryEntry(match);

  const keyboard = new InlineKeyboard()
    .text('📔 返回列表', 'diary:list')
    .text('📝 最新日記', 'diary:back');

  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('想做什麼？', { reply_markup: keyboard });
}

/** /soul diary handler (parses subcommand args) */
export async function handleDiary(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text || '';
  const args = text.replace(/^\/(?:soul\s+diary|diary)\s*/, '').trim();

  if (args === 'list') {
    await handleDiaryList(ctx);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(args)) {
    await handleDiaryByDate(ctx, args);
  } else {
    await handleDiaryDefault(ctx);
  }
}

// ── Callback registration ────────────────────────────────────────────

export function registerDiaryCallbacks(): void {
  commandRegistry.registerCallback('diary:list', async (ctx) => {
    await handleDiaryList(ctx as BotContext);
  });

  commandRegistry.registerCallback('diary:view:', async (ctx, data) => {
    const index = parseInt(data, 10);
    if (isNaN(index)) {
      await ctx.reply('無效的日記索引。');
      return;
    }
    await handleDiaryView(ctx as BotContext, index);
  });

  commandRegistry.registerCallback('diary:back', async (ctx) => {
    await handleDiaryDefault(ctx as BotContext);
  });
}
