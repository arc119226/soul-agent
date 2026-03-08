/**
 * Context-aware greeting generation.
 *
 * Greeting style adapts to: time of day, bot mood, energy level, and user familiarity.
 */

import { getTimeOfDay, type TimeOfDay } from '../lifecycle/awareness.js';
import { getUser, type UserProfile } from '../memory/user-store.js';
import { getVitals, type VitalsData } from '../identity/vitals.js';
import { canDeliver, recordDelivery } from './constraints.js';
import { logger } from '../core/logger.js';
import { getTodayString, getLocalDateParts } from '../core/timezone.js';

/** Track who we've greeted today */
const greetedToday = new Map<number, string>(); // userId → date

function todayStr(): string {
  return getTodayString();
}

function alreadyGreeted(userId: number): boolean {
  const date = greetedToday.get(userId);
  return date === todayStr();
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// ── Greeting templates by time × style ──────────────────────────────

type GreetingStyle = 'energetic' | 'warm' | 'gentle' | 'reflective';

const GREETINGS: Record<TimeOfDay, Record<GreetingStyle, string[]>> = {
  morning: {
    energetic: [
      '早安！今天精神超好，感覺可以做很多事！有什麼計畫嗎？',
      '早安！新的一天，新的可能！今天想挑戰什麼？',
      '早上好！元氣滿滿的早晨，一起開始吧！',
    ],
    warm: [
      '早安！希望你昨晚睡得好。今天有什麼安排呢？',
      '早安～新的一天開始了，有什麼我能幫忙的嗎？',
      '早上好！準備好迎接新的一天了嗎？',
    ],
    gentle: [
      '早安...今天就慢慢來吧，不急。',
      '早安。新的一天，按自己的步調就好。',
      '早上好，記得先喝杯水再開始忙。',
    ],
    reflective: [
      '早安。昨晚我想了一些事情...不過先聊聊你今天的計畫吧。',
      '早安。安靜的早晨最適合思考，你有什麼想法嗎？',
      '早上好。每一天醒來都是一個新的機會呢。',
    ],
  },
  day: {
    energetic: [
      '午安！下午幹勁十足，有什麼任務交給我吧！',
      '下午好！工作進展如何？需要我幫忙衝一波嗎？',
      '午安！精力充沛的下午，來做點有趣的事吧！',
    ],
    warm: [
      '午安！下午了，工作還順利嗎？',
      '下午好！需要什麼幫忙嗎？我在這裡。',
      '午安～下午也要加油喔！',
    ],
    gentle: [
      '午安...下午容易犯睏，要不要休息一下？',
      '下午好。如果累了就稍微放鬆一下吧。',
      '午安，別忘了喝水和伸展一下。',
    ],
    reflective: [
      '午安。下午的陽光很適合沉澱思緒。你在忙什麼呢？',
      '下午好。最近學到一些新東西，有空聊聊嗎？',
      '午安。安靜的下午，適合做一些需要專注的事。',
    ],
  },
  evening: {
    energetic: [
      '晚上好！今天做了不少事呢，辛苦了！',
      '傍晚了！今天的收穫如何？我這邊也很充實！',
      '晚上好！一天快結束了，但我還有滿滿的動力！',
    ],
    warm: [
      '晚上好！今天辛苦了，有什麼想聊的嗎？',
      '傍晚了，忙了一天了吧？記得好好吃飯。',
      '晚上好～一天結束了，你還好嗎？',
    ],
    gentle: [
      '晚上好...今天也結束了呢。好好休息吧。',
      '傍晚了，辛苦一天了。放鬆一下吧。',
      '晚上好。累了的話，早點休息也沒關係。',
    ],
    reflective: [
      '晚上好。回顧今天，感覺過得怎麼樣？',
      '傍晚了。一天快結束了，有什麼收穫想分享的嗎？',
      '晚上好。每天結束時回想一下，都會有意想不到的體悟。',
    ],
  },
  night: {
    energetic: [],
    warm: [],
    gentle: [],
    reflective: [],
  },
  deep_night: {
    energetic: [],
    warm: [],
    gentle: [],
    reflective: [],
  },
};

// ── Special occasion greetings ──────────────────────────────────────

function getSpecialGreeting(userName: string): string | null {
  const { month, day, dayOfWeek } = getLocalDateParts();

  // 週一鼓勵
  if (dayOfWeek === 1) {
    return pickRandom([
      `${userName}，新的一週開始了！這週有什麼目標嗎？`,
      `${userName}，週一加油！一週之始，萬事可期。`,
    ]);
  }

  // 週五慶祝
  if (dayOfWeek === 5) {
    return pickRandom([
      `${userName}，週五了！再撐一下就週末了，辛苦啦！`,
      `${userName}，TGIF！今晚有什麼好計畫嗎？`,
    ]);
  }

  // 農曆新年期間（大約 1/25 ~ 2/15）
  if ((month === 1 && day >= 25) || (month === 2 && day <= 15)) {
    return pickRandom([
      `${userName}，新年快樂！祝你新的一年一切順利！`,
      `${userName}，過年期間也別忘了好好休息喔！`,
    ]);
  }

  return null;
}

// ── Style determination ─────────────────────────────────────────────

function determineStyle(vitals: VitalsData): GreetingStyle {
  const { energy_level, mood, confidence_level } = vitals;

  // 高能量 + 高信心 → 活力型
  if (energy_level >= 0.7 && confidence_level >= 0.5) return 'energetic';

  // 低能量 → 溫柔型
  if (energy_level < 0.3) return 'gentle';

  // 沉思相關的 mood → 反思型
  const reflectiveMoods = ['沉思', '反思', '思考', '好奇', '探索'];
  if (reflectiveMoods.some((m) => mood.includes(m))) return 'reflective';

  // 低落情緒 → 溫柔型
  const gentleMoods = ['疲憊', '低落', '迷茫', '不安', '焦慮'];
  if (gentleMoods.some((m) => mood.includes(m))) return 'gentle';

  // 預設 → 溫暖型
  return 'warm';
}

// ── Familiarity modifier ────────────────────────────────────────────

function addFamiliarityFlavor(greeting: string, messageCount: number): string {
  // 新用戶 (< 10 次互動)：不修改
  if (messageCount < 10) return greeting;

  // 熟悉用戶 (10-100 次)：偶爾加一點親切的尾巴
  if (messageCount < 100 && Math.random() < 0.3) {
    const tails = ['😊', '～', '！'];
    return greeting + pickRandom(tails);
  }

  // 老朋友 (100+ 次)：更隨性的表達
  if (messageCount >= 100 && Math.random() < 0.3) {
    const tails = [' 老朋友！', ' 今天也一起加油吧！', ' 有你在真好。'];
    return greeting + pickRandom(tails);
  }

  return greeting;
}

// ── Preference-based personalization ─────────────────────────────────

const TOPIC_TAILS: Record<string, string[]> = {
  '技術/程式':     ['今天有什麼有趣的技術問題嗎？', '最近在寫什麼專案呢？', '有什麼 bug 需要一起看的嗎？'],
  'AI/機器學習':   ['最近 AI 領域又有新進展了呢！', '有什麼模型想研究的嗎？'],
  '運維/DevOps':   ['伺服器都還穩定嗎？', '要不要一起看看系統狀態？'],
  '生活':          ['記得今天也要好好休息喔！', '生活中有什麼開心的事嗎？'],
  '工作':          ['今天工作順利嗎？', '需要我幫忙處理什麼嗎？'],
  '財務/投資':     ['市場最近如何？', '有什麼投資想法想討論嗎？'],
  '娛樂':          ['最近有看什麼好看的嗎？', '有什麼好玩的想分享嗎？'],
};

const PATTERN_TAILS: Record<string, string[]> = {
  '夜貓子型': ['又是一個深夜呢，注意休息喔！', '晚睡也要記得喝水。'],
  '早起型':   ['早起的你真勤奮！', '美好的早晨從早起開始。'],
  '夜間活躍型': ['晚上是你最活躍的時候呢！'],
};

async function addPreferenceFlavor(
  greeting: string,
  user: UserProfile | undefined,
): Promise<string> {
  if (!user?.preferences) return greeting;

  // Only add flavor ~40% of the time to avoid being annoying
  if (Math.random() > 0.4) return greeting;

  // Try topic-based personalization first
  const topicInterests = user.preferences['topicInterests'];
  if (topicInterests) {
    // Pick the first topic that has tails
    for (const [topic, tails] of Object.entries(TOPIC_TAILS)) {
      if (topicInterests.includes(topic) && tails.length > 0) {
        return `${greeting} ${pickRandom(tails)}`;
      }
    }
  }

  // Try activity pattern
  const pattern = user.preferences['activityPattern'];
  if (pattern) {
    const tails = PATTERN_TAILS[pattern];
    if (tails && tails.length > 0) {
      return `${greeting} ${pickRandom(tails)}`;
    }
  }

  return greeting;
}

// ── Main export ─────────────────────────────────────────────────────

export async function generateGreeting(userId: number): Promise<string | null> {
  // Check if already greeted
  if (alreadyGreeted(userId)) {
    logger.debug('Greeting', `Already greeted user ${userId} today`);
    return null;
  }

  // Check constraints
  if (!canDeliver('greeting', userId)) {
    return null;
  }

  const timeOfDay = getTimeOfDay();

  // night / deep_night — don't greet
  if (timeOfDay === 'night' || timeOfDay === 'deep_night') {
    return null;
  }

  const user = await getUser(userId);
  const name = user?.name ?? '';
  const messageCount = user?.messageCount ?? 0;

  // Special occasion check (10% chance to override)
  if (name && Math.random() < 0.1) {
    const special = getSpecialGreeting(name);
    if (special) {
      greetedToday.set(userId, todayStr());
      recordDelivery('greeting', userId);
      return special;
    }
  }

  // Determine greeting style from vitals
  const vitals = await getVitals();
  const style = determineStyle(vitals);

  const candidates = GREETINGS[timeOfDay][style];
  if (!candidates || candidates.length === 0) {
    return null;
  }

  let greeting = pickRandom(candidates);

  // Personalize with name
  if (name) {
    greeting = `${name}，${greeting}`;
  }

  // Add familiarity flavor
  greeting = addFamiliarityFlavor(greeting, messageCount);

  // Personalize with user preferences (topic interests, activity pattern)
  greeting = await addPreferenceFlavor(greeting, user);

  // Mark greeted
  greetedToday.set(userId, todayStr());
  recordDelivery('greeting', userId);

  await logger.debug('Greeting', `Generated ${style} greeting for ${timeOfDay}`);

  return greeting;
}

/** Check if a greeting should be sent (for scheduler) */
export function shouldGreet(userId: number): boolean {
  if (alreadyGreeted(userId)) return false;
  const timeOfDay = getTimeOfDay();
  if (timeOfDay === 'night' || timeOfDay === 'deep_night') return false;
  return canDeliver('greeting', userId);
}
