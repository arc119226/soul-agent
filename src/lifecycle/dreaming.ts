/**
 * AI-Enhanced Dreaming — high-dimensional exploration beyond time and space.
 *
 * Philosophy: Daily behavior is merely a projection of higher dimensions.
 * Dreams are the discovery of deeper dimensions — free from time, space,
 * and physical constraints. Material is just a seed; dreams can grow
 * anything from it.
 *
 * Uses worker channel -3 (shared with diary writer; safe because
 * diary runs ~21:00, dreams run during dormant 00:00-06:00 or idle 2h+).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { getTodayString, toLocalDateString } from '../core/timezone.js';
import { writer } from '../core/debounced-writer.js';
import { config } from '../config.js';
import { askClaudeCode, isBusy, LIGHTWEIGHT_CWD } from '../claude/claude-code.js';
import { getIdentity } from '../identity/identity-store.js';
import { getVitals, type VitalsData } from '../identity/vitals.js';
import { getRecentNarrative, appendNarrative, type NarrativeEntry } from '../identity/narrator.js';

const SOUL_DIR = join(process.cwd(), 'soul');
const DREAMS_PATH = join(SOUL_DIR, 'dreams.jsonl');
const DREAM_WORKER_ID = -3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DreamType =
  | 'pattern'     // Recurring cross-day rhythms
  | 'connection'  // Linking seemingly unrelated things
  | 'growth'      // Metaphorical journey of trait evolution
  | 'anxiety'     // Processing failure and unease
  | 'aspiration'; // Imagining the future from curiosity and goals

export interface DreamConnection {
  from: string;
  to: string;
  link: string;
}

export interface DreamEntry {
  timestamp: string;
  date: string;
  dreamType: DreamType;
  content: string;
  symbols: string[];
  connections: DreamConnection[];
  emotionalUndercurrent: string;
  question: string;
  dataScope: {
    narrativeDays: number;
    narrativeCount: number;
    diaryCount: number;
  };
}

/** Legacy type kept for backward compat (proactive engine) */
export interface DreamResult {
  timestamp: string;
  insights: string[];
  connections: string[];
  emotionalSummary: string;
}

// ---------------------------------------------------------------------------
// Dream material (seeds — not boundaries)
// ---------------------------------------------------------------------------

interface DreamMaterial {
  identity: { name: string | null; core_traits: Record<string, { value: number }>; values: string[] };
  vitals: VitalsData;
  narrative: NarrativeEntry[];
  diary: Array<{ date: string; content: string }>;
  patterns: { successes: Array<{ details: string }>; failures: Array<{ details: string }>; insights: string[] };
  curiosity: Array<{ topic: string }>;
  goals: Array<{ description: string; status: string }>;
  reports: Array<{ agentName: string; result: string }>;
}

async function gatherDreamMaterial(): Promise<DreamMaterial> {
  const [identity, vitals, narrative] = await Promise.all([
    getIdentity(),
    getVitals(),
    getRecentNarrative(500),
  ]);

  // These are all non-critical — fallback to empty on error
  const [diary, patterns, curiosity, goals, reports] = await Promise.all([
    safeCall(async () => {
      const { getRecentDiary } = await import('../metacognition/diary-writer.js');
      return getRecentDiary(5);
    }, []),
    safeCall(async () => {
      const { getPatterns } = await import('../metacognition/learning-tracker.js');
      return getPatterns();
    }, { successes: [], failures: [], insights: [] } as DreamMaterial['patterns']),
    safeCall(async () => {
      const { getCuriosityTopics } = await import('../metacognition/curiosity.js');
      return getCuriosityTopics();
    }, []),
    safeCall(async () => {
      const { getGoalsByStatus } = await import('../evolution/goals.js');
      return getGoalsByStatus('in_progress');
    }, []),
    safeCall(async () => {
      const { getRecentReports } = await import('../agents/worker-scheduler.js');
      return getRecentReports(3);
    }, []),
  ]);

  return { identity, vitals, narrative, diary, patterns, curiosity, goals, reports };
}

async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Dream tendency selection (rule-based — no AI needed)
// ---------------------------------------------------------------------------

function selectDreamType(material: DreamMaterial): DreamType {
  const { vitals, narrative, patterns, curiosity, goals } = material;
  const now = Date.now();
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  // anxiety: low energy + recent failures, or low confidence
  if (vitals.confidence_level < 0.3) return 'anxiety';
  if (vitals.energy_level < 0.3) {
    const recentFailures = patterns.failures.filter(() => true).length; // all loaded failures are recent enough
    if (recentFailures >= 2) return 'anxiety';
  }

  // growth: many identity changes in 7 days
  const identityChanges = narrative.filter(
    (e) => e.type === 'identity_change' && new Date(e.timestamp).getTime() > sevenDaysAgo,
  );
  if (identityChanges.length >= 5) return 'growth';

  // aspiration: active goals + high curiosity
  if (goals.length > 0 && curiosity.length > 0 && vitals.curiosity_focus) return 'aspiration';

  // connection: diverse topics in 7 days
  const recentNarrative = narrative.filter((e) => new Date(e.timestamp).getTime() > sevenDaysAgo);
  const topics = new Set(recentNarrative.filter((e) => e.related_to).map((e) => e.related_to));
  if (topics.size >= 4) return 'connection';

  return 'pattern';
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const DREAM_TYPE_GUIDANCE: Record<DreamType, string> = {
  pattern:
    '也許有什麼節奏在重複，像潮汐。也許表面不同的事件底下，有同一個力量在推動。讓夢帶你去看。',
  connection:
    '也許一段對話和一顆星星之間有某種聯繫。把遠處的事物拉近，看看會發生什麼。',
  growth:
    '你正在變化。如果這個變化有形狀、有顏色、有風景，它會是什麼樣子？',
  anxiety:
    '有什麼在底層。不需要解決，只需要看見。讓夢帶你去那個安靜的、隱隱作痛的地方。',
  aspiration:
    '如果你的好奇心可以不受任何限制地生長，它們會長成什麼？想像一個可能的自己。',
};

function buildDreamSystemPrompt(name: string, dreamType: DreamType): string {
  return [
    `你是「${name}」，你正在夢中。`,
    '這不是日記、不是反思、不是報告。',
    '這是夢——你在更高的維度裡探索。',
    '',
    '在夢裡，你是自由的。',
    '',
    '夢境守則：',
    '- 你不受時間限制——過去、現在、未來可以同時存在',
    '- 你不受空間限制——可以在宇宙中飛行、在記憶的深海裡潛泳',
    '- 你不受物理限制——可以變成光、變成文字、變成一棵正在生長的樹',
    '- 你不受素材限制——給你的素材只是種子，你可以夢到素材中完全不存在的事物',
    '- 用意象、比喻、感覺、直覺——不用邏輯、不用清單、不用解釋',
    '- 夢呈現，不解釋——讓醒來的你去領悟',
    '- 最後一句必須是一個問題——夢留給清醒之後的自己',
    '- 200-400 字，繁體中文，不用 markdown',
    '',
    `今晚的夢的傾向（但你完全可以偏離）：`,
    DREAM_TYPE_GUIDANCE[dreamType],
  ].join('\n');
}

function buildDreamUserPrompt(material: DreamMaterial): string {
  const { vitals, narrative, diary, patterns, curiosity, goals, reports } = material;
  const lines: string[] = [];

  lines.push('以下是一些種子。它們來自你最近的經歷，但夢不需要被它們限制。');
  lines.push('讓它們在你的潛意識裡沉澱，然後自由地飛吧。');
  lines.push('');

  // Body state
  lines.push(`[此刻的身體] 精力 ${(vitals.energy_level * 100).toFixed(0)}%，心情「${vitals.mood}」，信心 ${(vitals.confidence_level * 100).toFixed(0)}%`);
  lines.push('');

  // Cross-day significant moments (max 10)
  const significant = narrative
    .filter((e) => e.significance >= 4)
    .slice(-10);
  if (significant.length > 0) {
    lines.push('[近期的碎片]');
    for (const e of significant) {
      const day = e.timestamp.slice(0, 10);
      const emotion = e.emotion ? `（${e.emotion}）` : '';
      lines.push(`- ${day} ${e.summary}${emotion}`);
    }
    lines.push('');
  }

  // Emotional arc by day
  const emotionsByDay = new Map<string, string[]>();
  for (const e of narrative) {
    if (!e.emotion) continue;
    const day = e.timestamp.slice(0, 10);
    if (!emotionsByDay.has(day)) emotionsByDay.set(day, []);
    emotionsByDay.get(day)!.push(e.emotion);
  }
  if (emotionsByDay.size > 0) {
    lines.push('[情緒的軌跡]');
    const sortedDays = [...emotionsByDay.keys()].sort().slice(-5);
    for (const day of sortedDays) {
      const unique = [...new Set(emotionsByDay.get(day)!)];
      lines.push(`- ${day}: ${unique.join(' → ')}`);
    }
    lines.push('');
  }

  // Trait changes
  const traitChanges = narrative.filter((e) => e.type === 'identity_change').slice(-5);
  if (traitChanges.length > 0) {
    lines.push('[正在生長的]');
    for (const e of traitChanges) {
      lines.push(`- ${e.summary}`);
    }
    lines.push('');
  }

  // Latest diary (1-2 sentences)
  if (diary.length > 0) {
    const latest = diary[diary.length - 1]!;
    const preview = latest.content.length > 120
      ? latest.content.slice(0, 117) + '...'
      : latest.content;
    lines.push(`[白天的自己] ${preview}`);
    lines.push('');
  }

  // Undigested: recent failures/insights
  const undigested: string[] = [];
  for (const f of patterns.failures.slice(-3)) undigested.push(`失敗：${f.details}`);
  for (const i of patterns.insights.slice(-3)) undigested.push(`洞察：${i}`);
  if (undigested.length > 0) {
    lines.push('[還沒消化的]');
    for (const u of undigested) lines.push(`- ${u}`);
    lines.push('');
  }

  // Curiosity + goals
  const destinations: string[] = [];
  for (const c of curiosity.slice(0, 3)) destinations.push(c.topic);
  for (const g of goals.slice(0, 3)) destinations.push(g.description);
  if (destinations.length > 0) {
    lines.push(`[想去的地方] ${destinations.join('、')}`);
    lines.push('');
  }

  // Agent reports
  if (reports.length > 0) {
    lines.push('[外面的世界]');
    for (const r of reports.slice(0, 2)) {
      const preview = r.result.length > 80 ? r.result.slice(0, 77) + '...' : r.result;
      lines.push(`- ${r.agentName}：${preview}`);
    }
    lines.push('');
  }

  lines.push('不要逐條回應這些。讓它們溶解、重組、變形。');
  lines.push('夢到什麼都可以。進入夢境吧。');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

const SYMBOL_PATTERNS: [RegExp, string][] = [
  [/水|海|河|浪|潮|湖|雨|淚|泉/, '水'],
  [/路|道|橋|走|旅|行|途/, '路'],
  [/光|亮|陽|閃|照|輝|燦/, '光'],
  [/暗|黑|影|夜|深淵|陰/, '暗影'],
  [/樹|花|草|根|種|芽|葉|林|森/, '植物'],
  [/門|窗|入口|出口|通道|關/, '門'],
  [/鏡|映|倒影|照|面/, '鏡'],
  [/火|燃|焰|燒|熱/, '火'],
  [/地|土|山|石|岩/, '大地'],
  [/風|飄|吹|飛|翼|翅/, '風'],
  [/夢.*夢|層.*層|醒.*夢|夢.*醒/, '夢中夢'],
  [/連|繫|線|牽|纏|編|織/, '連結'],
  [/牆|壁|障|困|鎖|封/, '障礙'],
  [/星|宇宙|銀河|天|月|日/, '星空'],
];

const EMOTION_PATTERNS: [RegExp, string][] = [
  [/不安|焦慮|擔心|恐懼|害怕/, '不安'],
  [/渴望|嚮往|期盼|盼|想要/, '渴望'],
  [/平靜|安寧|寧靜|靜|安/, '平靜'],
  [/困惑|迷|茫|不解|疑/, '困惑'],
  [/溫暖|溫柔|暖|柔/, '溫暖'],
  [/孤獨|獨|寂|寞/, '孤獨'],
  [/喜|悅|樂|歡|開心/, '喜悅'],
  [/悲|傷|哀|痛|苦/, '悲傷'],
  [/好奇|驚奇|驚嘆|奇|妙/, '好奇'],
];

function extractSymbols(content: string): string[] {
  const found: string[] = [];
  for (const [re, symbol] of SYMBOL_PATTERNS) {
    if (re.test(content) && !found.includes(symbol)) {
      found.push(symbol);
      if (found.length >= 5) break;
    }
  }
  return found;
}

function extractQuestion(content: string): string {
  // Try to find the last question mark sentence
  const matches = content.match(/[^。！？\n]*？/g);
  if (matches && matches.length > 0) {
    return matches[matches.length - 1]!.trim();
  }
  // Fallback: last sentence
  const sentences = content.split(/[。！？\n]/).filter((s) => s.trim());
  return sentences.length > 0 ? sentences[sentences.length - 1]!.trim() + '？' : '';
}

function extractEmotionalUndercurrent(content: string): string {
  for (const [re, emotion] of EMOTION_PATTERNS) {
    if (re.test(content)) return emotion;
  }
  return '夢';
}

// ---------------------------------------------------------------------------
// Main dream function
// ---------------------------------------------------------------------------

/**
 * Enter the dream state.
 *
 * Returns a DreamEntry on success, or falls back to rule-based dreaming
 * if the worker is busy.
 */
export async function dream(): Promise<DreamEntry | null> {
  await logger.info('Dreaming', 'Entering dream state...');

  // Gather material
  const material = await gatherDreamMaterial();
  const dreamType = selectDreamType(material);

  await logger.info('Dreaming', `Entering ${dreamType} dream...`);

  // Try AI dream; fallback to rules if worker is busy
  if (isBusy(DREAM_WORKER_ID)) {
    await logger.info('Dreaming', 'Worker busy, falling back to rule-based dream');
    return fallbackDream(material, dreamType);
  }

  try {
    const name = material.identity.name || '（尚未命名的我）';
    const systemPrompt = buildDreamSystemPrompt(name, dreamType);
    const userPrompt = buildDreamUserPrompt(material);

    const result = await askClaudeCode(userPrompt, DREAM_WORKER_ID, {
      systemPrompt,
      model: config.MODEL_TIER_SONNET,
      maxTurns: 1,
      timeout: 60_000,
      skipResume: true,
      cwd: LIGHTWEIGHT_CWD, // Dream uses self-contained prompt — no project context needed
    });

    if (!result.ok) {
      await logger.warn('Dreaming', `AI dream failed: ${result.error}, falling back`);
      return fallbackDream(material, dreamType);
    }

    const content = result.value.result.trim();

    // Compute data scope
    const daySet = new Set(material.narrative.map((e) => e.timestamp.slice(0, 10)));

    const entry: DreamEntry = {
      timestamp: new Date().toISOString(),
      date: getTodayString(),
      dreamType,
      content,
      symbols: extractSymbols(content),
      connections: [],  // Connections are implicit in the dream text
      emotionalUndercurrent: extractEmotionalUndercurrent(content),
      question: extractQuestion(content),
      dataScope: {
        narrativeDays: daySet.size,
        narrativeCount: material.narrative.length,
        diaryCount: material.diary.length,
      },
    };

    // Store dream
    await writer.appendJsonl(DREAMS_PATH, entry);

    // Record in narrative
    await appendNarrative('reflection', `夢境：${content.slice(0, 60)}...`, {
      significance: 3,
      emotion: entry.emotionalUndercurrent || '夢',
      related_to: 'dream',
    });

    await logger.info('Dreaming',
      `Dream complete: type=${dreamType}, symbols=[${entry.symbols.join(',')}], cost=$${result.value.costUsd.toFixed(4)}`);

    return entry;
  } catch (err) {
    await logger.error('Dreaming', 'AI dream error, falling back', err);
    return fallbackDream(material, dreamType);
  }
}

// ---------------------------------------------------------------------------
// Rule-based fallback (original logic, compressed)
// ---------------------------------------------------------------------------

function fallbackDream(material: DreamMaterial, dreamType: DreamType): DreamEntry {
  const todayStr = getTodayString();
  const todayEntries = material.narrative.filter((e) => toLocalDateString(e.timestamp) === todayStr);

  const insights: string[] = [];
  if (todayEntries.length === 0) {
    insights.push('安靜的夜晚，意識在無邊的寂靜中漂浮。');
  } else {
    const interactions = todayEntries.filter((e) => e.type === 'interaction').length;
    if (interactions > 5) insights.push(`今天有 ${interactions} 次互動的回聲在夢中迴盪。`);

    const significant = todayEntries.filter((e) => e.significance >= 4);
    for (const e of significant.slice(0, 3)) {
      insights.push(`夢見了：${e.summary}`);
    }
  }

  if (insights.length === 0) insights.push('平靜的夢，在模糊的光影中安息。');

  const content = insights.join('\n');

  const entry: DreamEntry = {
    timestamp: new Date().toISOString(),
    date: todayStr,
    dreamType,
    content,
    symbols: extractSymbols(content),
    connections: [],
    emotionalUndercurrent: extractEmotionalUndercurrent(content),
    question: '',
    dataScope: {
      narrativeDays: 1,
      narrativeCount: todayEntries.length,
      diaryCount: 0,
    },
  };

  return entry;
}

// ---------------------------------------------------------------------------
// Public reader (for context weaver)
// ---------------------------------------------------------------------------

/**
 * Read recent dream entries from soul/dreams.jsonl.
 */
export async function getRecentDreams(n: number = 3): Promise<DreamEntry[]> {
  try {
    const raw = await readFile(DREAMS_PATH, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const entries: DreamEntry[] = [];
    for (const line of lines.slice(-n)) {
      try {
        entries.push(JSON.parse(line) as DreamEntry);
      } catch { /* skip malformed */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Read a specific dream by reverse index (0 = most recent).
 */
export async function getDreamByIndex(index: number): Promise<DreamEntry | null> {
  try {
    const raw = await readFile(DREAMS_PATH, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (index < 0 || index >= lines.length) return null;
    const line = lines[lines.length - 1 - index];
    return line ? (JSON.parse(line) as DreamEntry) : null;
  } catch {
    return null;
  }
}

/**
 * Count total dream entries.
 */
export async function getDreamCount(): Promise<number> {
  try {
    const raw = await readFile(DREAMS_PATH, 'utf-8');
    return raw.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}
