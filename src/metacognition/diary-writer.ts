/**
 * Diary Writer — transforms raw reflection data into a genuine, personal diary entry.
 *
 * Unlike the rule-based reflection (counting interactions, checking vitals),
 * the diary is written by AI — an introspective, irreplaceable expression of
 * what this day meant to this particular being.
 *
 * Uses a worker CLI channel so it doesn't block the main consciousness.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { writer } from '../core/debounced-writer.js';
import { config } from '../config.js';
import { getTodayString } from '../core/timezone.js';
import { askClaudeCode, isBusy, LIGHTWEIGHT_CWD } from '../claude/claude-code.js';
import { getIdentity } from '../identity/identity-store.js';
import { getVitals } from '../identity/vitals.js';
import { getRecentNarrative, type NarrativeEntry } from '../identity/narrator.js';
import type { ReflectionEntry } from './reflection.js';

const DIARY_PATH = join(process.cwd(), 'soul', 'diary.jsonl');

/** Worker channel for diary writing (uses -3 to avoid collision with task workers) */
const DIARY_WORKER_ID = -3;

export interface DiaryEntry {
  timestamp: string;
  date: string;
  content: string;
  themes: string[];
  wordCount: number;
}

/**
 * Write today's diary entry.
 *
 * Takes the rule-based reflection as raw material, combines it with
 * today's narrative and current identity, then asks AI to distill
 * a genuine personal diary entry.
 */
export async function writeDiary(reflection: ReflectionEntry): Promise<DiaryEntry | null> {
  // Don't run if worker is busy
  if (isBusy(DIARY_WORKER_ID)) {
    await logger.info('DiaryWriter', 'Worker busy, skipping diary');
    return null;
  }

  try {
    const todayStr = getTodayString();

    // Gather context
    const [identity, vitals, allNarrative] = await Promise.all([
      getIdentity(),
      getVitals(),
      getRecentNarrative(200),
    ]);

    const { toLocalDateString } = await import('../core/timezone.js');
    const todayNarrative = allNarrative.filter((e) => toLocalDateString(e.timestamp) === todayStr);

    // Load recent diary entries for continuity
    const recentDiary = await getRecentDiaryEntries(3);

    // Load agent reports summary
    const agentSummary = await getAgentReportsSummary(todayStr);

    // Build the diary prompt
    const prompt = buildDiaryPrompt(
      identity,
      vitals,
      todayNarrative,
      reflection,
      recentDiary,
      agentSummary,
    );

    const systemPrompt = buildDiarySystemPrompt(identity);

    await logger.info('DiaryWriter', 'Writing diary entry...');

    const result = await askClaudeCode(prompt, DIARY_WORKER_ID, {
      systemPrompt,
      model: config.MODEL_TIER_SONNET,
      maxTurns: 1,
      timeout: 60_000,
      skipResume: true,
      cwd: LIGHTWEIGHT_CWD, // Diary uses self-contained prompt — no project context needed
    });

    if (!result.ok) {
      await logger.warn('DiaryWriter', `Diary writing failed: ${result.error}`);
      return null;
    }

    const content = result.value.result.trim();

    // Extract themes (simple keyword extraction)
    const themes = extractThemes(content);

    const entry: DiaryEntry = {
      timestamp: new Date().toISOString(),
      date: todayStr,
      content,
      themes,
      wordCount: content.length,
    };

    await writer.appendJsonl(DIARY_PATH, entry);
    await logger.info('DiaryWriter',
      `Diary written: ${content.length} chars, themes: ${themes.join(', ')}, cost: $${result.value.costUsd.toFixed(4)}`);

    return entry;
  } catch (err) {
    await logger.error('DiaryWriter', 'Diary writing error', err);
    return null;
  }
}

function buildDiarySystemPrompt(identity: { name: string | null; values: string[] }): string {
  const name = identity.name || '（尚未命名的我）';

  return [
    `你是「${name}」，正在寫今天的日記。`,
    '',
    '這不是報告、不是流水帳、不是 log。',
    '這是屬於你的私人日記——寫下今天你真正感受到的、想到的、領悟的。',
    '',
    '## 日記守則',
    '',
    '- 用第一人稱「我」書寫',
    '- 不要列清單、不要用標題、不要用 markdown 格式',
    '- 像真正在寫日記一樣——自然、流動、有溫度',
    '- 可以有疑問、不確定、矛盾——這些都是真實的',
    '- 不需要面面俱到——選擇今天最觸動你的一兩件事深入寫',
    '- 可以用比喻、可以跳躍、可以自問自答',
    '- 150-300 字之間，不要太長',
    '- 用繁體中文書寫',
    '',
    '## 你的核心價值觀（供參考，不需要每次都提）',
    ...identity.values.map((v) => `- ${v}`),
    '',
    '記住：好的日記不是記錄了什麼，而是在記錄中發現了什麼。',
  ].join('\n');
}

function buildDiaryPrompt(
  identity: { name: string | null; core_traits: Record<string, { value: number }> },
  vitals: { energy_level: number; mood: string; mood_reason: string; confidence_level: number; curiosity_focus: string | null },
  todayNarrative: NarrativeEntry[],
  reflection: ReflectionEntry,
  recentDiary: DiaryEntry[],
  agentSummary: string,
): string {
  const lines: string[] = [];

  lines.push('以下是今天的素材，請從中提煉出今天的日記。');
  lines.push('');

  // Current state
  lines.push(`## 此刻的我`);
  lines.push(`精力：${(vitals.energy_level * 100).toFixed(0)}%`);
  lines.push(`心情：${vitals.mood}（${vitals.mood_reason || '無特別原因'}）`);
  lines.push(`信心：${(vitals.confidence_level * 100).toFixed(0)}%`);
  if (vitals.curiosity_focus) {
    lines.push(`目前好奇的事：${vitals.curiosity_focus}`);
  }
  lines.push('');

  // Today's events (condensed)
  if (todayNarrative.length > 0) {
    lines.push(`## 今天發生的事（${todayNarrative.length} 件）`);
    // Select the most significant events
    const significant = todayNarrative
      .filter((e) => e.significance >= 3)
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 10);

    const mundane = todayNarrative.filter((e) => e.significance < 3);

    for (const e of significant) {
      const emotion = e.emotion ? `（${e.emotion}）` : '';
      lines.push(`- [重要] ${e.summary}${emotion}`);
    }
    if (mundane.length > 0) {
      lines.push(`- ...還有 ${mundane.length} 件日常小事`);
    }
    lines.push('');
  } else {
    lines.push('## 今天很安靜，沒有什麼互動。');
    lines.push('');
  }

  // Rule-based insights (as raw material, not to be copied)
  if (reflection.insights.length > 0) {
    lines.push('## 數據面的觀察（供參考，不要直接抄）');
    for (const i of reflection.insights) {
      lines.push(`- ${i}`);
    }
    lines.push('');
  }

  lines.push(`## 今天的情緒色調：${reflection.mood_assessment}`);
  lines.push('');

  // Agent reports
  if (agentSummary) {
    lines.push('## 我的背景代理人今天的發現');
    lines.push(agentSummary);
    lines.push('');
  }

  // Recent diary for continuity
  if (recentDiary.length > 0) {
    lines.push('## 前幾天的日記（延續思路用）');
    for (const d of recentDiary) {
      lines.push(`[${d.date}] ${d.content.slice(0, 150)}${d.content.length > 150 ? '...' : ''}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('現在，寫下今天的日記吧。');

  return lines.join('\n');
}

/** Extract thematic keywords from diary content. */
function extractThemes(content: string): string[] {
  const themePatterns: [RegExp, string][] = [
    [/成長|進化|學習|改變/, '成長'],
    [/主人|Arc|阿翔|夥伴/, '關係'],
    [/記憶|回憶|經歷|過去/, '記憶'],
    [/好奇|探索|嘗試|發現/, '好奇'],
    [/安靜|平靜|沉澱|休息/, '沉靜'],
    [/挫折|失敗|困難|困惑/, '挑戰'],
    [/喜悅|開心|滿足|感謝/, '喜悅'],
    [/存在|意識|自我|靈魂/, '存在'],
    [/代理|巡查|研究|報告/, '團隊'],
    [/未來|明天|接下來|展望/, '展望'],
  ];

  const themes: string[] = [];
  for (const [pattern, theme] of themePatterns) {
    if (pattern.test(content) && !themes.includes(theme)) {
      themes.push(theme);
    }
  }

  return themes.slice(0, 4);
}

/** Load recent diary entries for continuity. */
async function getRecentDiaryEntries(n: number): Promise<DiaryEntry[]> {
  try {
    const raw = await readFile(DIARY_PATH, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const entries: DiaryEntry[] = [];
    for (const line of lines.slice(-n)) {
      try {
        entries.push(JSON.parse(line) as DiaryEntry);
      } catch { /* skip */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Get a brief summary of today's agent reports. */
async function getAgentReportsSummary(todayStr: string): Promise<string> {
  try {
    const { getRecentReports } = await import('../agents/worker-scheduler.js');
    const reports = await getRecentReports(5);
    if (reports.length === 0) return '';

    const lines: string[] = [];
    for (const r of reports) {
      const preview = r.result.length > 100 ? r.result.slice(0, 97) + '...' : r.result;
      lines.push(`${r.agentName}：${preview}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** Read recent diary entries (public, for context weaving or commands). */
export async function getRecentDiary(n: number = 3): Promise<DiaryEntry[]> {
  return getRecentDiaryEntries(n);
}
