/**
 * Tests for causal-verification.ts — transition chain causal consistency.
 *
 * Verifies four checks: hash chain, vector clock monotonic,
 * timestamp monotonic, and index sequential.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { appendJsonl: vi.fn(), schedule: vi.fn() },
}));

vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn(), off: vi.fn() },
}));

vi.mock('../../src/safety/audit-chain.js', () => ({
  appendAuditEntry: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock database to prevent real SQLite access when loading transition-log.js
vi.mock('../../src/core/database.js', () => ({
  getDb: () => { throw new Error('no db in test'); },
}));

// Mock getRecentTransitions to isolate from real SQLite/JSONL data
const mockGetRecentTransitions = vi.fn();
vi.mock('../../src/lifecycle/transition-log.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lifecycle/transition-log.js')>();
  return {
    ...orig,
    getRecentTransitions: (...args: unknown[]) => mockGetRecentTransitions(...args),
  };
});

import { verifyCausalHistory } from '../../src/lifecycle/causal-verification.js';
import { computeTransitionHash, __testing } from '../../src/lifecycle/transition-log.js';

// ── Helpers ──────────────────────────────────────────────────────────

const GENESIS_HASH = createHash('sha256').update('soul-agent:transition-log:genesis').digest('hex');

interface TestEntry {
  index: number;
  timestamp: string;
  from: string;
  to: string;
  reason: string;
  durationMs: number;
  context: { dailyPhase: string };
  prevHash: string;
  hash: string;
  vectorClock?: Record<string, number>;
}

function buildChain(count: number, opts?: { withVectorClock?: boolean }): TestEntry[] {
  const entries: TestEntry[] = [];
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < count; i++) {
    const partial: Omit<TestEntry, 'hash'> = {
      index: i,
      timestamp: new Date(Date.now() + i * 60000).toISOString(),
      from: i % 2 === 0 ? 'active' : 'resting',
      to: i % 2 === 0 ? 'resting' : 'active',
      reason: `reason-${i}`,
      durationMs: 1000 * (i + 1),
      context: { dailyPhase: 'active_service' },
      prevHash,
      ...(opts?.withVectorClock && { vectorClock: { bot: i + 1 } }),
    };

    const hash = computeTransitionHash(partial);
    const entry: TestEntry = { ...partial, hash };
    entries.push(entry);
    prevHash = hash;
  }

  return entries;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('verifyCausalHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.reset();
  });

  it('returns valid for empty chain', async () => {
    mockGetRecentTransitions.mockResolvedValueOnce([]);

    const result = await verifyCausalHistory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.length).toBe(0);
  });

  it('validates correct chain with vector clocks', async () => {
    const entries = buildChain(5, { withVectorClock: true });
    mockGetRecentTransitions.mockResolvedValueOnce(entries);

    const result = await verifyCausalHistory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.length).toBe(5);
    expect(result.value.checks.hashChain).toBe(true);
    expect(result.value.checks.vectorClockMonotonic).toBe(true);
    expect(result.value.checks.timestampMonotonic).toBe(true);
    expect(result.value.checks.indexSequential).toBe(true);
    expect(result.value.finalClock).toEqual({ bot: 5 });
  });

  it('validates chain without vector clocks (backward compat)', async () => {
    const entries = buildChain(3, { withVectorClock: false });
    mockGetRecentTransitions.mockResolvedValueOnce(entries);

    const result = await verifyCausalHistory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.finalClock).toBeNull(); // no vector clocks
  });

  it('detects tampered hash', async () => {
    const entries = buildChain(3, { withVectorClock: true });
    entries[1]!.hash = 'tampered';
    mockGetRecentTransitions.mockResolvedValueOnce(entries);

    const result = await verifyCausalHistory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.checks.hashChain).toBe(false);
    expect(result.value.brokenAt).toBe(1);
  });

  it('detects broken chain link', async () => {
    const entries = buildChain(3, { withVectorClock: true });
    // Break chain link but recompute hash
    entries[2]!.prevHash = 'wrong_prev';
    const { hash: _, ...rest } = entries[2]!;
    entries[2]!.hash = computeTransitionHash(rest);
    mockGetRecentTransitions.mockResolvedValueOnce(entries);

    const result = await verifyCausalHistory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.checks.hashChain).toBe(false);
  });

  it('detects vector clock regression', async () => {
    const entries = buildChain(3, { withVectorClock: true });
    // Entry 2 has clock regression: bot goes from 2 to 1
    entries[2]!.vectorClock = { bot: 1 }; // was { bot: 3 }
    // Recompute hash for valid hash chain
    const { hash: _, ...rest } = entries[2]!;
    entries[2]!.hash = computeTransitionHash(rest);
    // Fix prevHash chain
    entries[2]!.prevHash = entries[1]!.hash;
    const { hash: _2, ...rest2 } = entries[2]!;
    entries[2]!.hash = computeTransitionHash(rest2);
    mockGetRecentTransitions.mockResolvedValueOnce(entries);

    const result = await verifyCausalHistory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.checks.vectorClockMonotonic).toBe(false);
  });

  it('detects timestamp regression', async () => {
    const entries = buildChain(3, { withVectorClock: true });
    // Make entry 2 have earlier timestamp than entry 1
    entries[2]!.timestamp = new Date(0).toISOString();
    // Recompute hash
    entries[2]!.prevHash = entries[1]!.hash;
    const { hash: _, ...rest } = entries[2]!;
    entries[2]!.hash = computeTransitionHash(rest);
    mockGetRecentTransitions.mockResolvedValueOnce(entries);

    const result = await verifyCausalHistory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.checks.timestampMonotonic).toBe(false);
  });

  it('detects index gap', async () => {
    const entries = buildChain(3, { withVectorClock: true });
    // Skip index: 0, 1, 5
    entries[2]!.index = 5;
    entries[2]!.prevHash = entries[1]!.hash;
    const { hash: _, ...rest } = entries[2]!;
    entries[2]!.hash = computeTransitionHash(rest);
    mockGetRecentTransitions.mockResolvedValueOnce(entries);

    const result = await verifyCausalHistory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.checks.indexSequential).toBe(false);
  });

  it('handles mixed entries (some with vectorClock, some without)', async () => {
    // Entry 0: no vectorClock, Entry 1-2: with vectorClock
    const entries = buildChain(3, { withVectorClock: false });
    // Add vector clocks only to entries 1 and 2
    entries[1]!.vectorClock = { bot: 1 };
    entries[1]!.prevHash = entries[0]!.hash;
    const { hash: _1, ...rest1 } = entries[1]!;
    entries[1]!.hash = computeTransitionHash(rest1);

    entries[2]!.vectorClock = { bot: 2 };
    entries[2]!.prevHash = entries[1]!.hash;
    const { hash: _2, ...rest2 } = entries[2]!;
    entries[2]!.hash = computeTransitionHash(rest2);

    mockGetRecentTransitions.mockResolvedValueOnce(entries);

    const result = await verifyCausalHistory();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.finalClock).toEqual({ bot: 2 });
  });
});
