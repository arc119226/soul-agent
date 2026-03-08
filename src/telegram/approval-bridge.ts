/**
 * Approval bridge — connects the HTTP approval server to Telegram inline keyboards.
 *
 * Tool approval: 3 buttons — Allow / Allow Similar / Deny
 * Plan approval: 3 buttons — Confirm (per-tool) / Auto Allow / Cancel
 */

import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { commandRegistry } from './command-registry.js';
import {
  setApprovalHandler,
  setPlanApprovalHandler,
  setQuestionHandler,
  setCompleteHandler,
  resolveApproval,
  resolvePlanApproval,
  resolveQuestion,
  setPendingMessageId,
  getPendingApproval,
  getPendingPlanApproval,
  getPendingQuestion,
  addAutoApproval,
  addSessionAutoApproveAll,
  isDangerous,
} from '../claude/approval-server.js';

/** Escape special chars for Telegram MarkdownV1 inside backticks is fine,
 *  but outside we need to sanitize the preview text. */
function sanitize(text: string): string {
  return text.replace(/[`]/g, "'");
}

/**
 * Wire approval server callbacks to Telegram inline keyboards.
 * Call this AFTER both the bot and the approval server are initialized.
 */
export function wireApprovalToTelegram(bot: Bot<BotContext>): void {
  const chatId = config.APPROVAL_CHAT_ID;
  if (!chatId) {
    logger.info('approval-bridge', 'APPROVAL_CHAT_ID not set, skipping bridge');
    return;
  }

  const timeoutSec = Math.round(config.APPROVAL_TIMEOUT / 1000);

  // --- Tool Approval Handler ---
  setApprovalHandler((requestId, toolName, toolInput) => {
    const dangerous = isDangerous(toolName, toolInput);

    const lines: string[] = [];
    lines.push(dangerous ? '⚠️ *Dangerous Tool Approval*' : '🔧 *Tool Approval Required*');
    lines.push('');
    lines.push(`Tool: \`${toolName}\``);

    if (toolName === 'Bash') {
      const cmd = sanitize(String(toolInput.command ?? ''));
      lines.push(`Command: \`${cmd.slice(0, 300)}\``);
    } else if (toolName === 'Edit' || toolName === 'Write') {
      const filePath = sanitize(String(toolInput.file_path ?? ''));
      lines.push(`File: \`${filePath}\``);
    } else {
      const preview = sanitize(JSON.stringify(toolInput).slice(0, 200));
      lines.push(`Input: \`${preview}\``);
    }

    lines.push(`\n⏰ 請在 ${timeoutSec} 秒內回應`);
    const text = lines.join('\n');

    const keyboard = new InlineKeyboard()
      .text('✅ 允許', `approval:allow:${requestId}`)
      .text('🔓 允許類似', `approval:allow_similar:${requestId}`)
      .text('❌ 拒絕', `approval:deny:${requestId}`);

    bot.api
      .sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      })
      .then((msg) => {
        setPendingMessageId(requestId, msg.message_id);
      })
      .catch((err) => {
        logger.error(
          'approval-bridge',
          `Failed to send approval request: ${(err as Error).message}`,
        );
      });
  });

  // --- Plan Approval Handler ---
  setPlanApprovalHandler((requestId, planContent) => {
    const preview = planContent.slice(0, 500);
    const text = [
      '📋 *Plan Approval Required*',
      '',
      `\`\`\`\n${preview}\n\`\`\``,
      '',
      `⏰ 請在 ${timeoutSec} 秒內回應`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('✅ 每次確認', `plan:confirm:${requestId}`)
      .text('🔓 自動允許', `plan:auto_allow:${requestId}`)
      .text('❌ 取消', `plan:cancel:${requestId}`);

    bot.api
      .sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      })
      .then((msg) => {
        setPendingMessageId(requestId, msg.message_id);
      })
      .catch((err) => {
        logger.error(
          'approval-bridge',
          `Failed to send plan approval: ${(err as Error).message}`,
        );
      });
  });

  // --- Question Handler (AskUserQuestion bridge) ---
  setQuestionHandler((requestId, questions) => {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const lines: string[] = [];
      lines.push('❓ *Claude 提問*');
      lines.push('');
      if (q.header) lines.push(`*${sanitize(q.header)}*`);
      lines.push(sanitize(q.question));

      if (q.options.length > 0) {
        lines.push('');
        q.options.forEach((opt, j) => {
          lines.push(`${j + 1}. ${sanitize(opt.label)} — ${sanitize(opt.description)}`);
        });
      }

      lines.push(`\n⏰ 請在 ${timeoutSec} 秒內回應`);

      const keyboard = new InlineKeyboard();
      q.options.forEach((opt, j) => {
        keyboard.text(opt.label, `q:${requestId}:${i}:${j}`);
        if ((j + 1) % 2 === 0) keyboard.row();
      });

      bot.api
        .sendMessage(chatId, lines.join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        })
        .then((msg) => {
          setPendingMessageId(requestId, msg.message_id);
        })
        .catch((err) => {
          logger.error(
            'approval-bridge',
            `Failed to send question: ${(err as Error).message}`,
          );
        });
    }
  });

  // --- Completion Handler ---
  setCompleteHandler((summary) => {
    bot.api
      .sendMessage(chatId, `✅ *Task Complete*\n\n${summary}`, {
        parse_mode: 'Markdown',
      })
      .catch((err) => {
        logger.error(
          'approval-bridge',
          `Failed to send completion: ${(err as Error).message}`,
        );
      });
  });

  // --- Tool Approval Callback Routing ---
  commandRegistry.registerCallback('approval:', async (ctx, data) => {
    // data format: "allow:requestId", "allow_similar:requestId", or "deny:requestId"
    const colonIdx = data.indexOf(':');
    if (colonIdx < 0) return;
    const action = data.slice(0, colonIdx);
    const requestId = data.slice(colonIdx + 1);

    if (action === 'allow' || action === 'allow_similar') {
      // Get pending info before resolving (entry is removed on next poll)
      const pending = getPendingApproval(requestId);
      const resolved = resolveApproval(requestId, 'allow');

      if (resolved) {
        if (action === 'allow_similar' && pending) {
          addAutoApproval(pending.sessionId, pending.toolName, pending.toolInput);
        }

        const suffix = action === 'allow_similar' ? ' (+ 類似自動通過)' : '';
        try {
          await ctx.editMessageText(`✅ 已允許${suffix}`);
        } catch {
          try {
            await ctx.answerCallbackQuery({ text: `✅ 已允許${suffix}`, show_alert: false });
          } catch { /* double-fault: both edit and answer failed */ }
        }
        await logger.info('approval-bridge', `Tool ${action} for ${requestId}`);
      } else {
        await ctx.answerCallbackQuery({ text: `此審批已過期（超過 ${timeoutSec} 秒）。如需重試，請重新發送訊息。` });
      }
    } else if (action === 'deny') {
      const resolved = resolveApproval(requestId, 'deny');
      if (resolved) {
        try {
          await ctx.editMessageText('❌ 已拒絕');
        } catch {
          try {
            await ctx.answerCallbackQuery({ text: '❌ 已拒絕', show_alert: false });
          } catch { /* double-fault: both edit and answer failed */ }
        }
        await logger.info('approval-bridge', `Tool denied for ${requestId}`);
      } else {
        await ctx.answerCallbackQuery({ text: `此審批已過期（超過 ${timeoutSec} 秒）。如需重試，請重新發送訊息。` });
      }
    }
  });

  // --- Plan Approval Callback Routing ---
  commandRegistry.registerCallback('plan:', async (ctx, data) => {
    // data format: "confirm:requestId", "auto_allow:requestId", or "cancel:requestId"
    const colonIdx = data.indexOf(':');
    if (colonIdx < 0) return;
    const action = data.slice(0, colonIdx);
    const requestId = data.slice(colonIdx + 1);

    let decision: 'confirm' | 'auto_allow' | 'deny';
    if (action === 'confirm') {
      decision = 'confirm';
    } else if (action === 'auto_allow') {
      decision = 'auto_allow';
      const pending = getPendingPlanApproval(requestId);
      if (pending) {
        addSessionAutoApproveAll(pending.sessionId);
      }
    } else {
      decision = 'deny';
    }

    const resolved = resolvePlanApproval(requestId, decision);
    if (resolved) {
      const labels: Record<string, string> = {
        confirm: '✅ 計劃核准（每次確認）',
        auto_allow: '🔓 計劃核准（自動允許）',
        deny: '❌ 計劃已取消',
      };
      try {
        await ctx.editMessageText(labels[decision] ?? '');
      } catch {
        try {
          await ctx.answerCallbackQuery({ text: labels[decision] ?? '', show_alert: false });
        } catch { /* double-fault: both edit and answer failed */ }
      }
      await logger.info('approval-bridge', `Plan ${decision} for ${requestId}`);
    } else {
      await ctx.answerCallbackQuery({ text: `此審批已過期（超過 ${timeoutSec} 秒）。如需重試，請重新發送訊息。` });
    }
  });

  // --- Question Callback Routing ---
  commandRegistry.registerCallback('q:', async (ctx, data) => {
    // data format: "requestId:questionIdx:optionIdx"
    const parts = data.split(':');
    if (parts.length < 3) return;
    const [requestId, qIdxStr, oIdxStr] = parts;
    const qIdx = parseInt(qIdxStr!, 10);
    const oIdx = parseInt(oIdxStr!, 10);

    const pending = getPendingQuestion(requestId!);
    if (!pending || !pending.questions[qIdx]) {
      await ctx.answerCallbackQuery({ text: `此問題已過期（超過 ${timeoutSec} 秒）。如需重試，請重新發送訊息。` });
      return;
    }

    const selectedLabel = pending.questions[qIdx]!.options[oIdx]?.label ?? '?';
    const questionText = pending.questions[qIdx]!.question;

    const answers: Record<string, string> = {};
    answers[questionText] = selectedLabel;

    const resolved = resolveQuestion(requestId!, answers);
    if (resolved) {
      try {
        await ctx.editMessageText(`✅ 已回答：${selectedLabel}`);
      } catch {
        try {
          await ctx.answerCallbackQuery({ text: `✅ 已回答：${selectedLabel}`, show_alert: false });
        } catch { /* double-fault: both edit and answer failed */ }
      }
      await logger.info('approval-bridge', `Question answered: ${selectedLabel} for ${requestId}`);
    } else {
      await ctx.answerCallbackQuery({ text: `此問題已過期（超過 ${timeoutSec} 秒）。如需重試，請重新發送訊息。` });
    }
  });

  logger.info('approval-bridge', 'Approval bridge wired to Telegram');
}
