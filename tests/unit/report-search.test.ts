import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Create in-memory DB and mock getDb
let db: Database.Database;

vi.mock('../../src/core/database.js', () => ({
  getDb: () => db,
}));

// Import after mocks are set up
import { searchReports, escapeFts5Query } from '../../src/agents/report-search.js';

/** Run migrations v1-v3 on in-memory DB (simplified — only agent_reports + FTS) */
function setupSchema(database: Database.Database): void {
  database.pragma('journal_mode = WAL');

  // agent_reports table (subset of v1 schema)
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_reports (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT    NOT NULL,
      agent_name    TEXT    NOT NULL,
      task_id       TEXT,
      prompt        TEXT,
      result        TEXT,
      cost_usd      REAL    DEFAULT 0,
      duration      INTEGER,
      confidence    REAL,
      trace_summary TEXT,
      metadata      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reports_agent ON agent_reports(agent_name);
    CREATE INDEX IF NOT EXISTS idx_reports_ts ON agent_reports(timestamp);
  `);

  // v3: FTS5 + triggers
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS agent_reports_fts USING fts5(
      prompt,
      result,
      trace_summary,
      content = agent_reports,
      content_rowid = id,
      tokenize = 'trigram case_sensitive 0'
    );

    CREATE TRIGGER IF NOT EXISTS agent_reports_ai AFTER INSERT ON agent_reports BEGIN
      INSERT INTO agent_reports_fts(rowid, prompt, result, trace_summary)
      VALUES (new.id, new.prompt, new.result, new.trace_summary);
    END;

    CREATE TRIGGER IF NOT EXISTS agent_reports_ad AFTER DELETE ON agent_reports BEGIN
      INSERT INTO agent_reports_fts(agent_reports_fts, rowid, prompt, result, trace_summary)
      VALUES ('delete', old.id, old.prompt, old.result, old.trace_summary);
    END;

    CREATE TRIGGER IF NOT EXISTS agent_reports_au AFTER UPDATE ON agent_reports BEGIN
      INSERT INTO agent_reports_fts(agent_reports_fts, rowid, prompt, result, trace_summary)
      VALUES ('delete', old.id, old.prompt, old.result, old.trace_summary);
      INSERT INTO agent_reports_fts(rowid, prompt, result, trace_summary)
      VALUES (new.id, new.prompt, new.result, new.trace_summary);
    END;
  `);
}

function insertReport(opts: {
  agent_name: string;
  prompt?: string | null;
  result?: string | null;
  trace_summary?: string | null;
  task_id?: string | null;
  timestamp?: string;
}): number {
  const r = db.prepare(
    `INSERT INTO agent_reports (timestamp, agent_name, task_id, prompt, result, trace_summary)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.timestamp ?? new Date().toISOString(),
    opts.agent_name,
    opts.task_id ?? null,
    opts.prompt ?? null,
    opts.result ?? null,
    opts.trace_summary ?? null,
  );
  return Number(r.lastInsertRowid);
}

beforeAll(() => {
  db = new Database(':memory:');
  setupSchema(db);
});

afterAll(() => {
  db.close();
});

describe('escapeFts5Query', () => {
  it('wraps tokens in double quotes', () => {
    expect(escapeFts5Query('SQLite FTS5')).toBe('"SQLite" "FTS5"');
  });

  it('strips existing double quotes', () => {
    expect(escapeFts5Query('hello "world')).toBe('"hello" "world"');
  });

  it('neutralizes FTS5 operators', () => {
    expect(escapeFts5Query('A OR B')).toBe('"A" "OR" "B"');
    expect(escapeFts5Query('A NOT B')).toBe('"A" "NOT" "B"');
  });

  it('handles empty/whitespace input', () => {
    expect(escapeFts5Query('')).toBe('""');
    expect(escapeFts5Query('   ')).toBe('""');
  });

  it('handles asterisk wildcards', () => {
    expect(escapeFts5Query('test*')).toBe('"test*"');
  });
});

describe('searchReports', () => {
  describe('FTS5 MATCH path (query >= 3 chars)', () => {
    it('finds English keyword in result', () => {
      insertReport({
        agent_name: 'test-agent',
        prompt: 'Do something',
        result: 'SQLite database migration completed successfully',
      });

      const results = searchReports({ query: 'SQLite', limit: 10, full: false });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.agent_name).toBe('test-agent');
    });

    it('finds CJK keyword (3+ chars) in result', () => {
      insertReport({
        agent_name: 'architect',
        prompt: '設計全文搜尋方案',
        result: '全文搜尋設計報告：使用 FTS5 trigram tokenizer',
      });

      const results = searchReports({ query: '全文搜尋', limit: 10, full: false });
      expect(results.length).toBeGreaterThan(0);
    });

    it('ranks prompt matches higher than result matches', () => {
      // Clear existing data
      db.exec('DELETE FROM agent_reports');

      insertReport({
        agent_name: 'agent-a',
        prompt: 'Implement database indexing strategy',
        result: 'Some unrelated output text here',
      });
      insertReport({
        agent_name: 'agent-b',
        prompt: 'Some unrelated prompt text here',
        result: 'The database indexing strategy was implemented',
      });

      const results = searchReports({ query: 'indexing', limit: 10, full: false });
      expect(results.length).toBe(2);
      // prompt weight=5.0 vs result weight=1.0, so agent-a should rank first
      // BM25 returns negative scores, more negative = better match
      expect(results[0]!.agent_name).toBe('agent-a');
    });

    it('filters by agent_name', () => {
      db.exec('DELETE FROM agent_reports');

      insertReport({ agent_name: 'alpha', prompt: 'performance optimization task', result: 'done' });
      insertReport({ agent_name: 'beta', prompt: 'performance tuning task', result: 'done' });

      const results = searchReports({ query: 'performance', agentName: 'alpha', limit: 10, full: false });
      expect(results.length).toBe(1);
      expect(results[0]!.agent_name).toBe('alpha');
    });

    it('returns snippets with markers', () => {
      db.exec('DELETE FROM agent_reports');

      insertReport({
        agent_name: 'test',
        prompt: 'Analyze the SQLite performance metrics',
        result: 'SQLite metrics look good',
      });

      const results = searchReports({ query: 'SQLite', limit: 10, full: false });
      expect(results.length).toBeGreaterThan(0);
      const r = results[0]!;
      // Snippet should contain >>> and <<< markers
      expect(r.prompt_snippet + r.result_snippet).toMatch(/>>>/);
      expect(r.prompt_snippet + r.result_snippet).toMatch(/<<</);
    });

    it('returns full_result when full=true', () => {
      db.exec('DELETE FROM agent_reports');

      const fullText = 'This is the complete result text for verification purposes';
      insertReport({
        agent_name: 'test',
        prompt: 'verification task',
        result: fullText,
      });

      const results = searchReports({ query: 'verification', limit: 10, full: true });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.full_result).toBe(fullText);
    });

    it('respects limit parameter', () => {
      db.exec('DELETE FROM agent_reports');

      for (let i = 0; i < 20; i++) {
        insertReport({
          agent_name: 'bulk',
          prompt: `migration task number ${i}`,
          result: `completed migration ${i}`,
        });
      }

      const results = searchReports({ query: 'migration', limit: 5, full: false });
      expect(results.length).toBe(5);
    });

    it('handles no matches gracefully', () => {
      const results = searchReports({ query: 'xyznonexistent', limit: 10, full: false });
      expect(results).toEqual([]);
    });

    it('handles malicious FTS5 syntax gracefully', () => {
      // Unmatched quotes — should not throw
      expect(() => searchReports({ query: 'hello "world', limit: 10, full: false })).not.toThrow();

      // FTS5 operators — should not throw
      expect(() => searchReports({ query: 'NEAR(a,b)', limit: 10, full: false })).not.toThrow();

      // Asterisk — should not throw
      expect(() => searchReports({ query: 'test*', limit: 10, full: false })).not.toThrow();
    });
  });

  describe('Short query fallback (query < 3 chars)', () => {
    it('falls back to LIKE for 2-char CJK query', () => {
      db.exec('DELETE FROM agent_reports');

      insertReport({
        agent_name: 'test',
        prompt: '中文處理',
        result: 'Processed Chinese text',
      });

      const results = searchReports({ query: '中文', limit: 10, full: false });
      expect(results.length).toBeGreaterThan(0);
    });

    it('falls back to LIKE for 1-char query', () => {
      db.exec('DELETE FROM agent_reports');

      insertReport({
        agent_name: 'test',
        prompt: 'X marks the spot',
        result: 'Found it',
      });

      const results = searchReports({ query: 'X', limit: 10, full: false });
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns full_result when full=true in fallback', () => {
      db.exec('DELETE FROM agent_reports');

      const fullText = 'AB full result content';
      insertReport({
        agent_name: 'test',
        prompt: 'AB task',
        result: fullText,
      });

      const results = searchReports({ query: 'AB', limit: 10, full: true });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.full_result).toBe(fullText);
    });
  });

  describe('Sync triggers', () => {
    it('new INSERT is searchable immediately', () => {
      db.exec('DELETE FROM agent_reports');

      insertReport({
        agent_name: 'trigger-test',
        prompt: 'synchronization verification',
        result: 'trigger works',
      });

      const results = searchReports({ query: 'synchronization', limit: 10, full: false });
      expect(results.length).toBe(1);
    });

    it('DELETE removes from FTS index', () => {
      db.exec('DELETE FROM agent_reports');

      const id = insertReport({
        agent_name: 'trigger-test',
        prompt: 'deletable content here',
        result: 'to be removed',
      });

      // Verify searchable
      let results = searchReports({ query: 'deletable', limit: 10, full: false });
      expect(results.length).toBe(1);

      // Delete
      db.prepare('DELETE FROM agent_reports WHERE id = ?').run(id);

      // Verify no longer searchable
      results = searchReports({ query: 'deletable', limit: 10, full: false });
      expect(results.length).toBe(0);
    });
  });

  describe('CJK edge cases', () => {
    it('mixed CJK + English query works', () => {
      db.exec('DELETE FROM agent_reports');

      insertReport({
        agent_name: 'mixed',
        prompt: 'SQLite 搜尋引擎設計',
        result: 'Completed the SQLite search engine design',
      });

      const results = searchReports({ query: 'SQLite 搜尋引擎', limit: 10, full: false });
      expect(results.length).toBeGreaterThan(0);
    });

    it('handles NULL columns gracefully', () => {
      db.exec('DELETE FROM agent_reports');

      insertReport({
        agent_name: 'null-test',
        prompt: null,
        result: 'This result contains searchable content',
        trace_summary: null,
      });

      const results = searchReports({ query: 'searchable', limit: 10, full: false });
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
