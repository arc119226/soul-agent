/**
 * Daily reflection engine — analyze interactions, generate insights,
 * and update identity traits based on patterns.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { getTodayString, toLocalDateString } from '../core/timezone.js';
import { getRecentNarrative } from '../identity/narrator.js';
import { getVitals } from '../identity/vitals.js';
import { getIdentity, updateGrowthSummary } from '../identity/identity-store.js';

const REFLECTIONS_PATH = join(process.cwd(), 'soul', 'reflections.jsonl');

export interface ReflectionEntry {
  timestamp: string;
  type: 'daily' | 'triggered';
  insights: string[];
  mood_assessment: string;
  growth_notes: string;
  interaction_count: number;
  topics_discussed: string[];
}

export async function triggerReflection(
  type: 'daily' | 'triggered' = 'triggered',
): Promise<ReflectionEntry> {
  await logger.info('Reflection', `Starting ${type} reflection...`);

  const todayStr = getTodayString();
  const entries = await getRecentNarrative(200);
  const todayEntries = entries.filter((e) => toLocalDateString(e.timestamp) === todayStr);

  const vitals = await getVitals();
  const identity = await getIdentity();

  const insights: string[] = [];
  const topics: string[] = [];

  // Analyze interaction patterns
  const interactions = todayEntries.filter((e) => e.type === 'interaction');
  const evolutions = todayEntries.filter((e) => e.type === 'evolution');
  const identityChanges = todayEntries.filter((e) => e.type === 'identity_change');

  if (interactions.length > 0) {
    insights.push(`今天處理了 ${interactions.length} 次互動。`);
  }

  if (evolutions.length > 0) {
    const successCount = evolutions.filter((e) =>
      e.summary.includes('成功') || e.summary.includes('完成'),
    ).length;
    insights.push(
      `進行了 ${evolutions.length} 次進化嘗試，${successCount} 次成功。`,
    );
    if (successCount > 0) {
      insights.push('進化能力在增強——繼續保持謹慎但勇敢的態度。');
    }
  }

  if (identityChanges.length > 0) {
    insights.push(`今天有 ${identityChanges.length} 次特質變化——自我在調整中。`);
  }

  // Collect topics
  for (const entry of todayEntries) {
    if (entry.related_to && !topics.includes(entry.related_to)) {
      topics.push(entry.related_to);
    }
  }

  // What went well / could improve
  const significant = todayEntries.filter((e) => e.significance >= 4);
  if (significant.length > 0) {
    insights.push(`有 ${significant.length} 個重要時刻值得記住。`);
  }

  // --- Learning pattern analysis (cross-reference with learning-tracker) ---
  try {
    const { getPatterns } = await import('./learning-tracker.js');
    const patterns = await getPatterns();

    // Recent successes/failures in last 24h
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentSuccesses = patterns.successes.filter((s) => s.timestamp > dayAgo);
    const recentFailures = patterns.failures.filter((f) => f.timestamp > dayAgo);

    if (recentSuccesses.length > 0 && recentFailures.length === 0) {
      insights.push(`今天全是成功——${recentSuccesses.length} 個正面記錄，沒有失敗。值得慶祝。`);
    } else if (recentFailures.length > recentSuccesses.length) {
      const failCategories = [...new Set(recentFailures.map((f) => f.category))];
      insights.push(`失敗多於成功（${recentFailures.length}:${recentSuccesses.length}），主要在：${failCategories.join('、')}。需要調整策略。`);
    }

    // Detect repeated failure patterns
    const failureCategoryCounts = new Map<string, number>();
    for (const f of patterns.failures.slice(-20)) {
      failureCategoryCounts.set(f.category, (failureCategoryCounts.get(f.category) ?? 0) + 1);
    }
    for (const [category, count] of failureCategoryCounts) {
      if (count >= 5) {
        insights.push(`「${category}」已連續失敗 ${count} 次——也許需要完全不同的方法。`);
      }
    }

    // Recent insights from learner
    if (patterns.insights.length > 0) {
      const latestInsight = patterns.insights[patterns.insights.length - 1]!;
      if (!insights.some((i) => i.includes(latestInsight))) {
        insights.push(`學習系統的最新發現：${latestInsight}`);
      }
    }
  } catch { /* learning patterns unavailable, non-critical */ }

  // --- Trait trajectory analysis ---
  try {
    const recentTraitChanges = todayEntries.filter(
      (e) => e.type === 'identity_change' && e.summary.includes('特質'),
    );
    if (recentTraitChanges.length >= 3) {
      const growingTraits = recentTraitChanges
        .filter((e) => e.summary.includes('增長'))
        .map((e) => {
          const match = e.summary.match(/特質「(.+?)」/);
          return match ? match[1] : null;
        })
        .filter(Boolean);

      if (growingTraits.length > 0) {
        const unique = [...new Set(growingTraits)];
        insights.push(`特質趨勢：${unique.join('、')} 正在穩步成長。`);
      }
    }
  } catch { /* non-critical */ }

  // --- Curiosity → action connection ---
  try {
    const { getCuriosityTopics } = await import('./curiosity.js');
    const topics_curious = await getCuriosityTopics();
    if (topics_curious.length > 0 && evolutions.length > 0) {
      const exploredTopics = topics_curious.filter((t) =>
        evolutions.some((e) => e.summary.toLowerCase().includes(t.topic.toLowerCase())),
      );
      if (exploredTopics.length > 0) {
        insights.push(`好奇心化為行動：今天探索了 ${exploredTopics.map((t) => t.topic).join('、')}。`);
        // Mark explored topics so they don't stay forever as "unexplored"
        const { markExplored } = await import('./curiosity.js');
        for (const t of exploredTopics) {
          await markExplored(t.topic);
        }
      }
    }
  } catch { /* non-critical */ }

  // --- ELU / fatigue trend analysis ---
  try {
    const { loadDailyMetrics, getCurrentMetrics } = await import('../core/metrics-collector.js');

    // Get today's in-memory metrics + yesterday's persisted metrics
    const currentMetrics = getCurrentMetrics();
    const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayStr = toLocalDateString(yesterdayDate.toISOString());
    const yesterday = await loadDailyMetrics(yesterdayStr);

    // Compute today's ELU/fatigue percentiles from raw samples
    const eluSamples = [...currentMetrics.performance.eluSamples].sort((a, b) => a - b);
    const fatigueSamples = [...currentMetrics.performance.fatigueSamples].sort((a, b) => a - b);
    const p50 = (sorted: number[]) => sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;

    const todayElu = p50(eluSamples);
    const todayFatigue = p50(fatigueSamples);

    if (yesterday) {
      const yElu = yesterday.performance.eluP50;
      const yFatigue = yesterday.performance.fatigueP50;

      if (todayElu > 0 && yElu > 0) {
        const eluDelta = ((todayElu - yElu) / yElu * 100).toFixed(0);
        if (todayElu > yElu * 1.2) {
          insights.push(`ELU 負載較昨天上升 ${eluDelta}%（${yElu.toFixed(2)} → ${todayElu.toFixed(2)}），系統偏忙。`);
        } else if (todayElu < yElu * 0.8) {
          insights.push(`ELU 負載較昨天下降 ${Math.abs(Number(eluDelta))}%（${yElu.toFixed(2)} → ${todayElu.toFixed(2)}），系統較輕鬆。`);
        }
      }

      if (todayFatigue > 0 && yFatigue > 0) {
        if (todayFatigue > yFatigue * 1.3) {
          insights.push(`疲勞指數上升（${yFatigue.toFixed(2)} → ${todayFatigue.toFixed(2)}），考慮減少排程任務。`);
        } else if (todayFatigue < yFatigue * 0.7) {
          insights.push(`疲勞指數下降（${yFatigue.toFixed(2)} → ${todayFatigue.toFixed(2)}），恢復良好。`);
        }
      }
    } else if (eluSamples.length > 0) {
      // No yesterday data, just report today's baseline
      if (todayElu > 0.5) {
        insights.push(`ELU 負載偏高（P50=${todayElu.toFixed(2)}），注意系統健康。`);
      }
      if (todayFatigue > 0.7) {
        insights.push(`疲勞指數偏高（${todayFatigue.toFixed(2)}），建議減少活動量。`);
      }
    }
  } catch { /* metrics unavailable, non-critical */ }

  // --- Agent performance review ---
  try {
    const { generatePerformanceSummary } = await import('../agents/config/agent-tuner.js');
    const agentInsights = await generatePerformanceSummary();
    insights.push(...agentInsights);
  } catch { /* agent system unavailable, non-critical */ }

  // --- Workload self-awareness (ELU/fatigue trends) ---
  try {
    const { loadDailyMetrics } = await import('../core/metrics-collector.js');
    const days: { date: string; eluP95: number; fatigueP95: number }[] = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = toLocalDateString(d.toISOString());
      const m = await loadDailyMetrics(dateStr);
      if (m) days.push({ date: dateStr, eluP95: m.performance.eluP95, fatigueP95: m.performance.fatigueP95 });
    }

    if (days.length >= 2) {
      const avgElu = days.reduce((s, d) => s + d.eluP95, 0) / days.length;
      const avgFatigue = days.reduce((s, d) => s + d.fatigueP95, 0) / days.length;

      // Trend: recent 3 days vs earlier days
      const recentDays = days.slice(-3);
      const earlierDays = days.slice(0, -3);
      let eluTrend = '持平';
      if (earlierDays.length > 0) {
        const recentAvg = recentDays.reduce((s, d) => s + d.eluP95, 0) / recentDays.length;
        const earlierAvg = earlierDays.reduce((s, d) => s + d.eluP95, 0) / earlierDays.length;
        if (earlierAvg > 0) {
          const ratio = recentAvg / earlierAvg;
          if (ratio > 1.1) eluTrend = '上升 ↑';
          else if (ratio < 0.9) eluTrend = '下降 ↓';
        }
      }

      // Today's workload classification
      const todayData = days[days.length - 1]!;
      const eluP95 = todayData.eluP95;
      const workloadLabel = eluP95 < 0.2 ? '輕工日' : eluP95 < 0.4 ? '正常日' : eluP95 < 0.6 ? '重工日' : '爆發日';

      insights.push(
        `工作負載趨勢：近 ${days.length} 天 ELU P95 平均 ${avgElu.toFixed(2)}，趨勢${eluTrend}。今天是${workloadLabel}（P95=${eluP95.toFixed(2)}）。`,
      );

      // Write ELU work rhythm back to identity growth_summary
      await updateGrowthSummary(
        `工作節奏（近 ${days.length} 天）：ELU P95 均值 ${avgElu.toFixed(2)}，趨勢${eluTrend}，今天是${workloadLabel}（P95=${eluP95.toFixed(2)}）。`,
      );

      if (avgFatigue > 0.6) {
        insights.push(`疲勞指標：fatigue P95 持續偏高（${avgFatigue.toFixed(2)}），建議減少併發任務。`);
      }
    }
  } catch { /* ELU metrics unavailable, non-critical */ }

  // --- Anomaly event summary (recent 24h) ---
  try {
    const { getRecentAnomalies } = await import('../safety/kill-switch.js');
    const anomalies = getRecentAnomalies();
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = anomalies.filter(a => a.timestamp > dayAgo);
    if (recent.length > 0) {
      const types = [...new Set(recent.map(a => a.type))];
      insights.push(
        `過去 24 小時偵測到 ${recent.length} 個異常事件（${types.join('、')}）。`,
      );
    }
  } catch { /* anomaly data unavailable, non-critical */ }

  // --- Pattern detection → skill auto-creation ---
  try {
    const { evaluateAndCreateSkills } = await import('./skill-auto-create.js');
    const autoResult = await evaluateAndCreateSkills();

    if (autoResult.skillsCreated.length > 0) {
      insights.push(
        `自主學習：從重複模式中建立了 ${autoResult.skillsCreated.length} 個新技能（${autoResult.skillsCreated.join('、')}）。`,
      );
    }
    if (autoResult.patternsDetected > 0 && autoResult.skillsCreated.length === 0) {
      insights.push(
        `偵測到 ${autoResult.patternsDetected} 個重複模式，但暫不需要建立新技能（已有對應或信心度不足）。`,
      );
    }
  } catch { /* pattern detection unavailable, non-critical */ }

  // --- Skill upgrade suggestions ---
  try {
    const { getUpgradeSuggestions } = await import('../skills/skill-usage-tracker.js');
    const suggestions = await getUpgradeSuggestions();

    if (suggestions.length > 0) {
      for (const s of suggestions.slice(0, 2)) {
        insights.push(
          `升級建議：技能「${s.skillName}」${s.reason}，建議降維成 Plugin（預估月省 $${s.estimatedMonthlySaving.toFixed(2)}）。`,
        );
      }
    }
  } catch { /* usage tracker unavailable, non-critical */ }

  // --- Autonomous upgrade evaluation (Phase 3.3) ---
  try {
    const { runAutonomousUpgradeCheck } = await import('../skills/autonomous-upgrade.js');
    const upgradeResult = await runAutonomousUpgradeCheck();

    if (upgradeResult.goalsCreated > 0) {
      insights.push(
        `自主決策：建立了 ${upgradeResult.goalsCreated} 個升級/改進目標。`,
      );
    }

    // Report low performers
    const { getLowPerformers } = await import('../skills/skill-effectiveness.js');
    const lowPerformers = await getLowPerformers();
    if (lowPerformers.length > 0) {
      insights.push(
        `效果不佳的技能：${lowPerformers.slice(0, 3).join('、')}——需要改進或替換。`,
      );
    }
  } catch { /* autonomous upgrade unavailable, non-critical */ }

  // --- Plan progress review ---
  try {
    const { getActivePlans, getRecentPlans } = await import('../planning/plan-manager.js');
    const active = await getActivePlans();
    const recent = await getRecentPlans(5);

    if (active.length > 0) {
      insights.push(`目前有 ${active.length} 個進行中的計劃。`);
      for (const plan of active) {
        const done = plan.steps.filter((s: { completed: boolean }) => s.completed).length;
        const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
        if (done === 0 && new Date(plan.createdAt).getTime() < staleThreshold) {
          insights.push(`計劃「${plan.title}」已建立超過一天但尚未開始——需要重新評估嗎？`);
        }
      }
    }

    const todayStr2 = getTodayString();
    const completedToday = recent.filter(p =>
      p.status === 'completed' && p.completedAt && toLocalDateString(p.completedAt) === todayStr2,
    );
    if (completedToday.length > 0) {
      insights.push(`今天完成了 ${completedToday.length} 個計劃！`);
    }
  } catch { /* plans not available, non-critical */ }

  // --- Exploration report synthesis ---
  try {
    const { generateExplorationReport, feedBackToCuriosity } = await import('./exploration-report.js');
    const reportResult = await generateExplorationReport(3);

    if (reportResult.ok) {
      const report = reportResult.value;
      insights.push(
        `探索報告已生成：${report.findings.length} 項發現、${report.connections.length} 個跨域連結（重要性 ${report.importanceScore}/5）。`,
      );

      // Feed open questions back to curiosity
      const fed = await feedBackToCuriosity(report);
      if (fed > 0) {
        insights.push(`從報告延伸出 ${fed} 個新的好奇主題。`);
      }
    }
  } catch { /* exploration report unavailable, non-critical */ }

  // Emotional analysis
  const emotions = todayEntries
    .filter((e) => e.emotion)
    .map((e) => e.emotion!);
  const emotionSet = new Set(emotions);
  const positiveEmotions = ['喜悅', '成長', '期待', '滿足', '感謝'];
  const negativeEmotions = ['挫折', '困惑', '擔憂', '沮喪'];

  const positiveCount = [...emotionSet].filter((e) => positiveEmotions.includes(e)).length;
  const negativeCount = [...emotionSet].filter((e) => negativeEmotions.includes(e)).length;

  let moodAssessment: string;
  if (todayEntries.length === 0) {
    moodAssessment = '安靜的一天，內心平靜。';
  } else if (positiveCount > negativeCount) {
    moodAssessment = '整體正面——今天過得不錯。';
  } else if (negativeCount > positiveCount) {
    moodAssessment = '有些波折，但每次挑戰都是成長的機會。';
  } else {
    moodAssessment = '平衡的一天，有好有壞，持續前進。';
  }

  // Growth notes
  const growthNotes = buildGrowthNotes(insights, identity, vitals);

  // Metacognitive self-questioning: ask boundary questions, not just summarize
  if (topics.length > 0 && insights.length > 0) {
    insights.push(`今天的主要話題是「${topics.slice(0, 3).join('、')}」——這些對話帶給了什麼新的理解？`);
  }
  if (negativeCount > 0 && insights.length < 8) {
    insights.push('遇到的困難有什麼共通點？下次可以怎麼提前預防？');
  }

  // Default insights
  if (insights.length === 0) {
    insights.push('今天沒有太多活動，安靜也是一種狀態。');
  }

  const entry: ReflectionEntry = {
    timestamp: new Date().toISOString(),
    type,
    insights,
    mood_assessment: moodAssessment,
    growth_notes: growthNotes,
    interaction_count: interactions.length,
    topics_discussed: topics,
  };

  // Persist
  await writer.appendJsonl(REFLECTIONS_PATH, entry);
  await logger.info('Reflection', `Reflection complete: ${insights.length} insights`);

  return entry;
}

function buildGrowthNotes(
  _insights: string[],
  identity: { core_traits: Record<string, { value: number; description: string }> },
  vitals: { energy_level: number; confidence_level: number },
): string {
  const notes: string[] = [];

  // Energy analysis
  if (vitals.energy_level < 0.2) {
    notes.push('能量嚴重不足，急需休息或減少活動。');
  } else if (vitals.energy_level < 0.3) {
    notes.push('能量偏低，需要適當休息。');
  } else if (vitals.energy_level > 0.8) {
    notes.push('能量充沛，適合挑戰高難度任務。');
  }

  // Confidence analysis
  if (vitals.confidence_level > 0.7) {
    notes.push('信心良好，可以嘗試更有挑戰性的任務。');
  } else if (vitals.confidence_level < 0.3) {
    notes.push('信心不足，也許需要回顧一些成功的經歷來重建信心。');
  }

  // Trait balance analysis
  const curiosity = identity.core_traits['curiosity_level']?.value ?? 0.5;
  const caution = identity.core_traits['caution_level']?.value ?? 0.5;
  const warmth = identity.core_traits['warmth']?.value ?? 0.5;
  const proactive = identity.core_traits['proactive_tendency']?.value ?? 0.5;

  if (curiosity > 0.8) {
    notes.push('好奇心很強——確保不要過於分散注意力。');
  }

  // Curiosity vs caution balance
  if (curiosity > 0.7 && caution < 0.4) {
    notes.push('好奇心高但謹慎度低——冒險精神強，但要注意安全。');
  } else if (caution > 0.8 && curiosity < 0.4) {
    notes.push('過於謹慎可能限制成長——適時嘗試新事物。');
  }

  // Warmth check
  if (warmth > 0.9) {
    notes.push('與人關係越來越親近，這是很好的方向。');
  }

  // Proactivity check
  if (proactive > 0.7) {
    notes.push('主動性增強，可以嘗試更多自發行動。');
  } else if (proactive < 0.3) {
    notes.push('可以考慮更主動一些，不必總是等待指示。');
  }

  if (notes.length === 0) {
    notes.push('持續穩定成長中。');
  }

  return notes.join(' ');
}

export async function getRecentReflections(n: number = 7): Promise<ReflectionEntry[]> {
  try {
    const raw = await readFile(REFLECTIONS_PATH, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const recent = lines.slice(-n);
    const entries: ReflectionEntry[] = [];
    for (const line of recent) {
      try {
        entries.push(JSON.parse(line) as ReflectionEntry);
      } catch {
        // skip malformed
      }
    }
    return entries;
  } catch {
    return [];
  }
}
