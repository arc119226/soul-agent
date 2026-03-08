/**
 * Prompt Optimizer — auto-internalize high-value KB rules into agent systemPrompts.
 *
 * Follows the same pattern as budget-optimizer.ts and agent-tuner.ts:
 *   Load config → check lock → compute → save via saveAgentConfig() → log
 *
 * Called by knowledge-lifecycle.ts Phase 4 during daily review.
 */

import { logger } from '../../core/logger.js';
import { writer } from '../../core/debounced-writer.js';
import { join } from 'node:path';
import {
  loadIndex,
  saveIndex,
  type KnowledgeIndexEntry,
} from './knowledge-base.js';
import {
  loadAgentConfig,
  loadAllAgentConfigs,
  saveAgentConfig,
} from '../config/agent-config.js';

// ── Constants ────────────────────────────────────────────────────────

const SECTION_MARKER = '## 內化經驗';
const SECTION_INTRO = '以下是你從過去任務中學到的教訓，已成為你的工作習慣：';
const MAX_RULES_PER_AGENT = 20;
const INTERNALIZATION_LOG_PATH = join(process.cwd(), 'soul', 'knowledge', 'internalization-log.jsonl');

// ── Types ────────────────────────────────────────────────────────────

export interface InternalizeResult {
  internalized: string[];   // KB entry IDs that were internalized
  skipped: string[];        // KB entry IDs skipped (lock, duplicate, etc.)
  errors: string[];         // error messages
}

// ── Core Function ────────────────────────────────────────────────────

/**
 * Internalize promotion candidates into target agents' systemPrompts.
 * Called by knowledge-lifecycle.ts Phase 4 during daily review.
 */
export async function internalizePromotionCandidates(
  candidateIds: string[],
): Promise<InternalizeResult> {
  const result: InternalizeResult = {
    internalized: [],
    skipped: [],
    errors: [],
  };

  if (candidateIds.length === 0) return result;

  const index = await loadIndex();
  const allConfigs = await loadAllAgentConfigs();
  const enabledAgents = allConfigs.filter(c => c.enabled !== false);

  for (const kbId of candidateIds) {
    const entry = index.entries.find(e => e.id === kbId);
    if (!entry || entry.status !== 'active') {
      result.skipped.push(kbId);
      continue;
    }

    // Determine target agents
    const targetNames = (entry.scope === 'global' || entry.relatedAgents.length === 0)
      ? enabledAgents.map(c => c.name)
      : entry.relatedAgents;

    const internalizedTo: string[] = [];

    for (const agentName of targetNames) {
      try {
        const cfg = await loadAgentConfig(agentName);
        if (!cfg) continue;

        // Check lock
        if (cfg.promptLocked) {
          await logger.debug('PromptOptimizer', `Skipped ${agentName}: promptLocked`);
          continue;
        }

        // Check duplicate
        if (cfg.systemPrompt?.includes(`[${kbId}]`)) {
          continue; // Already internalized
        }

        // Build rule line
        const ruleLine = `- [${kbId}] ${entry.preventionRule}`;

        // Upsert section
        const newPrompt = upsertInternalizedSection(cfg.systemPrompt ?? '', ruleLine);

        // Check cap — count existing rules
        const ruleCount = countInternalizedRules(newPrompt);
        if (ruleCount > MAX_RULES_PER_AGENT) {
          // Trim to top 20 by removing oldest (first) rules
          cfg.systemPrompt = trimInternalizedRules(newPrompt, MAX_RULES_PER_AGENT);
        } else {
          cfg.systemPrompt = newPrompt;
        }

        await saveAgentConfig(cfg);
        internalizedTo.push(agentName);
      } catch (e) {
        const msg = `Error internalizing ${kbId} to ${agentName}: ${(e as Error).message}`;
        result.errors.push(msg);
        await logger.warn('PromptOptimizer', msg);
      }
    }

    if (internalizedTo.length > 0) {
      // Update KB entry
      entry.status = 'internalized';
      entry.internalizedTo = internalizedTo;
      entry.internalizedAt = new Date().toISOString();
      result.internalized.push(kbId);

      await logger.info('PromptOptimizer',
        `Internalized ${kbId} "${entry.title}" → ${internalizedTo.length} agents: ${internalizedTo.join(', ')}`);

      // Audit log
      await writer.appendJsonl(INTERNALIZATION_LOG_PATH, {
        action: 'internalize',
        kbId,
        title: entry.title,
        agents: internalizedTo,
        timestamp: new Date().toISOString(),
      });
    } else if (internalizedTo.length === 0) {
      result.skipped.push(kbId);
    }
  }

  // Save index once (batch update)
  await saveIndex(index);

  return result;
}

// ── Reverse Operation ────────────────────────────────────────────────

/**
 * Remove an internalized rule from an agent's systemPrompt and revert KB entry to active.
 */
export async function uninternalizeRule(kbId: string, agentName: string): Promise<boolean> {
  const cfg = await loadAgentConfig(agentName);
  if (!cfg?.systemPrompt) return false;

  const rulePattern = new RegExp(`^- \\[${kbId}\\].*$`, 'm');
  if (!rulePattern.test(cfg.systemPrompt)) return false;

  cfg.systemPrompt = cfg.systemPrompt.replace(rulePattern, '').replace(/\n{3,}/g, '\n\n');

  // Clean up empty section
  if (cfg.systemPrompt.includes(SECTION_MARKER) && countInternalizedRules(cfg.systemPrompt) === 0) {
    const markerIdx = cfg.systemPrompt.indexOf(SECTION_MARKER);
    cfg.systemPrompt = cfg.systemPrompt.slice(0, markerIdx).trimEnd();
  }

  await saveAgentConfig(cfg);

  // Update KB entry — remove agent from internalizedTo, revert to active if empty
  const index = await loadIndex();
  const entry = index.entries.find(e => e.id === kbId);
  if (entry) {
    entry.internalizedTo = (entry.internalizedTo ?? []).filter(n => n !== agentName);
    if (entry.internalizedTo.length === 0) {
      entry.status = 'active';
      entry.internalizedAt = undefined;
    }
    await saveIndex(index);
  }

  await logger.info('PromptOptimizer', `Un-internalized ${kbId} from ${agentName}`);

  await writer.appendJsonl(INTERNALIZATION_LOG_PATH, {
    action: 'uninternalize',
    kbId,
    agent: agentName,
    timestamp: new Date().toISOString(),
  });

  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Insert or append a rule to the '## 內化經驗' section in systemPrompt. */
export function upsertInternalizedSection(systemPrompt: string, newRule: string): string {
  const markerIdx = systemPrompt.indexOf(SECTION_MARKER);
  if (markerIdx === -1) {
    // First time: append section to end
    return systemPrompt.trimEnd() + '\n\n' + SECTION_MARKER + '\n\n' + SECTION_INTRO + '\n' + newRule;
  }
  // Existing section: find end boundary (next ## or EOF)
  const afterMarker = markerIdx + SECTION_MARKER.length;
  const nextSectionIdx = systemPrompt.indexOf('\n## ', afterMarker);
  const insertPoint = nextSectionIdx === -1 ? systemPrompt.length : nextSectionIdx;
  return systemPrompt.slice(0, insertPoint).trimEnd() + '\n' + newRule + systemPrompt.slice(insertPoint);
}

/** Count internalized rule lines in the systemPrompt. */
export function countInternalizedRules(systemPrompt: string): number {
  const matches = systemPrompt.match(/^- \[kb-[^\]]+\] .+$/gm);
  return matches ? matches.length : 0;
}

/** Trim internalized rules to maxCount by keeping only the last N (newest). */
function trimInternalizedRules(systemPrompt: string, maxCount: number): string {
  const markerIdx = systemPrompt.indexOf(SECTION_MARKER);
  if (markerIdx === -1) return systemPrompt;

  const afterMarker = markerIdx + SECTION_MARKER.length;
  const nextSectionIdx = systemPrompt.indexOf('\n## ', afterMarker);
  const sectionEnd = nextSectionIdx === -1 ? systemPrompt.length : nextSectionIdx;

  const sectionContent = systemPrompt.slice(markerIdx, sectionEnd);
  const rules = sectionContent.match(/^- \[kb-[^\]]+\] .+$/gm) ?? [];

  if (rules.length <= maxCount) return systemPrompt;

  // Keep last N rules (newest are appended last)
  const kept = rules.slice(-maxCount);
  const newSection = SECTION_MARKER + '\n\n' + SECTION_INTRO + '\n' + kept.join('\n');

  const beforeSection = systemPrompt.slice(0, markerIdx);
  const afterSection = systemPrompt.slice(sectionEnd);
  return beforeSection + newSection + afterSection;
}
