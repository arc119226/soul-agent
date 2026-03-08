/**
 * Tests for audit-chain.ts — Merkle Tree + Hash Chain integrity auditing.
 *
 * Pure-logic tests for:
 *   - Merkle tree construction and root computation
 *   - Hash chain entry creation and linking
 *   - Chain verification (valid + tampered)
 *   - Witness recording
 *   - Edge cases (empty input, single leaf, odd leaves)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// ── Mock external dependencies before importing ───────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/core/debounced-writer.js', () => {
  const lines: string[] = [];
  return {
    writer: {
      appendJsonl: vi.fn(async (_path: string, data: unknown) => {
        lines.push(JSON.stringify(data));
      }),
      schedule: vi.fn(),
      __getLines: () => lines,
      __clearLines: () => { lines.length = 0; },
    },
  };
});

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../../src/core/tail-read.js', () => ({
  tailReadJsonl: vi.fn().mockResolvedValue([]),
}));

import {
  buildMerkleTree,
  computeEntryHash,
  computeMerkleRootFromHashes,
  computeMerkleRoot,
  generateProof,
  verifyProof,
  generateProofFromHashes,
  appendAuditEntry,
  verifyChain,
  recordWitness,
  getChainStatus,
  getGenesisHash,
  getRecentWitnesses,
  getRecentEntries,
  verifyAuditLogIntegrity,
  type AuditEntry,
} from '../../src/safety/audit-chain.js';

import { readFile } from 'node:fs/promises';
import { tailReadJsonl } from '../../src/core/tail-read.js';

const mockedReadFile = vi.mocked(readFile);
const mockedTailReadJsonl = vi.mocked(tailReadJsonl);

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

// ── Merkle Tree Tests ─────────────────────────────────────────────────

describe('buildMerkleTree()', () => {
  it('returns null for empty input', () => {
    expect(buildMerkleTree([])).toBeNull();
  });

  it('returns single leaf as root for one element', () => {
    const root = buildMerkleTree([{ label: 'a.txt', hash: 'abc123' }]);
    expect(root).not.toBeNull();
    expect(root!.hash).toBe('abc123');
    expect(root!.label).toBe('a.txt');
    expect(root!.left).toBeUndefined();
    expect(root!.right).toBeUndefined();
  });

  it('builds correct tree for two leaves', () => {
    const h1 = sha256('file1');
    const h2 = sha256('file2');
    const root = buildMerkleTree([
      { label: 'f1', hash: h1 },
      { label: 'f2', hash: h2 },
    ]);

    expect(root).not.toBeNull();
    expect(root!.hash).toBe(sha256(h1 + h2));
    expect(root!.left!.hash).toBe(h1);
    expect(root!.right!.hash).toBe(h2);
  });

  it('handles odd number of leaves (duplicates last)', () => {
    const h1 = sha256('a');
    const h2 = sha256('b');
    const h3 = sha256('c');

    const root = buildMerkleTree([
      { label: '1', hash: h1 },
      { label: '2', hash: h2 },
      { label: '3', hash: h3 },
    ]);

    expect(root).not.toBeNull();
    // Level 1: [sha256(h1+h2), sha256(h3+h3)]
    const left = sha256(h1 + h2);
    const right = sha256(h3 + h3);
    expect(root!.hash).toBe(sha256(left + right));
  });

  it('builds correct tree for four leaves', () => {
    const hashes = ['a', 'b', 'c', 'd'].map((s) => sha256(s));
    const root = buildMerkleTree(
      hashes.map((h, i) => ({ label: `${i}`, hash: h })),
    );

    const l1 = sha256(hashes[0]! + hashes[1]!);
    const l2 = sha256(hashes[2]! + hashes[3]!);
    expect(root!.hash).toBe(sha256(l1 + l2));
  });

  it('is deterministic — same input always gives same root', () => {
    const leaves = [
      { label: 'x', hash: sha256('hello') },
      { label: 'y', hash: sha256('world') },
    ];
    const root1 = buildMerkleTree(leaves);
    const root2 = buildMerkleTree(leaves);
    expect(root1!.hash).toBe(root2!.hash);
  });
});

describe('computeMerkleRootFromHashes()', () => {
  it('returns null for empty object', () => {
    expect(computeMerkleRootFromHashes({})).toBeNull();
  });

  it('returns leaf hash for single file', () => {
    const hash = sha256('content');
    const root = computeMerkleRootFromHashes({ 'file.txt': hash });
    expect(root).toBe(hash);
  });

  it('sorts files alphabetically for deterministic root', () => {
    const hashes = {
      'b.txt': sha256('b'),
      'a.txt': sha256('a'),
    };
    const root1 = computeMerkleRootFromHashes(hashes);
    const root2 = computeMerkleRootFromHashes({ 'a.txt': sha256('a'), 'b.txt': sha256('b') });
    expect(root1).toBe(root2);
  });

  it('produces different root when any hash changes', () => {
    const original = {
      'soul/genesis.md': sha256('genesis'),
      'soul/identity.json': sha256('identity'),
    };
    const modified = {
      ...original,
      'soul/identity.json': sha256('identity-modified'),
    };
    const root1 = computeMerkleRootFromHashes(original);
    const root2 = computeMerkleRootFromHashes(modified);
    expect(root1).not.toBe(root2);
  });
});

// ── Merkle Proof Tests ────────────────────────────────────────────────

describe('generateProof()', () => {
  it('returns null for leaf not in tree', () => {
    const root = buildMerkleTree([
      { label: 'a.txt', hash: sha256('a') },
      { label: 'b.txt', hash: sha256('b') },
    ]);
    const proof = generateProof(root!, 'nonexistent.txt');
    expect(proof).toBeNull();
  });

  it('generates valid proof for single-leaf tree', () => {
    const hash = sha256('only file');
    const root = buildMerkleTree([{ label: 'only.txt', hash }]);
    const proof = generateProof(root!, 'only.txt');

    expect(proof).not.toBeNull();
    expect(proof!.leaf.label).toBe('only.txt');
    expect(proof!.leaf.hash).toBe(hash);
    expect(proof!.steps).toHaveLength(0); // single leaf = no siblings
    expect(proof!.root).toBe(hash);
  });

  it('generates valid proof for 2-leaf tree', () => {
    const hA = sha256('fileA');
    const hB = sha256('fileB');
    const root = buildMerkleTree([
      { label: 'a.txt', hash: hA },
      { label: 'b.txt', hash: hB },
    ]);

    const proofA = generateProof(root!, 'a.txt');
    expect(proofA).not.toBeNull();
    expect(proofA!.leaf.hash).toBe(hA);
    expect(proofA!.steps).toHaveLength(1);
    expect(proofA!.steps[0]!.hash).toBe(hB);
    expect(proofA!.steps[0]!.position).toBe('right');

    const proofB = generateProof(root!, 'b.txt');
    expect(proofB).not.toBeNull();
    expect(proofB!.leaf.hash).toBe(hB);
    expect(proofB!.steps).toHaveLength(1);
    expect(proofB!.steps[0]!.hash).toBe(hA);
    expect(proofB!.steps[0]!.position).toBe('left');
  });

  it('generates valid proof for 4-leaf tree (all leaves)', () => {
    const hashes = ['a', 'b', 'c', 'd'].map((s) => sha256(s));
    const labels = ['soul/genesis.md', 'soul/identity.json', 'soul/milestones.json', 'soul/vitals.json'];
    const leaves = labels.map((l, i) => ({ label: l, hash: hashes[i]! }));
    const root = buildMerkleTree(leaves);

    // Every leaf should produce a valid proof
    for (const leaf of leaves) {
      const proof = generateProof(root!, leaf.label);
      expect(proof).not.toBeNull();
      expect(proof!.leaf.hash).toBe(leaf.hash);
      expect(proof!.steps.length).toBeGreaterThan(0);
      expect(proof!.root).toBe(root!.hash);
      // Verify the proof is correct
      expect(verifyProof(proof!, leaf.hash)).toBe(true);
    }
  });

  it('generates valid proof for odd-count leaves (3 leaves)', () => {
    const leaves = [
      { label: 'x', hash: sha256('x') },
      { label: 'y', hash: sha256('y') },
      { label: 'z', hash: sha256('z') },
    ];
    const root = buildMerkleTree(leaves);

    for (const leaf of leaves) {
      const proof = generateProof(root!, leaf.label);
      expect(proof).not.toBeNull();
      expect(verifyProof(proof!, leaf.hash)).toBe(true);
    }
  });
});

describe('verifyProof()', () => {
  it('verifies a valid proof', () => {
    const hA = sha256('fileA');
    const hB = sha256('fileB');
    const expectedRoot = sha256(hA + hB);

    const proof = {
      leaf: { label: 'a.txt', hash: hA },
      steps: [{ hash: hB, position: 'right' as const }],
      root: expectedRoot,
    };

    expect(verifyProof(proof, hA)).toBe(true);
  });

  it('rejects proof with wrong leaf hash', () => {
    const hA = sha256('fileA');
    const hB = sha256('fileB');
    const expectedRoot = sha256(hA + hB);

    const proof = {
      leaf: { label: 'a.txt', hash: sha256('WRONG') },
      steps: [{ hash: hB, position: 'right' as const }],
      root: expectedRoot,
    };

    expect(verifyProof(proof, hA)).toBe(false);
  });

  it('rejects proof with wrong sibling hash', () => {
    const hA = sha256('fileA');
    const hB = sha256('fileB');
    const expectedRoot = sha256(hA + hB);

    const proof = {
      leaf: { label: 'a.txt', hash: hA },
      steps: [{ hash: sha256('WRONG'), position: 'right' as const }],
      root: expectedRoot,
    };

    expect(verifyProof(proof, hA)).toBe(false);
  });

  it('rejects proof with wrong root', () => {
    const hA = sha256('fileA');
    const hB = sha256('fileB');

    const proof = {
      leaf: { label: 'a.txt', hash: hA },
      steps: [{ hash: hB, position: 'right' as const }],
      root: 'wrong-root-hash',
    };

    expect(verifyProof(proof, hA)).toBe(false);
  });

  it('rejects proof with swapped position', () => {
    const hA = sha256('fileA');
    const hB = sha256('fileB');
    const correctRoot = sha256(hA + hB);

    const proof = {
      leaf: { label: 'a.txt', hash: hA },
      steps: [{ hash: hB, position: 'left' as const }], // should be 'right'
      root: correctRoot,
    };

    expect(verifyProof(proof, hA)).toBe(false);
  });

  // ── SPEC-16: Single-leaf bypass fix ──────────────────────────────
  it('rejects forged single-leaf proof (expectedLeafHash mismatch)', () => {
    const realHash = sha256('real-content');
    const forgedHash = sha256('forged-content');

    // Attacker constructs a proof where leaf.hash === root (trivially true for single-leaf)
    const forgedProof = {
      leaf: { label: 'soul/genesis.md', hash: forgedHash },
      steps: [],
      root: forgedHash,
    };

    // Caller provides the real expected hash — forgery must be rejected
    expect(verifyProof(forgedProof, realHash)).toBe(false);
  });

  it('accepts valid single-leaf proof with correct expectedLeafHash', () => {
    const hash = sha256('real-content');
    const proof = {
      leaf: { label: 'soul/genesis.md', hash },
      steps: [],
      root: hash,
    };

    expect(verifyProof(proof, hash)).toBe(true);
  });

  it('rejects single-leaf proof where leaf.hash !== root', () => {
    const hash = sha256('content');
    const proof = {
      leaf: { label: 'a.txt', hash },
      steps: [],
      root: 'different-root',
    };

    expect(verifyProof(proof, hash)).toBe(false);
  });
});

describe('generateProofFromHashes()', () => {
  it('returns null for empty hashes', () => {
    expect(generateProofFromHashes({}, 'any.txt')).toBeNull();
  });

  it('returns null for target not in hashes', () => {
    const hashes = { 'a.txt': sha256('a'), 'b.txt': sha256('b') };
    expect(generateProofFromHashes(hashes, 'c.txt')).toBeNull();
  });

  it('generates verifiable proof from file hashes', () => {
    const hashes = {
      'soul/genesis.md': sha256('genesis content'),
      'soul/identity.json': sha256('identity content'),
      'soul/vitals.json': sha256('vitals content'),
      'soul/milestones.json': sha256('milestones content'),
    };

    for (const file of Object.keys(hashes)) {
      const proof = generateProofFromHashes(hashes, file);
      expect(proof).not.toBeNull();
      expect(verifyProof(proof!, hashes[file]!)).toBe(true);
      expect(proof!.leaf.label).toBe(file);
      expect(proof!.leaf.hash).toBe(hashes[file]);
    }
  });

  it('proof root matches computeMerkleRootFromHashes', () => {
    const hashes = {
      'soul/genesis.md': sha256('genesis'),
      'soul/identity.json': sha256('identity'),
    };
    const root = computeMerkleRootFromHashes(hashes);
    const proof = generateProofFromHashes(hashes, 'soul/genesis.md');

    expect(proof).not.toBeNull();
    expect(proof!.root).toBe(root);
  });
});

describe('computeMerkleRoot() with disk I/O', () => {
  it('returns fail for empty file list', async () => {
    const result = await computeMerkleRoot([]);
    expect(result.ok).toBe(false);
  });

  it('hashes file content from disk', async () => {
    mockedReadFile.mockResolvedValueOnce('file content here');
    const result = await computeMerkleRoot(['test.txt']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(sha256('file content here'));
    }
  });

  it('handles missing file with sentinel hash', async () => {
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const result = await computeMerkleRoot(['missing.txt']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(sha256('MISSING:missing.txt'));
    }
  });
});

// ── Hash Chain Entry Tests ────────────────────────────────────────────

describe('computeEntryHash()', () => {
  it('computes deterministic hash from entry fields', () => {
    const entry = {
      index: 0,
      timestamp: '2026-02-20T00:00:00.000Z',
      type: 'evolution:start' as const,
      prevHash: 'genesis',
      payload: { goalId: 'g1' },
      merkleRoot: undefined,
    };
    const hash1 = computeEntryHash(entry);
    const hash2 = computeEntryHash(entry);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex length
  });

  it('changes when any field changes', () => {
    const base = {
      index: 0,
      timestamp: '2026-02-20T00:00:00.000Z',
      type: 'evolution:start' as const,
      prevHash: 'genesis',
      payload: { goalId: 'g1' },
    };
    const h1 = computeEntryHash(base);
    const h2 = computeEntryHash({ ...base, index: 1 });
    const h3 = computeEntryHash({ ...base, payload: { goalId: 'g2' } });
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('includes merkleRoot in hash computation', () => {
    const base = {
      index: 0,
      timestamp: '2026-02-20T00:00:00.000Z',
      type: 'witness' as const,
      prevHash: 'genesis',
      payload: {},
    };
    const h1 = computeEntryHash({ ...base, merkleRoot: 'root1' });
    const h2 = computeEntryHash({ ...base, merkleRoot: 'root2' });
    expect(h1).not.toBe(h2);
  });
});

// ── Chain Operations (with mocked I/O) ───────────────────────────────

describe('appendAuditEntry()', () => {
  beforeEach(() => {
    // Reset module state by making readFile throw (no existing log)
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    vi.clearAllMocks();
  });

  it('appends entry with genesis prevHash for first entry', async () => {
    // Force re-init by importing fresh (or just test the output)
    const result = await appendAuditEntry('evolution:start', { goalId: 'g1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.index).toBeGreaterThanOrEqual(0);
      expect(result.value.type).toBe('evolution:start');
      expect(result.value.payload.goalId).toBe('g1');
      expect(result.value.hash).toHaveLength(64);
    }
  });

  it('links consecutive entries via prevHash', async () => {
    const r1 = await appendAuditEntry('evolution:start', { goalId: 'g1' });
    const r2 = await appendAuditEntry('evolution:success', { goalId: 'g1' });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.value.prevHash).toBe(r1.value.hash);
    }
  });

  it('increments index for each entry', async () => {
    const r1 = await appendAuditEntry('evolution:start', { goalId: 'g1' });
    const r2 = await appendAuditEntry('evolution:success', { goalId: 'g1' });

    if (r1.ok && r2.ok) {
      expect(r2.value.index).toBe(r1.value.index + 1);
    }
  });

  it('includes merkleRoot when provided', async () => {
    const result = await appendAuditEntry('witness', { witnessNote: 'test' }, 'merkle-root-123');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.merkleRoot).toBe('merkle-root-123');
    }
  });
});

describe('appendAuditEntry() serialization', () => {
  beforeEach(() => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    vi.clearAllMocks();
  });

  it('concurrent appends produce sequential indices (no race condition)', async () => {
    // Fire 5 concurrent appends — without mutex these would get duplicate indices
    const results = await Promise.all([
      appendAuditEntry('evolution:start', { goalId: 'g1' }),
      appendAuditEntry('evolution:success', { goalId: 'g2' }),
      appendAuditEntry('witness', { witnessNote: 'w1' }),
      appendAuditEntry('evolution:fail', { error: 'e1' }),
      appendAuditEntry('transition:state', { description: 't1' }),
    ]);

    // All should succeed
    expect(results.every(r => r.ok)).toBe(true);

    // Indices should be sequential (no duplicates)
    const indices = results.filter(r => r.ok).map(r => r.ok ? r.value.index : -1);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1]! + 1);
    }

    // Each entry's prevHash should point to the previous entry's hash
    const entries = results.filter(r => r.ok).map(r => r.ok ? r.value : null);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.prevHash).toBe(entries[i - 1]!.hash);
    }
  });
});

// ── Chain Verification ────────────────────────────────────────────────

describe('verifyChain()', () => {
  it('returns valid for nonexistent chain file', async () => {
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const result = await verifyChain();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valid).toBe(true);
      expect(result.value.length).toBe(0);
    }
  });

  it('returns valid for empty file', async () => {
    mockedReadFile.mockResolvedValueOnce('');
    const result = await verifyChain();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valid).toBe(true);
      expect(result.value.length).toBe(0);
    }
  });

  it('validates a well-formed single-entry chain', async () => {
    const genesis = getGenesisHash();
    const entry: AuditEntry = {
      index: 0,
      timestamp: '2026-02-20T00:00:00.000Z',
      type: 'evolution:start',
      prevHash: genesis,
      payload: { goalId: 'g1' },
      hash: '', // will be computed
    };
    entry.hash = computeEntryHash(entry);

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(entry));
    const result = await verifyChain();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valid).toBe(true);
      expect(result.value.length).toBe(1);
      expect(result.value.brokenAt).toBe(-1);
    }
  });

  it('validates a well-formed multi-entry chain', async () => {
    const genesis = getGenesisHash();

    const e0: AuditEntry = {
      index: 0,
      timestamp: '2026-02-20T00:00:00.000Z',
      type: 'evolution:start',
      prevHash: genesis,
      payload: { goalId: 'g1' },
      hash: '',
    };
    e0.hash = computeEntryHash(e0);

    const e1: AuditEntry = {
      index: 1,
      timestamp: '2026-02-20T00:01:00.000Z',
      type: 'evolution:success',
      prevHash: e0.hash,
      payload: { goalId: 'g1', filesChanged: ['src/test.ts'] },
      hash: '',
    };
    e1.hash = computeEntryHash(e1);

    const content = [JSON.stringify(e0), JSON.stringify(e1)].join('\n');
    mockedReadFile.mockResolvedValueOnce(content);

    const result = await verifyChain();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valid).toBe(true);
      expect(result.value.length).toBe(2);
    }
  });

  it('detects tampered hash', async () => {
    const genesis = getGenesisHash();
    const entry: AuditEntry = {
      index: 0,
      timestamp: '2026-02-20T00:00:00.000Z',
      type: 'evolution:start',
      prevHash: genesis,
      payload: { goalId: 'g1' },
      hash: 'tampered-hash-value-that-is-definitely-wrong-1234567890abcdef',
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(entry));
    const result = await verifyChain();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valid).toBe(false);
      expect(result.value.brokenAt).toBe(0);
      expect(result.value.errors.length).toBeGreaterThan(0);
    }
  });

  it('detects broken prevHash link', async () => {
    const genesis = getGenesisHash();

    const e0: AuditEntry = {
      index: 0,
      timestamp: '2026-02-20T00:00:00.000Z',
      type: 'evolution:start',
      prevHash: genesis,
      payload: { goalId: 'g1' },
      hash: '',
    };
    e0.hash = computeEntryHash(e0);

    const e1: AuditEntry = {
      index: 1,
      timestamp: '2026-02-20T00:01:00.000Z',
      type: 'evolution:success',
      prevHash: 'wrong-prev-hash',
      payload: { goalId: 'g1' },
      hash: '',
    };
    e1.hash = computeEntryHash(e1);

    const content = [JSON.stringify(e0), JSON.stringify(e1)].join('\n');
    mockedReadFile.mockResolvedValueOnce(content);

    const result = await verifyChain();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valid).toBe(false);
      expect(result.value.brokenAt).toBe(1);
    }
  });

  it('detects invalid JSON in chain', async () => {
    mockedReadFile.mockResolvedValueOnce('not valid json\n{"also":"broken');
    const result = await verifyChain();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valid).toBe(false);
      expect(result.value.errors.length).toBeGreaterThan(0);
    }
  });
});

// ── Witness Tests ─────────────────────────────────────────────────────

describe('recordWitness()', () => {
  beforeEach(() => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    vi.clearAllMocks();
  });

  it('records witness with Merkle root from file hashes', async () => {
    const fileHashes = {
      'soul/genesis.md': sha256('genesis'),
      'soul/identity.json': sha256('identity'),
    };
    const result = await recordWitness(fileHashes, 'active');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.merkleRoot).toHaveLength(64);
      expect(result.value.state).toBe('active');
      expect(result.value.chainLength).toBeGreaterThan(0);
    }
  });

  it('fails for empty file hashes', async () => {
    const result = await recordWitness({}, 'active');
    expect(result.ok).toBe(false);
  });
});

// ── Query Helpers ─────────────────────────────────────────────────────

describe('getRecentWitnesses()', () => {
  it('returns empty array when no witness file exists', async () => {
    mockedTailReadJsonl.mockResolvedValueOnce([]);
    const witnesses = await getRecentWitnesses();
    expect(witnesses).toEqual([]);
  });

  it('returns parsed witness entries', async () => {
    const entry = { timestamp: '2026-02-20T00:00:00Z', merkleRoot: 'abc', chainTip: 'def', chainLength: 1, state: 'active' };
    mockedTailReadJsonl.mockResolvedValueOnce([entry]);
    const witnesses = await getRecentWitnesses();
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0]!.merkleRoot).toBe('abc');
  });
});

describe('getRecentEntries()', () => {
  it('returns empty array when no chain file exists', async () => {
    mockedTailReadJsonl.mockResolvedValueOnce([]);
    const entries = await getRecentEntries();
    expect(entries).toEqual([]);
  });
});

// ── Status ────────────────────────────────────────────────────────────

describe('getChainStatus()', () => {
  it('returns current chain tip and length', () => {
    const status = getChainStatus();
    expect(status).toHaveProperty('tip');
    expect(status).toHaveProperty('length');
    expect(status).toHaveProperty('initialized');
    expect(typeof status.tip).toBe('string');
    expect(typeof status.length).toBe('number');
  });
});

describe('getGenesisHash()', () => {
  it('returns a deterministic 64-char hex string', () => {
    const hash = getGenesisHash();
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Deterministic
    expect(getGenesisHash()).toBe(hash);
  });
});

// ── Audit Log Integrity (Phase 1A) ───────────────────────────────────

describe('recordWitness() auditLogHash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes auditLogHash when audit log exists', async () => {
    const logContent = '{"index":0}\n{"index":1}';
    // initAuditChain already ran (module state persists), so only mock the
    // auditLogHash readFile call inside recordWitness
    mockedReadFile.mockResolvedValueOnce(logContent);

    const fileHashes = {
      'soul/genesis.md': sha256('genesis'),
      'soul/identity.json': sha256('identity'),
    };
    const result = await recordWitness(fileHashes, 'active');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.auditLogHash).toBe(sha256(logContent));
    }
  });

  it('omits auditLogHash when audit log does not exist', async () => {
    // Only the auditLogHash read — initAuditChain already initialized
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const fileHashes = { 'soul/genesis.md': sha256('genesis') };
    const result = await recordWitness(fileHashes, 'active');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.auditLogHash).toBeUndefined();
    }
  });
});

describe('verifyAuditLogIntegrity()', () => {
  it('returns null when no witnesses exist', async () => {
    mockedTailReadJsonl.mockResolvedValueOnce([]);
    const result = await verifyAuditLogIntegrity();
    expect(result).toBeNull();
  });

  it('returns null when witness has no auditLogHash', async () => {
    const witness = { timestamp: '2026-02-20T00:00:00Z', merkleRoot: 'abc', chainTip: 'def', chainLength: 1, state: 'active' };
    mockedTailReadJsonl.mockResolvedValueOnce([witness]); // getRecentWitnesses
    const result = await verifyAuditLogIntegrity();
    expect(result).toBeNull();
  });

  it('detects audit log deletion', async () => {
    const witness = {
      timestamp: '2026-02-20T00:00:00Z', merkleRoot: 'abc', chainTip: 'def',
      chainLength: 5, state: 'active', auditLogHash: sha256('some content'),
    };
    mockedTailReadJsonl.mockResolvedValueOnce([witness]); // getRecentWitnesses
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT')); // audit log missing
    const result = await verifyAuditLogIntegrity();
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result!.ok) {
      expect(result!.value.valid).toBe(false);
      expect(result!.value.message).toContain('missing');
    }
  });

  it('detects audit log truncation', async () => {
    const logContent = '{"index":0}\n{"index":1}'; // 2 entries
    const witness = {
      timestamp: '2026-02-20T00:00:00Z', merkleRoot: 'abc', chainTip: 'def',
      chainLength: 5, state: 'active', auditLogHash: sha256('old content'),
    };
    mockedTailReadJsonl.mockResolvedValueOnce([witness]); // getRecentWitnesses
    mockedReadFile.mockResolvedValueOnce(logContent); // audit log read (truncated)
    const result = await verifyAuditLogIntegrity();
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result!.ok) {
      expect(result!.value.valid).toBe(false);
      expect(result!.value.message).toContain('2');
      expect(result!.value.message).toContain('5');
    }
  });

  it('accepts audit log with new entries appended', async () => {
    const logContent = '{"index":0}\n{"index":1}\n{"index":2}\n{"index":3}\n{"index":4}\n{"index":5}';
    const witness = {
      timestamp: '2026-02-20T00:00:00Z', merkleRoot: 'abc', chainTip: 'def',
      chainLength: 3, state: 'active', auditLogHash: sha256('old shorter content'),
    };
    mockedTailReadJsonl.mockResolvedValueOnce([witness]); // getRecentWitnesses
    mockedReadFile.mockResolvedValueOnce(logContent); // audit log (grew)
    const result = await verifyAuditLogIntegrity();
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    if (result!.ok) {
      expect(result!.value.valid).toBe(true);
      expect(result!.value.message).toContain('appended');
    }
  });
});
