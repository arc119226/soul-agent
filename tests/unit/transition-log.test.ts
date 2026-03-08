/**
 * Tests for transition-log.ts — hash-chained state transition recording.
 *
 * Pure-logic tests for:
 *   - Hash computation and chain linking
 *   - Genesis hash as first prevHash
 *   - Chain verification (valid + tampered)
 *   - Statistics computation
 *   - SQLite dual-write (Phase 3b)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

// ── In-memory SQLite for testing ─────────────────────────────────────
const testDb = new Database(':memory:');
testDb.exec(`CREATE TABLE IF NOT EXISTS transitions (
  idx          INTEGER PRIMARY KEY,
  timestamp    TEXT    NOT NULL,
  from_state   TEXT    NOT NULL,
  to_state     TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  duration_ms  INTEGER NOT NULL,
  context      TEXT    NOT NULL,
  prev_hash    TEXT    NOT NULL,
  hash         TEXT    NOT NULL UNIQUE,
  vector_clock TEXT
);
CREATE INDEX IF NOT EXISTS idx_transitions_ts ON transitions(timestamp);
CREATE INDEX IF NOT EXISTS idx_transitions_states ON transitions(from_state, to_state);
CREATE INDEX IF NOT EXISTS idx_transitions_ts_state ON transitions(timestamp, from_state);
`);

// ── Mock external dependencies before importing ───────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const appendedLines: string[] = [];

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    appendJsonl: vi.fn(async (_path: string, data: unknown) => {
      appendedLines.push(JSON.stringify(data));
    }),
    schedule: vi.fn(),
  },
}));

vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock audit-chain to prevent side effects
vi.mock('../../src/safety/audit-chain.js', () => ({
  appendAuditEntry: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock database to use in-memory SQLite
vi.mock('../../src/core/database.js', () => ({
  getDb: () => testDb,
}));

import {
  computeTransitionHash,
  recordTransition,
  verifyTransitionChain,
  getTransitionStats,
  getRecentTransitions,
  initTransitionLog,
  __testing,
  type TransitionEntry,
  type TransitionContext,
} from '../../src/lifecycle/transition-log.js';

import { readFile } from 'node:fs/promises';
import { eventBus } from '../../src/core/event-bus.js';

const GENESIS_HASH = createHash('sha256').update('soul-agent:transition-log:genesis').digest('hex');

describe('TransitionLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendedLines.length = 0;
    __testing.reset();
    // Clear SQLite rows between tests
    testDb.exec('DELETE FROM transitions');
  });

  describe('computeTransitionHash', () => {
    it('produces consistent SHA-256 hash', () => {
      const entry = {
        index: 0,
        timestamp: '2026-02-21T10:00:00.000Z',
        from: 'active',
        to: 'throttled',
        reason: 'fatigue=55',
        durationMs: 300000,
        context: { dailyPhase: 'active_service' } as TransitionContext,
        prevHash: GENESIS_HASH,
      };

      const hash1 = computeTransitionHash(entry);
      const hash2 = computeTransitionHash(entry);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it('different entries produce different hashes', () => {
      const base = {
        index: 0,
        timestamp: '2026-02-21T10:00:00.000Z',
        from: 'active',
        to: 'throttled',
        reason: 'test',
        durationMs: 300000,
        context: { dailyPhase: 'active_service' } as TransitionContext,
        prevHash: GENESIS_HASH,
      };

      const modified = { ...base, to: 'drained' };

      expect(computeTransitionHash(base)).not.toBe(computeTransitionHash(modified));
    });
  });

  describe('recordTransition', () => {
    it('records first entry with genesis prevHash', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service', fatigueScore: 55 };
      const entry = await recordTransition('active', 'throttled', 'fatigue=55', 300000, ctx);

      expect(entry.index).toBe(0);
      expect(entry.from).toBe('active');
      expect(entry.to).toBe('throttled');
      expect(entry.prevHash).toBe(GENESIS_HASH);
      expect(entry.hash).toHaveLength(64);
      expect(entry.context.fatigueScore).toBe(55);
    });

    it('chains entries via prevHash', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };

      const e1 = await recordTransition('active', 'throttled', 'r1', 100, ctx);
      const e2 = await recordTransition('throttled', 'drained', 'r2', 200, ctx);
      const e3 = await recordTransition('drained', 'resting', 'r3', 300, ctx);

      expect(e1.prevHash).toBe(GENESIS_HASH);
      expect(e2.prevHash).toBe(e1.hash);
      expect(e3.prevHash).toBe(e2.hash);

      expect(e1.index).toBe(0);
      expect(e2.index).toBe(1);
      expect(e3.index).toBe(2);
    });

    it('emits transition:recorded event with vectorClock', async () => {
      const ctx: TransitionContext = { dailyPhase: 'rest' };
      const entry = await recordTransition('active', 'resting', 'idle', 1000, ctx);

      expect(eventBus.emit).toHaveBeenCalledWith('transition:recorded', {
        index: 0,
        from: 'active',
        to: 'resting',
        hash: entry.hash,
        vectorClock: entry.vectorClock,
      });
    });

    it('appends to JSONL file', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      await recordTransition('active', 'thinking', 'user query', 5000, ctx);

      expect(appendedLines).toHaveLength(1);
      const parsed = JSON.parse(appendedLines[0]!) as TransitionEntry;
      expect(parsed.from).toBe('active');
      expect(parsed.to).toBe('thinking');
    });

    it('writes to SQLite (dual-write)', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service', fatigueScore: 42 };
      const entry = await recordTransition('active', 'throttled', 'fatigue=42', 5000, ctx);

      // Verify SQLite has the entry
      const row = testDb.prepare('SELECT * FROM transitions WHERE idx = ?').get(0) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.from_state).toBe('active');
      expect(row.to_state).toBe('throttled');
      expect(row.reason).toBe('fatigue=42');
      expect(row.duration_ms).toBe(5000);
      expect(row.hash).toBe(entry.hash);
      expect(row.prev_hash).toBe(GENESIS_HASH);

      const context = JSON.parse(row.context as string) as TransitionContext;
      expect(context.dailyPhase).toBe('active_service');
      expect(context.fatigueScore).toBe(42);
    });

    it('dual-write: both SQLite and JSONL have same data', async () => {
      const ctx: TransitionContext = { dailyPhase: 'rest' };
      await recordTransition('active', 'resting', 'idle', 1000, ctx);
      await recordTransition('resting', 'active', 'wake', 2000, ctx);

      // Check SQLite count
      const dbCount = (testDb.prepare('SELECT COUNT(*) as cnt FROM transitions').get() as { cnt: number }).cnt;
      expect(dbCount).toBe(2);

      // Check JSONL count
      expect(appendedLines).toHaveLength(2);
    });
  });

  describe('getRecentTransitions', () => {
    it('reads from SQLite when data is available', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      await recordTransition('active', 'throttled', 'r1', 100, ctx);
      await recordTransition('throttled', 'drained', 'r2', 200, ctx);
      await recordTransition('drained', 'resting', 'r3', 300, ctx);

      // readFile should NOT be called since SQLite has data
      const entries = await getRecentTransitions(2);
      expect(entries).toHaveLength(2);
      // Should return the last 2 entries in chronological order
      expect(entries[0]!.from).toBe('throttled');
      expect(entries[1]!.from).toBe('drained');
      expect(readFile).not.toHaveBeenCalled();
    });

    it('returns entries in chronological order from SQLite', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      await recordTransition('active', 'throttled', 'r1', 100, ctx);
      await recordTransition('throttled', 'drained', 'r2', 200, ctx);
      await recordTransition('drained', 'resting', 'r3', 300, ctx);

      const entries = await getRecentTransitions(10);
      expect(entries).toHaveLength(3);
      expect(entries[0]!.index).toBe(0);
      expect(entries[1]!.index).toBe(1);
      expect(entries[2]!.index).toBe(2);
    });

    it('falls back to JSONL when SQLite is empty', async () => {
      // SQLite is empty, provide JSONL data via readFile mock
      const jsonlEntry = {
        index: 0,
        timestamp: '2026-02-21T10:00:00.000Z',
        from: 'active',
        to: 'resting',
        reason: 'idle',
        durationMs: 1000,
        context: { dailyPhase: 'rest' },
        prevHash: GENESIS_HASH,
        hash: 'abc123',
      };
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(jsonlEntry) + '\n');

      const entries = await getRecentTransitions(10);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.from).toBe('active');
      expect(readFile).toHaveBeenCalled();
    });
  });

  describe('verifyTransitionChain', () => {
    it('returns valid for empty chain', async () => {
      // SQLite is empty, readFile fails
      vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));
      const result = await verifyTransitionChain();
      expect(result.valid).toBe(true);
      expect(result.length).toBe(0);
    });

    it('returns valid for intact chain (from SQLite)', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      await recordTransition('active', 'throttled', 'r1', 100, ctx);
      await recordTransition('throttled', 'drained', 'r2', 200, ctx);
      await recordTransition('drained', 'resting', 'r3', 300, ctx);

      const result = await verifyTransitionChain();
      expect(result.valid).toBe(true);
      expect(result.length).toBe(3);
      // readFile should NOT be called since SQLite has data
      expect(readFile).not.toHaveBeenCalled();
    });

    it('detects tampered hash', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      await recordTransition('active', 'throttled', 'r1', 100, ctx);
      await recordTransition('throttled', 'drained', 'r2', 200, ctx);

      // Tamper with second entry's hash in SQLite
      testDb.prepare('UPDATE transitions SET hash = ? WHERE idx = ?').run('tampered_hash', 1);

      const result = await verifyTransitionChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });

    it('detects broken chain link', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      await recordTransition('active', 'throttled', 'r1', 100, ctx);
      await recordTransition('throttled', 'drained', 'r2', 200, ctx);

      // Break the chain link: change prevHash of second entry
      // We need to also recompute the hash with the wrong prevHash
      const row = testDb.prepare('SELECT * FROM transitions WHERE idx = 1').get() as Record<string, unknown>;
      const fakeEntry = {
        index: 1,
        timestamp: row.timestamp as string,
        from: row.from_state as string,
        to: row.to_state as string,
        reason: row.reason as string,
        durationMs: row.duration_ms as number,
        context: JSON.parse(row.context as string) as TransitionContext,
        prevHash: 'wrong_prev_hash',
        vectorClock: row.vector_clock ? JSON.parse(row.vector_clock as string) : undefined,
      };
      const newHash = computeTransitionHash(fakeEntry);
      testDb.prepare('UPDATE transitions SET prev_hash = ?, hash = ? WHERE idx = ?').run('wrong_prev_hash', newHash, 1);

      const result = await verifyTransitionChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });
  });

  describe('getTransitionStats', () => {
    it('computes average duration and transition counts from SQLite', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      await recordTransition('active', 'throttled', 'r1', 60000, ctx);
      await recordTransition('throttled', 'drained', 'r2', 30000, ctx);
      await recordTransition('drained', 'resting', 'r3', 10000, ctx);
      await recordTransition('active', 'throttled', 'r4', 120000, ctx);

      const stats = await getTransitionStats();

      expect(stats.totalTransitions).toBe(4);
      // active appeared twice: ROUND(AVG(60000, 120000)) = 90000
      expect(stats.avgDurationByState['active']).toBe(90000);
      expect(stats.transitionCounts['active\u2192throttled']).toBe(2);
      expect(stats.transitionCounts['throttled\u2192drained']).toBe(1);
      // readFile should NOT be called since SQLite has data
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  describe('initTransitionLog', () => {
    it('initializes from SQLite when data is available', async () => {
      // Insert a row directly into SQLite to simulate existing data
      testDb.prepare(
        `INSERT INTO transitions (idx, timestamp, from_state, to_state, reason, duration_ms, context, prev_hash, hash, vector_clock)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        5, '2026-02-21T10:00:00.000Z', 'active', 'resting', 'idle', 5000,
        '{"dailyPhase":"rest"}', GENESIS_HASH, 'somehash123', null
      );

      await initTransitionLog();

      expect(__testing.getNextIndex()).toBe(6);
      expect(__testing.getLastHash()).toBe('somehash123');
      // readFile should NOT be called since SQLite has data
      expect(readFile).not.toHaveBeenCalled();
    });

    it('falls back to JSONL when SQLite is empty', async () => {
      const jsonlEntry = {
        index: 3,
        timestamp: '2026-02-21T10:00:00.000Z',
        from: 'active',
        to: 'resting',
        reason: 'idle',
        durationMs: 1000,
        context: { dailyPhase: 'rest' },
        prevHash: GENESIS_HASH,
        hash: 'jsonlhash456',
      };
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(jsonlEntry) + '\n');

      await initTransitionLog();

      expect(__testing.getNextIndex()).toBe(4);
      expect(__testing.getLastHash()).toBe('jsonlhash456');
      expect(readFile).toHaveBeenCalled();
    });

    it('starts fresh when both SQLite and JSONL are empty', async () => {
      vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

      await initTransitionLog();

      expect(__testing.getNextIndex()).toBe(0);
      expect(__testing.getLastHash()).toBe(GENESIS_HASH);
    });
  });

  describe('vector clock integration', () => {
    it('includes vectorClock in recorded entry', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      const entry = await recordTransition('active', 'throttled', 'test', 100, ctx);

      expect(entry.vectorClock).toBeDefined();
      expect(entry.vectorClock!.bot).toBe(1);
    });

    it('vector clock increments across entries', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      const e1 = await recordTransition('active', 'throttled', 'r1', 100, ctx);
      const e2 = await recordTransition('throttled', 'drained', 'r2', 200, ctx);
      const e3 = await recordTransition('drained', 'resting', 'r3', 300, ctx);

      expect(e1.vectorClock!.bot).toBe(1);
      expect(e2.vectorClock!.bot).toBe(2);
      expect(e3.vectorClock!.bot).toBe(3);
    });

    it('vectorClock is included in hash computation', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      const entry = await recordTransition('active', 'resting', 'test', 100, ctx);

      // Verify the hash includes vectorClock by recomputing
      const { hash: _, ...rest } = entry;
      const recomputed = computeTransitionHash(rest);
      expect(recomputed).toBe(entry.hash);
    });

    it('backward compat: entries without vectorClock produce same hash', () => {
      // Simulate a legacy entry (no vectorClock field)
      const legacyEntry = {
        index: 0,
        timestamp: '2026-02-20T23:20:29.814Z',
        from: 'active',
        to: 'resting',
        reason: 'no interaction',
        durationMs: 48,
        context: { dailyPhase: 'greeting' } as TransitionContext,
        prevHash: GENESIS_HASH,
      };

      // Hash without vectorClock
      const hash1 = computeTransitionHash(legacyEntry);

      // Same entry with vectorClock: undefined (simulates reading old JSONL)
      const withUndefined = { ...legacyEntry, vectorClock: undefined };
      const hash2 = computeTransitionHash(withUndefined);

      // Both should produce identical hashes
      expect(hash1).toBe(hash2);
    });

    it('entries with vectorClock produce different hash than without', () => {
      const base = {
        index: 0,
        timestamp: '2026-02-21T10:00:00.000Z',
        from: 'active',
        to: 'resting',
        reason: 'test',
        durationMs: 100,
        context: { dailyPhase: 'active_service' } as TransitionContext,
        prevHash: GENESIS_HASH,
      };

      const withClock = { ...base, vectorClock: { bot: 1 } };
      expect(computeTransitionHash(base)).not.toBe(computeTransitionHash(withClock));
    });

    it('vectorClock is persisted in SQLite', async () => {
      const ctx: TransitionContext = { dailyPhase: 'active_service' };
      await recordTransition('active', 'throttled', 'test', 100, ctx);

      const row = testDb.prepare('SELECT vector_clock FROM transitions WHERE idx = 0').get() as { vector_clock: string | null };
      expect(row.vector_clock).not.toBeNull();
      const clock = JSON.parse(row.vector_clock!) as { bot: number };
      expect(clock.bot).toBe(1);
    });
  });

  describe('__testing helpers', () => {
    it('reset restores initial state', async () => {
      const ctx: TransitionContext = { dailyPhase: 'rest' };
      await recordTransition('active', 'resting', 'test', 1000, ctx);

      expect(__testing.getNextIndex()).toBe(1);
      expect(__testing.getLastHash()).not.toBe(GENESIS_HASH);

      __testing.reset();

      expect(__testing.getNextIndex()).toBe(0);
      expect(__testing.getLastHash()).toBe(GENESIS_HASH);
    });

    it('genesis hash is deterministic', () => {
      const expected = createHash('sha256').update('soul-agent:transition-log:genesis').digest('hex');
      expect(__testing.getGenesisHash()).toBe(expected);
    });
  });
});
