/**
 * Proactive Pattern Observer — real-time pattern detection.
 *
 * Unlike pattern-detector.ts (batch, scans 200 history entries),
 * this module observes EVERY message in real-time and maintains
 * an incremental token frequency buffer.
 *
 * When a new cluster crosses the threshold, it immediately triggers
 * skill creation — no waiting for daily reflection.
 *
 * Design: "肌肉記憶" — learn while doing, not just during sleep.
 *
 * Integration: Listens to 'message:received' events via EventBus.
 */

import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';

// ── Configuration ───────────────────────────────────────────────────

/** Minimum messages in a cluster to trigger auto-skill */
const CLUSTER_THRESHOLD = 5;

/** Sliding window size (most recent N messages) */
const BUFFER_SIZE = 100;

/** Minimum Jaccard similarity to merge into a cluster */
const SIMILARITY_THRESHOLD = 0.3;

/** Cooldown between auto-creates (30 minutes) */
const AUTO_CREATE_COOLDOWN_MS = 30 * 60 * 1000;

/** Stop words (same as pattern-detector) */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
  'at', 'by', 'from', 'it', 'this', 'that', 'and', 'or', 'but', 'not',
  'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'me',
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '們',
  '有', '和', '就', '不', '都', '也', '要', '會', '可以', '這',
  '那', '一', '個', '上', '下', '到', '說', '把', '讓', '吧',
  '嗎', '呢', '啊', '喔', '好', '對', '很', '還', '再', '去',
]);

// ── Types ───────────────────────────────────────────────────────────

interface BufferEntry {
  text: string;
  tokens: string[];
  timestamp: number;
  userId: number;
}

interface LiveCluster {
  centroid: string[];
  entries: BufferEntry[];
  keywords: string[];
  lastUpdated: number;
  /** Set of skill names already created from this cluster */
  createdSkills: Set<string>;
}

// ── State ───────────────────────────────────────────────────────────

const buffer: BufferEntry[] = [];
const clusters: LiveCluster[] = [];
let lastAutoCreateTime = 0;
let handler: ((data: { chatId: number; userId: number; text: string }) => void) | null = null;

// ── Tokenization ────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  const words = lower.match(/[a-z]{2,}/g) ?? [];
  for (const w of words) {
    if (!STOP_WORDS.has(w)) tokens.push(w);
  }

  const chineseMatches = lower.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  for (const phrase of chineseMatches) {
    if (phrase.length >= 2) {
      for (let i = 0; i <= phrase.length - 2; i++) {
        const bigram = phrase.slice(i, i + 2);
        if (!STOP_WORDS.has(bigram)) tokens.push(bigram);
      }
    }
  }

  return tokens;
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Core Logic ──────────────────────────────────────────────────────

/**
 * Process a new message: add to buffer, assign to cluster, check threshold.
 */
async function observeMessage(userId: number, text: string): Promise<void> {
  // Skip very short messages (commands, confirmations)
  if (text.length < 5) return;

  const tokens = tokenize(text);
  if (tokens.length < 2) return;

  const entry: BufferEntry = {
    text: text.slice(0, 100),
    tokens,
    timestamp: Date.now(),
    userId,
  };

  // Add to sliding window buffer
  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) {
    buffer.shift();
  }

  // Assign to existing cluster or create new one
  let assigned = false;
  for (const cluster of clusters) {
    const sim = jaccardSimilarity(tokens, cluster.centroid);
    if (sim >= SIMILARITY_THRESHOLD) {
      cluster.entries.push(entry);
      cluster.lastUpdated = Date.now();
      // Update keywords
      cluster.keywords = extractTopKeywords(cluster.entries);
      assigned = true;

      // Check if this cluster crosses the threshold
      if (cluster.entries.length >= CLUSTER_THRESHOLD && cluster.createdSkills.size === 0) {
        await tryAutoCreateSkill(cluster);
      }
      break;
    }
  }

  if (!assigned) {
    clusters.push({
      centroid: tokens,
      entries: [entry],
      keywords: tokens.slice(0, 5),
      lastUpdated: Date.now(),
      createdSkills: new Set(),
    });
  }

  // Periodic cleanup: remove clusters older than 24h with < threshold entries
  cleanupStaleClusters();
}

/**
 * Extract top keywords from a cluster's entries.
 */
function extractTopKeywords(entries: BufferEntry[], max = 8): string[] {
  const freq = new Map<string, number>();
  for (const entry of entries) {
    const unique = new Set(entry.tokens);
    for (const token of unique) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([token]) => token);
}

/**
 * Remove clusters that are stale (>24h old with few entries).
 */
function cleanupStaleClusters(): void {
  const now = Date.now();
  const STALE_MS = 24 * 60 * 60 * 1000;

  for (let i = clusters.length - 1; i >= 0; i--) {
    const cluster = clusters[i]!;
    if (now - cluster.lastUpdated > STALE_MS && cluster.entries.length < CLUSTER_THRESHOLD) {
      clusters.splice(i, 1);
    }
  }
}

/**
 * Try to auto-create a skill from a cluster that crossed the threshold.
 */
async function tryAutoCreateSkill(cluster: LiveCluster): Promise<void> {
  const now = Date.now();

  // Cooldown check
  if (now - lastAutoCreateTime < AUTO_CREATE_COOLDOWN_MS) {
    return;
  }

  try {
    // Check if skill already exists for these keywords
    const patternDetector = await import('./pattern-detector.js');
    const fakePattern: import('./pattern-detector.js').DetectedPattern = {
      label: cluster.keywords.slice(0, 3).join('-'),
      keywords: cluster.keywords,
      frequency: cluster.entries.length,
      examples: cluster.entries.slice(0, 3).map((e) => e.text),
      firstSeen: new Date(cluster.entries[0]!.timestamp).toISOString(),
      lastSeen: new Date(cluster.entries[cluster.entries.length - 1]!.timestamp).toISOString(),
      suggestedWorkflow: '（即時偵測，工作流程待確認）',
      confidence: Math.min(cluster.entries.length / 10, 1),
    };

    const hasSkill = await patternDetector.patternHasSkill(fakePattern);
    if (hasSkill) {
      cluster.createdSkills.add('existing');
      return;
    }

    // Create skill via skill-auto-create
    const { evaluateAndCreateSkills } = await import('./skill-auto-create.js');
    const result = await evaluateAndCreateSkills();

    if (result.skillsCreated.length > 0) {
      lastAutoCreateTime = now;
      for (const name of result.skillsCreated) {
        cluster.createdSkills.add(name);
      }
      logger.info(
        'proactive-observer',
        `Real-time skill creation: ${result.skillsCreated.join(', ')} (cluster size: ${cluster.entries.length})`,
      );
    }
  } catch (err) {
    logger.warn('proactive-observer', 'Auto-create from real-time observation failed', err);
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Start the proactive observer. Listens to message:received events.
 */
export function startProactiveObserver(): void {
  handler = ({ userId, text }) => {
    observeMessage(userId, text).catch((err) => {
      logger.warn('proactive-observer', 'Observation error', err);
    });
  };

  eventBus.on('message:received', handler);
  logger.info('proactive-observer', 'Proactive pattern observer started');
}

/**
 * Stop the proactive observer.
 */
export function stopProactiveObserver(): void {
  if (handler) {
    eventBus.off('message:received', handler);
    handler = null;
  }
  logger.info('proactive-observer', 'Proactive pattern observer stopped');
}

/**
 * Get current cluster status (for debugging/monitoring).
 */
export function getClusterStatus(): { keywords: string[]; size: number; hasSkill: boolean }[] {
  return clusters.map((c) => ({
    keywords: c.keywords,
    size: c.entries.length,
    hasSkill: c.createdSkills.size > 0,
  }));
}
