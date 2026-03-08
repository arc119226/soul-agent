/**
 * Memory Quality Scorer — evaluates memories on 4 dimensions
 * beyond simple recency/frequency/importance.
 *
 * Dimensions:
 *   1. Emotional Resonance (0-1) — 情感連結度
 *   2. Identity Relevance (0-1) — 身份相關度
 *   3. Practical Value (0-1) — 實用價值
 *   4. Uniqueness (0-1) — 獨特性
 *
 * The final quality score is combined with the existing scoring.ts
 * via a weighted merge, preserving backward compatibility.
 */

import { computeRelevance } from './text-relevance.js';

// Quality dimension weights
const EMOTIONAL_WEIGHT = 0.25;
const IDENTITY_WEIGHT  = 0.25;
const PRACTICAL_WEIGHT = 0.30;
const UNIQUENESS_WEIGHT = 0.20;

// ── Per-dimension scoring parameters ─────────────────────────────────

const EMOTIONAL_SCORES = {
  POSITIVE_WORD: 0.12,
  NEGATIVE_WORD: 0.10,
  EXCLAMATION: 0.05,
  EXCLAMATION_CAP: 0.15,
  EMOJI: 0.08,
  EMOJI_CAP: 0.15,
  REPEATED_PUNCT: 0.1,
} as const;

const IDENTITY_SCORES = {
  KEYWORD: 0.13,
  PRONOUN: 0.02,
  PRONOUN_CAP: 0.1,
  DECISION: 0.2,
  SELF_STATEMENT: 0.25,
} as const;

const PRACTICAL_SCORES = {
  BASELINE: 0.1,
  TECH: 0.3,
  HOWTO: 0.2,
  NUMBER: 0.1,
  DATE: 0.15,
  URL: 0.1,
  LEN_200: 0.08,
  LEN_500: 0.07,
} as const;

const UNIQUENESS_OVERLAP_FACTOR = 1.2;
const DEFAULT_QUALITY_BLEND = 0.3;

// Emotional signal keywords (Chinese + English)
const POSITIVE_SIGNALS = [
  '開心', '感謝', '愛', '喜歡', '好棒', '厲害', '感動',
  '謝謝', '幸福', '快樂', '棒', '讚', '很好',
  'happy', 'love', 'great', 'thank', 'wonderful', 'amazing',
];
const NEGATIVE_SIGNALS = [
  '難過', '擔心', '害怕', '生氣', '失望', '困擾', '抱歉',
  '不好意思', '糟糕', '煩惱',
  'sad', 'worried', 'angry', 'disappointed', 'sorry',
];
const IDENTITY_SIGNALS = [
  '名字', '生日', '喜歡', '討厭', '偏好', '習慣',
  '工作', '家', '朋友', '興趣', '個性', '我是', '我的',
  'name', 'birthday', 'prefer', 'habit', 'like', 'dislike',
];

export interface QualityScore {
  emotional: number;
  identity: number;
  practical: number;
  uniqueness: number;
  composite: number;
}

export function scoreEmotionalResonance(content: string): number {
  const lower = content.toLowerCase();
  let score = 0;

  // Positive emotional words
  for (const word of POSITIVE_SIGNALS) {
    if (lower.includes(word)) score += EMOTIONAL_SCORES.POSITIVE_WORD;
  }

  // Negative emotional words (slightly lower weight)
  for (const word of NEGATIVE_SIGNALS) {
    if (lower.includes(word)) score += EMOTIONAL_SCORES.NEGATIVE_WORD;
  }

  // Exclamation/emotion markers boost
  const exclamations = (content.match(/[！!？?]/g) ?? []).length;
  score += Math.min(exclamations * EMOTIONAL_SCORES.EXCLAMATION, EMOTIONAL_SCORES.EXCLAMATION_CAP);

  // Emoji presence
  const emojiCount = (content.match(/[\u{1F300}-\u{1F9FF}]/gu) ?? []).length;
  score += Math.min(emojiCount * EMOTIONAL_SCORES.EMOJI, EMOTIONAL_SCORES.EMOJI_CAP);

  // Repeated punctuation indicates strong emotion
  if (/[！!？?]{2,}/.test(content)) score += EMOTIONAL_SCORES.REPEATED_PUNCT;

  return Math.min(score, 1);
}

export function scoreIdentityRelevance(content: string): number {
  const lower = content.toLowerCase();
  let score = 0;

  // Identity keywords
  for (const signal of IDENTITY_SIGNALS) {
    if (lower.includes(signal)) score += IDENTITY_SCORES.KEYWORD;
  }

  // Personal pronouns (more common in identity-defining statements)
  const personalPronouns = (content.match(/[我你他她它]/g) ?? []).length;
  score += Math.min(personalPronouns * IDENTITY_SCORES.PRONOUN, IDENTITY_SCORES.PRONOUN_CAP);

  // Decisions and preferences are identity-defining
  if (lower.includes('決定') || lower.includes('選擇') || lower.includes('decide') || lower.includes('choose')) {
    score += IDENTITY_SCORES.DECISION;
  }

  // "我是" / "I am" statements are strong identity markers
  if (lower.includes('我是') || lower.includes('i am') || lower.includes("i'm")) {
    score += IDENTITY_SCORES.SELF_STATEMENT;
  }

  return Math.min(score, 1);
}

export function scorePracticalValue(content: string): number {
  const lower = content.toLowerCase();
  let score = PRACTICAL_SCORES.BASELINE;

  // Technical content (higher practical value)
  const techSignals = /(?:code|api|function|bug|error|config|設定|安裝|部署|指令|command|步驟|方法)/i;
  if (techSignals.test(content)) score += PRACTICAL_SCORES.TECH;

  // Instructions and how-tos
  if (lower.includes('步驟') || lower.includes('怎麼') || lower.includes('如何') ||
      lower.includes('how to') || lower.includes('step')) {
    score += PRACTICAL_SCORES.HOWTO;
  }

  // Factual content (numbers, dates, specific nouns)
  const hasNumbers = /\d{2,}/.test(content);
  if (hasNumbers) score += PRACTICAL_SCORES.NUMBER;

  const hasDate = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(content);
  if (hasDate) score += PRACTICAL_SCORES.DATE;

  // URLs and paths indicate reference material
  if (/https?:\/\/|\/[\w/.-]+/.test(content)) score += PRACTICAL_SCORES.URL;

  // Content length as proxy for information density
  if (content.length > 200) score += PRACTICAL_SCORES.LEN_200;
  if (content.length > 500) score += PRACTICAL_SCORES.LEN_500;

  return Math.min(score, 1);
}

export function scoreUniqueness(
  content: string,
  existingContents: string[],
): number {
  if (existingContents.length === 0) return 1; // first item is always unique

  // Check overlap with existing memories using text-relevance
  let maxOverlap = 0;
  for (const existing of existingContents) {
    const overlap = computeRelevance(content, existing);
    if (overlap > maxOverlap) maxOverlap = overlap;
  }

  // High overlap = low uniqueness
  // Use a steeper curve to penalize high overlap more
  return Math.max(0, 1 - maxOverlap * UNIQUENESS_OVERLAP_FACTOR);
}

export function computeQualityScore(
  content: string,
  existingContents: string[] = [],
): QualityScore {
  const emotional = scoreEmotionalResonance(content);
  const identity = scoreIdentityRelevance(content);
  const practical = scorePracticalValue(content);
  const uniqueness = scoreUniqueness(content, existingContents);

  const composite =
    EMOTIONAL_WEIGHT * emotional +
    IDENTITY_WEIGHT * identity +
    PRACTICAL_WEIGHT * practical +
    UNIQUENESS_WEIGHT * uniqueness;

  return { emotional, identity, practical, uniqueness, composite };
}

/**
 * Enhanced memory selection: combines existing token-cost-aware scoring
 * with quality dimensions for a more nuanced memory curation.
 *
 * @param baseScore - The original recency/frequency/importance score
 * @param qualityComposite - The 4-dimensional quality score (0-1)
 * @param qualityBlendRatio - How much weight to give quality (default 0.3 = 30%)
 * @returns Blended score combining both aspects
 */
export function qualityAdjustedScore(
  baseScore: number,
  qualityComposite: number,
  qualityBlendRatio: number = DEFAULT_QUALITY_BLEND,
): number {
  // Blend: 70% existing scoring + 30% quality
  return (1 - qualityBlendRatio) * baseScore + qualityBlendRatio * qualityComposite;
}
