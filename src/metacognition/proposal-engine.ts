/**
 * Proposal Engine — data-driven evolution proposals.
 *
 * Aggregates signals from 6 sources (learning-patterns, evolution-metrics,
 * daily metrics, vitals, pattern-detector, narrative) and generates
 * ranked proposals for human review.
 *
 * This is the "doctor reading the reports" — turning raw metrics
 * into actionable improvement suggestions.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { loadDailyMetrics, type DailyMetricsSummary } from '../core/metrics-collector.js';
import { getTodayString } from '../core/timezone.js';

// ── Types ──────────────────────────────────────────────────────

export type ProposalSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ProposalSource =
  | 'learning-patterns'
  | 'evolution-metrics'
  | 'daily-metrics'
  | 'vitals'
  | 'reply-quality'
  | 'agent-performance'
  | 'work-patterns';

export interface Proposal {
  title: string;
  severity: ProposalSeverity;
  source: ProposalSource;
  evidence: string;       // data that triggered this proposal
  suggestion: string;     // actionable next step
  score: number;          // 0-100, higher = more urgent
}

// ── Signal readers ─────────────────────────────────────────────

const SOUL_DIR = join(process.cwd(), 'soul');
const DATA_DIR = join(process.cwd(), 'data');

interface LearningPatterns {
  patterns: {
    successes: Array<{ category: string; details: string; timestamp: string }>;
    failures: Array<{ category: string; details: string; timestamp: string }>;
    insights: string[];
  };
}

interface DailyMetrics {
  messages: { received: number; sent: number };
  agents: { tasksCompleted: number; tasksFailed: number };
  evolution: { attempts: number; successes: number; failures: number };
  performance: {
    eluP50?: number; eluP95?: number; eluMax?: number;
    fatigueP50?: number; fatigueP95?: number; fatigueMax?: number;
    heapMaxMB?: number;
  };
}

interface Vitals {
  energy_level: number;
  confidence_level: number;
  mood: string;
  identity_health_status?: string;
}

interface EvolutionMetricLine {
  timestamp: string;
  goalId: string;
  success: boolean;
  duration: number;
  failedStep?: string;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

// ── Analyzers ──────────────────────────────────────────────────

function analyzeLearningPatterns(data: LearningPatterns): Proposal[] {
  const proposals: Proposal[] = [];
  const { successes, failures } = data.patterns;

  // Group failures by category
  const failuresByCategory = new Map<string, number>();
  const recentCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days
  for (const f of failures) {
    if (new Date(f.timestamp).getTime() > recentCutoff) {
      failuresByCategory.set(f.category, (failuresByCategory.get(f.category) ?? 0) + 1);
    }
  }

  // Group recent successes for success rate
  const successesByCategory = new Map<string, number>();
  for (const s of successes) {
    if (new Date(s.timestamp).getTime() > recentCutoff) {
      successesByCategory.set(s.category, (successesByCategory.get(s.category) ?? 0) + 1);
    }
  }

  for (const [category, failCount] of failuresByCategory) {
    const successCount = successesByCategory.get(category) ?? 0;
    const total = failCount + successCount;
    const failRate = failCount / total;

    if (failCount >= 3 && failRate > 0.3) {
      proposals.push({
        title: `「${category}」類別失敗率偏高`,
        severity: failRate > 0.5 ? 'high' : 'medium',
        source: 'learning-patterns',
        evidence: `近 3 天：${failCount} 次失敗 / ${total} 次嘗試（失敗率 ${(failRate * 100).toFixed(0)}%）`,
        suggestion: `分析 ${category} 的失敗模式，找出共同原因`,
        score: Math.round(failRate * 60 + Math.min(failCount, 10) * 4),
      });
    }
  }

  return proposals;
}

function analyzeReplyQuality(data: LearningPatterns): Proposal[] {
  const proposals: Proposal[] = [];
  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Parse reply-quality details to extract dimension scores
  const recentQuality = data.patterns.successes
    .concat(data.patterns.failures)
    .filter(r => r.category === 'reply-quality' && new Date(r.timestamp).getTime() > recentCutoff);

  if (recentQuality.length < 5) return proposals;

  // Extract dimension scores from details string
  const dimensions = { length: 0, responsiveness: 0, emotion: 0, action: 0, clarity: 0 };
  let parsed = 0;

  for (const r of recentQuality) {
    const match = r.details.match(
      /長度=(\d+\.?\d*)\s*切題=(\d+\.?\d*)\s*情感=(\d+\.?\d*)\s*實用=(\d+\.?\d*)\s*清晰=(\d+\.?\d*)/,
    );
    if (match) {
      dimensions.length += parseFloat(match[1]!);
      dimensions.responsiveness += parseFloat(match[2]!);
      dimensions.emotion += parseFloat(match[3]!);
      dimensions.action += parseFloat(match[4]!);
      dimensions.clarity += parseFloat(match[5]!);
      parsed++;
    }
  }

  if (parsed < 5) return proposals;

  // Average each dimension
  const avg = {
    length: dimensions.length / parsed,
    responsiveness: dimensions.responsiveness / parsed,
    emotion: dimensions.emotion / parsed,
    action: dimensions.action / parsed,
    clarity: dimensions.clarity / parsed,
  };

  // Flag weak dimensions (< 0.6 average)
  const weakDims: string[] = [];
  if (avg.responsiveness < 0.6) weakDims.push(`切題度（${avg.responsiveness.toFixed(2)}）`);
  if (avg.emotion < 0.5) weakDims.push(`情感溫度（${avg.emotion.toFixed(2)}）`);
  if (avg.action < 0.5) weakDims.push(`實用性（${avg.action.toFixed(2)}）`);
  if (avg.clarity < 0.6) weakDims.push(`清晰度（${avg.clarity.toFixed(2)}）`);

  if (weakDims.length > 0) {
    const worstScore = Math.min(avg.responsiveness, avg.emotion, avg.action, avg.clarity);
    proposals.push({
      title: '回覆品質有改善空間',
      severity: worstScore < 0.4 ? 'high' : 'medium',
      source: 'reply-quality',
      evidence: `${parsed} 次回覆的弱維度：${weakDims.join('、')}`,
      suggestion: `針對最弱維度調整回覆策略`,
      score: Math.round((1 - worstScore) * 50 + weakDims.length * 10),
    });
  }

  return proposals;
}

function analyzeEvolutionMetrics(metrics: EvolutionMetricLine[]): Proposal[] {
  const proposals: Proposal[] = [];
  if (metrics.length < 2) return proposals;

  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = metrics.filter(m => new Date(m.timestamp).getTime() > recentCutoff);
  if (recent.length < 2) return proposals;

  const failures = recent.filter(m => !m.success);
  const failRate = failures.length / recent.length;

  if (failRate > 0.4 && failures.length >= 2) {
    // Analyze common failure steps
    const stepCounts = new Map<string, number>();
    for (const f of failures) {
      if (f.failedStep) {
        stepCounts.set(f.failedStep, (stepCounts.get(f.failedStep) ?? 0) + 1);
      }
    }
    const topStep = [...stepCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    proposals.push({
      title: '進化管線失敗率偏高',
      severity: failRate > 0.6 ? 'critical' : 'high',
      source: 'evolution-metrics',
      evidence: `近 7 天：${failures.length}/${recent.length} 次失敗（${(failRate * 100).toFixed(0)}%）` +
        (topStep ? `，最常失敗步驟：${topStep[0]}（${topStep[1]} 次）` : ''),
      suggestion: topStep
        ? `優先修復 ${topStep[0]} 步驟的穩定性`
        : '檢查 CLI 可用性和逾時設定',
      score: Math.round(failRate * 80 + failures.length * 3),
    });
  }

  // Duration anomaly
  const durations = recent.filter(m => m.success).map(m => m.duration);
  if (durations.length >= 3) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    const stddev = Math.sqrt(
      durations.reduce((s, d) => s + (d - mean) ** 2, 0) / durations.length,
    );
    const latest = durations[durations.length - 1]!;
    if (stddev > 0 && (latest - mean) / stddev > 2.5) {
      proposals.push({
        title: '進化耗時異常增加',
        severity: 'medium',
        source: 'evolution-metrics',
        evidence: `最近一次耗時 ${(latest / 1000).toFixed(1)}s，平均 ${(mean / 1000).toFixed(1)}s（Z=${((latest - mean) / stddev).toFixed(1)}）`,
        suggestion: '檢查進化目標複雜度或系統資源是否不足',
        score: 40,
      });
    }
  }

  return proposals;
}

function analyzeDailyMetrics(data: DailyMetrics): Proposal[] {
  const proposals: Proposal[] = [];

  // Agent task failures
  if (data.agents.tasksFailed > 0) {
    const total = data.agents.tasksCompleted + data.agents.tasksFailed;
    const failRate = data.agents.tasksFailed / total;
    proposals.push({
      title: '背景 Agent 任務失敗',
      severity: failRate > 0.5 ? 'high' : 'medium',
      source: 'agent-performance',
      evidence: `今日：${data.agents.tasksFailed} 個任務失敗（共 ${total} 個）`,
      suggestion: '檢查失敗的 Agent 日誌，確認是配置問題還是外部依賴問題',
      score: Math.round(failRate * 50 + data.agents.tasksFailed * 10),
    });
  }

  // Performance alerts
  if (data.performance.heapMaxMB && data.performance.heapMaxMB > 200) {
    proposals.push({
      title: '記憶體使用偏高',
      severity: data.performance.heapMaxMB > 500 ? 'high' : 'medium',
      source: 'daily-metrics',
      evidence: `Heap max: ${data.performance.heapMaxMB.toFixed(1)} MB`,
      suggestion: '檢查快取策略和 JSONL 檔案大小，考慮壓縮或清理',
      score: Math.round(Math.min(data.performance.heapMaxMB / 10, 60)),
    });
  }

  if (data.performance.fatigueP95 && data.performance.fatigueP95 > 50) {
    proposals.push({
      title: '系統疲勞度偏高',
      severity: data.performance.fatigueP95 > 80 ? 'high' : 'medium',
      source: 'daily-metrics',
      evidence: `Fatigue P95: ${data.performance.fatigueP95}`,
      suggestion: '增加休息間隔或降低並行任務數',
      score: Math.round(data.performance.fatigueP95 * 0.6),
    });
  }

  return proposals;
}

function analyzeVitals(vitals: Vitals): Proposal[] {
  const proposals: Proposal[] = [];

  if (vitals.identity_health_status === 'compromised') {
    proposals.push({
      title: '身份驗證狀態異常',
      severity: 'critical',
      source: 'vitals',
      evidence: `identity_health_status = ${vitals.identity_health_status}`,
      suggestion: '執行完整性檢查，考慮重建審計鏈或從快照恢復',
      score: 90,
    });
  } else if (vitals.identity_health_status === 'degraded') {
    proposals.push({
      title: '身份驗證狀態退化',
      severity: 'high',
      source: 'vitals',
      evidence: `identity_health_status = ${vitals.identity_health_status}`,
      suggestion: '執行靈魂完整性驗證，檢查哪些檢查項失敗',
      score: 70,
    });
  }

  if (vitals.confidence_level < 0.3) {
    proposals.push({
      title: '信心值偏低',
      severity: 'medium',
      source: 'vitals',
      evidence: `confidence = ${(vitals.confidence_level * 100).toFixed(0)}%`,
      suggestion: '執行小型且必定成功的進化任務來重建信心',
      score: Math.round((1 - vitals.confidence_level) * 40),
    });
  }

  if (vitals.energy_level < 0.2) {
    proposals.push({
      title: '精力嚴重不足',
      severity: 'high',
      source: 'vitals',
      evidence: `energy = ${(vitals.energy_level * 100).toFixed(0)}%`,
      suggestion: '進入休息狀態恢復精力，暫緩進化任務',
      score: Math.round((1 - vitals.energy_level) * 60),
    });
  }

  return proposals;
}

// ── Work pattern analyzer (cross-day ELU trends) ──────────────

const ELU_HIGH_THRESHOLD = 0.5; // P95 above this = high load day
const CONSECUTIVE_HIGH_DAYS_ALERT = 3;

async function analyzeWorkPatterns(): Promise<Proposal[]> {
  const proposals: Proposal[] = [];
  const today = getTodayString();

  // Load 7 days of metrics
  const days: DailyMetricsSummary[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const m = await loadDailyMetrics(dateStr);
    if (m) days.push(m);
  }

  if (days.length < 3) return proposals; // need at least 3 days of data

  // 1. ELU P50 trend — simple linear regression slope
  const eluP50s = days.map((d, i) => ({ x: i, y: d.performance.eluP50 }));
  const n = eluP50s.length;
  const meanX = eluP50s.reduce((s, p) => s + p.x, 0) / n;
  const meanY = eluP50s.reduce((s, p) => s + p.y, 0) / n;
  const num = eluP50s.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0);
  const den = eluP50s.reduce((s, p) => s + (p.x - meanX) ** 2, 0);
  const slope = den > 0 ? num / den : 0;

  // Significant upward trend: slope > 0.02 per day (2% ELU increase/day)
  if (slope > 0.02) {
    const weeklyIncrease = (slope * 7 * 100).toFixed(1);
    proposals.push({
      title: 'ELU 負載呈上升趨勢',
      severity: slope > 0.05 ? 'high' : 'medium',
      source: 'work-patterns',
      evidence: `${days.length} 日 ELU P50 趨勢斜率 +${(slope * 100).toFixed(2)}%/天（週增 ~${weeklyIncrease}%），最新值 ${(days[days.length - 1]!.performance.eluP50 * 100).toFixed(1)}%`,
      suggestion: '檢查是否有新增排程任務或記憶體洩漏導致負載持續上升',
      score: Math.round(Math.min(slope * 1000, 70)),
    });
  }

  // 2. Consecutive high-load days (P95 > threshold)
  let consecutiveHigh = 0;
  let maxConsecutive = 0;
  for (const d of days) {
    if (d.performance.eluP95 > ELU_HIGH_THRESHOLD) {
      consecutiveHigh++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveHigh);
    } else {
      consecutiveHigh = 0;
    }
  }

  if (maxConsecutive >= CONSECUTIVE_HIGH_DAYS_ALERT) {
    proposals.push({
      title: '連續高負載運行',
      severity: maxConsecutive >= 5 ? 'high' : 'medium',
      source: 'work-patterns',
      evidence: `連續 ${maxConsecutive} 天 ELU P95 超過 ${(ELU_HIGH_THRESHOLD * 100).toFixed(0)}%`,
      suggestion: '考慮降低並行 agent 數量或增加休息週期',
      score: Math.round(maxConsecutive * 15),
    });
  }

  // 3. Active/resting ratio trend
  const ratios: number[] = [];
  for (const d of days) {
    const active = d.lifecycle.stateSeconds['active'] ?? 0;
    const resting = d.lifecycle.stateSeconds['resting'] ?? d.lifecycle.stateSeconds['sleeping'] ?? 0;
    if (active + resting > 0) {
      ratios.push(active / (active + resting));
    }
  }

  if (ratios.length >= 3) {
    const recentAvg = ratios.slice(-3).reduce((s, r) => s + r, 0) / 3;
    const olderAvg = ratios.slice(0, -3).length > 0
      ? ratios.slice(0, -3).reduce((s, r) => s + r, 0) / ratios.slice(0, -3).length
      : recentAvg;

    if (recentAvg > 0.85 && recentAvg > olderAvg + 0.1) {
      proposals.push({
        title: '工作/休息比例失衡',
        severity: recentAvg > 0.95 ? 'high' : 'medium',
        source: 'work-patterns',
        evidence: `近 3 日活躍佔比 ${(recentAvg * 100).toFixed(0)}%（前期 ${(olderAvg * 100).toFixed(0)}%）`,
        suggestion: '增加休息時間以避免系統疲勞累積',
        score: Math.round(recentAvg * 50),
      });
    }
  }

  return proposals;
}

// ── Main engine ────────────────────────────────────────────────

/**
 * Generate ranked proposals by aggregating all signal sources.
 * Returns proposals sorted by score (highest first), deduplicated.
 */
export async function generateProposals(): Promise<Proposal[]> {
  const proposals: Proposal[] = [];

  // 1. Learning patterns + reply quality
  const patterns = await readJson<LearningPatterns>(join(SOUL_DIR, 'learning-patterns.json'));
  if (patterns) {
    proposals.push(...analyzeLearningPatterns(patterns));
    proposals.push(...analyzeReplyQuality(patterns));
  }

  // 2. Evolution metrics
  const evoMetrics = await readJsonl<EvolutionMetricLine>(join(DATA_DIR, 'evolution-metrics.jsonl'));
  proposals.push(...analyzeEvolutionMetrics(evoMetrics));

  // 3. Daily metrics (today)
  const today = getTodayString();
  const dailyMetrics = await readJson<DailyMetrics>(join(SOUL_DIR, 'metrics', `${today}.json`));
  if (dailyMetrics) {
    proposals.push(...analyzeDailyMetrics(dailyMetrics));
  }

  // 4. Vitals
  const vitals = await readJson<Vitals>(join(SOUL_DIR, 'vitals.json'));
  if (vitals) {
    proposals.push(...analyzeVitals(vitals));
  }

  // 5. Work patterns (cross-day ELU trends)
  proposals.push(...await analyzeWorkPatterns());

  // Sort by score descending, deduplicate by title
  const seen = new Set<string>();
  const unique = proposals.filter(p => {
    if (seen.has(p.title)) return false;
    seen.add(p.title);
    return true;
  });

  unique.sort((a, b) => b.score - a.score);

  await logger.debug('ProposalEngine', `Generated ${unique.length} proposals from ${proposals.length} raw signals`);

  return unique;
}

/**
 * Format proposals into human-readable text for Telegram.
 */
export function formatProposals(proposals: Proposal[]): string {
  if (proposals.length === 0) {
    return '目前沒有偵測到需要改善的項目。系統運行正常。';
  }

  const severityIcon: Record<ProposalSeverity, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢',
  };

  const lines: string[] = ['📊 *資料驅動進化提案*', ''];

  for (const [i, p] of proposals.entries()) {
    lines.push(`${severityIcon[p.severity]} *${i + 1}. ${p.title}*`);
    lines.push(`   來源：${p.source}`);
    lines.push(`   證據：${p.evidence}`);
    lines.push(`   建議：${p.suggestion}`);
    lines.push('');
  }

  lines.push(`共 ${proposals.length} 項提案，依緊急度排序。`);
  lines.push('使用 /goals add <描述> 將提案轉為進化目標。');

  return lines.join('\n');
}
