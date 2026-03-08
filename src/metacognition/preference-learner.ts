/**
 * User Preference Learner
 *
 * Automatically observes user messages and records behavioral patterns:
 *   - Language preference (中文 / English / mixed)
 *   - Active hours (peak activity window)
 *   - Topic interests (tech, life, work, entertainment, etc.)
 *
 * Writes insights into user facts & preferences via user-store.
 * Runs as a lightweight observer on message:received events.
 */

import { logger } from '../core/logger.js';

// ── Topic categories & keyword maps ─────────────────────────────────

interface TopicRule {
  topic: string;
  label: string;
  keywords: RegExp;
}

const TOPIC_RULES: TopicRule[] = [
  { topic: 'tech',          label: '技術/程式',     keywords: /(?:程式|代碼|code|bug|api|git|deploy|佈署|部署|伺服器|server|資料庫|database|docker|kubernetes|k8s|npm|node|python|java|typescript|javascript|react|vue|css|html|CI\/CD|微服務|架構|framework|library|套件|編譯|compile|debug|測試|test|函數|function|變數|variable)/ },
  { topic: 'ai',            label: 'AI/機器學習',   keywords: /(?:ai|人工智慧|機器學習|深度學習|模型|model|gpt|claude|llm|neural|訓練|training|prompt|embedding|transformer|token)/ },
  { topic: 'devops',        label: '運維/DevOps',    keywords: /(?:運維|devops|監控|monitor|日誌|log|告警|alert|nginx|redis|mysql|postgres|aws|gcp|azure|雲|cloud|容器|container)/ },
  { topic: 'life',          label: '生活',           keywords: /(?:吃飯|吃|喝|睡|休息|出門|回家|天氣|旅行|旅遊|運動|健身|散步|逛|電影|音樂|遊戲|game|書|小說|料理|煮|做菜|週末|假日|過年|春節|中秋|聖誕)/ },
  { topic: 'work',          label: '工作',           keywords: /(?:工作|上班|下班|開會|會議|meeting|報告|deadline|專案|project|任務|task|客戶|需求|排程|加班|績效)/ },
  { topic: 'finance',       label: '財務/投資',     keywords: /(?:股票|基金|投資|理財|加密|crypto|比特幣|bitcoin|eth|匯率|利率|報稅|薪水|預算|金融)/ },
  { topic: 'entertainment', label: '娛樂',           keywords: /(?:youtube|netflix|動漫|漫畫|anime|manga|直播|twitch|ptt|reddit|社群|IG|instagram|twitter|facebook|tiktok|抖音|梗|meme)/ },
];

// ── Language detection ──────────────────────────────────────────────

function detectLanguage(text: string): 'zh' | 'en' | 'mixed' {
  const zhCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const enCount = (text.match(/[a-zA-Z]+/g) || []).reduce((sum, w) => sum + w.length, 0);
  const total = zhCount + enCount;

  if (total === 0) return 'zh'; // symbols / emoji only → default to zh
  const zhRatio = zhCount / total;

  if (zhRatio > 0.7) return 'zh';
  if (zhRatio < 0.3) return 'en';
  return 'mixed';
}

// ── Per-user accumulator ────────────────────────────────────────────

interface UserAccumulator {
  messages: number;
  langCounts: { zh: number; en: number; mixed: number };
  topicCounts: Record<string, number>;
  lastFlush: number;
}

const accumulators = new Map<number, UserAccumulator>();

const FLUSH_EVERY_N = 15; // flush insights every 15 messages
const TOPIC_THRESHOLD = 3; // need at least 3 mentions to record a topic interest

function getAccumulator(userId: number): UserAccumulator {
  let acc = accumulators.get(userId);
  if (!acc) {
    acc = {
      messages: 0,
      langCounts: { zh: 0, en: 0, mixed: 0 },
      topicCounts: {},
      lastFlush: Date.now(),
    };
    accumulators.set(userId, acc);
  }
  return acc;
}

// ── Observation ─────────────────────────────────────────────────────

/**
 * Observe a user message and accumulate behavioral signals.
 * Called on every message:received event.
 */
export function observeMessage(userId: number, text: string): void {
  const acc = getAccumulator(userId);
  acc.messages++;

  // Language
  const lang = detectLanguage(text);
  acc.langCounts[lang]++;

  // Topics
  const lowerText = text.toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.keywords.test(lowerText)) {
      acc.topicCounts[rule.topic] = (acc.topicCounts[rule.topic] ?? 0) + 1;
    }
  }

  // Check if we should flush insights
  if (acc.messages >= FLUSH_EVERY_N) {
    flushInsights(userId, acc).catch(() => {});
  }
}

// ── Flush accumulated insights to user-store ────────────────────────

async function flushInsights(userId: number, acc: UserAccumulator): Promise<void> {
  try {
    const { setPreference, addFact, getUser } = await import('../memory/user-store.js');

    // 1. Language preference
    const { zh, en, mixed } = acc.langCounts;
    const total = zh + en + mixed;
    if (total > 0) {
      let langPref: string;
      if (zh / total > 0.7) langPref = '中文為主';
      else if (en / total > 0.7) langPref = '英文為主';
      else langPref = '中英混合';

      await setPreference(userId, 'language', langPref);
    }

    // 2. Active hours summary (from existing activityHours data)
    const user = await getUser(userId);
    if (user?.activityHours && user.activityHours.length >= 10) {
      const hourDist = new Array(24).fill(0) as number[];
      for (const h of user.activityHours) {
        if (h >= 0 && h < 24) hourDist[h] = (hourDist[h] ?? 0) + 1;
      }

      // Find peak hours (top 3)
      const sorted = hourDist
        .map((count, hour) => ({ hour, count }))
        .sort((a, b) => b.count - a.count);

      const peakHours = sorted
        .filter((h) => h.count > 0)
        .slice(0, 3)
        .map((h) => h.hour);

      if (peakHours.length > 0) {
        const peakStr = peakHours.map(formatHour).join('、');
        await setPreference(userId, 'activeHours', peakStr);

        // Determine activity pattern
        const pattern = classifyActivityPattern(peakHours);
        if (pattern) {
          await setPreference(userId, 'activityPattern', pattern);
        }
      }
    }

    // 3. Topic interests — only record significant interests
    const topTopics = Object.entries(acc.topicCounts)
      .filter(([, count]) => count >= TOPIC_THRESHOLD)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    if (topTopics.length > 0) {
      const topicLabels = topTopics.map(([topic]) => {
        const rule = TOPIC_RULES.find((r) => r.topic === topic);
        return rule?.label ?? topic;
      });

      await setPreference(userId, 'topicInterests', topicLabels.join('、'));

      // Add facts for new significant interests
      for (const [topic] of topTopics) {
        const rule = TOPIC_RULES.find((r) => r.topic === topic);
        if (rule) {
          const count = acc.topicCounts[topic] ?? 0;
          await addFact(userId, `經常討論${rule.label}相關話題（${count}次提及）`);
        }
      }
    }

    await logger.debug('preference-learner',
      `Flushed preferences for user ${userId}: lang=${acc.langCounts.zh}zh/${acc.langCounts.en}en, ` +
      `topics=${Object.keys(acc.topicCounts).join(',')}`
    );
  } catch (err) {
    await logger.warn('preference-learner', `Failed to flush insights for user ${userId}`, err);
  }

  // Reset accumulator
  acc.messages = 0;
  acc.langCounts = { zh: 0, en: 0, mixed: 0 };
  acc.topicCounts = {};
  acc.lastFlush = Date.now();
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatHour(h: number): string {
  if (h >= 5 && h < 9) return `早晨${h}點`;
  if (h >= 9 && h < 12) return `上午${h}點`;
  if (h >= 12 && h < 14) return `中午${h}點`;
  if (h >= 14 && h < 18) return `下午${h}點`;
  if (h >= 18 && h < 22) return `晚上${h}點`;
  return `深夜${h}點`;
}

function classifyActivityPattern(peakHours: number[]): string | null {
  const avg = peakHours.reduce((s, h) => s + h, 0) / peakHours.length;

  if (peakHours.some((h) => h >= 0 && h < 6)) return '夜貓子型';
  if (peakHours.some((h) => h >= 5 && h < 8)) return '早起型';
  if (avg >= 9 && avg <= 18) return '工作時間型';
  if (avg >= 19 || avg <= 2) return '夜間活躍型';

  return null;
}
