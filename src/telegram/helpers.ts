import type { BotContext } from '../bot.js';

/**
 * Send a message with Markdown formatting.
 * Falls back to plain text if Markdown parsing fails.
 */
export async function sendMarkdown(
  ctx: BotContext,
  chatId: number,
  text: string
): Promise<void> {
  try {
    await ctx.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch {
    // Fallback to plain text
    try {
      await ctx.api.sendMessage(chatId, text);
    } catch (err) {
      console.error('[sendMarkdown] Failed to send even plain text:', err);
    }
  }
}

/**
 * Send a long message, splitting at safe Unicode boundaries.
 * Telegram limit is 4096 chars per message.
 */
export async function sendLongMessage(
  ctx: BotContext,
  chatId: number,
  text: string,
  parseMode?: 'Markdown' | 'HTML'
): Promise<void> {
  const MARKER_RESERVE = 15;
  const MAX_LENGTH = 4000 - MARKER_RESERVE; // Leave margin for split markers
  let chunks = splitMessage(text, MAX_LENGTH);

  if (chunks.length > 1) {
    const total = chunks.length;
    chunks = chunks.map((chunk, i) => {
      const marker = `— (${i + 1}/${total}) —`;
      if (i === 0) return chunk + '\n' + marker;
      return marker + '\n' + chunk;
    });
  }

  for (const chunk of chunks) {
    try {
      await ctx.api.sendMessage(chatId, chunk, {
        parse_mode: parseMode,
      });
    } catch {
      // Retry without parse mode
      try {
        await ctx.api.sendMessage(chatId, chunk);
      } catch (err) {
        console.error('[sendLongMessage] Failed to send chunk:', err);
      }
    }
  }
}

/**
 * Format a user-facing error message with consistent structure.
 * Uses plain text + emoji (no Markdown).
 */
export function formatUserError(
  category: 'timeout' | 'cli-error' | 'system-error',
  detail?: string,
  options?: { compact?: boolean },
): string {
  const templates = {
    'timeout': { icon: '⏱', title: '處理超時', suggestion: '請簡化問題或稍後重試。長時間問題可嘗試 /cc new 重置。' },
    'cli-error': { icon: '❌', title: '處理失敗', suggestion: '請重新發送訊息。若持續失敗，嘗試 /cc new。' },
    'system-error': { icon: '⚠️', title: '系統異常', suggestion: '請稍後重試。若問題持續，請聯繫管理員。' },
  };
  const t = templates[category];
  if (options?.compact) return `${t.icon} ${t.title}`;
  const lines = [`${t.icon} ${t.title}`];
  if (detail) lines.push(detail.slice(0, 100));
  lines.push('', `💡 ${t.suggestion}`);
  return lines.join('\n');
}

/** Split text at safe boundaries (newlines > spaces > chars) */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find best split point
    let splitAt = maxLength;

    // Try splitting at double newline
    const doubleNewline = remaining.lastIndexOf('\n\n', maxLength);
    if (doubleNewline > maxLength * 0.3) {
      splitAt = doubleNewline + 2;
    } else {
      // Try splitting at single newline
      const newline = remaining.lastIndexOf('\n', maxLength);
      if (newline > maxLength * 0.3) {
        splitAt = newline + 1;
      } else {
        // Try splitting at space
        const space = remaining.lastIndexOf(' ', maxLength);
        if (space > maxLength * 0.3) {
          splitAt = space + 1;
        }
        // Otherwise split at maxLength (may break multi-byte chars)
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

