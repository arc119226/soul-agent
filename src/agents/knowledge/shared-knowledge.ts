/**
 * Cross-Agent Knowledge Transfer — enables agents to share findings.
 *
 * Design:
 *   - JSONL append-only storage (soul/agent-tasks/shared-knowledge.jsonl)
 *   - Deposit: after task completion with confidence >= threshold
 *   - Query: keyword overlap + recency decay, with TTL filtering
 *   - Injection: into worker system prompt (max ~250 tokens)
 */

import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writer } from '../../core/debounced-writer.js';
import { logger } from '../../core/logger.js';

// ── Constants ────────────────────────────────────────────────────────

const KNOWLEDGE_PATH = join(process.cwd(), 'soul', 'agent-tasks', 'shared-knowledge.jsonl');
const DEFAULT_TTL_HOURS = 72;
const MAX_INJECTION_CHARS = 1000; // ~250 tokens (was 2000)
const RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000; // 24h

// Agent blacklist — 純操作記錄 agents，不存入共享知識
const DEPOSIT_BLACKLIST = new Set([
  'channel-op',
  'blog-publisher',
  'secretary',
]);

// Summary patterns indicating operational logs, not knowledge
const LOW_VALUE_PATTERNS = [
  /部署報告|部署成功|Deployment\s+successful/i,
  /已成功發送|發送.*成功|Cross-post.*成功/i,
  /PR\s*#?\d+.*merge|squash\s+merge/i,
  /hexo\s+generate|cloudflare.*deploy/i,
];

// In-memory cache of recent summaries per agent (for dedup, max 20 per agent)
const recentSummaries = new Map<string, string[]>();
const MAX_RECENT_PER_AGENT = 20;

// ── Types ────────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id: string;
  agentName: string;
  taskId: string;
  timestamp: string;
  summary: string;
  keywords: string[];
  importance: number; // 1-5
  category: 'finding' | 'insight' | 'warning' | 'trend';
  ttlHours: number;
}

// ── Deposit ──────────────────────────────────────────────────────────

/**
 * Deposit a knowledge entry after a successful task.
 * Extracts keywords and summary from the result text.
 */
export async function depositKnowledge(
  agentName: string,
  taskId: string,
  result: string,
  _prompt: string,
): Promise<void> {
  // Filter out purely operational agents
  if (DEPOSIT_BLACKLIST.has(agentName)) return;

  const summary = extractSummary(result);
  if (!summary) return; // Nothing meaningful to deposit

  // Filter out low-value operational log patterns
  if (LOW_VALUE_PATTERNS.some(p => p.test(summary))) return;

  // Near-duplicate detection — skip if too similar to recent entries from same agent
  const recent = recentSummaries.get(agentName) ?? [];
  if (recent.some(prev => summarySimilarity(prev, summary) > 0.7)) return;

  // Update recent cache
  recent.push(summary);
  if (recent.length > MAX_RECENT_PER_AGENT) recent.shift();
  recentSummaries.set(agentName, recent);

  const keywords = extractKeywords(summary);
  if (keywords.length === 0) return;

  const entry: KnowledgeEntry = {
    id: randomUUID(),
    agentName,
    taskId,
    timestamp: new Date().toISOString(),
    summary,
    keywords,
    importance: estimateImportance(result),
    category: categorize(result),
    ttlHours: DEFAULT_TTL_HOURS,
  };

  await writer.appendJsonl(KNOWLEDGE_PATH, entry);
  await logger.debug('SharedKnowledge', `Deposited: "${summary.slice(0, 60)}..." (${keywords.length} keywords)`);
}

// ── Query ────────────────────────────────────────────────────────────

/**
 * Query relevant knowledge for a given agent and prompt.
 * Returns formatted text ready for system prompt injection.
 */
export async function queryKnowledge(
  forAgent: string,
  prompt: string,
  maxChars: number = MAX_INJECTION_CHARS,
): Promise<string> {
  const entries = await loadValidEntries();
  if (entries.length === 0) return '';

  const queryKeywords = extractKeywords(prompt);

  // Score and rank
  const scored = entries
    .filter((e) => e.agentName !== forAgent) // Exclude self-referencing
    .map((e) => ({
      entry: e,
      score: computeRelevance(e, queryKeywords),
    }))
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return '';

  // Build injection text within budget
  const lines: string[] = [];
  let chars = 0;

  for (const { entry } of scored) {
    const line = `- [${entry.agentName}] ${entry.summary}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }

  if (lines.length === 0) return '';

  return `## 其他代理人的近期相關發現\n\n${lines.join('\n')}`;
}

// ── Internal: Scoring ────────────────────────────────────────────────

function computeRelevance(entry: KnowledgeEntry, queryKeywords: string[]): number {
  if (queryKeywords.length === 0) return 0;

  // Keyword overlap score
  const overlap = entry.keywords.filter((k) =>
    queryKeywords.some((qk) => k.includes(qk) || qk.includes(k)),
  ).length;
  const keywordScore = overlap / Math.max(queryKeywords.length, 1);

  // Recency decay (same formula as memory/scoring.ts)
  const age = Date.now() - new Date(entry.timestamp).getTime();
  const recency = age <= 0 ? 1 : Math.exp((-Math.LN2 * age) / RECENCY_HALF_LIFE_MS);

  // Importance weight
  const importanceWeight = entry.importance / 5;

  return keywordScore * 0.5 + recency * 0.3 + importanceWeight * 0.2;
}

// ── Internal: Extraction ─────────────────────────────────────────────

/** Extract a concise summary from result text (first meaningful heading/paragraph). */
function extractSummary(result: string): string {
  // Try to find an executive summary section
  const execMatch = result.match(/(?:##?\s*(?:摘要|執行摘要|Summary|Executive Summary|結論|Conclusion))\s*\n+([\s\S]*?)(?:\n##|\n---|\n\n\n|$)/i);
  if (execMatch?.[1]) {
    return execMatch[1].trim().slice(0, 300);
  }

  // Fall back to first non-empty paragraph
  const paragraphs = result.split(/\n{2,}/).filter((p) => p.trim().length > 20);
  if (paragraphs.length > 0 && paragraphs[0]) {
    return paragraphs[0].trim().slice(0, 300);
  }

  return result.trim().slice(0, 300);
}

/** Extract keywords from summary text (NOT full result, to avoid prompt template pollution). */
function extractKeywords(summary: string): string[] {
  const text = summary.toLowerCase();

  // Extract CJK terms (2-4 char sequences) + Latin terms (3+ chars)
  const cjkMatches = text.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];
  const latinMatches = text.match(/\b[a-z][a-z0-9_-]{2,20}\b/g) ?? [];

  // Deduplicate and filter stop words + prompt template fragments
  const stopWords = new Set([
    // English common
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'not',
    'are', 'was', 'but', 'they', 'will', 'can', 'has', 'had', 'been',
    'now', 'let', 'here', 'all', 'need', 'enough', 'material',
    // Chinese common
    '的', '是', '在', '了', '和', '有', '我', '不', '這', '個', '你', '他',
    '也', '到', '就', '說', '都', '會', '要', '把', '上', '下',
    // HANDOFF template fragments (the main pollution source)
    '上游任務', '交接', '上游', '交接類型', '產出類型', '摘要',
    '上游產出', '請執行你', '的例行任', '這是退回', '修正',
    '上限', '請根據上', '游的回饋', '修改後重', '新交付',
    '路徑',
  ]);

  const keywords = [...new Set([...cjkMatches, ...latinMatches])]
    .filter((w) => !stopWords.has(w))
    .slice(0, 15);

  return keywords;
}

/** Simple word-level Jaccard similarity. */
function summarySimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 && wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Estimate importance from text structure signals. */
function estimateImportance(result: string): number {
  let score = 2; // baseline
  if (/重要|critical|important|urgent|嚴重|安全|vulnerability/i.test(result)) score++;
  if (/發現|found|discover|trend|趨勢|洞見|insight/i.test(result)) score++;
  if (result.length > 2000) score++; // Substantial content
  return Math.min(score, 5);
}

/** Categorize the knowledge entry. */
function categorize(result: string): KnowledgeEntry['category'] {
  if (/warning|alert|漏洞|vulnerability|風險|risk/i.test(result)) return 'warning';
  if (/trend|趨勢|走勢|pattern/i.test(result)) return 'trend';
  if (/insight|洞見|分析|analysis/i.test(result)) return 'insight';
  return 'finding';
}

// ── Internal: Storage ────────────────────────────────────────────────

/** Load all non-expired entries from the JSONL file. */
async function loadValidEntries(): Promise<KnowledgeEntry[]> {
  const entries: KnowledgeEntry[] = [];
  const now = Date.now();

  try {
    const raw = await readFile(KNOWLEDGE_PATH, 'utf-8');
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as KnowledgeEntry;
        // TTL check
        const age = now - new Date(entry.timestamp).getTime();
        if (age < entry.ttlHours * 60 * 60 * 1000) {
          entries.push(entry);
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* file doesn't exist */ }

  return entries;
}

// ── Compaction ───────────────────────────────────────────────────────

/**
 * Remove expired entries from the JSONL file.
 * Called once per day from worker-scheduler's daily check.
 */
export async function compactKnowledge(): Promise<number> {
  let originalCount: number;
  try {
    const raw = await readFile(KNOWLEDGE_PATH, 'utf-8');
    const lines = raw.trim().split('\n').filter((l) => l.trim());
    originalCount = lines.length;
  } catch {
    return 0; // file doesn't exist
  }

  let valid = await loadValidEntries();

  // Deep clean: remove low-value operational records from historical data
  const beforeDeepClean = valid.length;
  valid = valid.filter(e => {
    // Remove blacklisted agents' entries
    if (DEPOSIT_BLACKLIST.has(e.agentName)) return false;
    // Remove low-importance findings (importance <= 2 AND category = finding)
    if (e.importance <= 2 && e.category === 'finding') return false;
    // Remove entries matching low-value patterns
    if (LOW_VALUE_PATTERNS.some(p => p.test(e.summary))) return false;
    return true;
  });

  const removed = originalCount - valid.length;
  if (removed <= 0) return 0;

  const compacted = valid.map((e) => JSON.stringify(e)).join('\n') + (valid.length > 0 ? '\n' : '');
  await writeFile(KNOWLEDGE_PATH, compacted, 'utf-8');
  await logger.info('SharedKnowledge', `Compacted: removed ${removed} entries (${beforeDeepClean - valid.length} deep-clean + ${originalCount - beforeDeepClean} expired), ${valid.length} retained`);
  return removed;
}
