/**
 * Evolution Intention Recorder — captures the "why" before each molt.
 * Writes to soul/evolution/intentions.jsonl as an append-only stream.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import type { Goal } from './goals.js';

const INTENTIONS_PATH = join(process.cwd(), 'soul', 'evolution', 'intentions.jsonl');

export interface EvolutionIntention {
  timestamp: string;
  goalId: string;
  description: string;
  motivation: string;
  expectedOutcome: string;
  riskAssessment: string;
  complexity: 'low' | 'medium' | 'high';
  affectedAreas: string[];
  precedents: string[];
}

export function classifyComplexity(goal: Goal): 'low' | 'medium' | 'high' {
  const desc = goal.description.toLowerCase();
  const tags = goal.tags.map(t => t.toLowerCase());

  // High: core changes, refactoring, architecture
  if (
    desc.includes('refactor') || desc.includes('architecture') ||
    desc.includes('core') || desc.includes('重構') ||
    tags.includes('refactor') || tags.includes('core')
  ) {
    return 'high';
  }

  // Medium: new features, plugins, modules
  if (
    desc.includes('plugin') || desc.includes('add') || desc.includes('new') ||
    desc.includes('新增') || desc.includes('功能') ||
    tags.includes('feature') || tags.includes('new')
  ) {
    return 'medium';
  }

  return 'low';
}

export function inferAffectedAreas(goal: Goal): string[] {
  const desc = goal.description.toLowerCase();
  const areas: string[] = [];

  const patterns: Array<[string[], string]> = [
    [['plugin', '插件'], 'plugins'],
    [['core', 'src/core'], 'core'],
    [['lifecycle', 'heartbeat', '生命'], 'lifecycle'],
    [['memory', 'chat', '記憶'], 'memory'],
    [['identity', 'trait', '身份', '特質'], 'identity'],
    [['evolution', 'evolve', '演化', '進化'], 'evolution'],
    [['agent', 'worker', '代理'], 'agents'],
    [['metacognition', 'reflection', '反思'], 'metacognition'],
    [['telegram', 'bot', 'command'], 'telegram'],
    [['plan', '計劃'], 'planning'],
  ];

  for (const [keywords, area] of patterns) {
    if (keywords.some(k => desc.includes(k))) {
      areas.push(area);
    }
  }

  if (areas.length === 0) areas.push('general');
  return areas;
}

export async function findPrecedents(goal: Goal): Promise<string[]> {
  try {
    const raw = await readFile(INTENTIONS_PATH, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const past: EvolutionIntention[] = [];
    for (const line of lines) {
      try { past.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }

    const currentAreas = new Set(inferAffectedAreas(goal));
    return past
      .filter(p => p.affectedAreas.some(a => currentAreas.has(a)))
      .slice(-3)
      .map(p => p.goalId);
  } catch {
    return [];
  }
}

function buildMotivation(goal: Goal): string {
  const tags = goal.tags.map(t => t.toLowerCase());
  if (tags.includes('bug') || tags.includes('fix')) {
    return `修復問題：${goal.description}`;
  }
  if (tags.includes('feature') || tags.includes('new')) {
    return `新增能力：${goal.description}`;
  }
  if (tags.includes('refactor')) {
    return `改善結構：${goal.description}`;
  }
  return `成長目標：${goal.description}`;
}

function buildExpectedOutcome(goal: Goal): string {
  return `完成後，系統將具備：${goal.description}`;
}

function buildRiskAssessment(complexity: 'low' | 'medium' | 'high'): string {
  switch (complexity) {
    case 'high':
      return '高風險 — 可能影響核心模組，需要格外謹慎，失敗需立即回滾';
    case 'medium':
      return '中等風險 — 新增功能可能與現有系統有交互，注意整合測試';
    case 'low':
      return '低風險 — 局部修改，影響範圍有限';
  }
}

export async function recordIntention(goal: Goal): Promise<EvolutionIntention> {
  const complexity = classifyComplexity(goal);
  const affectedAreas = inferAffectedAreas(goal);
  const precedents = await findPrecedents(goal);

  const intention: EvolutionIntention = {
    timestamp: new Date().toISOString(),
    goalId: goal.id,
    description: goal.description,
    motivation: buildMotivation(goal),
    expectedOutcome: buildExpectedOutcome(goal),
    riskAssessment: buildRiskAssessment(complexity),
    complexity,
    affectedAreas,
    precedents,
  };

  await writer.appendJsonl(INTENTIONS_PATH, intention);

  await eventBus.emit('evolution:intention', {
    goalId: goal.id,
    complexity,
    motivation: intention.motivation,
  });

  // Write narrative entry
  try {
    const { appendNarrative } = await import('../identity/narrator.js');
    await appendNarrative('evolution',
      `準備演化「${goal.description}」— ${intention.riskAssessment}`,
      { significance: complexity === 'high' ? 4 : 3, emotion: '專注' },
    );
  } catch { /* non-critical */ }

  await logger.info('IntentionRecorder',
    `Recorded intention for ${goal.id}: ${complexity} complexity, areas=[${affectedAreas.join(',')}]`,
  );

  return intention;
}

export async function getRecentIntentions(n: number = 10): Promise<EvolutionIntention[]> {
  try {
    const raw = await readFile(INTENTIONS_PATH, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const entries: EvolutionIntention[] = [];
    for (const line of lines.slice(-n)) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return entries;
  } catch {
    return [];
  }
}
