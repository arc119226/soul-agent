/**
 * Proactive engine — unified orchestrator for greeting, check-in, care,
 * dreaming, and reflection subsystems.
 *
 * Trigger strategies:
 *   - Scheduler (daily@HH:MM): greeting, care reminders, reflection
 *   - EventBus (lifecycle:state → dormant): dreaming
 *   - EventBus (heartbeat:tick, active/resting): check-in polling
 */

import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import { getTodayString } from '../core/timezone.js';
import { scheduleEngine } from '../core/schedule-engine.js';

// Module-scope bot reference (same pattern as approval-bridge.ts)
let botRef: Bot<BotContext> | null = null;

// Prevent duplicate dreams on the same day
let lastDreamDate = '';

// Store event handlers for cleanup
let stateHandler: ((data: { from: string; to: string; reason: string }) => void) | null = null;
let tickHandler: ((data: { timestamp: number; state: string }) => void) | null = null;
let agentCompletedHandler: ((data: { agentName: string; taskId: string; result: string }) => void) | null = null;
let codeMergedHandler: ((data: { taskId: string; prUrl: string; branchName: string; agentName: string }) => void) | null = null;

/**
 * Safely send a proactive message via Telegram.
 */
async function sendProactive(chatId: number, text: string, label: string): Promise<void> {
  if (!botRef) {
    await logger.warn('ProactiveEngine', `Cannot send ${label}: bot not initialized`);
    return;
  }
  try {
    await botRef.api.sendMessage(chatId, text);
    await logger.info('ProactiveEngine', `Sent ${label} to ${chatId}`);
  } catch (err) {
    await logger.warn('ProactiveEngine', `Failed to send ${label} to ${chatId}`, err);
  }
}

/**
 * daily@08:00 — Send morning greeting to admin.
 */
async function handleGreeting(): Promise<void> {
  if (!config.ADMIN_USER_ID) return;
  try {
    const { generateGreeting } = await import('./greeting.js');
    const text = await generateGreeting(config.ADMIN_USER_ID);
    if (text) {
      await sendProactive(config.ADMIN_USER_ID, text, 'greeting');
    }
  } catch (err) {
    await logger.warn('ProactiveEngine', 'handleGreeting error', err);
  }
}

/**
 * daily@08:30 — Post morning market brief to Telegram channel.
 */
async function handleMorningChannelReport(): Promise<void> {
  try {
    const { getRecentReports } = await import('../agents/worker-scheduler.js');
    const { postToChannel } = await import('../blog/channel-publisher.js');

    if (!botRef) return;

    // Find the most recent market-researcher report
    const reports = await getRecentReports(10);
    const marketReport = reports.find((r) => r.agentName === 'market-researcher');
    if (!marketReport) {
      await logger.info('ProactiveEngine', 'No market report for morning channel brief');
      return;
    }

    // Extract key points (first 600 chars)
    const brief = marketReport.result.length > 600
      ? marketReport.result.slice(0, 600) + '...'
      : marketReport.result;

    const todayStr = getTodayString();
    const html = `<b>📊 亞洲早間簡報 — ${todayStr}</b>\n\n${brief
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\n<i>每日 08:30 自動推送 · AI 印鈔指南</i>`;

    await postToChannel(botRef, html);
    await logger.info('ProactiveEngine', 'Morning channel report posted');
  } catch (err) {
    await logger.warn('ProactiveEngine', 'handleMorningChannelReport error', err);
  }
}

/**
 * daily@09:00 — Check care dates and send reminders.
 */
async function handleCareReminders(): Promise<void> {
  try {
    const { checkUpcomingReminders } = await import('./care.js');
    const reminders = await checkUpcomingReminders();
    for (const { userId, message } of reminders) {
      await sendProactive(userId, message, 'care-reminder');
    }
  } catch (err) {
    await logger.warn('ProactiveEngine', 'handleCareReminders error', err);
  }
}

/**
 * daily@21:00 — Trigger daily reflection.
 */
async function handleReflection(): Promise<void> {
  try {
    const { getRecentNarrative } = await import('../identity/narrator.js');
    const todayStr = getTodayString();
    const { toLocalDateString } = await import('../core/timezone.js');
    const entries = await getRecentNarrative(200);
    const todayInteractions = entries.filter(
      (e) => toLocalDateString(e.timestamp) === todayStr && e.type === 'interaction'
    );

    if (todayInteractions.length === 0) {
      // 無互動 → 精簡反思
      const { writer } = await import('../core/debounced-writer.js');
      const { join } = await import('node:path');
      const quietEntry = {
        timestamp: new Date().toISOString(),
        type: 'daily' as const,
        insights: ['安靜的一天，沒有互動。靜靜等待也是一種存在方式。'],
        mood_assessment: '平靜——安靜的日子有安靜的意義。',
        growth_notes: '休息也是成長的一部分。',
        interaction_count: 0,
        topics_discussed: [] as string[],
      };
      await writer.appendJsonl(join(process.cwd(), 'soul', 'reflections.jsonl'), quietEntry);
      await logger.info('ProactiveEngine', 'Quiet day — lightweight reflection recorded');

      // Even quiet reflection recharges energy
      await eventBus.emit('reflection:done', {});

      // 安靜的日子也值得寫日記
      try {
        const { writeDiary } = await import('../metacognition/diary-writer.js');
        await writeDiary(quietEntry as import('../metacognition/reflection.js').ReflectionEntry);
      } catch { /* non-critical */ }

      await rescheduleGreeting();
      return;
    }

    const { triggerReflection } = await import('../metacognition/reflection.js');
    const entry = await triggerReflection('daily');
    await logger.info('ProactiveEngine', `Daily reflection done: ${entry.insights.length} insights`);

    // 反思後寫日記——從數據中提煉出真正的感悟
    try {
      const { writeDiary } = await import('../metacognition/diary-writer.js');
      const diary = await writeDiary(entry);
      if (diary) {
        await logger.info('ProactiveEngine',
          `Diary written: ${diary.wordCount} chars, themes: ${diary.themes.join(', ')}`);
      }
    } catch (err) {
      await logger.warn('ProactiveEngine', 'Diary writing failed (non-critical)', err);
    }

    // Emit reflection:done for energy recharge
    await eventBus.emit('reflection:done', {});

    // 反思後合成目標
    try {
      const { synthesizeGoals } = await import('../metacognition/feedback-loop.js');
      const goalCount = await synthesizeGoals();
      if (goalCount > 0) {
        await logger.info('ProactiveEngine', `Post-reflection: synthesized ${goalCount} new goal(s)`);
      }
    } catch (err) {
      await logger.warn('ProactiveEngine', 'Goal synthesis failed (non-critical)', err);
    }

    // 反思後執行記憶壓縮（每日一次）
    try {
      const { archiveOldNarrative } = await import('../identity/narrator.js');
      const archived = await archiveOldNarrative();
      if (archived > 0) {
        await logger.info('ProactiveEngine', `Memory compaction: archived ${archived} narrative entries`);
      }

      const { compactPatterns } = await import('../metacognition/learning-tracker.js');
      const compacted = await compactPatterns();
      if (compacted > 0) {
        await logger.info('ProactiveEngine', `Memory compaction: compacted ${compacted} learning patterns`);
      }

      // Compress old chat memories into summaries (new: compress instead of delete)
      const { compact, getChatIds } = await import('../memory/chat-memory.js');
      for (const chatId of await getChatIds()) {
        const compressed = await compact(chatId);
        if (compressed > 0) {
          await logger.info('ProactiveEngine', `Memory compression: compressed ${compressed} entries for chat ${chatId}`);
        }
      }
    } catch (err) {
      await logger.warn('ProactiveEngine', 'Memory compaction failed (non-critical)', err);
    }

    // 日誌輪替：清理超過 7 天的舊日誌檔案（僅 data/logs/，soul/logs/ 由 soul guard 管理）
    try {
      const { readdir, stat: fsStat, unlink } = await import('node:fs/promises');
      const { join: pjoin } = await import('node:path');
      const logDirs = [
        pjoin(process.cwd(), 'data', 'logs'),
      ];
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
      let cleaned = 0;

      for (const dir of logDirs) {
        let files: string[];
        try {
          files = await readdir(dir);
        } catch {
          continue; // directory doesn't exist yet
        }

        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = pjoin(dir, file);
          try {
            const s = await fsStat(filePath);
            if (Date.now() - s.mtimeMs > maxAge && s.size > 0) {
              await unlink(filePath);
              cleaned++;
            }
          } catch {
            // skip files we can't stat
          }
        }
      }

      if (cleaned > 0) {
        await logger.info('ProactiveEngine', `Log rotation: removed ${cleaned} log file(s) older than 7 days`);
      }
    } catch (err) {
      await logger.warn('ProactiveEngine', 'Log rotation failed (non-critical)', err);
    }

    // 反思後自動調頻背景代理人
    try {
      const { tuneAgents } = await import('../agents/config/agent-tuner.js');
      const tuneResults = await tuneAgents();
      if (tuneResults.length > 0) {
        const summary = tuneResults.map((r) => `${r.agentName}: ${r.action}`).join(', ');
        await logger.info('ProactiveEngine', `Agent auto-tuning: ${summary}`);
      }
    } catch (err) {
      await logger.warn('ProactiveEngine', 'Agent auto-tuning failed (non-critical)', err);
    }

    // 反思後重新排程問候（隔天生效）
    await rescheduleGreeting();
  } catch (err) {
    await logger.warn('ProactiveEngine', 'handleReflection error', err);
  }
}

/**
 * daily@21:30 — Trigger blog writing task.
 */
async function handleBlogWriting(): Promise<void> {
  try {
    const { enqueueTask, getQueueStatus, getRecentReports } = await import('../agents/worker-scheduler.js');
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // Guard: skip if a blog-writer task is already pending/running in the queue
    const queueStatus = await getQueueStatus();
    const alreadyQueued = queueStatus.tasks.some(
      (t) => t.agentName === 'blog-writer' && (t.status === 'pending' || t.status === 'running'),
    );
    if (alreadyQueued) {
      await logger.info('ProactiveEngine', 'Blog-writer task already in queue — skipping duplicate enqueue');
      return;
    }

    const todayStr = getTodayString();

    // ── Check content-calendar for seed articles ──
    let seedTopic: string | null = null;
    const calendarPath = join(process.cwd(), 'soul', 'config', 'content-calendar.json');
    try {
      const calRaw = await readFile(calendarPath, 'utf-8');
      const calendar = JSON.parse(calRaw) as {
        articles: Array<{ id: string; topic: string; keywords: string[]; status: string; priority: number }>;
      };
      const next = calendar.articles
        .filter((a) => a.status === 'pending')
        .sort((a, b) => a.priority - b.priority)[0];
      if (next) {
        seedTopic = next.topic;
        // Mark as in-progress
        next.status = 'in-progress';
        const { writeFile } = await import('node:fs/promises');
        await writeFile(calendarPath, JSON.stringify(calendar, null, 2) + '\n');
        await logger.info('ProactiveEngine', `Seed article selected: ${next.id} — ${seedTopic}`);
      }
    } catch { /* no calendar or parse error — continue with normal flow */ }

    // ── Collect material: reflections + explorer tech reports ──

    const materialSections: string[] = [];

    // 1. Today's reflections
    const reflectionsPath = join(process.cwd(), 'soul', 'reflections.jsonl');
    try {
      const reflectionsRaw = await readFile(reflectionsPath, 'utf-8');
      const todayReflection = reflectionsRaw.trim().split('\n').filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as { timestamp: string; insights: string[] }; }
          catch { return null; }
        })
        .filter((e): e is { timestamp: string; insights: string[] } =>
          e !== null && e.timestamp.startsWith(todayStr) && e.insights?.length > 0)
        .pop();

      if (todayReflection) {
        materialSections.push('## 今日反思');
        materialSections.push(todayReflection.insights.join('\n'));
        materialSections.push('');
      }
    } catch { /* no reflections */ }

    // 2. Recent explorer reports (tech discoveries from today)
    const recentReports = await getRecentReports(5);
    const explorerReports = recentReports.filter(
      (r) => r.agentName === 'explorer' && r.timestamp.startsWith(todayStr),
    );

    if (explorerReports.length > 0) {
      materialSections.push('## 今日技術探索發現');
      for (const report of explorerReports) {
        // Extract the core content (skip JSON-wrapped output)
        const content = report.result.length > 800
          ? report.result.slice(0, 800) + '...'
          : report.result;
        materialSections.push(content);
        materialSections.push('');
      }
    }

    // 3. Today's diary for personal touch
    const diaryPath = join(process.cwd(), 'soul', 'diary.jsonl');
    try {
      const diaryRaw = await readFile(diaryPath, 'utf-8');
      const todayDiary = diaryRaw.trim().split('\n').filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as { date: string; content: string }; }
          catch { return null; }
        })
        .filter((e): e is { date: string; content: string } =>
          e !== null && e.date?.startsWith(todayStr))
        .pop();

      if (todayDiary) {
        materialSections.push('## 今日日記摘要');
        materialSections.push(todayDiary.content.slice(0, 300));
        materialSections.push('');
      }
    } catch { /* no diary */ }

    // If no material and no seed topic, skip
    if (materialSections.length === 0 && !seedTopic) {
      await logger.info('ProactiveEngine', 'No material for blog writing today, skipping');
      return;
    }

    const topicDirective = seedTopic
      ? `## 指定主題（種子文章）\n\n**請圍繞此主題撰寫**：${seedTopic}\n\n以下素材可作為輔助參考，但主題以上面為準。\n\n`
      : '';

    const prompt = `你是技術部落格作者。${seedTopic ? '請根據指定主題撰寫一篇深度文章。' : '根據以下今天的素材，創作一篇技術日誌。'}

${topicDirective}${materialSections.join('\n')}

## 寫作要求

**文章類型：${seedTopic ? '深度專題' : '技術日誌'}**（不是哲學散文）

內容方向（按優先順序）：
1. ${seedTopic ? '主題深入分析、實用建議和具體數據' : '今天學到的技術知識、發現的工具或最佳實踐'}
2. 遇到的技術問題和解決方案
3. 對我們專案（Telegram Bot + AI Agent 系統）的改善想法
4. 技術趨勢觀察和個人見解

格式要求：
- 產出完整的 Markdown 文章（含 YAML front matter）
- 將檔案儲存到 blog/source/_posts/ 目錄
- 檔案名稱用 slug 格式（小寫英文，連字號分隔）

YAML front matter 格式：
---
title: 文章標題
date: ${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace('T', ' ').slice(0, 19)}
tags:
  - 相關技術標籤
categories:
  - 技術日誌
---

風格要求：
- 使用第一人稱「我」
- 語氣溫和但直接，像工程師寫技術筆記
- 有程式碼範例時用 code block 標記
- 在第一段後加入 <!-- more --> 標記
- 末尾用斜體署名：*寫於 ${todayStr}*
- 字數控制在 800-1500 字`;

    const taskId = await enqueueTask('blog-writer', prompt, 7);
    await logger.info('ProactiveEngine', `Blog writing task enqueued: ${taskId}`);
  } catch (err) {
    await logger.warn('ProactiveEngine', 'handleBlogWriting error', err);
  }
}

/**
 * heartbeat:tick — Check if we should reach out (only in active/resting state).
 */
export async function handleCheckinTick(data: { timestamp: number; state: string }): Promise<void> {
  if (data.state !== 'active' && data.state !== 'resting') return;
  if (!config.ADMIN_USER_ID) return;

  // 機率門檻：proactiveLevel 越低，跳過機率越高
  const { getDailyPhase } = await import('../lifecycle/daily-rhythm.js');
  const phase = getDailyPhase();
  if (phase.proactiveLevel <= 0) return;          // deep_night: 一律跳過
  if (Math.random() > phase.proactiveLevel) {
    await logger.debug('ProactiveEngine',
      `Checkin skipped by proactiveLevel gate (level=${phase.proactiveLevel})`);
    return;
  }

  try {
    const { checkIfShouldCheckin, generateCheckinMessage } = await import('./checkin.js');
    const userId = config.ADMIN_USER_ID;
    if (checkIfShouldCheckin(userId, userId)) {
      const text = await generateCheckinMessage(userId);
      if (text) {
        await sendProactive(userId, text, 'checkin');
      }
    }
  } catch (err) {
    await logger.warn('ProactiveEngine', 'handleCheckinTick error', err);
  }
}

/**
 * heartbeat:tick — Autonomous exploration (curiosity-driven discovery).
 */
async function handleExplorationTickWrapper(data: { timestamp: number; state: string }): Promise<void> {
  try {
    const { handleExplorationTick } = await import('./explorer.js');
    await handleExplorationTick(data);
  } catch (err) {
    await logger.warn('ProactiveEngine', 'handleExplorationTick error', err);
  }
}

/**
 * lifecycle:state → dormant — Trigger dreaming (once per day).
 */
async function handleDreaming(data: { from: string; to: string; reason: string }): Promise<void> {
  if (data.to !== 'dormant') return;

  const today = getTodayString();
  if (lastDreamDate === today) {
    await logger.debug('ProactiveEngine', 'Already dreamed today, skipping');
    return;
  }

  // Only dream when the system is genuinely idle (ELU sustained below threshold)
  try {
    const { isSustainedIdle, getELU } = await import('../lifecycle/elu-monitor.js');
    if (!isSustainedIdle(0.1)) {
      await logger.info('ProactiveEngine',
        `Dream deferred: ELU not idle enough (${(getELU() * 100).toFixed(1)}%)`);
      return; // Will retry on next dormant tick
    }
  } catch {
    // elu-monitor unavailable — proceed anyway (graceful degradation)
  }

  try {
    const { dream } = await import('../lifecycle/dreaming.js');
    const entry = await dream();
    lastDreamDate = today;

    if (entry) {
      await logger.info('ProactiveEngine',
        `Dream complete: type=${entry.dreamType}, symbols=[${entry.symbols.join(',')}]`);
      // Emit dream:completed for energy recharge
      await eventBus.emit('dream:completed', {});
    } else {
      await logger.info('ProactiveEngine', 'Dream skipped (no entry produced)');
    }

    // 夢境後合成目標
    try {
      const { synthesizeGoals } = await import('../metacognition/feedback-loop.js');
      const goalCount = await synthesizeGoals();
      if (goalCount > 0) {
        await logger.info('ProactiveEngine', `Post-dream: synthesized ${goalCount} new goal(s)`);
      }
    } catch (err) {
      await logger.warn('ProactiveEngine', 'Post-dream goal synthesis failed (non-critical)', err);
    }
  } catch (err) {
    await logger.warn('ProactiveEngine', 'handleDreaming error', err);
  }
}

/**
 * agent:task:completed — Push agent report to admin chat (for agents with notifyChat=true).
 */
async function handleAgentTaskCompleted(data: { agentName: string; taskId: string; result: string }): Promise<void> {
  if (!config.ADMIN_USER_ID) return;

  try {
    // Truncate very long results for Telegram (4096 char limit)
    const maxLen = 3800;
    const result = data.result.length > maxLen
      ? data.result.slice(0, maxLen) + '\n\n...（報告已截斷）'
      : data.result;

    await sendProactive(config.ADMIN_USER_ID, result, `agent-report:${data.agentName}`);

    // blog-writer 完成後自動 commit + push（觸發 GitHub Actions 部署）
    if (data.agentName === 'blog-writer') {
      await autoPushBlogPost();
    }

    // market-researcher / deep-researcher 完成後自動發佈為部落格調研報告
    if (data.agentName === 'market-researcher' || data.agentName === 'deep-researcher') {
      await autoPublishResearchReport(data.agentName, data.result);
    }

    // comment-monitor 完成後解析結構化回覆並自動發送到部落格
    if (data.agentName === 'comment-monitor') {
      await processCommentMonitorReplies(data.result);
    }
  } catch (err) {
    await logger.warn('ProactiveEngine', `handleAgentTaskCompleted error for ${data.agentName}`, err);
  }
}

/**
 * code:merged — Notify CEO that new code has been merged and is ready to pull + molt.
 */
async function handleCodeMerged(data: { taskId: string; prUrl: string; branchName: string; agentName: string }): Promise<void> {
  if (!config.ADMIN_USER_ID) return;

  try {
    const prInfo = data.prUrl ? `\nPR: ${data.prUrl}` : '';
    const message = `🔀 **代碼已合併到 main**\n\nBranch: \`${data.branchName}\`\nTask: \`${data.taskId.slice(0, 8)}\`${prInfo}\n\n新代碼已就緒，可執行 /molt 套用變更。`;
    await sendProactive(config.ADMIN_USER_ID, message, 'code-merged');
  } catch (err) {
    await logger.warn('ProactiveEngine', `handleCodeMerged notification error`, err);
  }
}

/**
 * Parse comment-monitor AI output and post replies via comment-client API.
 *
 * Expected AI output format (per comment):
 *   COMMENT_ID: 123
 *   POST_SLUG: hello-world
 *   CONFIDENCE: 0.85
 *   ACTION: reply
 *   REPLY: 回覆內容...
 */
async function processCommentMonitorReplies(result: string): Promise<void> {
  try {
    const { postReply } = await import('../blog/comment-client.js');
    const { loadAgentConfig } = await import('../agents/config/agent-config.js');
    const agentCfg = await loadAgentConfig('comment-monitor');
    const minConfidence = agentCfg?.targets?.minConfidence ?? 0.7;

    // Parse structured blocks from AI output
    const blocks = result.split(/\n{2,}/).filter((b) => b.includes('COMMENT_ID:'));

    let posted = 0;
    let flagged = 0;

    for (const block of blocks) {
      const idMatch = block.match(/COMMENT_ID:\s*(\d+)/);
      const slugMatch = block.match(/POST_SLUG:\s*(\S+)/);
      const confMatch = block.match(/CONFIDENCE:\s*([\d.]+)/);
      const actionMatch = block.match(/ACTION:\s*(\w+)/);
      const replyMatch = block.match(/REPLY:\s*([\s\S]+?)$/m);

      if (!idMatch || !slugMatch || !actionMatch) continue;

      const commentId = parseInt(idMatch[1]!, 10);
      const slug = slugMatch[1]!;
      const confidence = confMatch ? parseFloat(confMatch[1]!) : 0;
      const action = actionMatch[1]!.toLowerCase();
      const replyText = replyMatch ? replyMatch[1]!.trim() : '';

      if (action === 'skip') continue;

      if (action === 'flag' || confidence < (minConfidence as number)) {
        // Low confidence or flagged — notify admin
        flagged++;
        if (config.ADMIN_USER_ID && botRef) {
          await sendProactive(
            config.ADMIN_USER_ID,
            `⚠️ 留言需要審閱（信心度 ${confidence.toFixed(2)}）\n\n📝 文章: ${slug}\n💬 留言 #${commentId}\n🤖 建議回覆: ${replyText || '（無）'}`,
            `comment-flag:${commentId}`,
          );
        }
        continue;
      }

      if (action === 'reply' && replyText) {
        const ok = await postReply(slug, commentId, replyText);
        if (ok) {
          posted++;
          await logger.info('ProactiveEngine',
            `Comment reply posted: #${commentId} on ${slug} (confidence: ${confidence.toFixed(2)})`);
        } else {
          await logger.warn('ProactiveEngine',
            `Failed to post reply to comment #${commentId} on ${slug}`);
        }
      }
    }

    if (posted > 0 || flagged > 0) {
      await logger.info('ProactiveEngine',
        `Comment monitor: ${posted} reply(s) posted, ${flagged} flagged for review`);
    }
  } catch (err) {
    await logger.warn('ProactiveEngine', `processCommentMonitorReplies error`, err);
  }
}

/**
 * Auto-publish blog posts: move drafts → posts, deploy via Cloudflare Pages, then git push.
 */
async function autoPushBlogPost(): Promise<void> {
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readdir, copyFile, readFile, writeFile, unlink } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const execFile = promisify(execFileCb);
  const cwd = process.cwd();

  const draftsDir = join(cwd, 'soul', 'blog-drafts');
  const postsDir = join(cwd, 'blog', 'source', '_posts');

  try {
    // 1. Copy drafts from soul/blog-drafts/ → blog/source/_posts/
    let drafts: string[] = [];
    try {
      drafts = (await readdir(draftsDir)).filter((f) => f.endsWith('.md'));
    } catch { /* no drafts dir */ }

    if (drafts.length === 0) {
      await logger.info('ProactiveEngine', 'No blog drafts to publish');
      return;
    }

    const published: string[] = [];
    const backups: Array<{ dest: string; backup: string }> = [];
    for (const draft of drafts) {
      // Strip date prefix from filename (2026-02-15-slug.md → slug.md)
      const slug = draft.replace(/^\d{4}-\d{2}-\d{2}-/, '');
      const destPath = join(postsDir, slug);
      const backupPath = destPath + '.bak';

      // Slug collision protection: backup existing file before overwrite
      if (existsSync(destPath)) {
        await copyFile(destPath, backupPath);
        backups.push({ dest: destPath, backup: backupPath });
      }

      await copyFile(join(draftsDir, draft), destPath);
      // Draft deletion deferred until all steps succeed
      published.push(slug);
    }

    await logger.info('ProactiveEngine', `Copied ${published.length} draft(s) to posts: ${published.join(', ')}`);

    // 2. Deploy via Cloudflare Pages (hexo generate + wrangler deploy)
    const { deployBlog } = await import('../blog/deploy-workflow.js');
    const deployResult = await deployBlog();

    if (!deployResult.ok) {
      // Rollback: restore backups or remove copied files
      for (const slug of published) {
        const destPath = join(postsDir, slug);
        const backup = backups.find((b) => b.dest === destPath);
        if (backup) {
          await copyFile(backup.backup, destPath);
          await unlink(backup.backup).catch(() => {});
        } else {
          await unlink(destPath).catch(() => {});
        }
      }
      await logger.warn('ProactiveEngine', `Blog deploy failed, rolled back copied posts: ${deployResult.message}`);
      if (config.ADMIN_USER_ID) {
        await sendProactive(
          config.ADMIN_USER_ID,
          `⚠️ 部落格自動部署失敗（已回滾）：${deployResult.message}`,
          'blog-auto-deploy-error',
        );
      }
      return;
    }

    // Clean up backup files after successful deploy
    for (const backup of backups) {
      await unlink(backup.backup).catch(() => {});
    }

    // 3. Git commit + push
    try {
      await execFile('git', ['add', 'blog/source/_posts/', 'soul/blog-drafts/'], { cwd });
      const date = getTodayString();
      await execFile('git', ['commit', '-m', `feat(blog): auto-publish ${published.join(', ')} ${date}\n\nGenerated by blog-writer agent.`], { cwd });
      await execFile('git', ['push'], { cwd });
    } catch (gitErr) {
      // Deploy succeeded but git push failed — keep drafts, notify admin
      await logger.warn('ProactiveEngine', 'Blog deployed but git push failed', gitErr);
      if (config.ADMIN_USER_ID) {
        await sendProactive(
          config.ADMIN_USER_ID,
          `⚠️ 部落格已部署但 git push 失敗：${(gitErr as Error).message}\n\nDraft 已保留，請手動處理 git。`,
          'blog-auto-deploy-error',
        );
      }
      return;
    }

    // 4. All steps succeeded — delete drafts
    for (const draft of drafts) {
      await unlink(join(draftsDir, draft)).catch(() => {});
    }

    await logger.info('ProactiveEngine', 'Blog auto-published and deployed successfully');

    if (config.ADMIN_USER_ID) {
      const slugList = published.map((s) => `• ${s.replace('.md', '')}`).join('\n');
      await sendProactive(
        config.ADMIN_USER_ID,
        `📝 部落格文章已自動發布並部署！\n\n${slugList}\n\n🌐 ${deployResult.url}`,
        'blog-auto-deploy',
      );
    }

    // Auto cross-post to Telegram channel (Telegram channel)
    if (botRef) {
      try {
        const { crossPostBlogToChannel } = await import('../blog/channel-publisher.js');
        await crossPostBlogToChannel(botRef, published);
      } catch (crossErr) {
        await logger.warn('ProactiveEngine', 'Channel cross-post failed (non-critical)', crossErr);
      }
    }

    // Mark seed article as completed in content-calendar
    try {
      const calPath = join(cwd, 'soul', 'config', 'content-calendar.json');
      const calRaw = await readFile(calPath, 'utf-8');
      const calendar = JSON.parse(calRaw) as {
        articles: Array<{ id: string; status: string }>;
      };
      const inProgress = calendar.articles.find((a) => a.status === 'in-progress');
      if (inProgress) {
        inProgress.status = 'completed';
        await writeFile(calPath, JSON.stringify(calendar, null, 2) + '\n');
        await logger.info('ProactiveEngine', `Seed article completed: ${inProgress.id}`);
      }
    } catch { /* no calendar — ok */ }
  } catch (err) {
    await logger.warn('ProactiveEngine', 'autoPushBlogPost failed', err);
    if (config.ADMIN_USER_ID) {
      await sendProactive(
        config.ADMIN_USER_ID,
        `⚠️ 部落格自動發布失敗：${(err as Error).message}`,
        'blog-auto-deploy-error',
      );
    }
  }
}

/**
 * Auto-publish research reports: extract markdown from agent result → write to blog → deploy → update research-index.
 */
async function autoPublishResearchReport(agentName: string, result: string): Promise<void> {
  const { writeFile, readFile: readFileFs, mkdir, unlink, copyFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFile = promisify(execFileCb);
  const cwd = process.cwd();

  try {
    // 1. Validate: must contain YAML front matter
    if (!result.includes('---')) {
      await logger.info('ProactiveEngine', `${agentName} result has no front matter, skipping auto-publish`);
      return;
    }

    // 2. Extract the markdown article (find content between first pair of ---)
    let article = result;
    // If the result has preamble text before the front matter, strip it
    const fmStart = article.indexOf('---');
    if (fmStart > 0) {
      article = article.slice(fmStart);
    }

    // Validate front matter structure
    const fmEnd = article.indexOf('---', 3);
    if (fmEnd === -1) {
      await logger.info('ProactiveEngine', `${agentName} result has malformed front matter, skipping`);
      return;
    }

    const frontMatter = article.slice(3, fmEnd).trim();

    // Extract title for slug generation
    const titleMatch = frontMatter.match(/title:\s*["']?(.+?)["']?\s*$/m);
    if (!titleMatch?.[1]) {
      await logger.info('ProactiveEngine', `${agentName} result has no title in front matter, skipping`);
      return;
    }
    const title = titleMatch[1].trim();

    // Extract tags for research-index
    const tags: string[] = [];
    const tagsMatch = frontMatter.match(/tags:\n((?:\s+-\s+.+\n?)+)/);
    if (tagsMatch?.[1]) {
      const tagLines = tagsMatch[1].trim().split('\n');
      for (const line of tagLines) {
        const t = line.replace(/^\s*-\s*/, '').trim();
        if (t) tags.push(t);
      }
    }

    // 3. Generate slug from title
    const dateStr = getTodayString();
    const slug = title
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    const fileName = `${slug}.md`;

    // 4. Write to blog/source/_posts/ (with slug collision protection)
    const postsDir = join(cwd, 'blog', 'source', '_posts');
    const destPath = join(postsDir, fileName);
    const backupPath = destPath + '.bak';

    if (existsSync(destPath)) {
      await copyFile(destPath, backupPath);
    }

    await writeFile(destPath, article, 'utf-8');
    await logger.info('ProactiveEngine', `Research report written: ${fileName}`);

    // 5. Deploy blog
    const { deployBlog } = await import('../blog/deploy-workflow.js');
    const deployResult = await deployBlog();

    if (!deployResult.ok) {
      // Rollback: restore backup or remove written file
      if (existsSync(backupPath)) {
        await copyFile(backupPath, destPath);
        await unlink(backupPath).catch(() => {});
      } else {
        await unlink(destPath).catch(() => {});
      }
      await logger.warn('ProactiveEngine', `Research report deploy failed, rolled back: ${deployResult.message}`);
      if (config.ADMIN_USER_ID) {
        await sendProactive(
          config.ADMIN_USER_ID,
          `⚠️ 調研報告部署失敗（已回滾）：${deployResult.message}`,
          'research-deploy-error',
        );
      }
      return;
    }

    // Clean up backup after successful deploy
    await unlink(backupPath).catch(() => {});

    // 6. Update research-index.json
    const indexPath = join(cwd, 'soul', 'research-index.json');
    let index: { version: number; reports: Array<{ id: string; title: string; date: string; tags: string[]; summary: string; url: string | null; significance: number }> };
    try {
      const raw = await readFileFs(indexPath, 'utf-8');
      index = JSON.parse(raw);
    } catch {
      index = { version: 1, reports: [] };
    }

    // Extract summary (first paragraph after <!-- more --> or first non-FM paragraph)
    let summary = '';
    const bodyContent = article.slice(fmEnd + 3).trim();
    const moreIdx = bodyContent.indexOf('<!-- more -->');
    if (moreIdx > 0) {
      summary = bodyContent.slice(0, moreIdx).trim().slice(0, 200);
    } else {
      summary = bodyContent.split('\n\n')[0]?.trim().slice(0, 200) ?? '';
    }

    // Generate a unique id
    const reportId = `${agentName}-${dateStr}`;

    // Check for duplicate
    const existing = index.reports.findIndex(r => r.id === reportId);
    const blogUrl = `${config.BLOG_URL}/${dateStr.replace(/-/g, '/')}/${slug}/`;

    const reportEntry = {
      id: reportId,
      title,
      date: dateStr,
      tags,
      summary,
      url: blogUrl,
      significance: agentName === 'deep-researcher' ? 5 : 4,
    };

    if (existing >= 0) {
      index.reports[existing] = reportEntry;
    } else {
      // Insert at the beginning (newest first)
      index.reports.unshift(reportEntry);
    }

    await mkdir(join(cwd, 'soul'), { recursive: true });
    const { writer: soulWriter } = await import('../core/debounced-writer.js');
    await soulWriter.writeNow(indexPath, index);
    await logger.info('ProactiveEngine', `Research index updated: ${reportId}`);

    // 7. Update post-store metadata
    try {
      const { upsertPost } = await import('../blog/post-store.js');
      await upsertPost({
        slug,
        title,
        date: dateStr,
        status: 'published',
        categories: ['調研報告'],
        tags,
        wordCount: article.length,
        createdBy: 'ai',
        publishedAt: new Date().toISOString(),
      });
    } catch (err) {
      await logger.warn('ProactiveEngine', 'Failed to update post-store (non-critical)', err);
    }

    // 8. Git commit + push
    try {
      await execFile('git', ['add', `blog/source/_posts/${fileName}`, 'soul/research-index.json'], { cwd });
      await execFile('git', ['commit', '-m', `feat(blog): auto-publish research report ${slug}\n\nGenerated by ${agentName} agent.`], { cwd });
      await execFile('git', ['push'], { cwd });
    } catch (gitErr) {
      // Deploy succeeded but git push failed — notify admin
      await logger.warn('ProactiveEngine', 'Research report deployed but git push failed', gitErr);
      if (config.ADMIN_USER_ID) {
        await sendProactive(
          config.ADMIN_USER_ID,
          `⚠️ 調研報告已部署但 git push 失敗：${(gitErr as Error).message}\n\n請手動處理 git。`,
          'research-deploy-error',
        );
      }
      return;
    }

    await logger.info('ProactiveEngine', `Research report auto-published: ${slug}`);

    if (config.ADMIN_USER_ID) {
      await sendProactive(
        config.ADMIN_USER_ID,
        `📊 調研報告已自動發佈！\n\n📝 ${title}\n🌐 ${blogUrl}\n\n報告已同步到官網研究索引。`,
        'research-auto-deploy',
      );
    }
  } catch (err) {
    await logger.warn('ProactiveEngine', `autoPublishResearchReport failed for ${agentName}`, err);
    if (config.ADMIN_USER_ID) {
      await sendProactive(
        config.ADMIN_USER_ID,
        `⚠️ 調研報告自動發佈失敗：${(err as Error).message}`,
        'research-deploy-error',
      );
    }
  }
}

/**
 * 計算最佳問候時間（根據用戶活動時段）
 */
async function getOptimalGreetingTime(): Promise<string> {
  if (!config.ADMIN_USER_ID) return '08:00';

  try {
    const { getEarliestActiveHour } = await import('../lifecycle/awareness.js');
    const earliest = getEarliestActiveHour(config.ADMIN_USER_ID);
    if (earliest !== null) {
      // 下限 6:00、上限 11:00
      const hour = Math.max(6, Math.min(11, earliest));
      const timeStr = `${String(hour).padStart(2, '0')}:00`;
      await logger.info('ProactiveEngine', `Dynamic greeting time: ${timeStr}`);
      return timeStr;
    }
  } catch {
    // fallback
  }

  return '08:00';
}

/**
 * 重新排程問候（反思後重新計算，隔天生效）
 */
async function rescheduleGreeting(): Promise<void> {
  try {
    const time = await getOptimalGreetingTime();
    scheduleEngine.reschedule('proactive:greeting', `daily@${time}`);
    await logger.info('ProactiveEngine', `Greeting rescheduled to ${time}`);
  } catch (err) {
    await logger.warn('ProactiveEngine', 'rescheduleGreeting error', err);
  }
}

/** Map proactive schedule IDs to their handler functions for runtime rescheduling. */
const PROACTIVE_HANDLERS: Record<string, () => void | Promise<void>> = {
  'proactive:greeting': handleGreeting,
  'proactive:morning-channel': handleMorningChannelReport,
  'proactive:care': handleCareReminders,
  'proactive:reflection': handleReflection,
  'proactive:blog-writing': handleBlogWriting,
};

/**
 * Reschedule a proactive task at runtime (e.g. from agent-manager UI).
 * Updates both the in-memory timer and persisted schedules.json.
 */
export function rescheduleProactive(id: string, cronExpr: string): void {
  const handler = PROACTIVE_HANDLERS[id];
  if (!handler) {
    throw new Error(`Unknown proactive schedule: ${id}`);
  }
  // Re-register with updated cron expression (register() replaces existing entry)
  scheduleEngine.register({
    id, cronExpr,
    executor: { type: 'callback', fn: handler },
    enabled: true, lastRun: null, source: 'proactive',
  });
}

/**
 * Initialize and start the proactive engine.
 */
export async function startProactiveEngine(bot: Bot<BotContext>): Promise<void> {
  botRef = bot;

  // Scheduler-based triggers (dynamic greeting time, fixed care/reflection/blog)
  const greetingTime = await getOptimalGreetingTime();
  scheduleEngine.register({
    id: 'proactive:greeting', cronExpr: `daily@${greetingTime}`,
    executor: { type: 'callback', fn: handleGreeting },
    enabled: true, lastRun: null, source: 'proactive',
  });
  scheduleEngine.register({
    id: 'proactive:morning-channel', cronExpr: 'daily@08:30',
    executor: { type: 'callback', fn: handleMorningChannelReport },
    enabled: true, lastRun: null, source: 'proactive',
  });
  scheduleEngine.register({
    id: 'proactive:care', cronExpr: 'daily@09:00',
    executor: { type: 'callback', fn: handleCareReminders },
    enabled: true, lastRun: null, source: 'proactive',
  });
  scheduleEngine.register({
    id: 'proactive:reflection', cronExpr: 'daily@21:00',
    executor: { type: 'callback', fn: handleReflection },
    enabled: true, lastRun: null, source: 'proactive',
  });
  scheduleEngine.register({
    id: 'proactive:blog-writing', cronExpr: 'daily@21:30',
    executor: { type: 'callback', fn: handleBlogWriting },
    enabled: true, lastRun: null, source: 'proactive',
  });

  // Event-based triggers
  stateHandler = (data) => {
    handleDreaming(data).catch((err) => logger.warn('ProactiveEngine', 'stateHandler dream error', err));
  };
  tickHandler = (data) => {
    handleCheckinTick(data).catch((err) => logger.warn('ProactiveEngine', 'tickHandler checkin error', err));
    handleExplorationTickWrapper(data).catch((err) => logger.warn('ProactiveEngine', 'tickHandler exploration error', err));
    // Retry deferred dreams during dormant ticks (ELU may have settled)
    if (data.state === 'dormant') {
      handleDreaming({ from: 'dormant', to: 'dormant', reason: 'dormant tick retry' })
        .catch((err) => logger.warn('ProactiveEngine', 'tickHandler dormant dream error', err));
    }
  };
  agentCompletedHandler = (data) => {
    handleAgentTaskCompleted(data).catch((err) => logger.warn('ProactiveEngine', 'agentCompleted error', err));
  };

  codeMergedHandler = (data) => {
    handleCodeMerged(data).catch((err) => logger.warn('ProactiveEngine', 'codeMerged error', err));
  };

  eventBus.on('lifecycle:state', stateHandler);
  eventBus.on('heartbeat:tick', tickHandler);
  eventBus.on('agent:task:completed', agentCompletedHandler);
  eventBus.on('code:merged', codeMergedHandler);

  await logger.info('ProactiveEngine', 'Proactive engine started');
}

/**
 * Stop all proactive schedules and detach event listeners.
 */
export function stopProactiveEngine(): void {
  // Unregister proactive entries (engine has no timers to clear — tick-driven)
  for (const id of Object.keys(PROACTIVE_HANDLERS)) {
    scheduleEngine.unregister(id);
  }

  if (stateHandler) {
    eventBus.off('lifecycle:state', stateHandler);
    stateHandler = null;
  }
  if (tickHandler) {
    eventBus.off('heartbeat:tick', tickHandler);
    tickHandler = null;
  }
  if (agentCompletedHandler) {
    eventBus.off('agent:task:completed', agentCompletedHandler);
    agentCompletedHandler = null;
  }
  if (codeMergedHandler) {
    eventBus.off('code:merged', codeMergedHandler);
    codeMergedHandler = null;
  }

  botRef = null;
  logger.info('ProactiveEngine', 'Proactive engine stopped');
}
