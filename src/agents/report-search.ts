import type Database from 'better-sqlite3';
import { getDb } from '../core/database.js';

export interface ReportSearchOptions {
  query: string;
  agentName?: string;
  limit: number;
  full: boolean;
}

export interface ReportSearchResult {
  id: number;
  agent_name: string;
  timestamp: string;
  task_id: string | null;
  prompt_snippet: string;
  result_snippet: string;
  trace_summary: string | null;
  score: number;
  full_result?: string;
}

/**
 * Escape a user query for safe use in FTS5 MATCH.
 *
 * FTS5 query syntax treats `*`, `"`, `NEAR`, `AND`, `OR`, `NOT`, `(`, `)` as
 * special operators. Unmatched quotes or stray operators throw exceptions.
 *
 * Strategy: strip all double quotes, split on whitespace, wrap each non-empty
 * token in double quotes. This forces literal matching and neutralizes operators.
 */
export function escapeFts5Query(raw: string): string {
  const stripped = raw.replace(/"/g, '');
  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t}"`).join(' ');
}

export function searchReports(opts: ReportSearchOptions): ReportSearchResult[] {
  const db = getDb();
  const { query, agentName, limit, full } = opts;

  // Short query fallback: trigram needs ≥3 chars
  if (query.length < 3) {
    return shortQueryFallback(db, opts);
  }

  // --- FTS5 MATCH path ---
  const safeQuery = escapeFts5Query(query);

  const agentFilter = agentName ? 'AND r.agent_name = ?' : '';
  const params: unknown[] = [safeQuery];
  if (agentName) params.push(agentName);
  params.push(limit);

  // Snippet token counts: prompt=16, result=32 (increased for CJK)
  const sql = `
    SELECT
      r.id,
      r.agent_name,
      r.timestamp,
      r.task_id,
      snippet(agent_reports_fts, 0, '>>>', '<<<', '...', 16) AS prompt_snippet,
      snippet(agent_reports_fts, 1, '>>>', '<<<', '...', 32) AS result_snippet,
      r.trace_summary,
      bm25(agent_reports_fts, 5.0, 1.0, 2.0) AS score
      ${full ? ', r.result AS full_result' : ''}
    FROM agent_reports_fts
    JOIN agent_reports r ON r.id = agent_reports_fts.rowid
    WHERE agent_reports_fts MATCH ?
    ${agentFilter}
    ORDER BY bm25(agent_reports_fts, 5.0, 1.0, 2.0)
    LIMIT ?
  `;

  return db.prepare(sql).all(...params) as ReportSearchResult[];
}

function shortQueryFallback(db: Database.Database, opts: ReportSearchOptions): ReportSearchResult[] {
  const { query, agentName, limit, full } = opts;
  const pattern = `%${query}%`;
  const agentFilter = agentName ? 'AND agent_name = ?' : '';
  const params: unknown[] = [pattern, pattern, pattern];
  if (agentName) params.push(agentName);
  params.push(limit);

  const sql = `
    SELECT id, agent_name, timestamp, task_id,
           SUBSTR(COALESCE(prompt, ''), 1, 200) AS prompt_snippet,
           SUBSTR(COALESCE(result, ''), 1, 400) AS result_snippet,
           trace_summary,
           0 AS score
           ${full ? ', result AS full_result' : ''}
    FROM agent_reports
    WHERE (prompt LIKE ? OR result LIKE ? OR trace_summary LIKE ?)
    ${agentFilter}
    ORDER BY timestamp DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params) as ReportSearchResult[];
}
