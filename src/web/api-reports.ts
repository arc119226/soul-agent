/**
 * API handlers for report viewing and search.
 *
 * Endpoints:
 *   GET /api/reports              → Paginated report listing
 *   GET /api/reports/:id          → Full report with markdown content
 *   GET /api/reports/search?q=    → Full-text search via FTS5
 */

import { getDb } from '../core/database.js';
import { logger } from '../core/logger.js';

// ── Report List ─────────────────────────────────────────────────────

export interface ReportListItem {
  id: number;
  timestamp: string;
  agentName: string;
  taskId: string | null;
  promptSnippet: string;
  resultSnippet: string;
  costUsd: number;
  duration: number;
  confidence: number;
}

export interface ReportListResponse {
  total: number;
  page: number;
  pageSize: number;
  reports: ReportListItem[];
}

export function gatherReportList(opts: {
  agent?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}): ReportListResponse {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const offset = (page - 1) * limit;

  try {
    const db = getDb();

    // Build WHERE clauses dynamically
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.agent) {
      conditions.push('agent_name = ?');
      params.push(opts.agent);
    }
    if (opts.from) {
      conditions.push('timestamp >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      conditions.push('timestamp <= ?');
      params.push(opts.to + 'T23:59:59');
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Count total
    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM agent_reports ${where}`).get(...params) as { cnt: number };
    const total = countRow.cnt;

    // Fetch page
    const rows = db.prepare(`
      SELECT id, timestamp, agent_name,task_id,
             SUBSTR(COALESCE(prompt, ''), 1, 200) AS prompt_snippet,
             SUBSTR(COALESCE(result, ''), 1, 400) AS result_snippet,
             cost_usd, duration, confidence
      FROM agent_reports
      ${where}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      total,
      page,
      pageSize: limit,
      reports: rows.map(r => ({
        id: r.id as number,
        timestamp: r.timestamp as string,
        agentName: r.agent_name as string,
        taskId: (r.task_id as string) ?? null,
        promptSnippet: (r.prompt_snippet as string) ?? '',
        resultSnippet: (r.result_snippet as string) ?? '',
        costUsd: (r.cost_usd as number) ?? 0,
        duration: (r.duration as number) ?? 0,
        confidence: (r.confidence as number) ?? 0,
      })),
    };
  } catch (err) {
    logger.warn('API-Reports', 'gatherReportList failed', err);
    return { total: 0, page, pageSize: limit, reports: [] };
  }
}

// ── Report Detail ───────────────────────────────────────────────────

export interface ReportDetail {
  id: number;
  timestamp: string;
  agentName: string;
  taskId: string | null;
  prompt: string;
  result: string;
  costUsd: number;
  duration: number;
  confidence: number;
  traceSummary: string | null;
}

export function gatherReportDetail(id: number): ReportDetail | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM agent_reports WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: row.id as number,
      timestamp: row.timestamp as string,
      agentName: row.agent_name as string,
      taskId: (row.task_id as string) ?? null,
      prompt: (row.prompt as string) ?? '',
      result: (row.result as string) ?? '',
      costUsd: (row.cost_usd as number) ?? 0,
      duration: (row.duration as number) ?? 0,
      confidence: (row.confidence as number) ?? 0,
      traceSummary: (row.trace_summary as string) ?? null,
    };
  } catch (err) {
    logger.warn('API-Reports', `gatherReportDetail(${id}) failed`, err);
    return null;
  }
}

// ── Report Search ───────────────────────────────────────────────────

export async function gatherReportSearch(query: string, limit = 20): Promise<ReportListItem[]> {
  try {
    const { searchReports } = await import('../agents/report-search.js');
    const results = searchReports({ query, limit, full: false });
    return results.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      agentName: r.agent_name,
      taskId: r.task_id ?? null,
      promptSnippet: r.prompt_snippet ?? '',
      resultSnippet: r.result_snippet ?? '',
      costUsd: 0,
      duration: 0,
      confidence: 0,
    }));
  } catch (err) {
    logger.warn('API-Reports', 'gatherReportSearch failed', err);
    return [];
  }
}
