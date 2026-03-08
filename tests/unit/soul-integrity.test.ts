/**
 * Tests for soul-integrity.ts — verifySoulIntegrity per-file hash diffing (SPEC-31).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external dependencies ──────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockReadFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// ── Import after mocks ──────────────────────────────────────────────

import {
  verifySoulIntegrity,
  computeSoulFingerprint,
  diffFingerprints,
  CRITICAL_FILES,
  type SoulFingerprint,
} from '../../src/safety/soul-integrity.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeFakeContent(seed: string): string {
  return `fake-content-${seed}`;
}

/**
 * Set up mockReadFile to return predictable content per file path.
 * contentMap maps file path suffix → content string.
 */
function setupFileContents(contentMap: Record<string, string>): void {
  mockReadFile.mockImplementation((filePath: string) => {
    for (const [suffix, content] of Object.entries(contentMap)) {
      if (filePath.endsWith(suffix)) {
        return Promise.resolve(content);
      }
    }
    return Promise.reject(new Error(`File not found: ${filePath}`));
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('diffFingerprints', () => {
  const currentFp: SoulFingerprint = {
    hash: 'composite-hash',
    files: {
      'soul/genesis.md': 'aaa',
      'soul/identity.json': 'bbb',
      'soul/vitals.json': 'ccc',
      'soul/milestones.json': 'ddd',
    },
    computedAt: new Date().toISOString(),
  };

  it('returns all files when storedFileHashes is null (legacy fallback)', () => {
    const result = diffFingerprints(null, currentFp);
    expect(result).toEqual([...CRITICAL_FILES]);
  });

  it('returns all files when storedFileHashes is empty object (legacy fallback)', () => {
    const result = diffFingerprints({}, currentFp);
    expect(result).toEqual([...CRITICAL_FILES]);
  });

  it('returns empty array when all hashes match', () => {
    const stored = { ...currentFp.files };
    const result = diffFingerprints(stored, currentFp);
    expect(result).toEqual([]);
  });

  it('returns only the changed file when one hash differs', () => {
    const stored = {
      ...currentFp.files,
      'soul/genesis.md': 'different-hash',
    };
    const result = diffFingerprints(stored, currentFp);
    expect(result).toEqual(['soul/genesis.md']);
  });

  it('returns multiple changed files when multiple hashes differ', () => {
    const stored = {
      'soul/genesis.md': 'different-1',
      'soul/identity.json': 'bbb', // same
      'soul/vitals.json': 'different-2',
      'soul/milestones.json': 'ddd', // same
    };
    const result = diffFingerprints(stored, currentFp);
    expect(result).toEqual(['soul/genesis.md', 'soul/vitals.json']);
  });

  it('reports files missing from stored hashes as changed', () => {
    const stored = {
      'soul/genesis.md': 'aaa',
      'soul/identity.json': 'bbb',
      // vitals.json and milestones.json missing
    };
    const result = diffFingerprints(stored, currentFp);
    expect(result).toEqual(['soul/vitals.json', 'soul/milestones.json']);
  });
});

describe('verifySoulIntegrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseContents: Record<string, string> = {
    'genesis.md': makeFakeContent('genesis'),
    'identity.json': makeFakeContent('identity'),
    'vitals.json': makeFakeContent('vitals'),
    'milestones.json': makeFakeContent('milestones'),
  };

  it('returns valid=true with empty changedFiles on first boot (null expected)', async () => {
    setupFileContents(baseContents);

    const result = await verifySoulIntegrity(null);
    expect(result.ok).toBe(true);
    expect(result.value!.valid).toBe(true);
    expect(result.value!.changedFiles).toEqual([]);
  });

  it('returns valid=true when composite hash matches', async () => {
    setupFileContents(baseContents);

    // First compute to get the hash
    const fpResult = await computeSoulFingerprint();
    expect(fpResult.ok).toBe(true);
    const hash = fpResult.value!.hash;
    const fileHashes = fpResult.value!.files;

    // Verify with matching hash
    const result = await verifySoulIntegrity(hash, fileHashes);
    expect(result.ok).toBe(true);
    expect(result.value!.valid).toBe(true);
    expect(result.value!.changedFiles).toEqual([]);
  });

  it('pinpoints exactly which file changed when per-file hashes are stored', async () => {
    // First compute with original contents
    setupFileContents(baseContents);
    const fpResult = await computeSoulFingerprint();
    expect(fpResult.ok).toBe(true);
    const originalHash = fpResult.value!.hash;
    const originalFileHashes = fpResult.value!.files;

    // Now change only genesis.md
    setupFileContents({
      ...baseContents,
      'genesis.md': makeFakeContent('genesis-MODIFIED'),
    });

    const result = await verifySoulIntegrity(originalHash, originalFileHashes);
    expect(result.ok).toBe(true);
    expect(result.value!.valid).toBe(false);
    expect(result.value!.changedFiles).toEqual(['soul/genesis.md']);
  });

  it('reports all files as potentially changed when no per-file hashes stored (legacy)', async () => {
    setupFileContents(baseContents);
    const fpResult = await computeSoulFingerprint();
    expect(fpResult.ok).toBe(true);
    const originalHash = fpResult.value!.hash;

    // Change one file
    setupFileContents({
      ...baseContents,
      'milestones.json': makeFakeContent('milestones-MODIFIED'),
    });

    // Call without per-file hashes (legacy checkpoint)
    const result = await verifySoulIntegrity(originalHash);
    expect(result.ok).toBe(true);
    expect(result.value!.valid).toBe(false);
    // Legacy fallback: all files reported
    expect(result.value!.changedFiles).toEqual([...CRITICAL_FILES]);
  });

  it('reports all files when storedFileHashes is null (legacy)', async () => {
    setupFileContents(baseContents);
    const fpResult = await computeSoulFingerprint();
    const originalHash = fpResult.value!.hash;

    setupFileContents({
      ...baseContents,
      'identity.json': makeFakeContent('identity-MODIFIED'),
    });

    const result = await verifySoulIntegrity(originalHash, null);
    expect(result.ok).toBe(true);
    expect(result.value!.valid).toBe(false);
    expect(result.value!.changedFiles).toEqual([...CRITICAL_FILES]);
  });
});
