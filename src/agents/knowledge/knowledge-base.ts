/**
 * Knowledge Base — persistent team knowledge for avoiding repeated mistakes.
 *
 * Architecture:
 *   - soul/knowledge/index.json — searchable metadata index (read on every query)
 *   - soul/knowledge/entries/kb-*.md — full knowledge entries (read on demand)
 *   - soul/knowledge/archive/ — archived/superseded entries
 *
 * Phase 1: manual write (MCP tools) + auto inject (buildWorkerSystemPrompt)
 * Phase 2 will add LLM-based extraction (Haiku) via addKnowledgeEntry() interface
 */

import { readFile, writeFile, rename, mkdir, unlink, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTodayString } from '../../core/timezone.js';
import { logger } from '../../core/logger.js';

// ── Paths ────────────────────────────────────────────────────────────

const KNOWLEDGE_DIR = join(process.cwd(), 'soul', 'knowledge');
const INDEX_PATH = join(KNOWLEDGE_DIR, 'index.json');
const ARCHIVE_DIR = join(KNOWLEDGE_DIR, 'archive');
const LOCK_PATH = INDEX_PATH + '.lock';
const LOCK_TIMEOUT_MS = 5000;

// ── Types ────────────────────────────────────────────────────────────

export type KnowledgeCategory =
  | 'agent-config'
  | 'deployment'
  | 'wsl-environment'
  | 'git-worktree'
  | 'pipeline'
  | 'mcp-tools'
  | 'api-integration'
  | 'performance'
  | 'security'
  | 'architecture'
  | 'other';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface KnowledgeIndexEntry {
  id: string;
  title: string;
  date: string;             // ISO date (YYYY-MM-DD)
  category: KnowledgeCategory;
  severity: Severity;
  tags: string[];            // max 10
  relatedAgents: string[];
  status: 'active' | 'archived' | 'superseded' | 'internalized';
  supersededBy?: string;
  internalizedTo?: string[];    // agent names that received this rule
  internalizedAt?: string;      // ISO timestamp of internalization
  file: string;              // relative path, e.g. "entries/kb-2026-02-26-001.md"
  preventionRule: string;    // one-liner for prompt injection
  scope: 'global' | 'targeted';  // CTO修改3: global = all agents, targeted = relatedAgents only
  hitCount?: number;         // number of times matched in queries
  lastHitAt?: string;        // ISO timestamp of last query match
}

export interface KnowledgeIndex {
  version: 1;
  entries: KnowledgeIndexEntry[];
  lastUpdated: string;
}

export interface AddKnowledgeInput {
  title: string;
  category: KnowledgeCategory;
  severity: Severity;
  tags: string[];
  relatedAgents?: string[];
  scope?: 'global' | 'targeted';
  problem: string;
  rootCause?: string;
  solution?: string;
  preventionRule: string;
  context?: string;
  sourceAgent?: string;
  sourceTaskId?: string;
}

// ── File Lock ────────────────────────────────────────────────────────
// CTO修改4: simple file lock for concurrent write protection

async function acquireLock(): Promise<boolean> {
  await mkdir(dirname(LOCK_PATH), { recursive: true });

  // Check if stale lock exists
  try {
    const lockStat = await stat(LOCK_PATH);
    const age = Date.now() - lockStat.mtimeMs;
    if (age > LOCK_TIMEOUT_MS) {
      // Stale lock — force release
      await unlink(LOCK_PATH).catch(() => {});
    } else {
      return false; // Lock held by another process
    }
  } catch {
    // No lock file — good
  }

  try {
    // O_CREAT | O_EXCL equivalent: writeFile with flag 'wx'
    await writeFile(LOCK_PATH, `${process.pid}:${Date.now()}`, { flag: 'wx' });
    return true;
  } catch {
    return false; // Another process grabbed it
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_PATH).catch(() => {});
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const maxRetries = 10;
  const retryDelay = 500;

  for (let i = 0; i < maxRetries; i++) {
    if (await acquireLock()) {
      try {
        return await fn();
      } finally {
        await releaseLock();
      }
    }
    await new Promise(r => setTimeout(r, retryDelay));
  }

  // Final attempt: force acquire (stale lock protection)
  await unlink(LOCK_PATH).catch(() => {});
  if (await acquireLock()) {
    try {
      return await fn();
    } finally {
      await releaseLock();
    }
  }

  throw new Error('Failed to acquire knowledge base lock after retries');
}

// ── Index CRUD ───────────────────────────────────────────────────────

export async function loadIndex(): Promise<KnowledgeIndex> {
  try {
    const raw = await readFile(INDEX_PATH, 'utf-8');
    return JSON.parse(raw) as KnowledgeIndex;
  } catch {
    return { version: 1, entries: [], lastUpdated: new Date().toISOString() };
  }
}

export async function saveIndex(index: KnowledgeIndex): Promise<void> {
  index.lastUpdated = new Date().toISOString();
  await mkdir(dirname(INDEX_PATH), { recursive: true });
  const tmpPath = join(dirname(INDEX_PATH), `.tmp-${randomUUID()}`);
  await writeFile(tmpPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, INDEX_PATH);
}

// ── Add Knowledge Entry ──────────────────────────────────────────────

export async function addKnowledgeEntry(input: AddKnowledgeInput): Promise<string> {
  return withLock(async () => {
    const index = await loadIndex();
    const today = getTodayString();

    // Generate ID: kb-YYYY-MM-DD-NNN
    const todayEntries = index.entries.filter(e => e.date === today);
    const seq = String(todayEntries.length + 1).padStart(3, '0');
    const id = `kb-${today}-${seq}`;

    // Build MD entry
    const tags = input.tags.slice(0, 10);
    const md = buildEntryMarkdown({
      id,
      title: input.title,
      date: today,
      category: input.category,
      severity: input.severity,
      tags,
      sourceAgent: input.sourceAgent ?? 'manual',
      sourceTaskId: input.sourceTaskId ?? 'manual',
      relatedAgents: input.relatedAgents ?? [],
      scope: input.scope ?? 'targeted',
      problem: input.problem,
      rootCause: input.rootCause,
      solution: input.solution,
      preventionRule: input.preventionRule,
      context: input.context,
    });

    // Write MD file (atomic)
    const relPath = `entries/${id}.md`;
    const fullPath = join(KNOWLEDGE_DIR, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    const tmpPath = join(dirname(fullPath), `.tmp-${randomUUID()}`);
    await writeFile(tmpPath, md, 'utf-8');
    await rename(tmpPath, fullPath);

    // Update index
    const entry: KnowledgeIndexEntry = {
      id,
      title: input.title,
      date: today,
      category: input.category,
      severity: input.severity,
      tags,
      relatedAgents: input.relatedAgents ?? [],
      status: 'active',
      file: relPath,
      preventionRule: input.preventionRule,
      scope: input.scope ?? 'targeted',
      hitCount: 0,
    };
    index.entries.push(entry);
    await saveIndex(index);

    await logger.info('KnowledgeBase', `Added: ${id} — ${input.title}`);
    return id;
  });
}

// ── Query Knowledge Base ─────────────────────────────────────────────

export async function queryKnowledgeBase(
  agentName: string,
  taskPrompt: string,
  maxChars: number = 1500,
): Promise<string> {
  const index = await loadIndex();
  const taskTags = extractQueryTags(taskPrompt);

  const scored = index.entries
    .filter(e => e.status === 'active')
    .map(e => ({
      entry: e,
      score: computeKBRelevance(e, agentName, taskTags),
    }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return '';

  // Update hit counts (fire-and-forget, non-blocking)
  updateHitCounts(scored.map(s => s.entry.id)).catch(() => {});

  return formatInjection(scored, maxChars);
}

// ── Scoring ──────────────────────────────────────────────────────────

export function computeKBRelevance(
  entry: KnowledgeIndexEntry,
  agentName: string,
  taskTags: string[],
): number {
  let score = 0;

  // CTO修改3: global scope → +0.3 for all agents
  if (entry.scope === 'global') {
    score += 0.3;
  }

  // ① Agent directly related → +0.5
  if (entry.relatedAgents.includes(agentName)) score += 0.5;
  // If targeted scope and agent not in relatedAgents, skip
  else if (entry.scope === 'targeted' && entry.relatedAgents.length > 0) return 0;

  // ② Tag overlap → proportional to overlap ratio, max +0.3
  if (taskTags.length > 0) {
    const overlap = entry.tags.filter(t =>
      taskTags.some(qt => t.includes(qt) || qt.includes(t)),
    ).length;
    score += (overlap / Math.max(taskTags.length, 1)) * 0.3;
  }

  // ③ Severity bonus
  const severityBonus: Record<Severity, number> = {
    LOW: 0,
    MEDIUM: 0.05,
    HIGH: 0.15,
    CRITICAL: 0.2,
  };
  score += severityBonus[entry.severity] ?? 0;

  return score;
}

// ── Tag Extraction ───────────────────────────────────────────────────

export function extractQueryTags(prompt: string): string[] {
  // Step 1: Remove prompt template sections
  const cleaned = prompt
    .replace(/^##\s+.+$/gm, '')       // Remove headings
    .replace(/\*\*.+?\*\*/g, '')       // Remove bold markers
    .replace(/```[\s\S]*?```/g, '')    // Remove code blocks
    .replace(/\|[^\n]*\|/g, '');       // Remove table rows

  // Step 2: Extract meaningful terms
  const cjk = cleaned.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  const latin = cleaned.match(/\b[a-z][a-z0-9_.-]{2,30}\b/gi) ?? [];

  // Step 3: Strict stopword filter (includes common prompt fragments)
  const stop = new Set([
    '請執行', '你的任務', '核心目標', '完成後', '注意事項',
    '重要提示', '以下是', '工作守則', '團隊成員', '背景工作',
    '代理人', '回報發現', '不要修改', '程式碼', '調查和報告',
    '權限範圍', '可讀取', '可寫入', '可執行', '的指令',
    'important', 'please', 'ensure', 'should', 'following',
    'must', 'agent', 'task', 'prompt', 'system', 'note',
    'the', 'and', 'for', 'with', 'this', 'that', 'from',
    'have', 'not', 'are', 'was', 'but', 'they', 'will',
    'can', 'has', 'had', 'been', 'you', 'your', 'use',
  ]);

  return [...new Set([...cjk, ...latin])]
    .filter(w => !stop.has(w.toLowerCase()))
    .slice(0, 10);
}

// ── Injection Format ─────────────────────────────────────────────────

function formatInjection(
  scored: Array<{ entry: KnowledgeIndexEntry; score: number }>,
  maxChars: number,
): string {
  const header = '## 前車之鑑（Knowledge Base）\n\n以下是團隊過去遇過的相關問題，請注意避免重蹈覆轍：\n';
  let result = header;

  for (const { entry } of scored) {
    const severityIcon = entry.severity === 'CRITICAL' || entry.severity === 'HIGH' ? '⚠' : 'ℹ';
    const line = `\n### ${severityIcon} [${entry.severity}] ${entry.title}\n**預防規則**: ${entry.preventionRule}\n`;

    if (result.length + line.length > maxChars) break;
    result += line;
  }

  return result;
}

// ── Hit Count Update ─────────────────────────────────────────────────

async function updateHitCounts(ids: string[]): Promise<void> {
  try {
    await withLock(async () => {
      const index = await loadIndex();
      const now = new Date().toISOString();
      for (const entry of index.entries) {
        if (ids.includes(entry.id)) {
          entry.hitCount = (entry.hitCount ?? 0) + 1;
          entry.lastHitAt = now;
        }
      }
      await saveIndex(index);
    });
  } catch (e) {
    await logger.debug('KnowledgeBase', `Hit count update non-fatal: ${(e as Error).message}`);
  }
}

// ── Archive Entry ────────────────────────────────────────────────────

export async function archiveEntry(id: string, reason?: string): Promise<{ archived: boolean; warning?: string }> {
  return withLock(async () => {
    const index = await loadIndex();
    const entry = index.entries.find(e => e.id === id);
    if (!entry) return { archived: false };
    if (entry.status !== 'active') return { archived: false };

    let warning: string | undefined;
    // CTO修改2: HIGH/CRITICAL entries cannot be auto-archived (only manual)
    // This function IS manual, so we allow it — but log the severity and warn the caller
    if (entry.severity === 'HIGH' || entry.severity === 'CRITICAL') {
      await logger.info('KnowledgeBase', `Archiving HIGH/CRITICAL entry ${id} (manual): ${reason ?? 'no reason'}`);
      warning = `⚠ 此條目為 ${entry.severity} 級別，已歸檔但建議確認是否確實已過時`;
    }

    entry.status = 'archived';

    // Move MD file to archive/
    try {
      const srcPath = join(KNOWLEDGE_DIR, entry.file);
      const archivePath = join(ARCHIVE_DIR, `${id}.md`);
      await mkdir(ARCHIVE_DIR, { recursive: true });
      const content = await readFile(srcPath, 'utf-8');
      const tmpPath = join(ARCHIVE_DIR, `.tmp-${randomUUID()}`);
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, archivePath);
      await unlink(srcPath).catch(() => {});
      entry.file = `archive/${id}.md`;
    } catch {
      // File move failed — status change will still be saved below
    }

    await saveIndex(index);
    await logger.info('KnowledgeBase', `Archived: ${id} — ${reason ?? 'manual'}`);
    return { archived: true, warning };
  });
}

// ── Get Entry ────────────────────────────────────────────────────────

export async function getEntry(id: string): Promise<string | null> {
  const index = await loadIndex();
  const entry = index.entries.find(e => e.id === id);
  if (!entry) return null;

  try {
    return await readFile(join(KNOWLEDGE_DIR, entry.file), 'utf-8');
  } catch {
    return null;
  }
}

// ── Build Entry Markdown ─────────────────────────────────────────────

function buildEntryMarkdown(opts: {
  id: string;
  title: string;
  date: string;
  category: KnowledgeCategory;
  severity: Severity;
  tags: string[];
  sourceAgent: string;
  sourceTaskId: string;
  relatedAgents: string[];
  scope: 'global' | 'targeted';
  problem: string;
  rootCause?: string;
  solution?: string;
  preventionRule: string;
  context?: string;
}): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${opts.id}`);
  lines.push(`title: "${opts.title}"`);
  lines.push(`date: ${opts.date}`);
  lines.push(`category: ${opts.category}`);
  lines.push(`severity: ${opts.severity}`);
  lines.push(`tags: [${opts.tags.join(', ')}]`);
  lines.push(`sourceAgent: ${opts.sourceAgent}`);
  lines.push(`sourceTaskId: ${opts.sourceTaskId}`);
  lines.push(`relatedAgents: [${opts.relatedAgents.join(', ')}]`);
  lines.push(`scope: ${opts.scope}`);
  lines.push(`supersedes: null`);
  lines.push(`status: active`);
  lines.push('---');
  lines.push('');
  lines.push('## Problem');
  lines.push('');
  lines.push(opts.problem);

  if (opts.rootCause) {
    lines.push('');
    lines.push('## Root Cause');
    lines.push('');
    lines.push(opts.rootCause);
  }

  if (opts.solution) {
    lines.push('');
    lines.push('## Solution');
    lines.push('');
    lines.push(opts.solution);
  }

  lines.push('');
  lines.push('## Prevention Rule');
  lines.push('');
  lines.push(`> ${opts.preventionRule}`);

  if (opts.context) {
    lines.push('');
    lines.push('## Context');
    lines.push('');
    lines.push(opts.context);
  }

  lines.push('');
  return lines.join('\n');
}
