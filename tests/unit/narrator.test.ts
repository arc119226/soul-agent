import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// ── Single in-memory SQLite for the entire test suite ──────────────
// We use one DB instance so that narrator's lazy-init prepared statements
// remain valid across tests. We clear rows in beforeEach instead.
const testDb = new Database(':memory:');
testDb.exec(`CREATE TABLE IF NOT EXISTS narrative (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  summary       TEXT    NOT NULL,
  emotion       TEXT,
  significance  INTEGER NOT NULL DEFAULT 3,
  related_to    TEXT,
  data          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
)`);

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
}));

vi.mock('../../src/core/database.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    schedule: vi.fn(),
    appendJsonl: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/memory/text-relevance.js', () => ({
  computeRelevance: vi.fn((query: string, text: string) => {
    return text.toLowerCase().includes(query.toLowerCase()) ? 0.8 : 0.05;
  }),
}));

import {
  appendNarrative,
  getRecentNarrative,
  getNarrativeByType,
  getSignificantNarrative,
  searchNarrative,
  reconstructTraitsFromNarrative,
} from '../../src/identity/narrator.js';
import { writer } from '../../src/core/debounced-writer.js';
import { eventBus } from '../../src/core/event-bus.js';

describe('Narrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear all rows between tests (keep schema + prepared stmts valid)
    testDb.exec('DELETE FROM narrative');
  });

  describe('appendNarrative()', () => {
    it('creates entry with correct JSONL structure', async () => {
      const entry = await appendNarrative('interaction', 'User asked about weather');

      expect(entry.type).toBe('interaction');
      expect(entry.summary).toBe('User asked about weather');
      expect(entry.significance).toBe(3); // default
      expect(entry.timestamp).toBeTruthy();
      expect(entry.emotion).toBeUndefined();
      expect(entry.related_to).toBeUndefined();
    });

    it('includes optional fields when provided', async () => {
      const entry = await appendNarrative('reflection', 'Deep thought', {
        emotion: 'contemplative',
        significance: 5,
        related_to: 'prev-entry',
      });

      expect(entry.emotion).toBe('contemplative');
      expect(entry.significance).toBe(5);
      expect(entry.related_to).toBe('prev-entry');
    });

    it('calls writer.appendJsonl with path and entry', async () => {
      await appendNarrative('boot', 'System started');

      expect(writer.appendJsonl).toHaveBeenCalledTimes(1);
      const [path, data] = vi.mocked(writer.appendJsonl).mock.calls[0]!;
      expect(path).toContain('narrative.jsonl');
      expect(data).toHaveProperty('type', 'boot');
      expect(data).toHaveProperty('summary', 'System started');
    });

    it('emits narrative:entry event', async () => {
      await appendNarrative('milestone', 'First evolution');

      expect(eventBus.emit).toHaveBeenCalledWith('narrative:entry', {
        type: 'milestone',
        summary: 'First evolution',
      });
    });

    it('handles all narrative types', async () => {
      const types = ['interaction', 'evolution', 'reflection', 'milestone', 'identity_change', 'boot', 'shutdown'] as const;

      for (const type of types) {
        const entry = await appendNarrative(type, `Test ${type}`);
        expect(entry.type).toBe(type);
      }
    });
  });

  describe('getRecentNarrative()', () => {
    it('returns empty array when no entries exist', async () => {
      const entries = await getRecentNarrative(5);
      expect(entries).toEqual([]);
    });

    it('returns last N entries in chronological order', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance) VALUES (?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'boot', 'Started', 3);
      insert.run('2026-02-13T02:00:00Z', 'interaction', 'Chat', 2);
      insert.run('2026-02-13T03:00:00Z', 'reflection', 'Thought', 4);

      const entries = await getRecentNarrative(2);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.type).toBe('interaction');
      expect(entries[1]!.type).toBe('reflection');
    });

    it('returns all entries when N exceeds total', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance) VALUES (?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'boot', 'OK', 3);
      insert.run('2026-02-13T02:00:00Z', 'interaction', 'Chat', 2);

      const entries = await getRecentNarrative(10);
      expect(entries).toHaveLength(2);
    });

    it('handles empty database', async () => {
      const entries = await getRecentNarrative(10);
      expect(entries).toHaveLength(0);
    });
  });

  describe('getNarrativeByType()', () => {
    it('filters entries by type', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance) VALUES (?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'boot', 'Start', 3);
      insert.run('2026-02-13T02:00:00Z', 'interaction', 'Chat 1', 2);
      insert.run('2026-02-13T03:00:00Z', 'interaction', 'Chat 2', 2);
      insert.run('2026-02-13T04:00:00Z', 'reflection', 'Think', 4);

      const entries = await getNarrativeByType('interaction');
      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.type === 'interaction')).toBe(true);
    });
  });

  describe('getSignificantNarrative()', () => {
    it('filters entries by minimum significance', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance) VALUES (?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'boot', 'Low', 1);
      insert.run('2026-02-13T02:00:00Z', 'milestone', 'High', 5);
      insert.run('2026-02-13T03:00:00Z', 'reflection', 'Mid', 3);
      insert.run('2026-02-13T04:00:00Z', 'evolution', 'Also High', 4);

      const entries = await getSignificantNarrative(4);
      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.significance >= 4)).toBe(true);
    });
  });

  describe('searchNarrative()', () => {
    it('returns entries matching query sorted by relevance', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance) VALUES (?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'boot', 'System boot', 3);
      insert.run('2026-02-13T02:00:00Z', 'interaction', 'Weather discussion', 2);
      insert.run('2026-02-13T03:00:00Z', 'interaction', 'Code review', 3);

      const results = await searchNarrative('weather');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.summary).toContain('Weather');
      expect(results[0]!.score).toBeGreaterThan(0.1);
    });

    it('returns empty array when no matches', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance) VALUES (?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'boot', 'System boot', 3);

      const results = await searchNarrative('xyznonexistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('reconstructTraitsFromNarrative()', () => {
    it('returns empty map when no identity_change events', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance) VALUES (?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'boot', 'Started', 3);
      insert.run('2026-02-13T02:00:00Z', 'interaction', 'Chat', 2);

      const traits = await reconstructTraitsFromNarrative();
      expect(traits).toEqual({});
    });

    it('extracts trait values from identity_change events', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance, related_to) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'identity_change', '特質「curiosity_level」從 0.80 增長到 0.85：探索新領域', 2, 'curiosity_level');
      insert.run('2026-02-13T02:00:00Z', 'identity_change', '特質「confidence」從 0.40 增長到 0.45：成功完成任務', 2, 'confidence');

      const traits = await reconstructTraitsFromNarrative();
      expect(traits['curiosity_level']).toBeCloseTo(0.85);
      expect(traits['confidence']).toBeCloseTo(0.45);
    });

    it('keeps last value when multiple events for same trait', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance, related_to) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'identity_change', '特質「warmth」從 0.90 增長到 0.95：溫暖互動', 2, 'warmth');
      insert.run('2026-02-13T02:00:00Z', 'identity_change', '特質「warmth」從 0.95 降低到 0.92：冷靜反思', 2, 'warmth');

      const traits = await reconstructTraitsFromNarrative();
      expect(traits['warmth']).toBeCloseTo(0.92);
    });

    it('ignores identity_change events without related_to', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance) VALUES (?, ?, ?, ?)',
      );
      insert.run('2026-02-13T01:00:00Z', 'identity_change', '新增價值觀：「誠實」', 4);

      const traits = await reconstructTraitsFromNarrative();
      expect(traits).toEqual({});
    });

    it('returns empty map when no entries in database', async () => {
      const traits = await reconstructTraitsFromNarrative();
      expect(traits).toEqual({});
    });

    it('prefers structured data.newValue over regex', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance, related_to, data) VALUES (?, ?, ?, ?, ?, ?)',
      );
      insert.run(
        '2026-02-13T01:00:00Z', 'identity_change',
        '特質「courage」從 0.50 增長到 0.55：test',
        2, 'courage',
        JSON.stringify({ oldValue: 0.50, newValue: 0.60, reason: 'test' }),
      );

      const traits = await reconstructTraitsFromNarrative();
      // data.newValue (0.60) wins over regex (0.55)
      expect(traits['courage']).toBeCloseTo(0.60);
    });

    it('falls back to regex when data field is absent (legacy)', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance, related_to) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run(
        '2026-02-13T01:00:00Z', 'identity_change',
        '特質「warmth」從 0.80 增長到 0.85：互動', 2,
        'warmth',
      );

      const traits = await reconstructTraitsFromNarrative();
      expect(traits['warmth']).toBeCloseTo(0.85);
    });

    it('rejects values outside [0, 1] range', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance, related_to, data) VALUES (?, ?, ?, ?, ?, ?)',
      );
      insert.run(
        '2026-02-13T01:00:00Z', 'identity_change',
        '特質「x」從 0 增長到 5.00：bug', 2, 'x', null,
      );
      insert.run(
        '2026-02-13T02:00:00Z', 'identity_change',
        'test', 2, 'y',
        JSON.stringify({ oldValue: 0, newValue: -0.1, reason: 'bug' }),
      );

      const traits = await reconstructTraitsFromNarrative();
      expect(traits['x']).toBeUndefined();
      expect(traits['y']).toBeUndefined();
    });

    it('rejects NaN and Infinity from regex parse', async () => {
      const insert = testDb.prepare(
        'INSERT INTO narrative (timestamp, type, summary, significance, related_to) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run(
        '2026-02-13T01:00:00Z', 'identity_change',
        '特質「z」從 0 增長到 NaN：bad', 2, 'z',
      );

      const traits = await reconstructTraitsFromNarrative();
      expect(traits['z']).toBeUndefined();
    });
  });

  describe('appendNarrative() with data field', () => {
    it('includes data field in entry when provided', async () => {
      const entry = await appendNarrative('identity_change', 'Test', {
        related_to: 'courage',
        data: { oldValue: 0.5, newValue: 0.6, reason: 'growth' },
      });

      expect(entry.data).toEqual({ oldValue: 0.5, newValue: 0.6, reason: 'growth' });

      const [, writtenData] = vi.mocked(writer.appendJsonl).mock.calls[0]!;
      expect(writtenData).toHaveProperty('data', { oldValue: 0.5, newValue: 0.6, reason: 'growth' });
    });

    it('omits data field when not provided', async () => {
      const entry = await appendNarrative('interaction', 'Hello');

      expect(entry.data).toBeUndefined();
    });
  });
});
