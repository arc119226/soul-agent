/**
 * Skill Effectiveness Tracker — measures how well skills perform.
 *
 * Tracks proxy signals for skill quality:
 * 1. Follow-up rate: Does the user ask follow-up questions after skill activation?
 *    - Low follow-up = skill was comprehensive (GOOD)
 *    - High follow-up = skill was insufficient (BAD)
 * 2. Topic switch rate: Does the user change topic after skill activation?
 *    - Quick topic switch = skill answered the question (GOOD)
 *    - Lingering on same topic = skill didn't fully answer (NEUTRAL)
 * 3. Explicit feedback: "good", "thanks", "不對", "錯了" etc.
 *
 * Persists to soul/skills/.effectiveness.json
 *
 * Integration: Called from feedback-loop after message:sent events.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';

const EFFECTIVENESS_PATH = join(process.cwd(), 'soul', 'skills', '.effectiveness.json');

// ── Types ───────────────────────────────────────────────────────────

export interface SkillEffectiveness {
  /** Total number of activations tracked */
  activations: number;
  /** Number of times user gave positive signal after activation */
  positiveSignals: number;
  /** Number of times user gave negative signal after activation */
  negativeSignals: number;
  /** Number of follow-up questions within 5 minutes */
  followUpCount: number;
  /** Computed effectiveness score (0.0–1.0) */
  score: number;
  /** Last updated */
  lastUpdated: string;
}

interface EffectivenessFile {
  version: number;
  skills: Record<string, SkillEffectiveness>;
}

// ── Feedback detection patterns ─────────────────────────────────────

const POSITIVE_PATTERNS = [
  /^(thanks|thx|ty|謝|感謝|good|great|perfect|nice|讚|太好了|很好|不錯|ok|可以)/i,
  /👍|💯|✅|🎉|❤️/,
];

const NEGATIVE_PATTERNS = [
  /^(wrong|bad|不對|錯了|不是|有誤|不行|重來|再試)/i,
  /👎|❌|😡|🤔/,
  /但是.*不對|不是.*我要的|搞錯了/,
];

const FOLLOWUP_PATTERNS = [
  /^(還有|另外|那|然後|接著|再|可以|能不能)/,
  /[?？]$/,
  /怎麼|如何|什麼|為什麼|哪/,
];

// ── State ───────────────────────────────────────────────────────────

let data: EffectivenessFile | null = null;

/** Track which skills were activated recently (for correlating feedback) */
interface RecentActivation {
  skillNames: string[];
  timestamp: number;
  chatId: number;
}

const recentActivations: RecentActivation[] = [];

/** Window to correlate user feedback with skill activation (5 minutes) */
const CORRELATION_WINDOW_MS = 5 * 60 * 1000;

// ── Persistence ─────────────────────────────────────────────────────

async function load(): Promise<EffectivenessFile> {
  if (data) return data;
  try {
    const raw = await readFile(EFFECTIVENESS_PATH, 'utf-8');
    data = JSON.parse(raw) as EffectivenessFile;
  } catch {
    data = { version: 1, skills: {} };
  }
  return data;
}

function persist(): void {
  if (!data) return;
  writer.schedule(EFFECTIVENESS_PATH, data);
}

function computeScore(stat: SkillEffectiveness): number {
  if (stat.activations === 0) return 0.5; // neutral default

  const positiveRate = stat.positiveSignals / stat.activations;
  const negativeRate = stat.negativeSignals / stat.activations;
  const followUpRate = stat.followUpCount / stat.activations;

  // Score formula:
  // - Positive signals boost score
  // - Negative signals reduce score
  // - Low follow-up rate is slightly positive (skill was sufficient)
  const score = 0.5
    + positiveRate * 0.3    // max +0.3
    - negativeRate * 0.4    // max -0.4
    - followUpRate * 0.1;   // max -0.1

  return Math.max(0, Math.min(1, score));
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Record that skills were activated for a message.
 * Call this after matchSkills() returns results.
 */
export async function recordActivation(skillNames: string[], chatId: number): Promise<void> {
  if (skillNames.length === 0) return;

  const d = await load();
  const now = new Date().toISOString();

  for (const name of skillNames) {
    if (!d.skills[name]) {
      d.skills[name] = {
        activations: 0,
        positiveSignals: 0,
        negativeSignals: 0,
        followUpCount: 0,
        score: 0.5,
        lastUpdated: now,
      };
    }
    d.skills[name]!.activations++;
    d.skills[name]!.lastUpdated = now;
    d.skills[name]!.score = computeScore(d.skills[name]!);
  }

  // Track for feedback correlation
  recentActivations.push({
    skillNames,
    timestamp: Date.now(),
    chatId,
  });

  // Cleanup old activations
  const cutoff = Date.now() - CORRELATION_WINDOW_MS;
  while (recentActivations.length > 0 && recentActivations[0]!.timestamp < cutoff) {
    recentActivations.shift();
  }

  persist();
}

/**
 * Analyze a user's follow-up message for effectiveness signals.
 * Call this for EVERY user message to detect feedback patterns.
 */
export async function analyzeUserFeedback(chatId: number, text: string): Promise<void> {
  // Find recent activations for this chat
  const cutoff = Date.now() - CORRELATION_WINDOW_MS;
  const relevantActivations = recentActivations.filter(
    (a) => a.chatId === chatId && a.timestamp > cutoff,
  );

  if (relevantActivations.length === 0) return;

  const d = await load();
  const affectedSkills = new Set<string>();

  for (const activation of relevantActivations) {
    for (const name of activation.skillNames) {
      affectedSkills.add(name);
    }
  }

  // Check for positive signals
  const isPositive = POSITIVE_PATTERNS.some((p) => p.test(text));
  if (isPositive) {
    for (const name of affectedSkills) {
      if (d.skills[name]) {
        d.skills[name]!.positiveSignals++;
        d.skills[name]!.score = computeScore(d.skills[name]!);
        d.skills[name]!.lastUpdated = new Date().toISOString();
      }
    }
    persist();
    return; // Positive signal found, no need to check further
  }

  // Check for negative signals
  const isNegative = NEGATIVE_PATTERNS.some((p) => p.test(text));
  if (isNegative) {
    for (const name of affectedSkills) {
      if (d.skills[name]) {
        d.skills[name]!.negativeSignals++;
        d.skills[name]!.score = computeScore(d.skills[name]!);
        d.skills[name]!.lastUpdated = new Date().toISOString();
      }
    }
    persist();
    return;
  }

  // Check for follow-up questions
  const isFollowUp = FOLLOWUP_PATTERNS.some((p) => p.test(text));
  if (isFollowUp) {
    for (const name of affectedSkills) {
      if (d.skills[name]) {
        d.skills[name]!.followUpCount++;
        d.skills[name]!.score = computeScore(d.skills[name]!);
        d.skills[name]!.lastUpdated = new Date().toISOString();
      }
    }
    persist();
  }
}

/**
 * Get effectiveness data for a specific skill.
 */
export async function getEffectiveness(skillName: string): Promise<SkillEffectiveness | null> {
  const d = await load();
  return d.skills[skillName] ?? null;
}

/**
 * Get all effectiveness data.
 */
export async function getAllEffectiveness(): Promise<Record<string, SkillEffectiveness>> {
  const d = await load();
  return { ...d.skills };
}

/**
 * Get skills that are performing well (high score + sufficient activations).
 * These are good candidates for Plugin upgrade.
 */
export async function getHighPerformers(minActivations = 10, minScore = 0.65): Promise<string[]> {
  const d = await load();
  return Object.entries(d.skills)
    .filter(([, stat]) => stat.activations >= minActivations && stat.score >= minScore)
    .sort((a, b) => b[1].score - a[1].score)
    .map(([name]) => name);
}

/**
 * Get skills that are performing poorly (low score + sufficient activations).
 * These might need modification or deletion.
 */
export async function getLowPerformers(minActivations = 5, maxScore = 0.35): Promise<string[]> {
  const d = await load();
  return Object.entries(d.skills)
    .filter(([, stat]) => stat.activations >= minActivations && stat.score <= maxScore)
    .sort((a, b) => a[1].score - b[1].score)
    .map(([name]) => name);
}

/** Reset cache (for testing) */
export function resetCache(): void {
  data = null;
}
