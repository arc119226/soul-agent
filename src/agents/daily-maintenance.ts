/**
 * Daily Maintenance — scheduled agent checks and daily housekeeping tasks.
 *
 * Uses the unified ScheduleEngine for cron evaluation. Agent-specific
 * pre-flight checks (budget, constraints, dependencies) are applied
 * after the engine identifies due entries.
 */

import {
  loadAgentConfig,
  loadAllAgentConfigs,
  isOverDailyLimit,
  recordAgentRun,
  type AgentConfig,
} from './config/agent-config.js';
import type { AgentTask } from './task-types.js';
import { scheduleEngine } from '../core/schedule-engine.js';
import { getTodayString, toLocalDateString } from '../core/timezone.js';
import { logger } from '../core/logger.js';

// ── Daily Housekeeping (once-per-day guard) ──────────────────────────

let lastHousekeepingDate = '';

/**
 * Run daily housekeeping tasks: budget optimization, knowledge compaction,
 * lifecycle review, stats snapshot, soul cleanup, SQLite cleanup, artifact cleanup.
 */
async function runDailyHousekeeping(): Promise<void> {
  const todayStr = getTodayString();
  if (lastHousekeepingDate === todayStr) return;
  lastHousekeepingDate = todayStr;

  const now = new Date();

  try {
    const { optimizeBudgets } = await import('./budget-optimizer.js');
    const result = await optimizeBudgets();
    if (result.changed > 0) {
      await logger.info('DailyMaintenance',
        `Daily budget optimization: ${result.changed} agent(s) adjusted`);
    }
  } catch (e) {
    logger.debug('DailyMaintenance', `optimizeBudgets non-fatal: ${(e as Error).message}`);
  }

  try {
    const { compactKnowledge } = await import('./knowledge/shared-knowledge.js');
    await compactKnowledge();
  } catch (e) {
    logger.debug('DailyMaintenance', `compactKnowledge non-fatal: ${(e as Error).message}`);
  }

  try {
    const { reviewKnowledgeBase } = await import('./knowledge/knowledge-lifecycle.js');
    const result = await reviewKnowledgeBase();
    if (result.archived.length || result.merged.length || result.promotionCandidates.length || result.internalized?.length) {
      await logger.info('DailyMaintenance',
        `Knowledge lifecycle: archived=${result.archived.length}, merged=${result.merged.length}, promotions=${result.promotionCandidates.length}, internalized=${result.internalized?.length ?? 0}`);
    }
  } catch (e) {
    logger.debug('DailyMaintenance', `knowledge lifecycle non-fatal: ${(e as Error).message}`);
  }

  try {
    const { snapshotDailyStats } = await import('./monitoring/stats-snapshot.js');
    const yesterday = getTodayString(new Date(now.getTime() - 86400_000));
    await snapshotDailyStats(yesterday);
  } catch (e) {
    logger.debug('DailyMaintenance', `snapshotDailyStats non-fatal: ${(e as Error).message}`);
  }

  try {
    const { runSoulCleanup } = await import('../core/soul-cleanup.js');
    const cleanup = await runSoulCleanup();
    const total = cleanup.agentReports.removed + cleanup.agentStats.removed
      + cleanup.metrics.removed + cleanup.passports.removed + cleanup.logs.truncated.length;
    if (total > 0) {
      await logger.info('DailyMaintenance',
        `Soul cleanup: reports=${cleanup.agentReports.removed} (${(cleanup.agentReports.freedBytes / 1024).toFixed(0)}KB), ` +
        `stats=${cleanup.agentStats.removed}, metrics=${cleanup.metrics.removed}, ` +
        `passports=${cleanup.passports.removed}, logs=[${cleanup.logs.truncated.join(',')}]`);
    }
  } catch (e) {
    logger.debug('DailyMaintenance', `soul cleanup non-fatal: ${(e as Error).message}`);
  }

  try {
    const { runDailyCleanup } = await import('../core/database.js');
    const dbCleanup = runDailyCleanup();
    const totalDeleted = Object.values(dbCleanup.deleted).reduce((a: number, b: number) => a + b, 0);
    if (totalDeleted > 0) {
      await logger.info('DailyMaintenance',
        `DB cleanup: ${JSON.stringify(dbCleanup.deleted)}`);
    }
  } catch (e) {
    logger.debug('DailyMaintenance', `DB cleanup non-fatal: ${(e as Error).message}`);
  }

  try {
    const { cleanupArtifacts } = await import('./governance/handoff-artifact.js');
    const artifactCleanup = await cleanupArtifacts();
    if (artifactCleanup.removed > 0) {
      await logger.info('DailyMaintenance',
        `Artifact cleanup: ${artifactCleanup.removed} expired file(s) removed`);
    }
  } catch (e) {
    logger.debug('DailyMaintenance', `artifact cleanup non-fatal: ${(e as Error).message}`);
  }

  // DLQ retry — process failed tasks eligible for automatic retry
  try {
    const { processDLQ } = await import('./monitoring/dlq-consumer.js');
    const dlqResult = await processDLQ({ limit: 10 });
    if (dlqResult.retried > 0 || dlqResult.processed > 0) {
      await logger.info('DailyMaintenance',
        `DLQ processing: ${dlqResult.retried} retried, ${dlqResult.skipped} skipped, ${dlqResult.resolved} resolved`);
    }
  } catch (e) {
    logger.debug('DailyMaintenance', `DLQ processing non-fatal: ${(e as Error).message}`);
  }

  // Auto-tune agent timeout/maxTurns based on P95 historical data
  try {
    const { tuneAgentParams } = await import('./config/agent-tuner.js');
    const paramResults = await tuneAgentParams();
    if (paramResults.length > 0) {
      await logger.info('DailyMaintenance',
        `Param tuning: ${paramResults.length} adjustment(s)`);
    }
  } catch (e) {
    logger.debug('DailyMaintenance', `param tuning non-fatal: ${(e as Error).message}`);
  }
}

// ── Agent Schedule Reconciliation ────────────────────────────────────

/**
 * Sync all agent configs to the ScheduleEngine.
 * Called on each heartbeat tick to detect config changes.
 */
export async function reconcileAgentSchedules(): Promise<void> {
  const agents = await loadAllAgentConfigs();
  const currentAgentIds = new Set(
    scheduleEngine.getBySource('agent').map((e) => e.id),
  );

  for (const agent of agents) {
    const scheduleId = `agent:${agent.name}`;
    currentAgentIds.delete(scheduleId);

    if (!agent.enabled || agent.schedule === 'manual') {
      scheduleEngine.unregister(scheduleId);
      continue;
    }

    const existing = scheduleEngine.getById(scheduleId);
    // Only re-register if schedule changed or entry doesn't exist
    if (!existing || existing.cronExpr !== agent.schedule) {
      // Distinguish real schedule changes from legacy migration artifacts.
      // Legacy entries (persisted before cronExpr tracking) load with cronExpr='manual'.
      // Since manual agents are filtered out above (line 152-154), seeing
      // cronExpr='manual' here means it's a legacy stub — NOT a real schedule change.
      // Clearing lastRun for legacy stubs causes a "schedule avalanche" where all
      // agents fire simultaneously on first startup after the migration.
      const isConfirmedChange = existing != null
        && existing.cronExpr !== 'manual' // 'manual' = legacy stub default, not a real schedule
        && existing.cronExpr !== agent.schedule;

      if (isConfirmedChange) {
        // Real schedule change → clear stale in-memory trackers (lastRunMs, dailyFired)
        scheduleEngine.unregister(scheduleId);
      }
      scheduleEngine.register({
        id: scheduleId,
        cronExpr: agent.schedule,
        executor: { type: 'agent', agentName: agent.name },
        enabled: true,
        // Only clear lastRun for confirmed schedule changes.
        // For new entries or legacy migrations, preserve lastRun from agent config.
        lastRun: isConfirmedChange ? null : (existing?.lastRun ?? agent.lastRun ?? null),
        constraints: agent.scheduleConstraints,
        source: 'agent',
        meta: { description: agent.description },
      });
    }
  }

  // Remove entries for agents that no longer exist
  for (const orphanId of currentAgentIds) {
    scheduleEngine.unregister(orphanId);
  }
}

// ── Scheduled Task Processing ────────────────────────────────────────

/**
 * Process all due schedule entries from the unified ScheduleEngine.
 * For callback entries: execute directly.
 * For agent entries: apply pre-flight checks, then enqueue.
 */
export async function processScheduledEntries(): Promise<void> {
  // Daily housekeeping (once per day, not time-specific)
  await runDailyHousekeeping();

  // Reconcile agent configs → schedule engine
  await reconcileAgentSchedules();

  const now = new Date();
  const dueEntries = scheduleEngine.evaluateDue(now);

  // Dynamic import to avoid circular dependency
  const { enqueueTask } = await import('./worker-scheduler.js');

  for (const entry of dueEntries) {
    if (entry.executor.type === 'callback') {
      // Execute callback directly (proactive tasks, heartbeat periodic tasks)
      try {
        await entry.executor.fn();
        await scheduleEngine.markRun(entry.id, 'success', now);
      } catch (err) {
        await scheduleEngine.markRun(entry.id, 'failure', now);
        logger.error('ScheduleDispatch', `Callback ${entry.id} failed`, err);
      }
    } else if (entry.executor.type === 'agent') {
      // Agent tasks: apply pre-flight checks
      const agentName = entry.executor.agentName;
      const agent = await loadAgentConfig(agentName);
      if (!agent || !agent.enabled) {
        await scheduleEngine.markRun(entry.id, 'skipped', now);
        continue;
      }

      // Budget check
      if (await isOverDailyLimit(agentName)) {
        await scheduleEngine.markRun(entry.id, 'skipped', now);
        continue;
      }

      // Cost gate check (agent-specific, uses totalCostToday)
      if (agent.scheduleConstraints?.costGate !== undefined) {
        const todaySpend = agent.costResetDate === getTodayString(now)
          ? (agent.totalCostToday ?? 0) : 0;
        if (todaySpend >= agent.scheduleConstraints.costGate) {
          await scheduleEngine.markRun(entry.id, 'skipped', now);
          continue;
        }
      }

      // Dependency check
      if (agent.dependsOnAgents?.length) {
        const todayStr = getTodayString();
        let depsReady = true;
        for (const depName of agent.dependsOnAgents) {
          const depCfg = await loadAgentConfig(depName);
          if (!depCfg) continue;
          const ranToday = depCfg.lastRun && toLocalDateString(depCfg.lastRun) === todayStr;
          if (!ranToday) {
            await logger.info('DailyMaintenance',
              `Agent "${agentName}" deferred — dependency "${depName}" hasn't run today yet`);
            depsReady = false;
            break;
          }
        }
        if (!depsReady) continue; // Will re-evaluate on next tick (not marked as run)
      }

      // Special handling: comment-monitor needs real comment data
      if (agentName === 'comment-monitor') {
        await enqueueCommentMonitorTask(agent, enqueueTask);
        await scheduleEngine.markRun(entry.id, 'success', now);
        continue;
      }

      // Enqueue agent task
      const prompt = agent.systemPrompt
        ? `請執行你的例行任務。`
        : `請執行「${agentName}」的例行巡查任務。`;

      await enqueueTask(agentName, prompt, 5, { source: 'scheduled' });
      await scheduleEngine.markRun(entry.id, 'success', now);
      await logger.info('DailyMaintenance',
        `Scheduled task enqueued for agent "${agentName}" (schedule: ${agent.schedule})`);
    }
  }
}

// ── Backwards Compat ─────────────────────────────────────────────────

/**
 * @deprecated Use processScheduledEntries() instead.
 * Kept for backward compatibility with worker-scheduler.ts import.
 */
export async function checkScheduledAgents(): Promise<void> {
  await processScheduledEntries();
}

// ── Helpers ──────────────────────────────────────────────────────────

type EnqueueTaskFn = (
  agentName: string,
  prompt: string,
  priority: number,
  opts?: { source?: AgentTask['source'] },
) => Promise<string>;

/**
 * Fetch real blog comments, then enqueue a comment-monitor task with actual data.
 * If no new unreplied comments, skip the task entirely (save cost).
 */
async function enqueueCommentMonitorTask(agent: AgentConfig, enqueueTask: EnqueueTaskFn): Promise<void> {
  try {
    const { getLatestComments } = await import('../blog/comment-client.js');
    const since = agent.targets?.checkInterval ?? '2h';
    const result = await getLatestComments(since as string, 20);

    // Filter to unreplied comments only (ai_replied === 0)
    const unreplied = result.comments.filter((c) => c.ai_replied === 0);

    // CPU pre-filter: skip comments not worth AI analysis
    const worthAnalyzing = unreplied.filter((c) => {
      const content = c.content.trim();
      if (content.length < 5) return false;                          // too short
      if (/^[\p{Emoji}\p{P}\p{S}\s]+$/u.test(content)) return false; // pure emoji/symbols
      return true;
    });

    if (worthAnalyzing.length === 0) {
      const skipped = unreplied.length - worthAnalyzing.length;
      await logger.info('DailyMaintenance',
        `comment-monitor: no actionable comments in last ${since}` +
        (skipped > 0 ? ` (${skipped} filtered by CPU pre-filter)` : '') +
        ', skipping task');
      // Still update lastRun so the scheduler doesn't re-check immediately
      await recordAgentRun(agent.name, 0);
      return;
    }

    // Build prompt with real comment data for AI to analyze and draft replies
    const commentLines = worthAnalyzing.map((c) =>
      `COMMENT_ID: ${c.id}\nPOST_SLUG: ${c.post_slug}\nAUTHOR: ${c.author_name}\nDATE: ${c.created_at}\nCONTENT: ${c.content}\n---`
    ).join('\n');

    const skipped = unreplied.length - worthAnalyzing.length;
    const prompt = `以下是部落格上的 ${worthAnalyzing.length} 則待回覆留言：

${commentLines}

請對每條留言進行分析並生成回覆。嚴格按照以下格式輸出，每條留言之間用空行分隔：

COMMENT_ID: {id}
POST_SLUG: {slug}
CONFIDENCE: {0.0-1.0}
ACTION: reply / skip / flag
REPLY: {你的回覆文字}

規則：
- confidence >= 0.7：將被自動發布
- confidence < 0.7：將被標記給管理員審閱
- ACTION=skip：垃圾留言不回覆
- ACTION=flag：需要管理員處理`;

    await enqueueTask(agent.name, prompt, 6, { source: 'scheduled' }); // Priority 6 (slightly above default 5)
    await logger.info('DailyMaintenance',
      `comment-monitor: ${worthAnalyzing.length} comment(s) enqueued` +
      (skipped > 0 ? ` (${skipped} filtered by CPU pre-filter)` : ''));
  } catch (err) {
    await logger.warn('DailyMaintenance',
      `comment-monitor: failed to fetch comments: ${(err as Error).message}`);
  }
}
