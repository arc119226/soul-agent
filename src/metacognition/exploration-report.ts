/**
 * Exploration Report Generator — synthesizes multi-agent reports into
 * a structured exploration report with cross-domain analysis.
 *
 * Reads from:
 *   - soul/agent-reports/{agentName}/{date}.jsonl (agent execution logs)
 *   - soul/learning-patterns.json (success/failure patterns)
 *   - soul/evolution/curiosity.json (knowledge gaps)
 *   - soul/reflections.jsonl (daily reflection insights)
 *   - soul/narrative.jsonl (lifecycle events)
 *
 * Outputs:
 *   - Structured ExplorationReport object for programmatic use
 *   - Markdown string for human/Telegram display
 *
 * Integration:
 *   - Called from reflection.ts during daily reflection
 *   - Can be triggered via EventBus 'exploration:synthesize' event
 *   - Results feed back into curiosity system as new questions
 */

import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { writer } from '../core/debounced-writer.js';
import { ok, fail, type Result } from '../result.js';
import type { AgentReport } from '../agents/worker-scheduler.js';

// ── Types ───────────────────────────────────────────────────────────

export interface ReportFinding {
  title: string;
  content: string;
  source: string;       // agent name that produced this
  importance: number;    // 1-5
  keywords: string[];
}

export interface CrossDomainConnection {
  domains: string[];     // which agent reports are connected
  description: string;
  strength: 'strong' | 'moderate' | 'tentative';
}

export interface ExplorationReport {
  timestamp: string;
  dateRange: { from: string; to: string };
  title: string;
  overview: string;
  findings: ReportFinding[];
  connections: CrossDomainConnection[];
  actionableInsights: string[];
  openQuestions: string[];
  importanceScore: number;    // 1-5
  sourcesUsed: number;
  totalCostUsd: number;
}

// ── Constants ───────────────────────────────────────────────────────

const REPORTS_DIR = join(process.cwd(), 'soul', 'agent-reports');
const SYNTHESIS_DIR = join(process.cwd(), 'soul', 'agent-reports', 'synthesis');
const CURIOSITY_PATH = join(process.cwd(), 'soul', 'evolution', 'curiosity.json');

// ── Data Collection ─────────────────────────────────────────────────

/**
 * Collect all agent reports from the given date range.
 * Returns reports grouped by agent name.
 */
async function collectReports(
  daysBack: number = 3,
): Promise<Map<string, AgentReport[]>> {
  const grouped = new Map<string, AgentReport[]>();
  const dates = generateDateStrings(daysBack);

  try {
    const agentDirs = await readdir(REPORTS_DIR).catch(() => [] as string[]);

    for (const agentDir of agentDirs) {
      // Skip synthesis dir itself
      if (agentDir === 'synthesis') continue;

      const reports: AgentReport[] = [];

      for (const dateStr of dates) {
        const filePath = join(REPORTS_DIR, agentDir, `${dateStr}.jsonl`);
        try {
          const raw = await readFile(filePath, 'utf-8');
          const lines = raw.trim().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const report = JSON.parse(line) as AgentReport;
              if (isUsableReport(report)) {
                reports.push(report);
              }
            } catch { /* skip malformed */ }
          }
        } catch { /* file doesn't exist for this date */ }
      }

      // Also check for standalone .md reports in the agent dir
      try {
        const files = await readdir(join(REPORTS_DIR, agentDir));
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          // Check if the file is within our date range
          const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
          if (dateMatch && dates.includes(dateMatch[1]!)) {
            const content = await readFile(join(REPORTS_DIR, agentDir, file), 'utf-8');
            reports.push({
              timestamp: dateMatch[1]!,
              agentName: agentDir,
              taskId: file,
              prompt: file.replace('.md', ''),
              result: content,
              costUsd: 0,
              duration: 0,
              confidence: 0.7,
            });
          }
        }
      } catch { /* dir listing failed */ }

      if (reports.length > 0) {
        grouped.set(agentDir, reports);
      }
    }

    // Also check top-level .md reports in REPORTS_DIR
    try {
      const topFiles = await readdir(REPORTS_DIR);
      for (const file of topFiles) {
        if (!file.endsWith('.md')) continue;
        const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && dates.includes(dateMatch[1]!)) {
          const content = await readFile(join(REPORTS_DIR, file), 'utf-8');
          const agentName = inferAgentFromFilename(file);
          const existing = grouped.get(agentName) ?? [];
          existing.push({
            timestamp: dateMatch[1]!,
            agentName,
            taskId: file,
            prompt: file.replace('.md', ''),
            result: content,
            costUsd: 0,
            duration: 0,
            confidence: 0.7,
          });
          grouped.set(agentName, existing);
        }
      }
    } catch { /* top-level read failed */ }
  } catch (err) {
    await logger.warn('ExplorationReport', 'Failed to collect reports', err);
  }

  return grouped;
}

/** Infer agent name from a top-level report filename */
function inferAgentFromFilename(filename: string): string {
  if (filename.includes('market-research')) return 'market-researcher';
  if (filename.includes('code-review')) return 'code-reviewer';
  if (filename.includes('research')) return 'deep-researcher';
  return 'misc';
}

/** Check if a report has usable content (not an error response) */
function isUsableReport(report: AgentReport): boolean {
  const result = report.result?.trim();
  if (!result || result.length < 30) return false;

  if (result.startsWith('{') && result.includes('"type"')) {
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>;
      if (parsed.is_error === true || parsed.subtype === 'error_max_turns') {
        return false;
      }
    } catch { /* not JSON, that's fine */ }
  }

  return true;
}

/** Generate date strings for the last N days */
function generateDateStrings(daysBack: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(Date.now() - i * 86400_000);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// ── Analysis Functions ──────────────────────────────────────────────

/**
 * Extract key findings from a single agent's reports.
 */
function extractFindings(
  agentName: string,
  reports: AgentReport[],
): ReportFinding[] {
  const findings: ReportFinding[] = [];

  for (const report of reports) {
    const result = report.result;

    // Extract sections with headers (## or ###)
    const sections = result.split(/(?=^#{2,3}\s)/m);

    for (const section of sections) {
      const headerMatch = section.match(/^#{2,3}\s+(.+)/);
      if (!headerMatch) continue;

      const title = headerMatch[1]!.trim();
      const content = section.slice(headerMatch[0].length).trim();

      // Skip structural headers
      if (isStructuralHeader(title)) continue;
      if (content.length < 20) continue;

      // Parse importance from content
      const importance = parseImportance(content) || estimateImportance(content);

      // Extract keywords from this section
      const keywords = extractSectionKeywords(title + ' ' + content);

      findings.push({
        title,
        content: truncateContent(content, 500),
        source: agentName,
        importance,
        keywords,
      });
    }
  }

  // Deduplicate by similar titles
  return deduplicateFindings(findings);
}

/** Headers that are structural, not content */
function isStructuralHeader(title: string): boolean {
  const structural = [
    '概述', '延伸問題', '重要性', 'sources', '來源',
    '目錄', '結論', '附錄', '參考',
  ];
  return structural.some((s) => title.toLowerCase().includes(s));
}

/** Parse explicit importance ratings like "重要性：4/5" */
function parseImportance(text: string): number | null {
  const match = text.match(/重要性[：:]\s*(\d)\/5/);
  return match ? parseInt(match[1]!, 10) : null;
}

/** Estimate importance from content heuristics */
function estimateImportance(content: string): number {
  let score = 3; // default

  // Longer content = likely more important
  if (content.length > 500) score += 0.5;
  if (content.length > 1000) score += 0.5;

  // Has external references
  if (content.includes('http')) score += 0.5;

  // Contains action words
  if (/建議|推薦|應該|需要|必須/.test(content)) score += 0.5;

  // Contains quantitative data
  if (/\d+%|\$[\d.]+|[\d,]+\s*(users|downloads|stars)/.test(content)) score += 0.5;

  return Math.min(Math.round(score), 5);
}

/** Extract keywords from a text section */
function extractSectionKeywords(text: string): string[] {
  const keywords: string[] = [];

  // English technical terms (2+ chars)
  const englishTerms = text.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*|[a-z]{4,}/g) ?? [];
  for (const term of englishTerms.slice(0, 5)) {
    if (!keywords.includes(term.toLowerCase())) {
      keywords.push(term.toLowerCase());
    }
  }

  // Chinese key phrases (2-4 chars between punctuation)
  const chineseTerms = text.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];
  const termFreq = new Map<string, number>();
  for (const term of chineseTerms) {
    termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
  }
  const topChinese = [...termFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term);
  keywords.push(...topChinese);

  return keywords.slice(0, 8);
}

/** Truncate content preserving sentence boundaries */
function truncateContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  // Try to cut at a sentence boundary
  const truncated = text.slice(0, maxLen);
  const lastSentence = truncated.lastIndexOf('。');
  const lastPeriod = truncated.lastIndexOf('. ');
  const cutPoint = Math.max(lastSentence, lastPeriod);

  if (cutPoint > maxLen * 0.5) {
    return text.slice(0, cutPoint + 1);
  }

  return truncated + '…';
}

/** Deduplicate findings by similar titles (Jaccard on words) */
function deduplicateFindings(findings: ReportFinding[]): ReportFinding[] {
  const result: ReportFinding[] = [];

  for (const finding of findings) {
    const titleWords = new Set(finding.title.toLowerCase().split(/\s+/));
    const isDuplicate = result.some((existing) => {
      const existingWords = new Set(existing.title.toLowerCase().split(/\s+/));
      let intersection = 0;
      for (const w of titleWords) {
        if (existingWords.has(w)) intersection++;
      }
      const union = titleWords.size + existingWords.size - intersection;
      return union > 0 && intersection / union > 0.6;
    });

    if (!isDuplicate) {
      result.push(finding);
    }
  }

  return result;
}

// ── Cross-Domain Analysis ───────────────────────────────────────────

/**
 * Detect connections between findings from different agents.
 * Uses keyword overlap to identify cross-domain themes.
 */
function detectConnections(
  allFindings: Map<string, ReportFinding[]>,
): CrossDomainConnection[] {
  const connections: CrossDomainConnection[] = [];
  const agents = [...allFindings.keys()];

  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const agentA = agents[i]!;
      const agentB = agents[j]!;
      const findingsA = allFindings.get(agentA) ?? [];
      const findingsB = allFindings.get(agentB) ?? [];

      // Compare keyword sets across agents
      const keywordsA = new Set(findingsA.flatMap((f) => f.keywords));
      const keywordsB = new Set(findingsB.flatMap((f) => f.keywords));

      let overlap = 0;
      const sharedKeywords: string[] = [];
      for (const kw of keywordsA) {
        if (keywordsB.has(kw)) {
          overlap++;
          sharedKeywords.push(kw);
        }
      }

      if (overlap >= 2) {
        const totalUnique = new Set([...keywordsA, ...keywordsB]).size;
        const ratio = overlap / totalUnique;

        let strength: 'strong' | 'moderate' | 'tentative';
        if (ratio > 0.3) strength = 'strong';
        else if (ratio > 0.15) strength = 'moderate';
        else strength = 'tentative';

        connections.push({
          domains: [agentA, agentB],
          description: `共享關鍵詞：${sharedKeywords.slice(0, 5).join('、')}`,
          strength,
        });
      }
    }
  }

  return connections.sort((a, b) => {
    const order = { strong: 0, moderate: 1, tentative: 2 };
    return order[a.strength] - order[b.strength];
  });
}

// ── Open Questions Extraction ───────────────────────────────────────

/**
 * Extract open questions from reports and curiosity system.
 */
async function gatherOpenQuestions(
  reports: Map<string, AgentReport[]>,
): Promise<string[]> {
  const questions: string[] = [];

  // Extract "延伸問題" from report content
  for (const [, agentReports] of reports) {
    for (const report of agentReports) {
      const extSection = report.result.match(
        /延伸問題[：:]?\s*\n([\s\S]*?)(?=\n#{2,3}\s|\n---|\n$)/,
      );
      if (extSection) {
        const lines = extSection[1]!.split('\n');
        for (const line of lines) {
          const cleaned = line.replace(/^\s*[-*\d.]+\s*/, '').trim();
          if (cleaned.length > 5 && !questions.includes(cleaned)) {
            questions.push(cleaned);
          }
        }
      }
    }
  }

  // Add unexplored curiosity topics
  try {
    const raw = await readFile(CURIOSITY_PATH, 'utf-8');
    const data = JSON.parse(raw) as { topics: Array<{ topic: string; explored: boolean }> };
    for (const topic of data.topics) {
      if (!topic.explored && !questions.some((q) => q.includes(topic.topic))) {
        questions.push(topic.topic);
      }
    }
  } catch { /* curiosity file not available */ }

  return questions.slice(0, 10);
}

// ── Actionable Insights ─────────────────────────────────────────────

/**
 * Derive actionable insights from findings and connections.
 */
function deriveActionableInsights(
  findings: ReportFinding[],
  connections: CrossDomainConnection[],
): string[] {
  const insights: string[] = [];

  // High-importance findings become direct insights
  const highImportance = findings.filter((f) => f.importance >= 4);
  for (const finding of highImportance.slice(0, 3)) {
    insights.push(`[${finding.source}] ${finding.title}：重要性 ${finding.importance}/5`);
  }

  // Strong cross-domain connections suggest synthesis opportunities
  const strongConnections = connections.filter((c) => c.strength === 'strong');
  for (const conn of strongConnections.slice(0, 2)) {
    insights.push(
      `跨域連結（${conn.domains.join(' × ')}）：${conn.description}——值得深入整合`,
    );
  }

  // Recommend areas with many findings
  const sourceCount = new Map<string, number>();
  for (const f of findings) {
    sourceCount.set(f.source, (sourceCount.get(f.source) ?? 0) + 1);
  }
  const topSource = [...sourceCount.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topSource && topSource[1] >= 3) {
    insights.push(`「${topSource[0]}」產出最多發現（${topSource[1]} 筆）——此領域值得持續關注`);
  }

  return insights;
}

// ── Report Generation ───────────────────────────────────────────────

/**
 * Generate a comprehensive exploration report from recent agent activities.
 *
 * @param daysBack — how many days of reports to include (default 3)
 * @returns Result containing the ExplorationReport
 */
export async function generateExplorationReport(
  daysBack: number = 3,
): Promise<Result<ExplorationReport>> {
  await logger.info('ExplorationReport', `Generating report (last ${daysBack} days)...`);

  // 1. Collect all agent reports
  const agentReports = await collectReports(daysBack);

  if (agentReports.size === 0) {
    return fail('沒有找到可用的 agent 報告來生成探索報告');
  }

  // 2. Extract findings per agent
  const findingsMap = new Map<string, ReportFinding[]>();
  const allFindings: ReportFinding[] = [];
  let totalCost = 0;
  let totalReports = 0;

  for (const [agentName, reports] of agentReports) {
    const agentFindings = extractFindings(agentName, reports);
    findingsMap.set(agentName, agentFindings);
    allFindings.push(...agentFindings);
    totalReports += reports.length;

    for (const r of reports) {
      totalCost += r.costUsd;
    }
  }

  // 3. Detect cross-domain connections
  const connections = detectConnections(findingsMap);

  // 4. Gather open questions
  const openQuestions = await gatherOpenQuestions(agentReports);

  // 5. Derive actionable insights
  const actionableInsights = deriveActionableInsights(allFindings, connections);

  // 6. Calculate overall importance
  const avgImportance = allFindings.length > 0
    ? allFindings.reduce((sum, f) => sum + f.importance, 0) / allFindings.length
    : 3;
  const importanceScore = Math.min(Math.round(avgImportance), 5);

  // 7. Build date range
  const dates = generateDateStrings(daysBack);
  const dateRange = {
    from: dates[dates.length - 1]!,
    to: dates[0]!,
  };

  // 8. Generate title and overview
  const agentNames = [...agentReports.keys()];
  const title = `探索綜合報告：${dateRange.from} ~ ${dateRange.to}`;
  const overview = buildOverview(agentNames, allFindings, connections);

  // 9. Sort findings by importance
  allFindings.sort((a, b) => b.importance - a.importance);

  const report: ExplorationReport = {
    timestamp: new Date().toISOString(),
    dateRange,
    title,
    overview,
    findings: allFindings.slice(0, 15), // Top 15 findings
    connections,
    actionableInsights,
    openQuestions,
    importanceScore,
    sourcesUsed: totalReports,
    totalCostUsd: totalCost,
  };

  // 10. Persist
  await persistReport(report);

  await logger.info('ExplorationReport',
    `Report generated: ${allFindings.length} findings, ${connections.length} connections, importance ${importanceScore}/5`);

  return ok('探索報告生成完成', report);
}

/** Build a concise overview paragraph */
function buildOverview(
  agentNames: string[],
  findings: ReportFinding[],
  connections: CrossDomainConnection[],
): string {
  const agentCount = agentNames.length;
  const findingCount = findings.length;
  const connectionCount = connections.length;
  const strongCount = connections.filter((c) => c.strength === 'strong').length;

  let overview = `本次報告綜合了 ${agentCount} 個代理人的探索成果，共提取出 ${findingCount} 項發現。`;

  if (connectionCount > 0) {
    overview += `其中發現 ${connectionCount} 個跨領域連結`;
    if (strongCount > 0) {
      overview += `（${strongCount} 個為強連結）`;
    }
    overview += '。';
  }

  // Mention top agents
  const agentFindingCounts = new Map<string, number>();
  for (const f of findings) {
    agentFindingCounts.set(f.source, (agentFindingCounts.get(f.source) ?? 0) + 1);
  }
  const topAgents = [...agentFindingCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `${name}(${count}筆)`)
    .join('、');

  if (topAgents) {
    overview += `主要貢獻者：${topAgents}。`;
  }

  return overview;
}

// ── Markdown Rendering ──────────────────────────────────────────────

/**
 * Render an ExplorationReport as a Markdown string.
 */
export function renderReportAsMarkdown(report: ExplorationReport): string {
  const lines: string[] = [];

  lines.push(`# ${report.title}`);
  lines.push(`> 生成時間：${report.timestamp.slice(0, 19).replace('T', ' ')}`);
  lines.push(`> 資料範圍：${report.dateRange.from} ~ ${report.dateRange.to}`);
  lines.push('');

  // Overview
  lines.push('## 概述');
  lines.push(report.overview);
  lines.push('');

  // Key Findings
  if (report.findings.length > 0) {
    lines.push('## 關鍵發現');
    lines.push('');

    for (let i = 0; i < report.findings.length; i++) {
      const f = report.findings[i]!;
      lines.push(`### ${i + 1}. ${f.title}`);
      lines.push(`*來源：${f.source} | 重要性：${'★'.repeat(f.importance)}${'☆'.repeat(5 - f.importance)}*`);
      lines.push('');
      lines.push(f.content);
      if (f.keywords.length > 0) {
        lines.push('');
        lines.push(`> 關鍵詞：${f.keywords.join('、')}`);
      }
      lines.push('');
    }
  }

  // Cross-Domain Connections
  if (report.connections.length > 0) {
    lines.push('## 跨領域連結');
    lines.push('');

    for (const conn of report.connections) {
      const strengthLabel = {
        strong: '🔴 強',
        moderate: '🟡 中',
        tentative: '⚪ 弱',
      }[conn.strength];

      lines.push(`- **${conn.domains.join(' × ')}** ${strengthLabel}`);
      lines.push(`  ${conn.description}`);
    }
    lines.push('');
  }

  // Actionable Insights
  if (report.actionableInsights.length > 0) {
    lines.push('## 可實踐洞見');
    lines.push('');
    for (const insight of report.actionableInsights) {
      lines.push(`- ${insight}`);
    }
    lines.push('');
  }

  // Open Questions
  if (report.openQuestions.length > 0) {
    lines.push('## 延伸問題');
    lines.push('');
    for (let i = 0; i < report.openQuestions.length; i++) {
      lines.push(`${i + 1}. ${report.openQuestions[i]}`);
    }
    lines.push('');
  }

  // Summary footer
  lines.push('---');
  lines.push(`**重要性：${report.importanceScore}/5** | 資料來源：${report.sourcesUsed} 份報告 | 花費：$${report.totalCostUsd.toFixed(2)}`);

  return lines.join('\n');
}

// ── Persistence ─────────────────────────────────────────────────────

/**
 * Save the report as both JSONL (structured) and Markdown (readable).
 */
async function persistReport(report: ExplorationReport): Promise<void> {
  await mkdir(SYNTHESIS_DIR, { recursive: true });

  const dateStr = report.timestamp.slice(0, 10);

  // JSONL for programmatic access
  const jsonlPath = join(SYNTHESIS_DIR, `${dateStr}.jsonl`);
  await writer.appendJsonl(jsonlPath, report);

  // Markdown for human reading
  const mdPath = join(SYNTHESIS_DIR, `${dateStr}-report.md`);
  const markdown = renderReportAsMarkdown(report);
  await writer.writeNow(mdPath, markdown);

  await logger.info('ExplorationReport', `Report persisted: ${mdPath}`);
}

// ── Integration: Feed Back to Curiosity ─────────────────────────────

/**
 * Feed open questions from the report back into the curiosity system.
 * Call this after report generation to close the exploration loop.
 */
export async function feedBackToCuriosity(
  report: ExplorationReport,
): Promise<number> {
  let added = 0;

  try {
    const { trackCuriosityTopic } = await import('./curiosity.js');

    for (const question of report.openQuestions.slice(0, 5)) {
      await trackCuriosityTopic(
        question,
        `從探索報告延伸（${report.dateRange.to}）`,
      );
      added++;
    }

    if (added > 0) {
      await logger.info('ExplorationReport',
        `Fed ${added} open questions back to curiosity system`);
    }
  } catch {
    await logger.warn('ExplorationReport', 'Could not feed back to curiosity system');
  }

  return added;
}

// ── Compact Summary for Context Weaving ─────────────────────────────

/**
 * Get a compact summary of the most recent exploration report.
 * Suitable for injection into the context-weaver system prompt.
 */
export async function getLatestReportSummary(): Promise<string | null> {
  try {
    const files = await readdir(SYNTHESIS_DIR).catch(() => [] as string[]);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl')).sort().reverse();

    if (jsonlFiles.length === 0) return null;

    const latest = jsonlFiles[0]!;
    const raw = await readFile(join(SYNTHESIS_DIR, latest), 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    if (lines.length === 0) return null;

    // Take the last report entry from the latest file
    const report = JSON.parse(lines[lines.length - 1]!) as ExplorationReport;

    // Build compact summary
    const topFindings = report.findings
      .slice(0, 3)
      .map((f) => `• ${f.title}（${f.source}，${f.importance}/5）`)
      .join('\n');

    const topInsights = report.actionableInsights
      .slice(0, 2)
      .map((i) => `• ${i}`)
      .join('\n');

    return [
      `📊 最近探索報告（${report.dateRange.to}）`,
      `重要性：${report.importanceScore}/5 | 來源：${report.sourcesUsed}份`,
      '',
      '主要發現：',
      topFindings,
      '',
      '洞見：',
      topInsights,
    ].join('\n');
  } catch {
    return null;
  }
}

// ── EventBus Integration ────────────────────────────────────────────

/**
 * Register EventBus listener for 'exploration:synthesize'.
 * Call this once during bot initialization.
 */
export function initExplorationReportListener(): void {
  import('../core/event-bus.js').then(({ eventBus }) => {
    eventBus.on('exploration:synthesize', async (data) => {
      const daysBack = data.daysBack ?? 3;
      const result = await generateExplorationReport(daysBack);
      if (result.ok) {
        await feedBackToCuriosity(result.value);
        await logger.info('ExplorationReport',
          `Synthesized via event: ${result.value.findings.length} findings`);
      }
    });
    logger.info('ExplorationReport', 'EventBus listener registered for exploration:synthesize');
  });
}
