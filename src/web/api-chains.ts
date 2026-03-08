/**
 * API handlers for task chain visualization and agent workload.
 *
 * Endpoints:
 *   GET /api/agents/workload        → Agent-centric workload overview
 *   GET /api/agents/:name/tasks     → Single agent's task list
 *   GET /api/agents/:name/config    → Agent configuration (incl. systemPrompt)
 *   PUT /api/agents/:name/config    → Update agent configuration
 *   GET /api/agents/flowmap         → HANDOFF flow statistics between agents
 *   GET /api/chains/:rootId         → Full chain tree for a root task
 */

import { getDb } from '../core/database.js';
import { logger } from '../core/logger.js';

// ── Agent Workload ──────────────────────────────────────────────────

export interface AgentWorkloadItem {
  name: string;
  label: string;
  role: string;
  enabled: boolean;
  running: number;
  pending: number;
  completedToday: number;
  costToday: number;
  avgDurationMs: number;
  currentTasks: Array<{ id: string; status: string; prompt: string; createdAt: string; source?: string }>;
}

export async function gatherAgentWorkload(): Promise<AgentWorkloadItem[]> {
  try {
    const { loadAllAgentConfigs } = await import('../agents/config/agent-config.js');
    const { agentLabel } = await import('../agents/config/agent-labels.js');
    const configs = await loadAllAgentConfigs();

    const db = getDb();

    // Running/pending counts per agent
    const activeRows = db.prepare(`
      SELECT agent_name,
             SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM agent_tasks
      WHERE status IN ('running', 'pending')
      GROUP BY agent_name
    `).all() as Array<{ agent_name: string; running: number; pending: number }>;

    // Today's completed + cost
    const todayRows = db.prepare(`
      SELECT agent_name,
             COUNT(*) as completed_today,
             SUM(cost_usd) as cost_today
      FROM agent_tasks
      WHERE status = 'completed' AND completed_at > date('now')
      GROUP BY agent_name
    `).all() as Array<{ agent_name: string; completed_today: number; cost_today: number }>;

    // Current running/pending task details (for the cards)
    const currentTasks = db.prepare(`
      SELECT id, agent_name, status, SUBSTR(prompt, 1, 120) as prompt, created_at, source
      FROM agent_tasks
      WHERE status IN ('running', 'pending')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at ASC
    `).all() as Array<{ id: string; agent_name: string; status: string; prompt: string; created_at: string; source: string | null }>;

    const activeMap = new Map(activeRows.map(r => [r.agent_name, r]));
    const todayMap = new Map(todayRows.map(r => [r.agent_name, r]));
    const tasksByAgent = new Map<string, typeof currentTasks>();
    for (const t of currentTasks) {
      if (!tasksByAgent.has(t.agent_name)) tasksByAgent.set(t.agent_name, []);
      tasksByAgent.get(t.agent_name)!.push(t);
    }

    return configs.map(cfg => {
      const active = activeMap.get(cfg.name);
      const today = todayMap.get(cfg.name);
      const tasks = tasksByAgent.get(cfg.name) ?? [];
      return {
        name: cfg.name,
        label: agentLabel(cfg.name),
        role: cfg.role ?? 'general',
        enabled: cfg.enabled,
        running: active?.running ?? 0,
        pending: active?.pending ?? 0,
        completedToday: today?.completed_today ?? 0,
        costToday: today?.cost_today ?? 0,
        avgDurationMs: cfg.avgDurationMs ?? 0,
        currentTasks: tasks.map(t => ({
          id: t.id,
          status: t.status,
          prompt: t.prompt,
          createdAt: t.created_at,
          source: t.source ?? undefined,
        })),
      };
    });
  } catch (err) {
    logger.warn('API-Chains', 'gatherAgentWorkload failed', err);
    return [];
  }
}

// ── Agent Tasks ─────────────────────────────────────────────────────

export interface AgentTaskItem {
  id: string;
  status: string;
  prompt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  costUsd: number;
  duration: number;
  source: string | null;
  parentTaskId: string | null;
  chainDepth: number;
  error: string | null;
  handoffIntent: string | null;
  reportId: number | null;
}

export function gatherAgentTasks(agentName: string, limit = 20): AgentTaskItem[] {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT t.id, t.status, SUBSTR(t.prompt, 1, 300) as prompt,
             t.created_at, t.started_at, t.completed_at,
             t.cost_usd, t.duration, t.source, t.parent_task_id,
             t.chain_depth, t.error, t.metadata,
             r.id as report_id
      FROM agent_tasks t
      LEFT JOIN agent_reports r ON r.task_id = t.id
      WHERE t.agent_name = ?
        AND (t.status IN ('running', 'pending') OR t.completed_at > datetime('now', '-1 day'))
      ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
               t.created_at DESC
      LIMIT ?
    `).all(agentName, limit) as Array<Record<string, unknown>>;

    return rows.map(r => {
      let handoffIntent: string | null = null;
      if (r.metadata) {
        try {
          const meta = JSON.parse(r.metadata as string);
          handoffIntent = meta.handoffIntent ?? null;
        } catch { /* ignore */ }
      }
      return {
        id: r.id as string,
        status: r.status as string,
        prompt: r.prompt as string,
        createdAt: r.created_at as string,
        startedAt: r.started_at as string | null,
        completedAt: r.completed_at as string | null,
        costUsd: (r.cost_usd as number) ?? 0,
        duration: (r.duration as number) ?? 0,
        source: r.source as string | null,
        parentTaskId: r.parent_task_id as string | null,
        chainDepth: (r.chain_depth as number) ?? 0,
        error: r.error as string | null,
        handoffIntent,
        reportId: (r.report_id as number | null) ?? null,
      };
    });
  } catch (err) {
    logger.warn('API-Chains', `gatherAgentTasks(${agentName}) failed`, err);
    return [];
  }
}

// ── Chain Detail ────────────────────────────────────────────────────

export interface ChainNode {
  id: string;
  agentName: string;
  status: string;
  parentTaskId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  costUsd: number;
  duration: number;
  source: string | null;
  chainDepth: number;
  error: string | null;
  handoffIntent: string | null;
  reportId: number | null;
}

export function gatherChainDetail(rootId: string): ChainNode[] {
  try {
    const db = getDb();

    // First find the true root — walk UP from rootId
    let actualRoot = rootId;
    for (let i = 0; i < 10; i++) {
      const parent = db.prepare(
        'SELECT parent_task_id FROM agent_tasks WHERE id = ?',
      ).get(actualRoot) as { parent_task_id: string | null } | undefined;
      if (!parent || !parent.parent_task_id) break;
      actualRoot = parent.parent_task_id;
    }

    // Walk DOWN from root using recursive CTE
    const rows = db.prepare(`
      WITH RECURSIVE chain(id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT t.id, chain.depth + 1
        FROM agent_tasks t
        JOIN chain ON t.parent_task_id = chain.id
        WHERE chain.depth < 10
      )
      SELECT t.id, t.agent_name, t.status, t.parent_task_id,
             t.created_at, t.started_at, t.completed_at,
             t.cost_usd, t.duration, t.source, t.chain_depth, t.error, t.metadata,
             r.id as report_id
      FROM chain
      JOIN agent_tasks t ON t.id = chain.id
      LEFT JOIN agent_reports r ON r.task_id = t.id
      ORDER BY t.created_at ASC
    `).all(actualRoot) as Array<Record<string, unknown>>;

    return rows.map(r => {
      let handoffIntent: string | null = null;
      if (r.metadata) {
        try {
          const meta = JSON.parse(r.metadata as string);
          handoffIntent = meta.handoffIntent ?? null;
        } catch { /* ignore */ }
      }
      return {
        id: r.id as string,
        agentName: r.agent_name as string,
        status: r.status as string,
        parentTaskId: r.parent_task_id as string | null,
        createdAt: r.created_at as string,
        startedAt: r.started_at as string | null,
        completedAt: r.completed_at as string | null,
        costUsd: (r.cost_usd as number) ?? 0,
        duration: (r.duration as number) ?? 0,
        source: r.source as string | null,
        chainDepth: (r.chain_depth as number) ?? 0,
        error: r.error as string | null,
        handoffIntent,
        reportId: (r.report_id as number | null) ?? null,
      };
    });
  } catch (err) {
    logger.warn('API-Chains', `gatherChainDetail(${rootId}) failed`, err);
    return [];
  }
}

// ── Flow Map ────────────────────────────────────────────────────────

export interface FlowEdge {
  from: string;
  to: string;
  count: number;
}

export function gatherFlowMap(): FlowEdge[] {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT origin_agent as from_agent, agent_name as to_agent, COUNT(*) as count
      FROM agent_tasks
      WHERE source = 'handoff' AND origin_agent IS NOT NULL
        AND created_at > datetime('now', '-7 days')
      GROUP BY origin_agent, agent_name
      ORDER BY count DESC
    `).all() as Array<{ from_agent: string; to_agent: string; count: number }>;

    return rows.map(r => ({ from: r.from_agent, to: r.to_agent, count: r.count }));
  } catch (err) {
    logger.warn('API-Chains', 'gatherFlowMap failed', err);
    return [];
  }
}

// ── Agent Config ────────────────────────────────────────────────────

export async function getAgentConfig(name: string): Promise<Record<string, unknown> | null> {
  try {
    const { loadAgentConfig } = await import('../agents/config/agent-config.js');
    const cfg = await loadAgentConfig(name);
    if (!cfg) return null;
    return {
      name: cfg.name,
      enabled: cfg.enabled,
      role: cfg.role,
      schedule: cfg.schedule,
      systemPrompt: cfg.systemPrompt,
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      timeout: cfg.timeout,
      dailyCostLimit: cfg.dailyCostLimit,
      notifyChat: cfg.notifyChat,
      budgetLocked: cfg.budgetLocked,
      scheduleLocked: cfg.scheduleLocked,
      promptLocked: cfg.promptLocked,
    };
  } catch (err) {
    logger.warn('API-Chains', `getAgentConfig(${name}) failed`, err);
    return null;
  }
}

export async function updateAgentConfig(
  name: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { loadAgentConfig, saveAgentConfig } = await import('../agents/config/agent-config.js');
    const cfg = await loadAgentConfig(name);
    if (!cfg) return { ok: false, error: 'Agent not found' };

    // Only allow updating safe fields
    const ALLOWED = ['systemPrompt', 'model', 'maxTurns', 'timeout', 'schedule', 'enabled', 'dailyCostLimit', 'notifyChat', 'personality'] as const;
    for (const key of ALLOWED) {
      if (key in patch && patch[key] !== undefined) {
        (cfg as unknown as Record<string, unknown>)[key] = patch[key];
      }
    }

    await saveAgentConfig(cfg);
    return { ok: true };
  } catch (err) {
    logger.warn('API-Chains', `updateAgentConfig(${name}) failed`, err);
    return { ok: false, error: (err as Error).message };
  }
}
