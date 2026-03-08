/**
 * Tests for identity-store.ts — validateIdentityConsistency() and startup integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// ── Single in-memory SQLite for the test suite ───────────────────────
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

// ── Mock external dependencies ───────────────────────────────────────

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
  computeRelevance: vi.fn(() => 0),
}));

import { readFile } from 'node:fs/promises';
import {
  validateIdentityConsistency,
  resetCache,
} from '../../src/identity/identity-store.js';

// ── Test Data ────────────────────────────────────────────────────────

function makeIdentity(traitOverrides?: Record<string, number>) {
  const defaults: Record<string, number> = {
    curiosity_level: 0.80,
    caution_level: 0.70,
    warmth: 1.00,
    humor: 1.00,
    proactive_tendency: 1.00,
    confidence: 0.40,
  };
  const values = { ...defaults, ...traitOverrides };

  return {
    version: 1,
    last_updated: '2026-02-20T00:00:00Z',
    name: 'Soul Agent',
    core_traits: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, { value: v, description: `${k} trait` }]),
    ),
    values: ['記憶比效率重要'],
    preferences: { language: '繁體中文' },
    growth_summary: 'test',
  };
}

/** Insert identity_change rows into the in-memory SQLite narrative table */
function insertNarrativeTraits(traitValues: Record<string, number>): void {
  const insert = testDb.prepare(
    'INSERT INTO narrative (timestamp, type, summary, significance, related_to) VALUES (?, ?, ?, ?, ?)',
  );
  Object.entries(traitValues).forEach(([name, value], i) => {
    insert.run(
      `2026-02-20T0${i}:00:00Z`,
      'identity_change',
      `特質「${name}」從 0.00 增長到 ${value.toFixed(2)}：測試`,
      2,
      name,
    );
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('validateIdentityConsistency()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
    testDb.exec('DELETE FROM narrative');
  });

  it('returns empty array when identity matches narrative', async () => {
    const identity = makeIdentity({ curiosity_level: 0.85, confidence: 0.45 });
    insertNarrativeTraits({ curiosity_level: 0.85, confidence: 0.45 });

    // readFile: loadIdentity reads identity.json
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(identity));

    const discrepancies = await validateIdentityConsistency();
    expect(discrepancies).toHaveLength(0);
  });

  it('detects discrepancy beyond threshold', async () => {
    const identity = makeIdentity({ curiosity_level: 0.85 });
    insertNarrativeTraits({ curiosity_level: 0.70 }); // delta = 0.15

    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(identity));

    const discrepancies = await validateIdentityConsistency();
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]!.trait).toBe('curiosity_level');
    expect(discrepancies[0]!.identityValue).toBeCloseTo(0.85);
    expect(discrepancies[0]!.narrativeValue).toBeCloseTo(0.70);
    expect(discrepancies[0]!.delta).toBeCloseTo(0.15);
  });

  it('ignores traits below threshold', async () => {
    const identity = makeIdentity({ confidence: 0.40 });
    insertNarrativeTraits({ confidence: 0.42 }); // delta = 0.02 < 0.05

    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(identity));

    const discrepancies = await validateIdentityConsistency();
    expect(discrepancies).toHaveLength(0);
  });

  it('supports custom threshold', async () => {
    const identity = makeIdentity({ warmth: 1.00 });
    insertNarrativeTraits({ warmth: 0.97 }); // delta = 0.03

    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(identity));

    // Default threshold 0.05 → no discrepancy
    const none = await validateIdentityConsistency();
    expect(none).toHaveLength(0);

    // Reset identity cache and re-mock readFile for second call
    // (narrative data persists in SQLite — no need to re-insert)
    resetCache();
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(identity));

    // Custom threshold 0.01 → detects discrepancy
    const found = await validateIdentityConsistency(0.01);
    expect(found).toHaveLength(1);
    expect(found[0]!.trait).toBe('warmth');
  });

  it('skips traits with no narrative record', async () => {
    const identity = makeIdentity({
      curiosity_level: 0.85,
      confidence: 0.40,
    });
    // Narrative only has curiosity_level, not confidence
    insertNarrativeTraits({ curiosity_level: 0.85 });

    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(identity));

    const discrepancies = await validateIdentityConsistency();
    // confidence has no narrative record → skipped, not flagged
    expect(discrepancies).toHaveLength(0);
  });

  it('detects multiple discrepancies at once', async () => {
    const identity = makeIdentity({
      curiosity_level: 0.85,
      warmth: 1.00,
      confidence: 0.40,
    });
    insertNarrativeTraits({
      curiosity_level: 0.60, // delta 0.25
      warmth: 0.80,          // delta 0.20
      confidence: 0.42,      // delta 0.02 (below threshold)
    });

    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(identity));

    const discrepancies = await validateIdentityConsistency();
    expect(discrepancies).toHaveLength(2);
    const traits = discrepancies.map(d => d.trait);
    expect(traits).toContain('curiosity_level');
    expect(traits).toContain('warmth');
  });
});
