/**
 * General text message handler.
 * - All messages: user tracking, interaction recording, wake-up
 * - All users: plugin routing → natural language intent matching → command execution
 * - Admin messages (no intent match): context weaving → Claude Code
 * - Other allowed users (no intent match): default reply
 */

import type { Bot } from 'grammy';
import type { Message } from '@grammyjs/types';
import type { BotContext } from '../bot.js';
import type { StreamProgress } from '../claude/claude-code.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { sendLongMessage, formatUserError } from './helpers.js';
import { isOk } from '../result.js';
import { eventBus } from '../core/event-bus.js';
import { updateUser } from '../memory/user-store.js';
import { recordInteraction, recordActivityHour } from '../lifecycle/awareness.js';
import { wakeUp } from '../lifecycle/heartbeat.js';
import { tryRouteToPlugin } from './plugin-router.js';
import { commandRegistry } from './command-registry.js';
import { askClaudeCode, LIGHTWEIGHT_CWD } from '../claude/claude-code.js';
import { routeMessage, MODEL_TIMEOUTS } from './model-router.js';
import { weaveLightContext, weaveContext } from '../identity/context-weaver.js';

// ── Empty response diagnostic (SPEC-36) ─────────────────────────────

function buildEmptyResponseDiagnostic(
  result: { numTurns: number; maxTurnsHit?: boolean; costUsd: number },
  route: { tier: string },
  maxTurns: number,
): string {
  let cause: string;
  let suggestion: string;

  if (result.numTurns === 0 && result.costUsd === 0) {
    cause = 'Claude CLI 未啟動或立即退出';
    suggestion = '嘗試 /cc new 重置會話';
  } else if (result.numTurns === 0 && result.costUsd > 0) {
    cause = '已連線但未產生回應';
    suggestion = '嘗試重新發送訊息';
  } else if (result.maxTurnsHit || result.numTurns >= maxTurns) {
    cause = `已達最大回合數 (${result.numTurns}/${maxTurns}) 但未產生結果`;
    suggestion = '簡化問題，或使用 ~ 前綴切換至 Opus';
  } else {
    cause = `處理 ${result.numTurns} 回合後停止`;
    suggestion = '嘗試重新發送訊息';
  }

  return [
    '🤔 沒有產生回應。',
    `• 模型: ${route.tier}`,
    `• 回合數: ${result.numTurns}`,
    `• 可能原因: ${cause}`,
    '',
    `💡 ${suggestion}`,
  ].join('\n');
}

// ── Message merge buffer ─────────────────────────────────────────────
// When Claude is busy, incoming messages accumulate here instead of
// queueing as separate tasks. Once the current task finishes, buffered
// messages are merged into a single combined prompt.

interface BufferedMessage {
  text: string;           // enriched text (with reply/forward context)
  originalText: string;   // raw user text (for routing/logging)
  ctx: BotContext;        // saved context for reply
  timestamp: number;
}

/** Per-chat message buffer and processing lock */
interface ChatState {
  processing: boolean;
  buffer: BufferedMessage[];
}

const chatStates = new Map<number, ChatState>();

function getChatState(chatId: number): ChatState {
  let state = chatStates.get(chatId);
  if (!state) {
    state = { processing: false, buffer: [] };
    chatStates.set(chatId, state);
  }
  return state;
}

// ── Reply / Forward context extraction ──────────────────────────────

/**
 * Extract contextual information from reply_to_message, quote, and forward_origin.
 * Returns a prefix string to prepend to the user's message for Claude, or empty string.
 */
function extractMessageContext(msg: Message.TextMessage): string {
  const parts: string[] = [];

  // 1. Forward origin
  if (msg.forward_origin) {
    const origin = msg.forward_origin;
    let sourceLabel: string;
    switch (origin.type) {
      case 'user':
        sourceLabel = origin.sender_user.first_name + (origin.sender_user.username ? ` (@${origin.sender_user.username})` : '');
        break;
      case 'hidden_user':
        sourceLabel = origin.sender_user_name;
        break;
      case 'chat':
        sourceLabel = ('title' in origin.sender_chat ? origin.sender_chat.title : '') || '(群組)';
        break;
      case 'channel':
        sourceLabel = ('title' in origin.chat ? origin.chat.title : '') || '(頻道)';
        break;
    }
    const date = new Date(origin.date * 1000);
    const timeStr = date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    parts.push(`[轉發訊息] 來自 ${sourceLabel} (${timeStr})`);
  }

  // 2. Reply to message
  if (msg.reply_to_message) {
    const reply = msg.reply_to_message;
    const replyText = reply.text || reply.caption || '';
    if (replyText) {
      const sender = reply.from;
      const senderName = sender
        ? (sender.first_name + (sender.username ? ` (@${sender.username})` : ''))
        : '(未知)';

      // Truncate very long quoted messages
      const maxQuoteLen = 500;
      const truncated = replyText.length > maxQuoteLen
        ? replyText.slice(0, maxQuoteLen) + '...'
        : replyText;

      parts.push(`[回覆訊息] ${senderName} 說：\n「${truncated}」`);
    }
  }

  // 3. Telegram quote (partial text selection)
  if (msg.quote?.text) {
    parts.push(`[引用] 「${msg.quote.text}」`);
  }

  if (parts.length === 0) return '';
  return parts.join('\n') + '\n\n';
}

/**
 * Register the general text message handler on the bot.
 * MUST be called AFTER command registration so commands take priority.
 */
export function setupMessageHandler(bot: Bot<BotContext>): void {
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    if (!userId || !text) return;

    // If it looks like a /command, try plugin routing before giving up.
    // grammY command middleware runs first — registered commands already handled.
    // Unregistered /xxx falls through here, so we strip the prefix and try plugins.
    if (text.startsWith('/')) {
      const withoutSlash = text.slice(1);
      if (!withoutSlash.trim()) return;
      // Only treat as command if slash is followed by letters (not paths like /home/user)
      if (/^[a-zA-Z]/.test(withoutSlash)) {
        try {
          const handled = await tryRouteToPlugin(ctx, chatId, userId, withoutSlash);
          if (handled) return;
        } catch (err) {
          await logger.error('message-handler', 'Plugin routing error for /-prefixed text', err);
        }
        // Unknown command — friendly feedback
        await ctx.reply(`未知指令 /${withoutSlash.split(/\s/)[0]}，輸入 /menu 查看可用指令。`);
        return;
      }
      // Paths like /home/user/file fall through to normal processing
    }

    // --- Common for all messages: track user, record interaction, wake up ---
    try {
      await updateUser(userId, {
        name: ctx.from.first_name || '',
        username: ctx.from.username || '',
      });
    } catch {
      // Non-fatal
    }

    recordInteraction(userId);
    recordActivityHour(userId);

    try {
      const displayName = ctx.from.username || ctx.from.first_name || String(userId);
      await wakeUp(`message from ${displayName}`);
    } catch {
      // Non-fatal
    }

    // --- Plugin routing (all users) ---
    try {
      const handled = await tryRouteToPlugin(ctx, chatId, userId, text);
      if (handled) return;
    } catch (err) {
      await logger.error('message-handler', 'Plugin routing error', err);
    }

    // --- Natural language intent matching (all users) ---
    // High-confidence matches execute the command directly, skipping Claude Code.
    // Threshold raised from 0.8 to 0.9 to reduce false positives and let ambiguous
    // messages flow to Claude Code for semantic understanding.
    try {
      const intent = commandRegistry.matchIntent(text);
      if (intent && intent.confidence >= 0.9) {
        // Check admin-only permissions
        const isAdmin = userId === config.ADMIN_USER_ID;
        if (!intent.command.adminOnly || isAdmin) {
          await logger.debug('message-handler',
            `Intent matched: "${text}" → /${intent.command.name} (${(intent.confidence * 100).toFixed(0)}%)`);
          await intent.command.handler(ctx);
          return;
        }
      }
    } catch (err) {
      await logger.warn('message-handler', 'Intent matching error (non-fatal)', err);
    }

    const isAdmin = userId === config.ADMIN_USER_ID;

    if (isAdmin) {
      // Extract reply/forward/quote context and prepend to user text
      const msgContext = extractMessageContext(ctx.message);
      const enrichedText = msgContext ? msgContext + text : text;
      await handleAdminMessage(ctx, chatId, userId, text, enrichedText);
    } else {
      await handleUserMessage(ctx);
    }
  });
}

/** Admin messages: merge buffer + process loop */
async function handleAdminMessage(
  ctx: BotContext,
  chatId: number,
  userId: number,
  text: string,
  enrichedText?: string,
): Promise<void> {
  const promptText = enrichedText || text;
  const state = getChatState(chatId);

  // If already processing, buffer this message and return immediately
  if (state.processing) {
    state.buffer.push({
      text: promptText,
      originalText: text,
      ctx,
      timestamp: Date.now(),
    });
    const pos = state.buffer.length;
    await ctx.reply(`📝 已收到（第 ${pos + 1} 則），處理完前一則後會合併處理`);
    await logger.info('message-handler', `Buffered message #${pos} for chat ${chatId}: "${text.slice(0, 40)}..."`);
    return;
  }

  // Not busy — start processing immediately
  state.processing = true;

  try {
    await processMessage(ctx, chatId, userId, text, promptText);
  } finally {
    // After processing, drain the buffer
    await drainBuffer(chatId, userId);
    state.processing = false;
  }
}

/**
 * Drain buffered messages: merge all pending messages into one combined prompt.
 * Keeps looping until the buffer is empty (in case new messages arrive during processing).
 */
async function drainBuffer(chatId: number, userId: number): Promise<void> {
  const state = getChatState(chatId);

  while (state.buffer.length > 0) {
    // Snapshot and clear buffer atomically
    const batch = state.buffer.splice(0);

    // Use the latest ctx for replying (most recent message)
    const latestCtx = batch[batch.length - 1]!.ctx;

    // Merge all buffered texts into one prompt
    const mergedParts = batch.map((m, i) => {
      const label = batch.length > 1 ? `[訊息 ${i + 1}] ` : '';
      return `${label}${m.text}`;
    });
    const mergedPrompt = mergedParts.join('\n\n');

    // For model routing, use the longest original text (most likely the substantive one)
    const routingText = batch.reduce((longest, m) =>
      m.originalText.length > longest.length ? m.originalText : longest, '');

    await logger.info('message-handler',
      `Merging ${batch.length} buffered message(s) for chat ${chatId}`);

    try {
      await processMessage(latestCtx, chatId, userId, routingText, mergedPrompt);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await logger.error('message-handler', `Error processing merged messages: ${errorMsg}`);
      await latestCtx.reply(formatUserError('system-error', errorMsg));
    }
  }
}

/** Core message processing: model routing → context weaving → Claude Code */
async function processMessage(
  ctx: BotContext,
  chatId: number,
  userId: number,
  text: string,      // original text for routing/logging
  promptText: string, // enriched text sent to Claude
): Promise<void> {
  try {
    // ── Model routing ──
    const route = await routeMessage(text, userId);

    // Strip intent marker (e.g. ~) so Claude receives clean text
    if (route.strippedText) {
      promptText = promptText.replace(text, route.strippedText);
      text = route.strippedText;
    }

    await logger.info('ModelRouter',
      `${route.tier} tier (${route.reason}) for: "${text.slice(0, 30)}${text.length > 30 ? '...' : ''}"`);

    if (route.tier === 'haiku') {
      // ── Haiku fast path: light context, no streaming, no progress ──
      let systemPrompt: string | undefined;
      try {
        systemPrompt = await weaveLightContext(chatId, userId);
      } catch {
        // Non-fatal
      }

      const result = await askClaudeCode(promptText, userId, {
        model: route.model,
        skipResume: true,
        maxTurns: 3,
        systemPrompt,
        cwd: LIGHTWEIGHT_CWD,
        timeout: MODEL_TIMEOUTS[route.tier],
      });

      if (isOk(result) && !result.value.maxTurnsHit) {
        const response = result.value.result || buildEmptyResponseDiagnostic(result.value, route, 3);
        await sendLongMessage(ctx, chatId, response, 'Markdown');
        eventBus.emit('message:received', { chatId, userId, text }).catch(() => {});
        eventBus.emit('message:sent', { chatId, text: response }).catch(() => {});
        if (result.value.costUsd > 0) {
          await logger.info('claude-code', `Cost: $${result.value.costUsd.toFixed(4)} [${route.tier}]`);
          eventBus.emit('cost:incurred', {
            source: 'main',
            tier: route.tier,
            costUsd: result.value.costUsd,
            chatId,
          }).catch(() => {});
        }
      } else if (isOk(result) && result.value.maxTurnsHit) {
        // Haiku hit turn limit — escalate to Sonnet path below
        await logger.info('ModelRouter', `Haiku hit maxTurns, falling back to Sonnet for: "${text.slice(0, 30)}..."`);
        route.tier = 'sonnet';
        route.model = config.MODEL_TIER_SONNET;
        route.reason = 'haiku-maxTurns-fallback';

        try {
          await ctx.reply('⏳ 問題較複雜，升級至 Sonnet 模型處理中...');
        } catch { /* non-fatal */ }
      } else if (!isOk(result)) {
        await ctx.reply(formatUserError('cli-error', result.error));
      }
    }

    if (route.tier !== 'haiku') {
      // ── Sonnet / Opus path: full context + streaming progress ──
      const progressMsg = await ctx.reply('⏳ 思考中...');
      const progressMsgId = progressMsg.message_id;

      let lastProgressUpdate = 0;
      const PROGRESS_THROTTLE_MS = 2000;
      const progressSteps: string[] = [];
      let lastEditedText = '';  // Deduplicate identical editMessageText calls

      const onProgress = (progress: StreamProgress) => {
        const now = Date.now();

        if (progress.type === 'text' && progress.fullText) {
          // ── Streaming text mode: show response content ──
          const MAX_DISPLAY = 3900;  // Telegram 4096 limit - leave room for header
          let display = progress.fullText;
          if (display.length > MAX_DISPLAY) {
            display = '...\n' + display.slice(-MAX_DISPLAY);  // Show tail for long responses
          }
          const msg = `✍️ 回應中...\n\n${display}`;
          if (msg === lastEditedText) return;  // Content unchanged, skip API call
          if (now - lastProgressUpdate < PROGRESS_THROTTLE_MS) return;
          lastProgressUpdate = now;
          lastEditedText = msg;
          ctx.api.editMessageText(chatId, progressMsgId, msg).catch(() => {});
        } else {
          // ── Step list mode: tools / thinking ──
          progressSteps.push(progress.summary);
          if (progressSteps.length > 5) progressSteps.shift();
          if (now - lastProgressUpdate < PROGRESS_THROTTLE_MS) return;
          lastProgressUpdate = now;
          const display = progressSteps
            .map((s, i) => i === progressSteps.length - 1 ? `▶ ${s}` : `  ${s}`)
            .join('\n');
          const msg = `⏳ 處理中...\n\n${display}`;
          if (msg === lastEditedText) return;
          lastEditedText = msg;
          ctx.api.editMessageText(chatId, progressMsgId, msg).catch(() => {});
        }
      };

      let systemPrompt: string | undefined;
      let contextDegraded = false;
      try {
        systemPrompt = await weaveContext(chatId, userId, [], text);
      } catch (err) {
        contextDegraded = true;
        await logger.warn('message-handler', 'Context weaving failed, proceeding without', err);
      }

      const tierTimeout = MODEL_TIMEOUTS[route.tier] ?? 180_000;
      const result = await askClaudeCode(promptText, userId, {
        systemPrompt,
        onProgress,
        model: route.model || undefined,
        maxTurns: 100,
        timeout: tierTimeout,
      });

      try {
        await ctx.api.deleteMessage(chatId, progressMsgId);
      } catch {
        // Non-fatal
      }

      // Timeout notification
      if (!isOk(result) && result.error.includes('timed out')) {
        await sendLongMessage(ctx, chatId, formatUserError('timeout'));
        return;
      }

      if (isOk(result)) {
        let response = result.value.result || buildEmptyResponseDiagnostic(result.value, route, 100);
        if (contextDegraded) {
          response += '\n\n⚡ 注意：本次回應未載入完整記憶，結果可能不夠精確。';
        }
        await sendLongMessage(ctx, chatId, response, 'Markdown');

        eventBus.emit('message:received', { chatId, userId, text }).catch(() => {});
        eventBus.emit('message:sent', { chatId, text: response }).catch(() => {});

        try {
          const { recordSuccess } = await import('../metacognition/learning-tracker.js');
          const topic = text.length > 40 ? text.slice(0, 37) + '...' : text;
          await recordSuccess('interaction', topic);
        } catch {
          // Non-fatal
        }

        try {
          const { evaluateAndRecord } = await import('../metacognition/reply-evaluator.js');
          await evaluateAndRecord(text, response);
        } catch {
          // Non-fatal
        }

        if (result.value.costUsd > 0) {
          await logger.info('claude-code', `Cost: $${result.value.costUsd.toFixed(4)}, turns: ${result.value.numTurns} [${route.tier}]`);
          eventBus.emit('cost:incurred', {
            source: 'main',
            tier: route.tier,
            costUsd: result.value.costUsd,
            chatId,
          }).catch(() => {});
        }
      } else {
        await ctx.reply(formatUserError('cli-error', result.error));

        try {
          const { recordFailure } = await import('../metacognition/learning-tracker.js');
          await recordFailure('interaction', result.error);
        } catch {
          // Non-fatal
        }
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await logger.error('message-handler', `Claude Code error: ${errorMsg}`);
    await ctx.reply(formatUserError('system-error', errorMsg));
  }
}

/** Non-admin user messages: default reply (intent matching already handled above) */
async function handleUserMessage(ctx: BotContext): Promise<void> {
  await ctx.reply('收到你的訊息了！目前我主要服務管理員，但你可以使用 /help 查看可用指令。');
}
