/**
 * Skill Auto-Create — automatically create Markdown skills
 * when repeating patterns are detected in user interactions.
 *
 * This is the bridge between pattern-detector and the skill system:
 *   detectRepeatingPatterns() → evaluateAndCreateSkills() → soul/skills/{name}.md
 *
 * Triggered by daily reflection or manual invocation.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import {
  detectRepeatingPatterns,
  patternHasSkill,
  type DetectedPattern,
} from './pattern-detector.js';
import { appendNarrative } from '../identity/narrator.js';
import { addInsight } from './learning-tracker.js';
import { logger } from '../core/logger.js';

const SKILLS_DIR = join(process.cwd(), 'soul', 'skills');
const REBUILD_SIGNAL = join(SKILLS_DIR, '.rebuild');

/** Minimum confidence to auto-create a skill */
const MIN_CONFIDENCE = 0.5;

/** Maximum skills to auto-create per evaluation cycle */
const MAX_AUTO_CREATE_PER_CYCLE = 2;

// ── Helpers ─────────────────────────────────────────────────────────

/** Generate a valid skill name from a pattern label */
function toSkillName(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
    || `auto-skill-${Date.now().toString(36)}`;
}

/** Convert Chinese keywords to English-safe skill name */
function generateSkillName(keywords: string[]): string {
  // Try to use English keywords first
  const english = keywords.filter((k) => /^[a-z0-9-]+$/i.test(k));
  if (english.length >= 2) {
    return toSkillName(english.slice(0, 3).join('-'));
  }

  // Fallback: use label-style name
  const label = keywords.slice(0, 3).join('-');
  return `auto-${toSkillName(label) || Date.now().toString(36)}`;
}

/** Atomic write */
async function atomicWrite(fullPath: string, content: string): Promise<void> {
  const dir = dirname(fullPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, fullPath);
}

/** Signal skill-loader to rebuild index */
async function signalRebuild(): Promise<void> {
  try {
    await writeFile(REBUILD_SIGNAL, new Date().toISOString(), 'utf-8');
  } catch { /* non-critical */ }
}

/** Build Markdown skill content from a pattern */
function buildSkillFromPattern(pattern: DetectedPattern, name: string): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${name}`);
  lines.push(`description: 自動學習：${pattern.label}（偵測到 ${pattern.frequency} 次重複）`);
  lines.push('keywords:');
  for (const kw of pattern.keywords) {
    lines.push(`  - ${kw}`);
  }
  lines.push('priority: 5');
  lines.push('enabled: true');
  lines.push('category: auto-learned');
  lines.push('version: "1.0"');
  lines.push('---');
  lines.push('');
  lines.push(`# ${pattern.label}`);
  lines.push('');
  lines.push('> 此技能由模式偵測系統自動創建，基於用戶的重複查詢。');
  lines.push('');
  lines.push('## 觸發情境');
  lines.push('');
  lines.push('用戶提出以下類似的請求時：');
  for (const ex of pattern.examples.slice(0, 3)) {
    lines.push(`- 「${ex}」`);
  }
  lines.push('');
  lines.push('## 建議工作流程');
  lines.push('');
  lines.push(pattern.suggestedWorkflow);
  lines.push('');
  lines.push('## 注意事項');
  lines.push('');
  lines.push('- 此技能是自動生成的，工作流程可能需要手動調整');
  lines.push('- 如果效果不好，可以用 `update_skill` 修改或 `delete_skill` 刪除');
  lines.push(`- 首次偵測：${pattern.firstSeen}`);
  lines.push(`- 信心度：${(pattern.confidence * 100).toFixed(0)}%`);

  return lines.join('\n');
}

// ── Main API ────────────────────────────────────────────────────────

export interface AutoCreateResult {
  /** Patterns evaluated */
  patternsDetected: number;
  /** Skills actually created */
  skillsCreated: string[];
  /** Patterns skipped (already has skill or low confidence) */
  skipped: Array<{ label: string; reason: string }>;
}

/**
 * Evaluate detected patterns and auto-create skills for qualifying ones.
 *
 * Call this from daily reflection or heartbeat.
 * Returns a summary of what was created.
 */
export async function evaluateAndCreateSkills(): Promise<AutoCreateResult> {
  const result: AutoCreateResult = {
    patternsDetected: 0,
    skillsCreated: [],
    skipped: [],
  };

  // 1. Detect patterns
  const patterns = await detectRepeatingPatterns();
  result.patternsDetected = patterns.length;

  if (patterns.length === 0) {
    return result;
  }

  await logger.info(
    'skill-auto-create',
    `Evaluating ${patterns.length} pattern(s) for skill creation`,
  );

  let created = 0;

  for (const pattern of patterns) {
    // Guard: max per cycle
    if (created >= MAX_AUTO_CREATE_PER_CYCLE) break;

    // Guard: minimum confidence
    if (pattern.confidence < MIN_CONFIDENCE) {
      result.skipped.push({
        label: pattern.label,
        reason: `信心度不足 (${(pattern.confidence * 100).toFixed(0)}% < ${MIN_CONFIDENCE * 100}%)`,
      });
      continue;
    }

    // Guard: keyword quality — filter too-short keywords
    const validKeywords = pattern.keywords.filter(kw => {
      if (/^[a-z0-9]+$/i.test(kw)) return kw.length >= 3;
      return kw.length >= 2;
    });
    if (validKeywords.length < 2) {
      result.skipped.push({
        label: pattern.label,
        reason: 'insufficient valid keywords after quality filter',
      });
      continue;
    }

    // Guard: already has a skill
    const hasSkill = await patternHasSkill(pattern);
    if (hasSkill) {
      result.skipped.push({
        label: pattern.label,
        reason: '已有對應技能',
      });
      continue;
    }

    // Generate name and check existing file confidence
    const name = generateSkillName(validKeywords);
    const skillPath = join(SKILLS_DIR, `${name}.md`);
    try {
      const existing = await readFile(skillPath, 'utf-8');
      // Extract existing confidence from frontmatter/content
      const confMatch = existing.match(/信心度：(\d+(\.\d+)?)%?/);
      const existingConf = confMatch ? parseFloat(confMatch[1]!) / 100 : 1.0; // manual skills default 1.0
      if (pattern.confidence <= existingConf) {
        result.skipped.push({
          label: pattern.label,
          reason: `existing skill has higher confidence (${(existingConf * 100).toFixed(0)}% >= ${(pattern.confidence * 100).toFixed(0)}%)`,
        });
        continue;
      }
      // Higher confidence → allow upgrade
      await logger.info(
        'skill-auto-create',
        `Upgrading skill ${name}: confidence ${(existingConf * 100).toFixed(0)}% → ${(pattern.confidence * 100).toFixed(0)}%`,
      );
    } catch {
      // File doesn't exist — can create
    }

    // Use quality-filtered keywords
    pattern.keywords = validKeywords;

    // Create the skill
    try {
      const content = buildSkillFromPattern(pattern, name);
      await atomicWrite(skillPath, content);
      result.skillsCreated.push(name);
      created++;

      await logger.info(
        'skill-auto-create',
        `Created skill "${name}" from pattern "${pattern.label}" (${pattern.frequency}x, confidence ${(pattern.confidence * 100).toFixed(0)}%)`,
      );

      // Record in narrative
      await appendNarrative(
        'milestone',
        `學會了新技能「${name}」：偵測到 ${pattern.frequency} 次重複的「${pattern.label}」模式`,
        {
          significance: 3,
          emotion: '成長',
          related_to: name,
        },
      );

      // Record as learning insight
      await addInsight(
        `自動學習：從 ${pattern.frequency} 次重複查詢中，建立了「${name}」技能`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logger.warn(
        'skill-auto-create',
        `Failed to create skill "${name}": ${msg}`,
      );
      result.skipped.push({
        label: pattern.label,
        reason: `創建失敗: ${msg}`,
      });
    }
  }

  // Signal rebuild if any skills were created
  if (result.skillsCreated.length > 0) {
    await signalRebuild();
  }

  return result;
}
