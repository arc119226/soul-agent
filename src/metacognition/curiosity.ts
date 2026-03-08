/**
 * Knowledge gap tracking — record what the bot wants to learn.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';

const CURIOSITY_PATH = join(process.cwd(), 'soul', 'evolution', 'curiosity.json');

/** Extract keywords from topic string for fuzzy dedup */
function extractTopicKeywords(text: string): string[] {
  const clean = text.replace(/\*\*/g, '').replace(/[`#\-\[\]()?？！!。：:]/g, ' ');
  const tokens = clean.split(/[\s,;、\-—]+/).filter(Boolean);
  const STOP = new Set([
    '如何', '什麼', '是否', '能否', '為什麼', '怎麼', '哪些', '可以', '應該',
    '目前', '未來', '已經', '需要', '支援', '使用', '進行', '實現', '我們',
    '這個', '一個', '還是', '是否', '有沒有',
    'how', 'what', 'why', 'when', 'which', 'can', 'should', 'the', 'and',
    'for', 'with', 'from', 'that', 'this', 'are', 'was', 'will', 'have',
  ]);
  return [...new Set(
    tokens.map(t => t.toLowerCase().trim()).filter(t => t.length >= 2 && !STOP.has(t))
  )];
}

export interface CuriosityTopic {
  topic: string;
  reason: string;
  addedAt: string;
  explored: boolean;
}

interface CuriosityFile {
  version: number;
  topics: CuriosityTopic[];
  questions: string[];
}

let curiosityData: CuriosityFile | null = null;

async function load(): Promise<CuriosityFile> {
  if (curiosityData) return curiosityData;
  try {
    const raw = await readFile(CURIOSITY_PATH, 'utf-8');
    curiosityData = JSON.parse(raw) as CuriosityFile;
    // Ensure topics have the full shape
    curiosityData.topics = (curiosityData.topics ?? []).map((t) => ({
      topic: typeof t === 'string' ? t : t.topic,
      reason: typeof t === 'string' ? '' : (t.reason ?? ''),
      addedAt: typeof t === 'string' ? new Date().toISOString() : (t.addedAt ?? new Date().toISOString()),
      explored: typeof t === 'string' ? false : (t.explored ?? false),
    }));
  } catch {
    curiosityData = { version: 1, topics: [], questions: [] };
  }
  return curiosityData;
}

function persist(): void {
  if (!curiosityData) return;
  writer.schedule(CURIOSITY_PATH, curiosityData);
}

export async function trackCuriosityTopic(topic: string, reason: string): Promise<void> {
  const data = await load();

  // Avoid duplicates
  if (data.topics.some((t) => t.topic.toLowerCase() === topic.toLowerCase())) {
    return;
  }

  // Fuzzy duplicate check — keyword overlap > 60% means same topic
  const newKeywords = extractTopicKeywords(topic);
  if (newKeywords.length >= 2) {
    const isDuplicate = data.topics.some((t) => {
      if (t.explored) return false; // Don't block if existing is already explored
      const existingKeywords = extractTopicKeywords(t.topic);
      if (existingKeywords.length < 2) return false;
      const overlap = newKeywords.filter(k => existingKeywords.includes(k)).length;
      const ratio = overlap / Math.min(newKeywords.length, existingKeywords.length);
      return ratio > 0.6;
    });
    if (isDuplicate) {
      await logger.info('Curiosity', `Fuzzy duplicate blocked: "${topic.slice(0, 50)}"`);
      return;
    }
  }

  data.topics.push({
    topic,
    reason,
    addedAt: new Date().toISOString(),
    explored: false,
  });

  // Cap at 30 topics — remove oldest explored ones first
  while (data.topics.length > 30) {
    const exploredIdx = data.topics.findIndex((t) => t.explored);
    if (exploredIdx >= 0) {
      data.topics.splice(exploredIdx, 1);
    } else {
      data.topics.shift();
    }
  }

  persist();
  await logger.info('Curiosity', `New topic: "${topic}" — ${reason}`);
}

export async function trackQuestion(question: string): Promise<void> {
  const data = await load();

  if (data.questions.includes(question)) return;

  data.questions.push(question);

  // Cap at 100 questions
  while (data.questions.length > 100) {
    data.questions.shift();
  }

  persist();
}

export async function markExplored(topic: string): Promise<boolean> {
  const data = await load();
  const entry = data.topics.find(
    (t) => t.topic.toLowerCase() === topic.toLowerCase(),
  );
  if (!entry) return false;
  entry.explored = true;
  persist();
  return true;
}

export async function getCuriosityTopics(): Promise<CuriosityTopic[]> {
  const data = await load();
  return data.topics.filter((t) => !t.explored);
}

export async function getAllCuriosityData(): Promise<CuriosityFile> {
  return load();
}

export function resetCache(): void {
  curiosityData = null;
}
