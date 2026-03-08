/**
 * Knowledge Extractor — Phase 2 auto-extraction via Haiku LLM.
 *
 * After a task completes (or fails at significant cost), this module checks
 * whether the execution contains valuable lessons. If so, it uses Haiku to
 * structure the insight into a Knowledge Base entry automatically.
 */

import { logger } from '../../core/logger.js';
import { askClaudeCode } from '../../claude/claude-code.js';
import { addKnowledgeEntry } from './knowledge-base.js';
import type { AgentTask } from '../worker-scheduler.js';
import type { AgentConfig } from '../config/agent-config.js';
import type { KnowledgeCategory, Severity } from './knowledge-base.js';
import { config } from '../../config.js';

// ── Trigger Logic ─────────────────────────────────────────────────────

/**
 * Determines whether knowledge extraction should be triggered for a task.
 * Returns true if any of the 5 conditions are met.
 */
export function shouldExtractKnowledge(
  task: AgentTask,
  confidence: number,
  agentConfig: AgentConfig,
): boolean {
  // Condition 1: High retry count — struggled to complete
  if ((task.retryCount ?? 0) >= 2) return true;

  // Condition 2: Cost anomaly — spent >2x the per-task budget
  if (agentConfig.maxCostPerTask && task.costUsd > agentConfig.maxCostPerTask * 2) return true;

  // Condition 3: Low confidence — result uncertain but not total failure
  if (confidence < 0.6 && confidence >= 0.3) return true;

  // Condition 4: Execution trace contains a rejected phase
  if (task.trace?.some(t => t.phase === 'rejected')) return true;

  // Condition 5: Task prompt explicitly opts in to extraction
  if (task.prompt.includes('extractKnowledge: true')) return true;

  return false;
}

// ── Extraction Logic ──────────────────────────────────────────────────

/**
 * Uses Haiku LLM to extract a structured knowledge entry from task execution results.
 * Returns the knowledge entry ID if a valuable lesson was found, or null otherwise.
 * Errors are logged and suppressed — this must never block the main task flow.
 */
export async function extractAndDeposit(
  task: AgentTask,
  result: string,
  confidence: number,
  _agentConfig: AgentConfig,
  workerId: number,
): Promise<string | null> {
  const prompt = buildExtractionPrompt(task, result, confidence);

  const response = await askClaudeCode(prompt, workerId, {
    model: config.MODEL_TIER_HAIKU,
    maxTurns: 1,
    skipResume: true,
  });

  if (!response.ok) {
    logger.debug('KnowledgeExtractor', `Haiku call failed for task ${task.id}: ${response.error}`);
    return null;
  }

  const text = response.value.result ?? '';

  // Haiku may prefix/suffix the JSON with extra text — extract with regex
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    logger.debug('KnowledgeExtractor', `No JSON found in response for task ${task.id}`);
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch (e) {
    logger.debug('KnowledgeExtractor', `JSON parse failed for task ${task.id}: ${(e as Error).message}`);
    return null;
  }

  if (parsed.extract !== true) {
    return null;
  }

  const knowledgeId = await addKnowledgeEntry({
    title: String(parsed.title ?? 'Auto-extracted knowledge'),
    category: validateCategory(String(parsed.category ?? 'other')),
    severity: validateSeverity(String(parsed.severity ?? 'LOW')),
    tags: Array.isArray(parsed.tags) ? (parsed.tags as unknown[]).map(String) : [],
    relatedAgents: Array.isArray(parsed.relatedAgents)
      ? (parsed.relatedAgents as unknown[]).map(String)
      : [task.agentName],
    scope: parsed.scope === 'global' ? 'global' : 'targeted',
    problem: String(parsed.problem ?? ''),
    rootCause: parsed.rootCause ? String(parsed.rootCause) : undefined,
    solution: parsed.solution ? String(parsed.solution) : undefined,
    preventionRule: String(parsed.preventionRule ?? ''),
    sourceAgent: task.agentName,
    sourceTaskId: task.id,
  });

  return knowledgeId;
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildExtractionPrompt(task: AgentTask, result: string, confidence: number): string {
  const taskPromptPreview = task.prompt.slice(0, 500);
  const resultPreview = result.slice(0, 1000);

  return `你是知識萃取器。分析以下 agent 任務的執行結果，判斷是否有值得記錄的踩坑經驗。

## 任務資訊
- Agent: ${task.agentName}
- 任務: ${taskPromptPreview}
- 結果: ${resultPreview}
- 信心分數: ${confidence}
- 重試次數: ${task.retryCount ?? 0}
- 成本: $${task.costUsd.toFixed(4)}

## 判斷標準
只有以下情況才值得記錄：
1. 遇到了非預期的錯誤或陷阱
2. 發現了配置、環境、工具使用上的注意事項
3. 找到了更好的做法（反面教訓）

如果這是一個正常順利完成的任務，沒有特別的教訓，請回覆：{"extract": false}

如果有值得記錄的知識，請回覆 JSON：
{
  "extract": true,
  "title": "一句話標題",
  "category": "agent-config|deployment|wsl-environment|git-worktree|pipeline|mcp-tools|api-integration|performance|security|architecture|other",
  "severity": "LOW|MEDIUM|HIGH|CRITICAL",
  "tags": ["tag1", "tag2"],
  "relatedAgents": ["agent1"],
  "scope": "global|targeted",
  "problem": "問題描述",
  "rootCause": "根因分析",
  "solution": "解決方案",
  "preventionRule": "一句話預防規則"
}

只回覆 JSON，不要其他文字。`;
}

const VALID_CATEGORIES = new Set<string>([
  'agent-config', 'deployment', 'wsl-environment', 'git-worktree',
  'pipeline', 'mcp-tools', 'api-integration', 'performance',
  'security', 'architecture', 'other',
]);

function validateCategory(value: string): KnowledgeCategory {
  return VALID_CATEGORIES.has(value) ? (value as KnowledgeCategory) : 'other';
}

const VALID_SEVERITIES = new Set<string>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

function validateSeverity(value: string): Severity {
  return VALID_SEVERITIES.has(value) ? (value as Severity) : 'LOW';
}
