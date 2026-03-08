/**
 * Markdown Skill System — Loader & Matcher
 *
 * Skills are Markdown files in soul/skills/ with YAML frontmatter.
 * They provide domain-specific instructions that get injected into
 * the Claude Code system prompt when a user message matches their triggers.
 *
 * This is a knowledge-level extension (complements TypeScript plugins):
 *   - TS Plugin = "I have a function that does X"  (command-driven)
 *   - MD Skill  = "I know how to think about X"    (knowledge-driven)
 */

import { readFile, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';

const SKILLS_DIR = join(process.cwd(), 'soul', 'skills');
const MAX_SKILL_INJECTION_CHARS = 8000;

// ── Types ───────────────────────────────────────────────────────────

export interface SkillMeta {
  name: string;
  description: string;
  file: string;
  keywords: string[];
  patterns: string[];
  priority: number;
  enabled: boolean;
  /** Skill category for classification */
  category: string;
  /** Version string for tracking changes */
  version: string;
  /** If set, this skill has been upgraded to a TypeScript plugin */
  upgradedToPlugin: string | null;
  /** Internal module dependencies */
  requiresModules: string[];
  /** Background agent dependencies */
  requiresAgents: string[];
  /** EventBus events that trigger this skill */
  triggersEvents: string[];
  /** Telegram commands that trigger this skill */
  triggersCommands: string[];
}

export interface MatchedSkill {
  meta: SkillMeta;
  body: string;
  /** Number of keyword hits */
  hits: number;
}

// ── Index (in-memory cache) ─────────────────────────────────────────

let skillIndex: SkillMeta[] = [];
let indexBuilt = false;

/**
 * Parse YAML-like frontmatter from a Markdown string.
 * Lightweight parser — no external YAML dependency.
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const yamlBlock = match[1]!;
  const body = match[2]!;
  const meta: Record<string, unknown> = {};

  // Simple line-by-line YAML parser (handles scalars and arrays)
  let currentKey = '';
  let currentArray: string[] | null = null;

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trimEnd();

    // Array item
    if (trimmed.startsWith('  - ') || trimmed.startsWith('    - ')) {
      if (currentArray) {
        currentArray.push(trimmed.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, ''));
      }
      continue;
    }

    // Flush previous array
    if (currentArray) {
      meta[currentKey] = currentArray;
      currentArray = null;
    }

    // Key: value
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      const value = rawValue!.trim();
      currentKey = key!;

      if (value === '' || value === '[]') {
        // Start of array or empty value
        currentArray = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array: [a, b, c]
        meta[currentKey] = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      } else if (value === 'true') {
        meta[currentKey] = true;
      } else if (value === 'false') {
        meta[currentKey] = false;
      } else if (/^\d+$/.test(value)) {
        meta[currentKey] = parseInt(value, 10);
      } else {
        meta[currentKey] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  // Flush last array
  if (currentArray) {
    meta[currentKey] = currentArray;
  }

  return { meta, body };
}

/**
 * Build the skill index by scanning soul/skills/*.md
 */
export async function buildSkillIndex(): Promise<void> {
  const skills: SkillMeta[] = [];

  try {
    const files = await readdir(SKILLS_DIR);
    const mdFiles = files.filter((f) => f.endsWith('.md') && !f.startsWith('_'));

    for (const file of mdFiles) {
      try {
        const content = await readFile(join(SKILLS_DIR, file), 'utf-8');
        const { meta } = parseFrontmatter(content);

        const skill: SkillMeta = {
          name: (meta.name as string) ?? file.replace('.md', ''),
          description: (meta.description as string) ?? '',
          file,
          keywords: Array.isArray(meta.keywords) ? meta.keywords as string[] : [],
          patterns: Array.isArray(meta.patterns) ? meta.patterns as string[] : [],
          priority: typeof meta.priority === 'number' ? meta.priority : 5,
          enabled: meta.enabled !== false,
          category: (meta.category as string) ?? 'general',
          version: (meta.version as string) ?? '1.0',
          upgradedToPlugin: (meta.upgraded_to_plugin as string) ?? null,
          requiresModules: Array.isArray(meta.requires_modules) ? meta.requires_modules as string[] : [],
          requiresAgents: Array.isArray(meta.requires_agents) ? meta.requires_agents as string[] : [],
          triggersEvents: Array.isArray(meta.triggers_events) ? meta.triggers_events as string[] : [],
          triggersCommands: Array.isArray(meta.triggers_commands) ? meta.triggers_commands as string[] : [],
        };

        if (skill.enabled && skill.keywords.length > 0) {
          skills.push(skill);
        }
      } catch (err) {
        await logger.warn('skill-loader', `Failed to parse skill: ${file}`, err);
      }
    }
  } catch {
    // soul/skills/ directory may not exist yet
    await logger.debug('skill-loader', 'soul/skills/ not found, no skills loaded');
  }

  skillIndex = skills;
  indexBuilt = true;
  await logger.info('skill-loader', `Skill index built: ${skills.length} skills loaded`);
}

/**
 * Match user message against skill triggers.
 * Returns matched skills sorted by (hits × priority), top N.
 */
export async function matchSkills(text: string, maxResults = 2): Promise<MatchedSkill[]> {
  await checkRebuildSignal();
  if (!indexBuilt) await buildSkillIndex();

  const lowerText = text.toLowerCase();
  const candidates: Array<{ meta: SkillMeta; hits: number }> = [];

  for (const skill of skillIndex) {
    let hits = 0;

    // Stage 0: command trigger (highest priority, direct match)
    if (skill.triggersCommands.length > 0) {
      const firstWord = lowerText.split(/\s/)[0] ?? '';
      for (const cmd of skill.triggersCommands) {
        if (firstWord === cmd.toLowerCase()) hits += 10;
      }
    }

    // Stage 1: keyword matching (word-boundary aware)
    for (const kw of skill.keywords) {
      const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|[\\s,.:;!?/()\\[\\]{}])${escaped}(?:$|[\\s,.:;!?/()\\[\\]{}])`, 'i');
      // For CJK keywords (no word boundaries), use includes
      const isCJK = /[\u4e00-\u9fff]/.test(kw);
      if (isCJK ? lowerText.includes(kw.toLowerCase()) : re.test(lowerText)) hits++;
    }

    if (hits === 0) continue;

    // Stage 2: regex pattern matching (bonus hits)
    for (const pat of skill.patterns) {
      try {
        if (new RegExp(pat, 'i').test(text)) hits += 2;
      } catch {
        // Invalid regex, skip
      }
    }

    candidates.push({ meta: skill, hits });
  }

  if (candidates.length === 0) return [];

  // Sort by (priority × hits) descending
  candidates.sort((a, b) => (b.hits * b.meta.priority) - (a.hits * a.meta.priority));

  // Load full body for top matches
  const results: MatchedSkill[] = [];
  for (const c of candidates.slice(0, maxResults)) {
    try {
      const content = await readFile(join(SKILLS_DIR, c.meta.file), 'utf-8');
      const { body: rawBody } = parseFrontmatter(content);
      let body = rawBody.trim();
      if (body.length > MAX_SKILL_INJECTION_CHARS) {
        logger.warn('skill-loader', `Skill ${c.meta.file} truncated (${body.length} → ${MAX_SKILL_INJECTION_CHARS})`);
        body = body.slice(0, MAX_SKILL_INJECTION_CHARS)
          + `\n\n[SKILL TRUNCATED: full content in soul/skills/${c.meta.file}]`;
      }
      results.push({ meta: c.meta, body, hits: c.hits });
    } catch {
      // Skip if file read fails
    }
  }

  // Track usage (non-blocking, non-critical)
  if (results.length > 0) {
    trackUsageAsync(results).catch(() => {});
  }

  return results;
}

/** Match skills by EventBus event name */
export async function matchSkillsByEvent(eventName: string): Promise<MatchedSkill[]> {
  if (!indexBuilt) await buildSkillIndex();

  const results: MatchedSkill[] = [];
  for (const skill of skillIndex) {
    if (skill.triggersEvents.some((e) => eventName.startsWith(e))) {
      try {
        const content = await readFile(join(SKILLS_DIR, skill.file), 'utf-8');
        const { body: rawBody } = parseFrontmatter(content);
        let body = rawBody.trim();
        if (body.length > MAX_SKILL_INJECTION_CHARS) {
          logger.warn('skill-loader', `Skill ${skill.file} truncated (${body.length} → ${MAX_SKILL_INJECTION_CHARS})`);
          body = body.slice(0, MAX_SKILL_INJECTION_CHARS)
            + `\n\n[SKILL TRUNCATED: full content in soul/skills/${skill.file}]`;
        }
        results.push({ meta: skill, body, hits: 1 });
      } catch {
        // Skip if file read fails
      }
    }
  }
  return results;
}

/** Get all loaded skill metadata */
export function getSkillIndex(): SkillMeta[] {
  return [...skillIndex];
}

/** Force rebuild index (e.g., after creating a new skill) */
export async function rebuildSkillIndex(): Promise<void> {
  indexBuilt = false;
  await buildSkillIndex();
}

// ── Usage tracking (non-blocking) ─────────────────────────

async function trackUsageAsync(results: MatchedSkill[]): Promise<void> {
  try {
    const { recordSkillUsage } = await import('./skill-usage-tracker.js');
    for (const r of results) {
      await recordSkillUsage(r.meta.name);
    }
  } catch {
    // Non-critical — tracker may not be available
  }
}

// ── Rebuild signal from MCP tools ─────────────────────────

const REBUILD_SIGNAL = join(SKILLS_DIR, '.rebuild');

/**
 * Check for .rebuild signal file written by MCP skill tools.
 * If found, trigger index rebuild and remove the signal.
 * Call this before matchSkills for near-instant skill hot-reload.
 */
async function checkRebuildSignal(): Promise<void> {
  try {
    await stat(REBUILD_SIGNAL);
    // Signal exists — rebuild and remove
    await logger.info('skill-loader', 'Rebuild signal detected, reloading skills...');
    await rebuildSkillIndex();
    try { await unlink(REBUILD_SIGNAL); } catch { /* already removed */ }
  } catch {
    // No signal file — nothing to do
  }
}
