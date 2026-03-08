/**
 * Narrative Analyzer — search, filter, and extract statistics from narrative history.
 *
 * Builds on narrator.ts (which provides basic CRUD + search) by adding:
 *   - Date-range queries (including archived data)
 *   - Aggregate statistics (type distribution, emotion trends, activity patterns)
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NarrativeEntry } from './narrator.js';

const NARRATIVE_PATH = join(process.cwd(), 'soul', 'narrative.jsonl');
const ARCHIVE_DIR = join(process.cwd(), 'soul', 'narrative-archive');

// ── Types ──────────────────────────────────────────────────────────

export interface NarrativeStats {
  totalEntries: number;
  byType: Record<string, number>;
  byEmotion: Record<string, number>;
  byDayOfWeek: Record<string, number>;
  byHour: Record<string, number>;
  avgSignificance: number;
  dateRange: { from: string; to: string };
}

// ── Core helpers ───────────────────────────────────────────────────

/** Parse a JSONL file into NarrativeEntry[] */
async function parseJsonl(path: string): Promise<NarrativeEntry[]> {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        try { return JSON.parse(line) as NarrativeEntry; }
        catch { return null; }
      })
      .filter((e): e is NarrativeEntry => e !== null);
  } catch {
    return [];
  }
}

/** Load all narrative entries (active + archived) */
async function loadAllEntries(): Promise<NarrativeEntry[]> {
  const entries: NarrativeEntry[] = [];

  // Load archive files
  try {
    const archiveFiles = await readdir(ARCHIVE_DIR);
    const jsonlFiles = archiveFiles.filter((f) => f.endsWith('.jsonl')).sort();
    for (const file of jsonlFiles) {
      const archived = await parseJsonl(join(ARCHIVE_DIR, file));
      entries.push(...archived);
    }
  } catch {
    // Archive dir may not exist
  }

  // Load active narrative
  const active = await parseJsonl(NARRATIVE_PATH);
  entries.push(...active);

  return entries;
}

// ── Public API ─────────────────────────────────────────────────────

/** Get entries within a date range (inclusive, format: YYYY-MM-DD) */
export async function getNarrativeByDate(date: string): Promise<NarrativeEntry[]> {
  const all = await loadAllEntries();
  return all.filter((e) => e.timestamp.startsWith(date));
}

/** Get entries within a date range (inclusive) */
export async function getNarrativeByRange(from: string, to: string): Promise<NarrativeEntry[]> {
  const all = await loadAllEntries();
  return all.filter((e) => {
    const d = e.timestamp.slice(0, 10);
    return d >= from && d <= to;
  });
}

/** Full-text search across all narrative entries (active + archived) */
export async function searchAllNarrative(
  keyword: string,
  limit: number = 20,
): Promise<NarrativeEntry[]> {
  const all = await loadAllEntries();
  const lower = keyword.toLowerCase();
  return all
    .filter((e) => e.summary.toLowerCase().includes(lower))
    .slice(-limit);
}

/** Compute aggregate statistics */
export async function getNarrativeStats(): Promise<NarrativeStats> {
  const all = await loadAllEntries();

  const stats: NarrativeStats = {
    totalEntries: all.length,
    byType: {},
    byEmotion: {},
    byDayOfWeek: {},
    byHour: {},
    avgSignificance: 0,
    dateRange: { from: '', to: '' },
  };

  if (all.length === 0) return stats;

  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  let sigSum = 0;

  for (const entry of all) {
    // Type distribution
    stats.byType[entry.type] = (stats.byType[entry.type] ?? 0) + 1;

    // Emotion distribution
    if (entry.emotion) {
      stats.byEmotion[entry.emotion] = (stats.byEmotion[entry.emotion] ?? 0) + 1;
    }

    // Day of week (Taipei time)
    try {
      const d = new Date(entry.timestamp);
      const taipeiDay = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const dayName = dayNames[taipeiDay.getDay()]!;
      stats.byDayOfWeek[dayName] = (stats.byDayOfWeek[dayName] ?? 0) + 1;

      // Hour distribution
      const hour = taipeiDay.getHours().toString().padStart(2, '0');
      stats.byHour[hour] = (stats.byHour[hour] ?? 0) + 1;
    } catch { /* skip */ }

    sigSum += entry.significance ?? 3;
  }

  stats.avgSignificance = sigSum / all.length;
  stats.dateRange.from = all[0]!.timestamp.slice(0, 10);
  stats.dateRange.to = all[all.length - 1]!.timestamp.slice(0, 10);

  return stats;
}

/** Format stats for Telegram display */
export function formatStats(stats: NarrativeStats): string {
  const lines: string[] = [
    `📊 *Narrative 統計*`,
    ``,
    `📝 總條目: ${stats.totalEntries}`,
    `📅 時間範圍: ${stats.dateRange.from} ~ ${stats.dateRange.to}`,
    `⭐ 平均重要性: ${stats.avgSignificance.toFixed(1)}/5`,
    ``,
  ];

  // Type breakdown
  const typeEntries = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);
  if (typeEntries.length > 0) {
    lines.push(`── 類型分布 ──`);
    for (const [type, count] of typeEntries) {
      const pct = ((count / stats.totalEntries) * 100).toFixed(0);
      lines.push(`  ${type}: ${count} (${pct}%)`);
    }
    lines.push(``);
  }

  // Emotion breakdown (top 5)
  const emotionEntries = Object.entries(stats.byEmotion).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (emotionEntries.length > 0) {
    lines.push(`── 情緒分布 (Top 5) ──`);
    for (const [emotion, count] of emotionEntries) {
      lines.push(`  ${emotion}: ${count}`);
    }
    lines.push(``);
  }

  // Day of week
  const dayEntries = Object.entries(stats.byDayOfWeek);
  if (dayEntries.length > 0) {
    lines.push(`── 星期分布 ──`);
    const ordered = ['一', '二', '三', '四', '五', '六', '日'];
    for (const day of ordered) {
      const count = stats.byDayOfWeek[day] ?? 0;
      if (count > 0) {
        const bar = '█'.repeat(Math.min(Math.round(count / 2), 15));
        lines.push(`  週${day} ${bar} ${count}`);
      }
    }
  }

  return lines.join('\n');
}
