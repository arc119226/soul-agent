/**
 * Metacognition and reflect handlers.
 * Registered as /soul subcommands via soul.ts.
 */

import { InlineKeyboard } from 'grammy';
import { triggerReflection, getRecentReflections } from '../metacognition/reflection.js';
import { getCuriosityTopics } from '../metacognition/curiosity.js';
import { getPatterns } from '../metacognition/learning-tracker.js';
import type { BotContext } from '../bot.js';

/** Metacognition status handler */
export async function handleMetacognition(ctx: BotContext): Promise<void> {
  const reflections = await getRecentReflections(3);
  const curiosity = await getCuriosityTopics();
  const patterns = await getPatterns();

  const lines: string[] = ['*後設認知狀態*', ''];

  lines.push(`*最近反思:* ${reflections.length} 筆`);
  if (reflections.length > 0) {
    const latest = reflections[reflections.length - 1]!;
    lines.push(`  上次: ${latest.timestamp.slice(0, 16)}`);
    lines.push(`  心得: ${latest.insights[0] ?? '(無)'}`);
    lines.push(`  情緒: ${latest.mood_assessment}`);
  }

  lines.push('');
  lines.push(`*好奇心:* ${curiosity.length} 個主題`);
  for (const t of curiosity.slice(0, 3)) {
    lines.push(`  - ${t.topic}`);
  }

  lines.push('');
  lines.push(`*學習模式:*`);
  lines.push(`  成功: ${patterns.successes.length} 次`);
  lines.push(`  失敗: ${patterns.failures.length} 次`);
  lines.push(`  洞察: ${patterns.insights.length} 項`);
  if (patterns.insights.length > 0) {
    const latest = patterns.insights[patterns.insights.length - 1]!;
    lines.push(`  最新: ${latest}`);
  }

  const text = lines.join('\n');

  const keyboard = new InlineKeyboard()
    .text('🪞 反思', 'soul:reflect')
    .text('📔 日記', 'soul:diary')
    .row()
    .text('🏆 成就', 'soul:achievements')
    .text('◀️ 返回選單', 'menu:home');

  try {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch {
    await ctx.reply(text.replace(/\*/g, ''), { reply_markup: keyboard });
  }
}

/** Reflect handler */
export async function handleReflect(ctx: BotContext): Promise<void> {
  await ctx.reply('開始反思...');

  const entry = await triggerReflection('triggered');

  const lines = [
    '*反思完成*',
    '',
    `*心得:*`,
    ...entry.insights.map((i: string) => `  - ${i}`),
    '',
    `*情緒評估:* ${entry.mood_assessment}`,
    `*成長筆記:* ${entry.growth_notes}`,
    `*互動次數:* ${entry.interaction_count}`,
  ];

  if (entry.topics_discussed.length > 0) {
    lines.push(`*討論主題:* ${entry.topics_discussed.join(', ')}`);
  }

  const text = lines.join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/\*/g, ''));
  }
}
