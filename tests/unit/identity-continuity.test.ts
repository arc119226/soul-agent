/**
 * Tests for Phase 3: Identity Continuity — per-file hash diffing
 * and precise change detection across soul integrity verification points.
 */
import { describe, it, expect } from 'vitest';

import {
  diffFingerprints,
  CRITICAL_FILES,
  type SoulFingerprint,
} from '../../src/safety/soul-integrity.js';

/** Helper to create a mock SoulFingerprint */
function makeFp(fileHashOverrides?: Record<string, string>): SoulFingerprint {
  const files: Record<string, string> = {
    'soul/genesis.md': 'aaa111',
    'soul/identity.json': 'bbb222',
    'soul/vitals.json': 'ccc333',
    'soul/milestones.json': 'ddd444',
    ...fileHashOverrides,
  };
  return {
    hash: 'composite-hash',
    files,
    computedAt: new Date().toISOString(),
  };
}

describe('diffFingerprints()', () => {
  it('returns empty array when all hashes match', () => {
    const stored = {
      'soul/genesis.md': 'aaa111',
      'soul/identity.json': 'bbb222',
      'soul/vitals.json': 'ccc333',
      'soul/milestones.json': 'ddd444',
    };
    const current = makeFp();

    const changed = diffFingerprints(stored, current);
    expect(changed).toEqual([]);
  });

  it('returns only changed files when one file differs', () => {
    const stored = {
      'soul/genesis.md': 'aaa111',
      'soul/identity.json': 'bbb222',
      'soul/vitals.json': 'ccc333',
      'soul/milestones.json': 'ddd444',
    };
    // vitals.json changed
    const current = makeFp({ 'soul/vitals.json': 'CHANGED' });

    const changed = diffFingerprints(stored, current);
    expect(changed).toEqual(['soul/vitals.json']);
  });

  it('returns multiple changed files when several differ', () => {
    const stored = {
      'soul/genesis.md': 'aaa111',
      'soul/identity.json': 'bbb222',
      'soul/vitals.json': 'ccc333',
      'soul/milestones.json': 'ddd444',
    };
    const current = makeFp({
      'soul/genesis.md': 'CHANGED1',
      'soul/milestones.json': 'CHANGED2',
    });

    const changed = diffFingerprints(stored, current);
    expect(changed).toEqual(['soul/genesis.md', 'soul/milestones.json']);
  });

  it('falls back to all files when storedFileHashes is null (legacy)', () => {
    const current = makeFp();

    const changed = diffFingerprints(null, current);
    expect(changed).toEqual([...CRITICAL_FILES]);
  });

  it('falls back to all files when storedFileHashes is undefined', () => {
    const current = makeFp();

    const changed = diffFingerprints(undefined, current);
    expect(changed).toEqual([...CRITICAL_FILES]);
  });

  it('falls back to all files when storedFileHashes is empty object', () => {
    const current = makeFp();

    const changed = diffFingerprints({}, current);
    expect(changed).toEqual([...CRITICAL_FILES]);
  });

  it('reports file as changed if stored hash is missing for that file', () => {
    // Partial stored hashes (e.g. new critical file added after checkpoint)
    const stored = {
      'soul/genesis.md': 'aaa111',
      'soul/identity.json': 'bbb222',
      // vitals.json and milestones.json missing
    };
    const current = makeFp();

    const changed = diffFingerprints(stored, current);
    expect(changed).toContain('soul/vitals.json');
    expect(changed).toContain('soul/milestones.json');
    expect(changed).not.toContain('soul/genesis.md');
    expect(changed).not.toContain('soul/identity.json');
  });

  it('preserves CRITICAL_FILES order in results', () => {
    const stored = {
      'soul/genesis.md': 'WRONG',
      'soul/identity.json': 'WRONG',
      'soul/vitals.json': 'WRONG',
      'soul/milestones.json': 'WRONG',
    };
    const current = makeFp();

    const changed = diffFingerprints(stored, current);
    // Should follow CRITICAL_FILES order
    expect(changed).toEqual([...CRITICAL_FILES]);
  });
});
