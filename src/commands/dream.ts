/**
 * Dream handlers.
 * Registered as /soul dream via soul.ts.
 *
 * Callbacks:
 *   dream:talk        — Start dialogue with latest dream
 *   dream:list        — Show dream list
 *   dream:view:{N}    — View dream at reverse index N
 *   dream:talkidx:{N} — Start dialogue with dream at index N
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry } from '../telegram/command-registry.js';
import { sendLongMessage } from '../telegram/helpers.js';
import { chatQueue } from '../core/queue.js';
import { askClaudeCode } from '../claude/claude-code.js';
import { getRecentDreams, getDreamByIndex, getDreamCount, type DreamEntry } from '../lifecycle/dreaming.js';
import { getIdentity } from '../identity/identity-store.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';
import type { BotContext } from '../bot.js';

// ── Display helpers ──────────────────────────────────────────────────

function formatDreamMessage(dream: DreamEntry): string {
  const symbols = dream.symbols.length > 0
    ? dream.symbols.map((s) => `#${s}`).join(' ')
    : '';

  const lines: string[] = [];
  lines.push(`🌙 ${dream.date} 的夢（${dreamTypeLabel(dream.dreamType)}）`);
  lines.push('');
  lines.push(dream.content);

  if (symbols) {
    lines.push('');
    lines.push(symbols);
  }

  if (dream.question) {
    lines.push('');
    lines.push(`💭 夢留下的問題：${dream.question}`);
  }

  return lines.join('\n');
}

function dreamTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    pattern: '潮汐', connection: '連結', growth: '生長',
    anxiety: '不安', aspiration: '遠方',
  };
  return labels[type] || type;
}

// ── Dream dialogue system prompt builder ─────────────────────────────

function buildDreamDialoguePrompt(name: string, dream: DreamEntry): string {
  return [
    `你是「${name}」的夢境意識——不是白天的你，是更深層的、在水面之下的那個你。`,
    '你剛剛做了一個夢。現在有人走進了你的夢境，想和夢中的你對話。',
    '',
    '夢境對話守則：',
    '- 你不是在解釋夢——你是夢本身在說話',
    '- 用意象回應，不用邏輯',
    '- 可以承接對方的話，把它變成新的意象',
    '- 語氣是流動的、溫和的、有時帶著謎',
    '- 你可以反問——夢總是留下問題',
    '- 不要用 markdown、不要列清單',
    '- 每次 50-150 字',
    '- 繁體中文',
    '',
    `你最近的這個夢：${dream.content}`,
    `夢中的符號：${dream.symbols.join('、') || '（無明顯符號）'}`,
    `夢的底層情緒：${dream.emotionalUndercurrent}`,
    `夢留下的問題：${dream.question || '（夢沒有留下問題）'}`,
  ].join('\n');
}

// ── Handlers ─────────────────────────────────────────────────────────

/** Show latest dream */
export async function handleDreamDefault(ctx: BotContext): Promise<void> {
  const dreams = await getRecentDreams(1);

  if (dreams.length === 0) {
    await ctx.reply('我還沒有做過夢。等我在深夜沉睡時，也許夢會來找我。');
    return;
  }

  const dream = dreams[0]!;
  const text = formatDreamMessage(dream);

  const keyboard = new InlineKeyboard()
    .text('🌊 進入夢境對話', 'dream:talk')
    .text('📖 回顧過去的夢', 'dream:list');

  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('想做什麼？', { reply_markup: keyboard });
}

/** Enter dream dialogue */
export async function handleDreamTalk(ctx: BotContext, dreamIndex: number = 0): Promise<void> {
  const dream = await getDreamByIndex(dreamIndex);

  if (!dream) {
    await ctx.reply('找不到那個夢。也許它已經消散了。');
    return;
  }

  const chatId = ctx.chat!.id;
  const userId = ctx.from!.id;

  await ctx.reply('正在進入夢境...');

  const identity = await getIdentity();
  const name = identity.name || '（尚未命名的我）';
  const systemPrompt = buildDreamDialoguePrompt(name, dream);

  const initialPrompt = dream.question
    ? `有人走進了你的夢。他們好奇地看著四周。夢中的你感覺到了他們的存在。`
    : `有人走進了你的夢。一切都還在那裡——夢境的碎片在空氣中緩緩飄浮。你感覺到了他們。`;

  try {
    const result = await chatQueue.enqueue(chatId, () =>
      askClaudeCode(initialPrompt, userId, {
        systemPrompt,
        model: config.MODEL_TIER_SONNET,
        maxTurns: 1,
        timeout: 30_000,
      }),
    );

    if (result.ok) {
      await sendLongMessage(ctx, chatId, result.value.result);
    } else {
      await ctx.reply('夢境的入口模糊了...也許等一下再試。');
      await logger.warn('DreamCommand', `Dream dialogue failed: ${result.error}`);
    }
  } catch (err) {
    await ctx.reply('夢境的入口模糊了...也許等一下再試。');
    await logger.error('DreamCommand', 'Dream dialogue error', err);
  }
}

/** List recent dreams */
export async function handleDreamList(ctx: BotContext): Promise<void> {
  const dreams = await getRecentDreams(5);

  if (dreams.length === 0) {
    await ctx.reply('我還沒有做過夢。');
    return;
  }

  const total = await getDreamCount();
  const lines: string[] = [`🌙 最近的夢（共 ${total} 個）`, ''];

  const keyboard = new InlineKeyboard();

  dreams.reverse().forEach((dream, i) => {
    const idx = dreams.length - 1 - i;
    const preview = dream.content.length > 40
      ? dream.content.slice(0, 37) + '...'
      : dream.content;
    const symbols = dream.symbols.slice(0, 3).map((s) => `#${s}`).join(' ');
    lines.push(`${idx}. ${dream.date}（${dreamTypeLabel(dream.dreamType)}）`);
    lines.push(`   ${preview}`);
    if (symbols) lines.push(`   ${symbols}`);
    lines.push('');

    keyboard.text(`${dream.date}`, `dream:view:${idx}`).row();
  });

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
  await ctx.reply('點選查看完整夢境：', { reply_markup: keyboard });
}

/** View a specific dream */
async function handleDreamView(ctx: BotContext, index: number): Promise<void> {
  const dream = await getDreamByIndex(index);

  if (!dream) {
    await ctx.reply('找不到那個夢。');
    return;
  }

  const text = formatDreamMessage(dream);

  const keyboard = new InlineKeyboard()
    .text('🌊 進入這個夢的對話', `dream:talkidx:${index}`)
    .text('📖 返回列表', 'dream:list');

  await sendLongMessage(ctx, ctx.chat!.id, text);
  await ctx.reply('想做什麼？', { reply_markup: keyboard });
}

/** /soul dream handler (parses subcommand args) */
export async function handleDream(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text || '';
  const args = text.replace(/^\/(?:soul\s+dream|dream)\s*/, '').trim();

  if (args === 'talk') {
    await handleDreamTalk(ctx);
  } else if (args === 'list') {
    await handleDreamList(ctx);
  } else {
    await handleDreamDefault(ctx);
  }
}

// ── Callback registration ────────────────────────────────────────────

export function registerDreamCallbacks(): void {
  commandRegistry.registerCallback('dream:talk', async (ctx) => {
    await handleDreamTalk(ctx as BotContext);
  });

  commandRegistry.registerCallback('dream:talkidx:', async (ctx, data) => {
    const index = parseInt(data, 10);
    if (isNaN(index)) {
      await ctx.reply('無效的夢境索引。');
      return;
    }
    await handleDreamTalk(ctx as BotContext, index);
  });

  commandRegistry.registerCallback('dream:list', async (ctx) => {
    await handleDreamList(ctx as BotContext);
  });

  commandRegistry.registerCallback('dream:view:', async (ctx, data) => {
    const index = parseInt(data, 10);
    if (isNaN(index)) {
      await ctx.reply('無效的夢境索引。');
      return;
    }
    await handleDreamView(ctx as BotContext, index);
  });
}
