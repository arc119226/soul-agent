/**
 * Skill Usage Tracker — record how often each Markdown skill is matched,
 * and detect candidates for Plugin upgrade.
 *
 * Persists to soul/skills/.usage-stats.json.
 * Integrates with matchSkills() to track every activation.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { getSkillIndex } from './skill-loader.js';

const STATS_PATH = join(process.cwd(), 'soul', 'skills', '.usage-stats.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ── Types ───────────────────────────────────────────────────────────

export interface SkillUsageStat {
  totalCount: number;
  weeklyCount: number;
  weekStart: string;
  lastUsed: string;
  createdAt: string;
}

interface UsageStatsFile {
  version: number;
  stats: Record<string, SkillUsageStat>;
}

// ── State ───────────────────────────────────────────────────────────

let statsData: UsageStatsFile | null = null;

async function load(): Promise<UsageStatsFile> {
  if (statsData) return statsData;
  try {
    const raw = await readFile(STATS_PATH, 'utf-8');
    statsData = JSON.parse(raw) as UsageStatsFile;
  } catch {
    statsData = { version: 1, stats: {} };
  }
  return statsData;
}

function persist(): void {
  if (!statsData) return;
  writer.schedule(STATS_PATH, statsData);
}

// ── Core API ────────────────────────────────────────────────────────

/**
 * Record a skill activation.
 * Call this after matchSkills() returns results.
 */
export async function recordSkillUsage(skillName: string): Promise<void> {
  const data = await load();
  const now = new Date().toISOString();

  const existing = data.stats[skillName];
  if (existing) {
    // Reset weekly count if week has passed
    const weekStart = new Date(existing.weekStart).getTime();
    if (Date.now() - weekStart > WEEK_MS) {
      existing.weeklyCount = 0;
      existing.weekStart = now;
    }

    existing.totalCount++;
    existing.weeklyCount++;
    existing.lastUsed = now;
  } else {
    data.stats[skillName] = {
      totalCount: 1,
      weeklyCount: 1,
      weekStart: now,
      lastUsed: now,
      createdAt: now,
    };
  }

  persist();
}

/**
 * Get usage stats for a specific skill.
 */
export async function getSkillUsage(skillName: string): Promise<SkillUsageStat | null> {
  const data = await load();
  return data.stats[skillName] ?? null;
}

/**
 * Get all usage stats.
 */
export async function getAllUsageStats(): Promise<Record<string, SkillUsageStat>> {
  const data = await load();
  return { ...data.stats };
}

/**
 * Prune ghost entries — remove usage stats for skills whose files no longer exist.
 * Called during upgrade checks to keep stats clean.
 */
export async function pruneGhostEntries(): Promise<number> {
  const data = await load();
  const liveNames = new Set(getSkillIndex().map((s) => s.name));
  let removed = 0;

  for (const name of Object.keys(data.stats)) {
    if (!liveNames.has(name)) {
      delete data.stats[name];
      removed++;
    }
  }

  if (removed > 0) {
    persist();
    await logger.info('skill-usage', `Pruned ${removed} ghost entry/entries from usage stats`);
  }

  return removed;
}

/**
 * Upgrade threshold — weekly count above which a skill should
 * be considered for Plugin compilation.
 */
const UPGRADE_THRESHOLD_WEEKLY = 20;
const UPGRADE_THRESHOLD_TOTAL = 50;

export interface UpgradeSuggestion {
  skillName: string;
  reason: string;
  weeklyCount: number;
  totalCount: number;
  /** Estimated monthly token savings (rough) */
  estimatedMonthlySaving: number;
  priority: 'high' | 'medium';
}

/** Categories that should never be suggested for Plugin upgrade (decision/thinking guides). */
const EXCLUDED_CATEGORIES = new Set(['system']);

/**
 * Check which skills should be upgraded to TypeScript Plugins.
 *
 * Filters out:
 * - Ghost skills (usage stats exist but .md file is deleted)
 * - Skills already upgraded to a Plugin (upgraded_to_plugin field)
 * - Core thinking guides (category in EXCLUDED_CATEGORIES)
 */
export async function getUpgradeSuggestions(): Promise<UpgradeSuggestion[]> {
  const data = await load();
  const suggestions: UpgradeSuggestion[] = [];

  // Build a lookup from the live skill index
  const skillMap = new Map(getSkillIndex().map((s) => [s.name, s]));

  for (const [name, stat] of Object.entries(data.stats)) {
    // ── Filter: ghost skill (file no longer exists or disabled) ──
    const meta = skillMap.get(name);
    if (!meta) {
      logger.debug('skill-usage', `Skipping ghost skill: ${name} (file missing or disabled)`);
      continue;
    }

    // ── Filter: already upgraded to Plugin ──
    if (meta.upgradedToPlugin) {
      logger.debug('skill-usage', `Skipping ${name}: already upgraded to plugin "${meta.upgradedToPlugin}"`);
      continue;
    }

    // ── Filter: excluded category (core thinking guides) ──
    if (EXCLUDED_CATEGORIES.has(meta.category)) {
      logger.debug('skill-usage', `Skipping ${name}: category "${meta.category}" excluded from upgrades`);
      continue;
    }

    // Reset stale weekly counts
    const weekStart = new Date(stat.weekStart).getTime();
    if (Date.now() - weekStart > WEEK_MS) {
      stat.weeklyCount = 0;
      stat.weekStart = new Date().toISOString();
    }

    if (stat.weeklyCount >= UPGRADE_THRESHOLD_WEEKLY) {
      suggestions.push({
        skillName: name,
        reason: `高頻使用（${stat.weeklyCount} 次/週）`,
        weeklyCount: stat.weeklyCount,
        totalCount: stat.totalCount,
        estimatedMonthlySaving: stat.weeklyCount * 4 * 0.003, // ~$0.003 per skill invocation
        priority: 'high',
      });
    } else if (stat.totalCount >= UPGRADE_THRESHOLD_TOTAL) {
      suggestions.push({
        skillName: name,
        reason: `累積使用多（${stat.totalCount} 次總計）`,
        weeklyCount: stat.weeklyCount,
        totalCount: stat.totalCount,
        estimatedMonthlySaving: stat.weeklyCount * 4 * 0.003,
        priority: 'medium',
      });
    }
  }

  if (suggestions.length > 0) {
    await logger.info(
      'skill-usage',
      `${suggestions.length} skill(s) suggested for upgrade: ${suggestions.map((s) => s.skillName).join(', ')}`,
    );
  }

  return suggestions.sort((a, b) => b.weeklyCount - a.weeklyCount);
}

/** Reset cache (for testing) */
export function resetCache(): void {
  statsData = null;
}
