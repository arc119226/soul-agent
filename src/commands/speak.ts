/**
 * Speak handler (TTS).
 * Registered as /soul speak via soul.ts.
 */

import { InputFile } from 'grammy';
import type { BotContext } from '../bot.js';

/** Text-to-speech handler */
export async function handleSpeak(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  // Extract text after /soul speak or /speak
  const match = text.match(/(?:\/soul\s+speak|\/speak)\s+(.+)/s);
  const toSpeak = match?.[1]?.trim();

  if (!toSpeak) {
    await ctx.reply('用法：/soul speak <要唸的文字>\n例如：/soul speak 你好，今天天氣真不錯');
    return;
  }

  if (toSpeak.length > 500) {
    await ctx.reply('⚠️ 文字太長了，最多 500 字。');
    return;
  }

  await ctx.replyWithChatAction('upload_voice');

  const { synthesize } = await import('../voice/tts.js');
  const buffer = await synthesize(toSpeak);

  if (!buffer) {
    await ctx.reply('❌ 語音合成失敗，請稍後再試。');
    return;
  }

  await ctx.replyWithVoice(new InputFile(buffer, 'voice.mp3'));
}
