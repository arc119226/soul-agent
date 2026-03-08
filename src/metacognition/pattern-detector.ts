/**
 * Pattern Detector — analyze narrative and chat memory to detect
 * repeating user queries that could be automated as Markdown Skills.
 *
 * Core insight (Arc): "一回生二回熟" — repeated work should be
 * captured as skills, then eventually compiled into plugins.
 *
 * Data flow:
 *   narrative.jsonl (interactions) + chat-memory (topics)
 *     → detectRepeatingPatterns()
 *     → skill-auto-create → soul/skills/{name}.md
 */

import { getRecentNarrative } from '../identity/narrator.js';
import { logger } from '../core/logger.js';

// ── Types ───────────────────────────────────────────────────────────

export interface DetectedPattern {
  /** Cluster label derived from common keywords */
  label: string;
  /** Keywords extracted from the cluster */
  keywords: string[];
  /** How many times this pattern appeared in the window */
  frequency: number;
  /** Representative messages from the cluster */
  examples: string[];
  /** When the pattern was first seen */
  firstSeen: string;
  /** When the pattern was last seen */
  lastSeen: string;
  /** Estimated workflow based on the messages */
  suggestedWorkflow: string;
  /** Confidence score 0-1 */
  confidence: number;
}

// ── Configuration ───────────────────────────────────────────────────

/** Minimum occurrences to be considered a repeating pattern */
const MIN_FREQUENCY = 5;

/** How many narrative entries to scan (most recent) */
const SCAN_WINDOW = 200;

/** Minimum Jaccard similarity to consider two messages "similar" */
const SIMILARITY_THRESHOLD = 0.3;

/** Stop words to ignore when tokenizing (中英混合) */
const STOP_WORDS = new Set([
  // English
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
  'at', 'by', 'from', 'it', 'this', 'that', 'and', 'or', 'but', 'not',
  'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'me',
  // Chinese common
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '們',
  '有', '和', '就', '不', '都', '也', '要', '會', '可以', '這',
  '那', '一', '個', '上', '下', '到', '說', '把', '讓', '吧',
  '嗎', '呢', '啊', '喔', '好', '對', '很', '還', '再', '去',
]);

// ── Tokenization ────────────────────────────────────────────────────

/**
 * Tokenize a message into meaningful words.
 * Handles both English words and Chinese characters.
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // English words
  const words = lower.match(/[a-z]{2,}/g) ?? [];
  for (const w of words) {
    if (!STOP_WORDS.has(w)) tokens.push(w);
  }

  // Chinese characters and short phrases (2-4 char sequences between punctuation)
  const chineseMatches = lower.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  for (const phrase of chineseMatches) {
    // Extract non-overlapping 2-grams for Chinese (stride=2 to avoid cross-word garbage)
    if (phrase.length >= 2) {
      for (let i = 0; i <= phrase.length - 2; i += 2) {
        const bigram = phrase.slice(i, i + 2);
        if (!STOP_WORDS.has(bigram)) tokens.push(bigram);
      }
    }
  }

  return tokens;
}

/**
 * Jaccard similarity between two token sets.
 */
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

// ── Clustering ──────────────────────────────────────────────────────

interface TokenizedEntry {
  text: string;
  tokens: string[];
  timestamp: string;
}

/**
 * Simple greedy clustering: assign each entry to the first cluster
 * with similarity >= threshold, or create a new cluster.
 */
function clusterMessages(entries: TokenizedEntry[]): TokenizedEntry[][] {
  const clusters: TokenizedEntry[][] = [];

  for (const entry of entries) {
    let assigned = false;
    for (const cluster of clusters) {
      // Compare against cluster centroid (first entry)
      const centroid = cluster[0]!;
      const sim = jaccardSimilarity(entry.tokens, centroid.tokens);
      if (sim >= SIMILARITY_THRESHOLD) {
        cluster.push(entry);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push([entry]);
    }
  }

  return clusters;
}

/**
 * Extract representative keywords from a cluster.
 * Returns the most frequent tokens across all entries.
 */
function extractKeywords(cluster: TokenizedEntry[], maxKeywords = 8): string[] {
  const freq = new Map<string, number>();
  for (const entry of cluster) {
    const unique = new Set(entry.tokens);
    for (const token of unique) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .filter(([, count]) => count >= 2) // appears in at least 2 messages
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([token]) => token)
    .filter(kw => {
      // English: at least 3 chars (filters out overly generic "ai", "ml", etc.)
      if (/^[a-z0-9]+$/i.test(kw)) return kw.length >= 3;
      // CJK/other: at least 2 chars (filters out single-char fragments)
      return kw.length >= 2;
    });
}

/**
 * Generate a cluster label from top keywords.
 */
function generateLabel(keywords: string[]): string {
  return keywords.slice(0, 3).join('-') || 'unknown-pattern';
}

/**
 * Infer a workflow suggestion based on message content.
 */
function inferWorkflow(entries: TokenizedEntry[]): string {
  const allText = entries.map((e) => e.text).join(' ').toLowerCase();

  // Heuristic rules for common patterns
  if (/新聞|news|hacker|hn/.test(allText)) {
    return '1. 使用 web_search 搜尋相關新聞\n2. 篩選最重要的 5 條\n3. 為每條生成摘要\n4. 格式化回覆';
  }
  if (/天氣|weather|溫度/.test(allText)) {
    return '1. 從訊息提取城市名\n2. 使用 web_fetch 查詢天氣 API\n3. 格式化天氣資訊回覆';
  }
  if (/翻譯|translate/.test(allText)) {
    return '1. 偵測源語言\n2. 翻譯為目標語言\n3. 附加語境說明';
  }
  if (/摘要|summarize|summary/.test(allText)) {
    return '1. 使用 web_fetch 取得內容\n2. 分析並提取重點\n3. 生成結構化摘要';
  }
  if (/查|search|搜/.test(allText)) {
    return '1. 使用 web_search 搜尋相關資訊\n2. 篩選最相關的結果\n3. 整理並回覆';
  }

  // Generic fallback
  return `1. 分析用戶需求\n2. 使用適當的工具處理\n3. 格式化結果回覆\n\n（此工作流程需要根據實際使用情況調整）`;
}

// ── Main API ────────────────────────────────────────────────────────

/**
 * Detect repeating patterns in recent user interactions.
 *
 * Scans narrative.jsonl for 'interaction' entries, clusters similar
 * messages, and returns patterns that appear >= MIN_FREQUENCY times.
 */
export async function detectRepeatingPatterns(): Promise<DetectedPattern[]> {
  // 1. Load recent narrative entries
  const entries = await getRecentNarrative(SCAN_WINDOW);
  const interactions = entries.filter(
    (e) => e.type === 'interaction' && e.related_to,
  );

  if (interactions.length < MIN_FREQUENCY) {
    return [];
  }

  // 2. Tokenize all interaction messages
  const tokenized: TokenizedEntry[] = interactions.map((e) => ({
    text: e.related_to ?? e.summary,
    tokens: tokenize(e.related_to ?? e.summary),
    timestamp: e.timestamp,
  }));

  // 3. Cluster similar messages
  const clusters = clusterMessages(tokenized);

  // 4. Filter to frequent clusters and build patterns
  const patterns: DetectedPattern[] = [];

  for (const cluster of clusters) {
    if (cluster.length < MIN_FREQUENCY) continue;

    const keywords = extractKeywords(cluster);
    if (keywords.length === 0) continue;

    const timestamps = cluster.map((e) => e.timestamp).sort();
    const examples = cluster
      .slice(0, 5)
      .map((e) => e.text);

    // Confidence: based on cluster size relative to total and keyword strength
    const sizeRatio = cluster.length / interactions.length;
    const keywordStrength = Math.min(keywords.length / 5, 1);
    const confidence = Math.min(sizeRatio * 2 + keywordStrength * 0.5, 1);

    patterns.push({
      label: generateLabel(keywords),
      keywords,
      frequency: cluster.length,
      examples,
      firstSeen: timestamps[0]!,
      lastSeen: timestamps[timestamps.length - 1]!,
      suggestedWorkflow: inferWorkflow(cluster),
      confidence,
    });
  }

  // Sort by frequency descending
  patterns.sort((a, b) => b.frequency - a.frequency);

  if (patterns.length > 0) {
    await logger.info(
      'pattern-detector',
      `Detected ${patterns.length} repeating pattern(s): ${patterns.map((p) => `"${p.label}" (${p.frequency}x)`).join(', ')}`,
    );
  }

  return patterns;
}

/**
 * Check if a detected pattern already has a corresponding skill.
 */
export async function patternHasSkill(pattern: DetectedPattern): Promise<boolean> {
  try {
    const { getSkillIndex } = await import('../skills/skill-loader.js');
    const skills = getSkillIndex();

    // Check if any existing skill covers this pattern's keywords
    for (const skill of skills) {
      const skillKeywords = new Set(skill.keywords.map((k) => k.toLowerCase()));
      const overlap = pattern.keywords.filter((k) => skillKeywords.has(k));
      // If >50% keyword overlap, consider it covered
      if (overlap.length >= pattern.keywords.length * 0.5) {
        return true;
      }
    }
  } catch {
    // skill-loader not available
  }

  return false;
}
