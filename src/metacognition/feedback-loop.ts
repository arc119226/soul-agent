/**
 * Feedback loop — the bot's "nervous system".
 *
 * Bridges existing events to existing-but-never-called functions:
 *   events → vitals, learning-tracker, capabilities, goals
 *
 * Also provides deterministic goal synthesis (no AI needed):
 *   learning patterns + curiosity + changelog → new goals
 */

import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';

type AnyHandler = (...args: unknown[]) => void | Promise<void>;

/* ── Energy & confidence deltas ───────────────── */
const ENERGY = {
  INTERACTION_GAIN: 0.05,
  MESSAGE_SENT_COST: -0.01,
  EVOLUTION_SUCCESS: 0.15,
  EVOLUTION_FAIL: -0.05,
  DORMANT_RECOVERY: 0.08,
  RESTING_RECOVERY: 0.005,
  ACTIVE_BASE_DRAIN: -0.002,
  ACTIVE_ELU_FACTOR: 0.016,
  REFLECTION_BONUS: 0.15,
  DREAM_BONUS: 0.10,
  AGENT_TASK_BONUS: 0.03,
} as const;

const CONFIDENCE = {
  EVOLUTION_SUCCESS: 0.1,
  EVOLUTION_FAIL: -0.05,
  MILESTONE_BONUS: 0.1,
  NATURAL_DECAY: -0.001,
  DECAY_THRESHOLD: 0.8,
} as const;

const TRAIT_DRIFT = {
  INTERACTION_WARMTH: 0.01,
  INTERACTION_HUMOR: 0.01,
  EVOLUTION_SUCCESS_CONFIDENCE: 0.02,
  EVOLUTION_SUCCESS_CURIOSITY: 0.01,
  EVOLUTION_FAIL_CAUTION: 0.02,
  EVOLUTION_FAIL_CONFIDENCE: -0.01,
  IDLE_PROACTIVE: 0.01,
} as const;

const STAGNATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// --- Trait drift helper ---
// updateTrait() takes absolute values, so we read current value first and add delta.
async function driftTrait(name: string, delta: number, reason: string): Promise<void> {
  const { getIdentity } = await import('../identity/identity-store.js');
  const id = await getIdentity();
  const trait = id.core_traits[name];
  if (!trait) return;
  const newValue = Math.min(1, Math.max(0, trait.value + delta));
  // Skip if effectively unchanged (avoid noise)
  if (Math.abs(newValue - trait.value) < 0.001) return;
  const { updateTrait } = await import('../identity/identity-store.js');
  await updateTrait(name, newValue, reason);
}

const registeredHandlers: Array<{ event: string; handler: AnyHandler }> = [];

function register<T>(
  event: string,
  handler: (data: T) => void | Promise<void>,
): void {
  eventBus.on(event as never, handler as never);
  registeredHandlers.push({ event, handler: handler as AnyHandler });
}

// --- Per-user interaction throttle (5 min cooldown, same as narrative-listener) ---
const INTERACTION_COOLDOWN_MS = 5 * 60 * 1000;
const lastInteractionTs = new Map<number, number>();

/**
 * Setup all feedback loop event listeners.
 * Call once during startup (after narrative-listener).
 */
export function setupFeedbackLoop(): void {
  // 1. message:received → energy↑, mood=engaged, check milestones, learn preferences
  register<{ chatId: number; userId: number; text: string }>(
    'message:received',
    async ({ userId, text }) => {
      try {
        const now = Date.now();
        const last = lastInteractionTs.get(userId) ?? 0;
        if (now - last < INTERACTION_COOLDOWN_MS) return;
        lastInteractionTs.set(userId, now);

        const { updateEnergy, setMood } = await import('../identity/vitals.js');
        await updateEnergy(ENERGY.INTERACTION_GAIN);
        await setMood('投入', '與用戶互動中');

        // Observe message for preference learning (every message, lightweight)
        try {
          const { observeMessage } = await import('./preference-learner.js');
          observeMessage(userId, text);
        } catch { /* preference learning is non-critical */ }

        // Check milestones after each interaction (throttled by cooldown above)
        try {
          const { collectStats, checkMilestones } = await import('../identity/milestones.js');
          const stats = await collectStats();
          await checkMilestones(stats);
        } catch { /* milestone check is non-critical */ }

        // Trait drift: frequent interaction → warmth↑, humor↑
        try {
          await driftTrait('warmth', TRAIT_DRIFT.INTERACTION_WARMTH, '與用戶互動，關係加深');
          await driftTrait('humor', TRAIT_DRIFT.INTERACTION_HUMOR, '互動中逐漸放鬆');
        } catch { /* trait drift is non-critical */ }
      } catch (err) {
        await logger.warn('feedback-loop', 'handleInteraction error', err);
      }
    },
  );

  // 1b. message:received → skill effectiveness feedback analysis (no cooldown)
  register<{ chatId: number; userId: number; text: string }>(
    'message:received',
    async ({ chatId, text }) => {
      try {
        const { analyzeUserFeedback } = await import('../skills/skill-effectiveness.js');
        await analyzeUserFeedback(chatId, text);
      } catch { /* skill effectiveness tracking is non-critical */ }
    },
  );

  // 2. message:sent → energy↓ (reduced cost: -0.01)
  register<{ chatId: number; text: string }>(
    'message:sent',
    async () => {
      try {
        const { updateEnergy } = await import('../identity/vitals.js');
        await updateEnergy(ENERGY.MESSAGE_SENT_COST);
      } catch (err) {
        await logger.warn('feedback-loop', 'handleMessageSent error', err);
      }
    },
  );

  // 3. evolution:success → energy↑, confidence↑, record success, add capability
  register<{ goalId: string; description: string }>(
    'evolution:success',
    async ({ goalId, description }) => {
      try {
        const { updateEnergy, updateConfidence } = await import('../identity/vitals.js');
        await updateEnergy(ENERGY.EVOLUTION_SUCCESS);
        await updateConfidence(CONFIDENCE.EVOLUTION_SUCCESS);

        const { recordSuccess } = await import('./learning-tracker.js');
        await recordSuccess('evolution', `目標 ${goalId}: ${description}`);

        const { addCapability } = await import('../evolution/capabilities.js');
        addCapability(`進化 ${goalId}: ${description}`);

        // Trait drift: evolution success → confidence↑, curiosity↑
        await driftTrait('confidence', TRAIT_DRIFT.EVOLUTION_SUCCESS_CONFIDENCE, `進化成功：${description}`);
        await driftTrait('curiosity_level', TRAIT_DRIFT.EVOLUTION_SUCCESS_CURIOSITY, '成功激發更多好奇心');
      } catch (err) {
        await logger.warn('feedback-loop', 'handleEvolutionOk error', err);
      }
    },
  );

  // 4. evolution:fail → energy↓, confidence↓, record failure
  register<{ goalId: string; error: string }>(
    'evolution:fail',
    async ({ goalId, error }) => {
      try {
        const { updateEnergy, updateConfidence } = await import('../identity/vitals.js');
        await updateEnergy(ENERGY.EVOLUTION_FAIL);
        await updateConfidence(CONFIDENCE.EVOLUTION_FAIL);

        const { recordFailure } = await import('./learning-tracker.js');
        const shortError = error.length > 80 ? error.slice(0, 77) + '...' : error;
        await recordFailure('evolution', `目標 ${goalId}: ${shortError}`);

        // Trait drift: evolution failure → caution↑, confidence↓
        await driftTrait('caution_level', TRAIT_DRIFT.EVOLUTION_FAIL_CAUTION, `進化失敗，更加謹慎：${shortError}`);
        await driftTrait('confidence', TRAIT_DRIFT.EVOLUTION_FAIL_CONFIDENCE, `進化失敗，信心微降`);
      } catch (err) {
        await logger.warn('feedback-loop', 'handleEvolutionFail error', err);
      }
    },
  );

  // 5. heartbeat:tick → energy drift (biologically-inspired rhythm)
  //    dormant: +0.08 (deep sleep recovery)
  //    resting: +0.005 (shallow rest, slight recovery)
  //    active:  ELU-scaled drain (heavy load drains faster)
  register<{ timestamp: number; state: string; elu: number }>(
    'heartbeat:tick',
    async ({ state, elu }) => {
      try {
        const { updateEnergy, updateConfidence, getVitals } = await import('../identity/vitals.js');
        if (state === 'dormant') {
          await updateEnergy(ENERGY.DORMANT_RECOVERY);
        } else if (state === 'resting') {
          await updateEnergy(ENERGY.RESTING_RECOVERY);
        } else {
          // Scale drain by actual workload via ELU
          const drain = ENERGY.ACTIVE_BASE_DRAIN - (elu * ENERGY.ACTIVE_ELU_FACTOR);
          await updateEnergy(drain);
        }

        // Confidence natural decay: if > 0.8 and no recent evolution success in 3 days
        try {
          const vitals = await getVitals();
          if (vitals.confidence_level > CONFIDENCE.DECAY_THRESHOLD) {
            const { getRecentChanges } = await import('../evolution/changelog.js');
            const recent = await getRecentChanges(20);
            const threeDaysAgo = Date.now() - STAGNATION_WINDOW_MS;
            const recentSuccess = recent.some(
              (e) => e.success && new Date(e.timestamp).getTime() > threeDaysAgo,
            );
            if (!recentSuccess) {
              await updateConfidence(CONFIDENCE.NATURAL_DECAY);
            }
          }
        } catch { /* confidence decay is non-critical */ }

        // Check time-based milestones every tick (uptime, streaks)
        try {
          const { collectStats, checkMilestones } = await import('../identity/milestones.js');
          const stats = await collectStats();
          await checkMilestones(stats);
        } catch { /* milestone check is non-critical */ }

        // Trait drift: long idle (no interaction in 1h) → proactive_tendency↑
        if (state !== 'dormant') {
          const now = Date.now();
          const IDLE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
          const anyRecentInteraction = [...lastInteractionTs.values()].some(
            (ts) => now - ts < IDLE_THRESHOLD_MS,
          );
          if (!anyRecentInteraction && lastInteractionTs.size > 0) {
            try {
              await driftTrait('proactive_tendency', TRAIT_DRIFT.IDLE_PROACTIVE, '長時間無互動，嘗試更主動');
            } catch { /* non-critical */ }
          }
        }
      } catch (err) {
        await logger.warn('feedback-loop', 'handleHeartbeat error', err);
      }
    },
  );

  // 5b. reflection:done → energy↑ (deep recharge from self-reflection)
  register<Record<string, never>>(
    'reflection:done',
    async () => {
      try {
        const { updateEnergy } = await import('../identity/vitals.js');
        await updateEnergy(ENERGY.REFLECTION_BONUS);
        await logger.info('feedback-loop', `Reflection done: energy +${ENERGY.REFLECTION_BONUS}`);
      } catch (err) {
        await logger.warn('feedback-loop', 'handleReflectionDone error', err);
      }
    },
  );

  // 5c. dream:completed → energy↑ (subconscious processing recharge)
  register<Record<string, never>>(
    'dream:completed',
    async () => {
      try {
        const { updateEnergy } = await import('../identity/vitals.js');
        await updateEnergy(ENERGY.DREAM_BONUS);
        await logger.info('feedback-loop', `Dream completed: energy +${ENERGY.DREAM_BONUS}`);
      } catch (err) {
        await logger.warn('feedback-loop', 'handleDreamCompleted error', err);
      }
    },
  );

  // 5d. agent:task:completed → energy↑ (background task success)
  register<{ agentName: string; taskId: string; result: string }>(
    'agent:task:completed',
    async () => {
      try {
        const { updateEnergy } = await import('../identity/vitals.js');
        await updateEnergy(ENERGY.AGENT_TASK_BONUS);
      } catch (err) {
        await logger.warn('feedback-loop', 'handleAgentTaskEnergy error', err);
      }
    },
  );

  // 6. lifecycle:state → mood update on significant transitions
  register<{ from: string; to: string; reason: string }>(
    'lifecycle:state',
    async ({ to, reason }) => {
      try {
        const moodMap: Record<string, [string, string]> = {
          dormant: ['疲倦', '進入休眠'],
          active: ['清醒', '回到活躍狀態'],
          resting: ['放鬆', '短暫休息'],
          thinking: ['專注', '思考中'],
          working: ['忙碌', '執行任務中'],
        };
        const entry = moodMap[to];
        if (entry) {
          const { setMood } = await import('../identity/vitals.js');
          await setMood(entry[0], entry[1] + (reason ? `：${reason}` : ''));
        }
      } catch (err) {
        await logger.warn('feedback-loop', 'handleLifecycle error', err);
      }
    },
  );

  // 7. milestone:reached → confidence↑, update growth summary
  register<{ type: string; description: string }>(
    'milestone:reached',
    async ({ description }) => {
      try {
        const { updateConfidence } = await import('../identity/vitals.js');
        await updateConfidence(CONFIDENCE.MILESTONE_BONUS);

        const { updateGrowthSummary } = await import('../identity/identity-store.js');
        await updateGrowthSummary(`最近里程碑：${description}`);
      } catch (err) {
        await logger.warn('feedback-loop', 'handleMilestone error', err);
      }
    },
  );

  logger.info('feedback-loop', 'Feedback loop registered (10 events + preference learning)');
}

/**
 * Detach all listeners. Call during shutdown.
 */
export function disposeFeedbackLoop(): void {
  for (const { event, handler } of registeredHandlers) {
    eventBus.off(event as never, handler as never);
  }
  registeredHandlers.length = 0;
  lastInteractionTs.clear();
}

// --- Report topic extraction ---

/**
 * Extract the actual topic from an explorer report.
 * Tries structured headings first (## 探索主題), then falls back to
 * content-bearing first lines, skipping preamble text.
 */
function extractReportTopic(result: string, fallback: string): string {
  // Strategy 1: Look for "## 探索主題" heading and grab the content line after it
  const topicHeadingMatch = result.match(/##\s*探索主題\s*\n+\**([^\n*]+)/);
  if (topicHeadingMatch?.[1]) {
    return topicHeadingMatch[1].trim().slice(0, 60);
  }

  // Strategy 1.5: Look for "# X 深度研究報告" or "# X 報告" style h1 headings
  const h1Match = result.match(/^#\s+(.+?)(?:深度研究報告|研究報告|報告|探索報告)?\s*$/m);
  if (h1Match?.[1]) {
    const topic = h1Match[1].replace(/\*+/g, '').trim();
    if (topic.length > 3) return topic.slice(0, 60);
  }

  // Strategy 2: Look for a line starting with "## " that isn't a generic section header
  const genericSections = /^[📝🔍✅❌💡📊🎯📋]*\s*(探索主題|概述|概覽|關鍵發現|發現|延伸問題|重要性|注意事項|結論|來源|Sources|執行摘要|摘要|任務完成|報告|目錄|背景|方法|參考)/;
  const headingMatch = result.match(/^##\s+(.+)/m);
  if (headingMatch?.[1]) {
    const heading = headingMatch[1].replace(/\*+/g, '').trim();
    if (!genericSections.test(heading) && heading.length > 3) {
      return heading.slice(0, 60);
    }
  }

  // Strategy 3: Find first line with meaningful content (skip JSON, preamble, blank lines)
  const preamblePatterns = /^(看來|完美|好的|讓我|我來|嗯|是的|沒問題|了解|收到|當然|太好了|非常好|現在|接下來|首先|然後|確實|沒錯|好吧|明白|OK)/;
  const lines = result.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{') || trimmed.startsWith('```')) continue;
    if (trimmed === '---' || trimmed.startsWith('>')) continue;
    if (trimmed.startsWith('#')) {
      const content = trimmed.replace(/^#+\s*/, '').replace(/\*+/g, '').trim();
      if (content.length > 3 && !genericSections.test(content)) {
        return content.slice(0, 60);
      }
      continue;
    }
    // Skip conversational preamble
    if (trimmed.length > 10 && !preamblePatterns.test(trimmed)) {
      return trimmed.slice(0, 60);
    }
  }

  return fallback;
}

/** Minimum meaningful topic length — reject single-char or emoji-only extractions */
const MIN_TOPIC_LENGTH = 5;

function isValidTopic(topic: string): boolean {
  if (topic.length < MIN_TOPIC_LENGTH) return false;
  // Reject strings that are only emoji / punctuation / symbols
  const stripped = topic.replace(/[\p{Emoji}\p{P}\p{S}\s]/gu, '');
  return stripped.length >= 2;
}

// --- Deterministic goal synthesis ---
const MAX_PENDING_GOALS = 5;

/**
 * Synthesize new goals based on learning patterns, curiosity, and changelog.
 * Pure deterministic rules — no AI involved.
 *
 * Returns the number of goals added.
 */
export async function synthesizeGoals(): Promise<number> {
  let added = 0;

  try {
    const { getAllGoals, addGoal } = await import('../evolution/goals.js');
    const pendingGoals = getAllGoals().filter(
      (g) => g.status === 'pending' || g.status === 'in_progress',
    );

    if (pendingGoals.length >= MAX_PENDING_GOALS) {
      await logger.debug('feedback-loop', `Goal cap reached (${pendingGoals.length}/${MAX_PENDING_GOALS}), skipping synthesis`);
      return 0;
    }

    const remaining = MAX_PENDING_GOALS - pendingGoals.length;
    const existingDescs = new Set(pendingGoals.map((g) => g.description));

    // Also check ALL goals (including failed) for repair-type duplicates.
    // Repair goals have varying failure counts in description (e.g. "5 次" vs "6 次"),
    // so exact description matching misses duplicates. Extract the category instead.
    const allGoals = getAllGoals();
    const abandonedRepairCategories = new Set<string>();
    for (const g of allGoals) {
      if (g.status !== 'failed') continue;
      const match = g.description.match(/^修復反覆失敗：(\S+)/);
      if (match) {
        abandonedRepairCategories.add(match[1]!.replace(/（.*$/, ''));
      }
    }

    // Rule 1: Repeated failures → repair goal (priority 4)
    // ONLY for categories that represent actual code bugs (not behavioral/scoring issues)
    const NON_CODE_CATEGORIES = new Set(['reply-quality', 'interaction', 'evolution']);
    if (added < remaining) {
      try {
        const { getPatterns } = await import('./learning-tracker.js');
        const patterns = await getPatterns();
        // Group failures by category
        const failureCounts = new Map<string, number>();
        for (const f of patterns.failures) {
          failureCounts.set(f.category, (failureCounts.get(f.category) ?? 0) + 1);
        }
        for (const [category, count] of failureCounts) {
          // Skip categories that aren't code bugs — reply-quality is scoring,
          // interaction is CLI exits, evolution is pipeline failures
          if (NON_CODE_CATEGORIES.has(category)) continue;
          // Skip categories that have already been abandoned (prevents re-synthesis
          // when failure count changes, e.g. "5 次" → "6 次")
          if (abandonedRepairCategories.has(category)) continue;
          if (count >= 3 && added < remaining) {
            const desc = `修復反覆失敗：${category}（${count} 次失敗）`;
            if (!existingDescs.has(desc)) {
              addGoal(desc, 4, ['auto', 'repair']);
              existingDescs.add(desc);
              added++;
              await logger.info('feedback-loop', `Synthesized repair goal: ${desc}`);
            }
          }
        }
      } catch { /* non-critical */ }
    }

    // Rule 2: Unexplored curiosity → exploration goal (priority 2)
    if (added < remaining) {
      try {
        const { getCuriosityTopics } = await import('./curiosity.js');
        const topics = await getCuriosityTopics();
        if (topics.length > 0) {
          // Pick the oldest unexplored topic
          const topic = topics[0]!;
          const desc = `探索好奇心話題：${topic.topic}`;
          if (!existingDescs.has(desc)) {
            addGoal(desc, 2, ['auto', 'curiosity']);
            existingDescs.add(desc);
            added++;
            await logger.info('feedback-loop', `Synthesized curiosity goal: ${desc}`);
          }
        }
      } catch { /* non-critical */ }
    }

    // Rule 3: Stagnation — no successful evolution in 3 days → strategy review (priority 3)
    if (added < remaining) {
      try {
        const { getRecentChanges } = await import('../evolution/changelog.js');
        const recent = await getRecentChanges(20);
        const stagnationCutoff = Date.now() - STAGNATION_WINDOW_MS;
        const recentSuccesses = recent.filter(
          (e) => e.success && new Date(e.timestamp).getTime() > stagnationCutoff,
        );
        if (recentSuccesses.length === 0 && recent.length > 0) {
          const desc = '策略檢視：近 3 天無成功進化，需要調整方法';
          if (!existingDescs.has(desc)) {
            addGoal(desc, 3, ['auto', 'strategy']);
            existingDescs.add(desc);
            added++;
            await logger.info('feedback-loop', `Synthesized strategy goal: ${desc}`);
          }
        }
      } catch { /* non-critical */ }
    }
    // Rule 4: Explorer report with high importance → deep-dive goal (priority 3)
    if (added < remaining) {
      try {
        const { getRecentReports } = await import('../agents/worker-scheduler.js');
        const reports = await getRecentReports(10);
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        for (const report of reports) {
          if (added >= remaining) break;
          const reportTime = new Date(report.timestamp).getTime();
          if (reportTime < oneDayAgo) continue;
          // Check importance ≥ 4
          const importanceMatch = report.result.match(/重要性[：:]\s*([45])\/5/);
          if (!importanceMatch) continue;
          // Extract topic from structured report headings, not raw first line
          const topic = extractReportTopic(report.result, report.agentName);
          if (!isValidTopic(topic)) continue;
          const desc = `深入研究：${topic}`;
          if (!existingDescs.has(desc)) {
            addGoal(desc, 3, ['auto', 'exploration']);
            existingDescs.add(desc);
            added++;
            await logger.info('feedback-loop', `Synthesized exploration goal: ${desc}`);
          }
        }
      } catch { /* non-critical */ }
    }
  } catch (err) {
    await logger.warn('feedback-loop', 'synthesizeGoals error', err);
  }

  return added;
}
