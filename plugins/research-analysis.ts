/**
 * Research Analysis Plugin — deep research, tech comparison, and report management.
 *
 * Replaces the Markdown skill `soul/skills/research-analysis.md` with active functionality:
 *   - research <topic>     → dispatch deep research task to background agent
 *   - research compare <A> vs <B> → structured comparison
 *   - research list         → list past research reports
 *   - research <number>     → view specific report detail
 *   - research suggest      → topic suggestions from recent HN/exploration
 *
 * Delegates actual research to the deep-researcher agent via worker-scheduler.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from '../src/plugins/plugin-api.js';
import { enqueueTask, type AgentReport } from '../src/agents/worker-scheduler.js';

// ── Constants ───────────────────────────────────────────────────────

const RESEARCHER_DIR = join(process.cwd(), 'soul', 'agent-reports', 'deep-researcher');
const HN_DIGEST_DIR = join(process.cwd(), 'soul', 'agent-reports', 'hackernews-digest');

// ── Report Loading ──────────────────────────────────────────────────

function isUsableReport(report: AgentReport): boolean {
  const result = report.result?.trim();
  if (!result || result.length < 30) return false;
  if (result.startsWith('{') && result.includes('"type"')) {
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>;
      if (parsed.is_error === true || parsed.subtype === 'error_max_turns') return false;
    } catch { /* not JSON, keep it */ }
  }
  return true;
}

async function loadReports(): Promise<AgentReport[]> {
  const reports: AgentReport[] = [];
  try {
    const files = await readdir(RESEARCHER_DIR);
    for (const file of files.filter((f) => f.endsWith('.jsonl')).sort().reverse()) {
      const raw = await readFile(join(RESEARCHER_DIR, file), 'utf-8');
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        try {
          const report = JSON.parse(line) as AgentReport;
          if (isUsableReport(report)) reports.push(report);
        } catch { /* skip malformed */ }
      }
    }
  } catch { /* dir doesn't exist */ }
  reports.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return reports;
}

// ── Display Helpers ─────────────────────────────────────────────────

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  return `${Math.floor(hours / 24)}d 前`;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + '...';
}

function extractTopic(prompt: string): string {
  const match = prompt.match(/主題[：:]\s*(.+)/);
  if (match?.[1]) return match[1].trim().slice(0, 60);
  return truncate(prompt.split('\n')[0] || prompt, 60);
}

// ── Research Prompts ────────────────────────────────────────────────

function buildResearchPrompt(topic: string): string {
  return [
    '## 深度研究任務',
    '',
    `主題：${topic}`,
    '',
    '## 研究步驟',
    '',
    '1. 用 2-3 次搜尋理解主題的全貌',
    '2. 閱讀最相關的 2-3 個網頁，提取關鍵資訊',
    '3. 彙整成結構化的研究報告',
    '',
    '## 報告格式',
    '',
    '# {主題} 深度研究報告',
    '',
    '> 研究日期：{今天日期}',
    '',
    '## 概述',
    '{2-3 句概括}',
    '',
    '## 關鍵發現',
    '### 1. {發現標題}',
    '{說明，附來源}',
    '',
    '(列出 3-5 個關鍵發現)',
    '',
    '## 與我們專案的關聯',
    '{這些發現對 本專案有什麼啟發或應用？}',
    '',
    '## 延伸問題',
    '1. {值得繼續研究的問題}',
    '2. {值得繼續研究的問題}',
    '',
    '## 重要性：X/5',
    '',
    '## 注意事項',
    '- 用繁體中文撰寫',
    '- 每個發現標注來源（URL）',
    '- 整份報告 500-1000 字',
  ].join('\n');
}

function buildComparePrompt(a: string, b: string): string {
  return [
    '## 技術比較任務',
    '',
    `比較對象：${a} vs ${b}`,
    '',
    '## 研究步驟',
    '',
    `1. 分別搜尋 "${a}" 和 "${b}" 的最新資訊`,
    '2. 從官方文件、GitHub、技術部落格收集數據',
    '3. 按照以下維度進行結構化比較',
    '',
    '## 報告格式',
    '',
    `# ${a} vs ${b} 比較報告`,
    '',
    '> 比較日期：{今天日期}',
    '',
    '## 概述',
    '{各自一句話介紹}',
    '',
    '## 比較表',
    '',
    `| 維度 | ${a} | ${b} |`,
    '|------|---|---|',
    '| 效能 | ... | ... |',
    '| 學習曲線 | ... | ... |',
    '| 生態系 | ... | ... |',
    '| 成熟度 | ... | ... |',
    '| 適合場景 | ... | ... |',
    '| 社群活躍度 | ... | ... |',
    '',
    '## 各自優勢',
    `### ${a} 的優勢`,
    '1. ...',
    '',
    `### ${b} 的優勢`,
    '1. ...',
    '',
    '## 建議',
    '根據我們的專案特點（TypeScript + ESM + Telegram Bot），推薦 {X}，因為...',
    '',
    '## 注意事項',
    '- 用繁體中文撰寫',
    '- 數據要附來源',
    '- 整份報告 500-1000 字',
  ].join('\n');
}

// ── Topic Suggestions ───────────────────────────────────────────────

async function getTopicSuggestions(): Promise<string[]> {
  const suggestions: string[] = [];
  try {
    const files = await readdir(HN_DIGEST_DIR);
    const mdFiles = files.filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 3);
    for (const file of mdFiles) {
      const content = await readFile(join(HN_DIGEST_DIR, file), 'utf-8');
      // Extract section headers as topic candidates
      const headers = content.match(/### .+/g) || [];
      for (const h of headers.slice(0, 3)) {
        const topic = h
          .replace(/^###\s*\d*\.?\s*/, '')
          .replace(/\*\*/g, '')
          .replace(/\s*\(.*?\)\s*$/, '')
          .trim();
        if (topic.length > 5 && topic.length < 80) {
          suggestions.push(topic);
        }
      }
    }
  } catch { /* no digests */ }
  return suggestions.slice(0, 5);
}

// ── Sub-command Handlers ────────────────────────────────────────────

async function handleNew(
  sendMarkdown: (text: string) => Promise<void>,
  topic: string,
): Promise<void> {
  const prompt = buildResearchPrompt(topic);
  try {
    const taskId = await enqueueTask('deep-researcher', prompt, 8);
    await sendMarkdown(
      `📚 **深度研究已派遣**\n\n` +
      `🔬 主題：${topic}\n` +
      `🆔 任務 ID：\`${taskId.slice(0, 8)}\`\n\n` +
      `研究代理人正在背景執行。\n完成後可用 \`研究 list\` 查看結果。`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMarkdown(`❌ 研究任務派遣失敗：${msg}`);
  }
}

async function handleCompare(
  sendMarkdown: (text: string) => Promise<void>,
  a: string,
  b: string,
): Promise<void> {
  const prompt = buildComparePrompt(a, b);
  try {
    const taskId = await enqueueTask('deep-researcher', prompt, 8);
    await sendMarkdown(
      `⚖️ **技術比較已派遣**\n\n` +
      `📊 比較：${a} vs ${b}\n` +
      `🆔 任務 ID：\`${taskId.slice(0, 8)}\`\n\n` +
      `研究代理人正在背景執行。\n完成後可用 \`研究 list\` 查看結果。`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMarkdown(`❌ 比較任務派遣失敗：${msg}`);
  }
}

async function handleList(sendMarkdown: (text: string) => Promise<void>): Promise<void> {
  const reports = await loadReports();
  if (reports.length === 0) {
    await sendMarkdown(
      '📚 還沒有深度研究紀錄。\n\n' +
      '**使用方式：**\n' +
      '• `研究 <主題>` — 啟動深度研究\n' +
      '• `研究 compare <A> vs <B>` — 技術比較\n' +
      '• `研究 suggest` — 推薦研究主題',
    );
    return;
  }

  const lines = [`📚 **深度研究紀錄**（共 ${reports.length} 筆）`, ''];
  const byDate = new Map<string, { report: AgentReport; index: number }[]>();
  reports.forEach((r, i) => {
    const date = r.timestamp.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push({ report: r, index: i });
  });

  for (const [date, entries] of byDate) {
    lines.push(`📅 **${date}**`);
    for (const { report, index } of entries) {
      const topic = extractTopic(report.prompt);
      lines.push(`  ${index + 1}. ${topic} (${timeAgo(report.timestamp)})`);
    }
    lines.push('');
  }

  lines.push('💡 輸入 `研究 <編號>` 查看詳情');
  await sendMarkdown(lines.join('\n'));
}

async function handleDetail(
  sendMarkdown: (text: string) => Promise<void>,
  sendLong: (text: string) => Promise<void>,
  index: number,
): Promise<void> {
  const reports = await loadReports();
  if (index < 0 || index >= reports.length) {
    await sendMarkdown(`❌ 找不到研究 #${index + 1}。目前共有 ${reports.length} 筆。`);
    return;
  }

  const report = reports[index]!;
  const text = [
    `📚 **研究 #${index + 1}**`,
    `📅 ${report.timestamp.slice(0, 10)} ${new Date(report.timestamp).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' })}`,
    `🔬 ${extractTopic(report.prompt)}`,
    '',
    report.result,
    '',
    `── 花費 $${report.costUsd.toFixed(2)} | 耗時 ${Math.round(report.duration / 1000)}s`,
  ].join('\n');

  await sendLong(text);
}

async function handleSuggest(sendMarkdown: (text: string) => Promise<void>): Promise<void> {
  const suggestions = await getTopicSuggestions();
  if (suggestions.length === 0) {
    await sendMarkdown('💡 目前沒有推薦主題。先跑一次 HN 摘要來收集靈感吧！');
    return;
  }

  const lines = ['💡 **推薦研究主題**（來自近期 HN 摘要）', ''];
  suggestions.forEach((s, i) => {
    lines.push(`${i + 1}. ${s}`);
  });
  lines.push('');
  lines.push('輸入 `研究 <主題>` 開始深度研究');

  await sendMarkdown(lines.join('\n'));
}

// ── Plugin Definition ───────────────────────────────────────────────

const plugin: Plugin = {
  meta: {
    name: 'research',
    description: '深度研究分析 — 項目調研、技術比較、可行性分析',
    icon: '🔬',
    aliases: ['研究', '調研', '分析', 'analyze', 'research'],
    version: '2.0.0',
  },

  handler: async (ctx, args) => {
    const trimmed = args.trim();

    // No args → show recent reports
    if (!trimmed) {
      await handleList(ctx.sendMarkdown);
      return;
    }

    // Sub-commands
    const parts = trimmed.split(/\s+/);
    const sub = parts[0]!.toLowerCase();

    // compare <A> vs <B>
    if (sub === 'compare' || sub === '比較') {
      const rest = parts.slice(1).join(' ');
      const vsMatch = rest.match(/^(.+?)\s+(?:vs|VS|對比|比較)\s+(.+)$/);
      if (vsMatch) {
        await handleCompare(ctx.sendMarkdown, vsMatch[1]!.trim(), vsMatch[2]!.trim());
      } else {
        await ctx.sendMarkdown(
          '⚖️ **技術比較格式：**\n\n' +
          '`研究 compare <A> vs <B>`\n\n' +
          '例如：`研究 compare Redis vs Memcached`',
        );
      }
      return;
    }

    // list
    if (sub === 'list' || sub === '列表') {
      await handleList(ctx.sendMarkdown);
      return;
    }

    // suggest
    if (sub === 'suggest' || sub === '推薦' || sub === '建議') {
      await handleSuggest(ctx.sendMarkdown);
      return;
    }

    // number → view detail
    const n = parseInt(trimmed, 10);
    if (!isNaN(n) && n >= 1 && trimmed.length <= 3) {
      await handleDetail(ctx.sendMarkdown, ctx.sendLongMessage, n - 1);
      return;
    }

    // Anything else → start new research
    await handleNew(ctx.sendMarkdown, trimmed);
  },
};

export default plugin;
