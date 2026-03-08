/**
 * Tests for soul-snapshot.ts — restoreSnapshot() functionality.
 *
 * Tests the recovery path: verify snapshot integrity → copy files → update fingerprint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external dependencies before importing ───────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/safety/soul-integrity.js', () => ({
  computeSoulFingerprint: vi.fn(),
  CRITICAL_FILES: [
    'soul/genesis.md',
    'soul/identity.json',
    'soul/vitals.json',
    'soul/milestones.json',
  ],
}));

vi.mock('../../src/safety/audit-chain.js', () => ({
  appendAuditEntry: vi.fn(async () => ({ ok: true, value: {} })),
}));

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockReaddir = vi.fn();
const mockRm = vi.fn();
const mockStat = vi.fn();
const mockCopyFile = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  copyFile: (...args: unknown[]) => mockCopyFile(...args),
}));

import { restoreSnapshot, diffCheckpoints, validateCheckpointIntegrity } from '../../src/safety/soul-snapshot.js';
import { computeSoulFingerprint } from '../../src/safety/soul-integrity.js';
import { appendAuditEntry } from '../../src/safety/audit-chain.js';

const mockedComputeFp = vi.mocked(computeSoulFingerprint);
const mockedAuditAppend = vi.mocked(appendAuditEntry);

// ── Test Data ─────────────────────────────────────────────────────────

function makeManifest(id = 'test-snapshot') {
  return {
    id,
    createdAt: '2026-02-20T00:00:00.000Z',
    trigger: 'pre-evolution' as const,
    fingerprint: {
      hash: 'composite-hash-abc',
      files: {
        'soul/genesis.md': 'hash-genesis',
        'soul/identity.json': 'hash-identity',
        'soul/vitals.json': 'hash-vitals',
        'soul/milestones.json': 'hash-milestones',
      },
      computedAt: '2026-02-20T00:00:00.000Z',
    },
    files: {
      'soul/genesis.md': { hash: 'hash-genesis', size: 100 },
      'soul/identity.json': { hash: 'hash-identity', size: 200 },
      'soul/vitals.json': { hash: 'hash-vitals', size: 150 },
      'soul/milestones.json': { hash: 'hash-milestones', size: 80 },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('restoreSnapshot()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({ size: 100 });
  });

  it('fails when snapshot verification fails', async () => {
    // verifySnapshot reads manifest → readFile throws
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await restoreSnapshot('nonexistent-id');
    expect(result.ok).toBe(false);
  });

  it('fails when snapshot is corrupted', async () => {
    const manifest = makeManifest();
    // First readFile: verifySnapshot reads manifest
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest));

    // verifySnapshot then reads each file and computes hash
    // Return content that produces a DIFFERENT hash than manifest expects
    // For each critical file in verifySnapshot, return content whose hash != manifest hash
    mockReadFile.mockResolvedValueOnce('corrupted genesis content');
    // This will produce a hash different from 'hash-genesis', so verifySnapshot returns false

    const result = await restoreSnapshot('test-snapshot');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('corrupted');
    }
  });

  it('successfully restores from a valid snapshot', async () => {
    const crypto = await import('node:crypto');
    const manifest = makeManifest();

    // Build manifest with real hashes
    const genesisContent = 'genesis file content';
    const identityContent = '{"name": "test"}';
    const vitalsContent = '{"energy": 0.99}';
    const milestonesContent = '{"milestones": []}';

    const realHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
    manifest.files['soul/genesis.md']!.hash = realHash(genesisContent);
    manifest.files['soul/identity.json']!.hash = realHash(identityContent);
    manifest.files['soul/vitals.json']!.hash = realHash(vitalsContent);
    manifest.files['soul/milestones.json']!.hash = realHash(milestonesContent);
    manifest.fingerprint.files['soul/genesis.md'] = realHash(genesisContent);
    manifest.fingerprint.files['soul/identity.json'] = realHash(identityContent);
    manifest.fingerprint.files['soul/vitals.json'] = realHash(vitalsContent);
    manifest.fingerprint.files['soul/milestones.json'] = realHash(milestonesContent);

    // verifySnapshot: read manifest
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest));
    // verifySnapshot: read each snapshot file (returns matching content)
    mockReadFile.mockResolvedValueOnce(genesisContent);
    mockReadFile.mockResolvedValueOnce(identityContent);
    mockReadFile.mockResolvedValueOnce(vitalsContent);
    mockReadFile.mockResolvedValueOnce(milestonesContent);
    // restoreSnapshot: read manifest again
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest));
    // restoreSnapshot: read vitals.json for fingerprint update
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ energy: 0.99 }));

    // Mock computeSoulFingerprint for post-restore fingerprint update
    mockedComputeFp.mockResolvedValueOnce({
      ok: true,
      value: { hash: 'new-hash', files: {}, computedAt: '2026-02-20T00:00:00Z' },
      message: 'ok',
    });

    const result = await restoreSnapshot('test-snapshot');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('test-snapshot');
    }

    // Should have copied 4 files
    expect(mockCopyFile).toHaveBeenCalledTimes(4);

    // Should have written updated vitals
    expect(mockWriteFile).toHaveBeenCalled();

    // Should have recorded in audit chain
    expect(mockedAuditAppend).toHaveBeenCalledWith(
      'integrity:mismatch',
      expect.objectContaining({
        witnessNote: expect.stringContaining('test-snapshot'),
        filesChanged: expect.arrayContaining(['soul/genesis.md']),
      }),
    );
  });

  it('records restoration event in audit chain', async () => {
    const crypto = await import('node:crypto');
    const manifest = makeManifest();
    const content = 'any content';
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // Set all hashes to match
    for (const key of Object.keys(manifest.files)) {
      manifest.files[key]!.hash = hash;
      manifest.fingerprint.files[key] = hash;
    }

    // verifySnapshot reads
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest));
    mockReadFile.mockResolvedValueOnce(content);
    mockReadFile.mockResolvedValueOnce(content);
    mockReadFile.mockResolvedValueOnce(content);
    mockReadFile.mockResolvedValueOnce(content);
    // restoreSnapshot reads manifest
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest));
    // vitals read for fingerprint update
    mockReadFile.mockResolvedValueOnce('{}');

    mockedComputeFp.mockResolvedValueOnce({
      ok: true,
      value: { hash: 'updated-fp', files: {}, computedAt: '2026-02-20T00:00:00Z' },
      message: 'ok',
    });

    await restoreSnapshot('test-snapshot');

    expect(mockedAuditAppend).toHaveBeenCalledTimes(1);
    expect(mockedAuditAppend).toHaveBeenCalledWith(
      'integrity:mismatch',
      expect.objectContaining({
        witnessNote: expect.stringContaining('restored'),
      }),
    );
  });
});

// ── diffCheckpoints Tests ────────────────────────────────────────────

describe('diffCheckpoints()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockRm.mockResolvedValue(undefined);
  });

  it('fails when older snapshot not found', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await diffCheckpoints('nonexistent', 'also-nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('nonexistent');
  });

  it('detects changed files between two snapshots', async () => {
    const older = makeManifest('snap-old');
    const newer = makeManifest('snap-new');
    // Change identity.json hash in newer
    newer.files['soul/identity.json']!.hash = 'different-hash';
    newer.fingerprint.hash = 'different-composite';

    mockReadFile.mockResolvedValueOnce(JSON.stringify(older));
    mockReadFile.mockResolvedValueOnce(JSON.stringify(newer));

    const result = await diffCheckpoints('snap-old', 'snap-new');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changedFiles).toContain('soul/identity.json');
      expect(result.value.changedFiles).toHaveLength(1);
      expect(result.value.fingerprintChanged).toBe(true);
    }
  });

  it('reports no changes when snapshots are identical', async () => {
    const a = makeManifest('snap-a');
    const b = makeManifest('snap-b');

    mockReadFile.mockResolvedValueOnce(JSON.stringify(a));
    mockReadFile.mockResolvedValueOnce(JSON.stringify(b));

    const result = await diffCheckpoints('snap-a', 'snap-b');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changedFiles).toHaveLength(0);
      expect(result.value.addedFiles).toHaveLength(0);
      expect(result.value.removedFiles).toHaveLength(0);
      expect(result.value.fingerprintChanged).toBe(false);
    }
  });

  it('detects added and removed files', async () => {
    const older = makeManifest('snap-old');
    const newer = makeManifest('snap-new');
    // Remove genesis from older, add a new file to newer
    const { 'soul/genesis.md': _, ...olderWithout } = older.files;
    older.files = olderWithout as typeof older.files;
    newer.files['soul/new-file.json'] = { hash: 'new-hash', size: 50 };

    mockReadFile.mockResolvedValueOnce(JSON.stringify(older));
    mockReadFile.mockResolvedValueOnce(JSON.stringify(newer));

    const result = await diffCheckpoints('snap-old', 'snap-new');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.addedFiles).toContain('soul/genesis.md');
      expect(result.value.addedFiles).toContain('soul/new-file.json');
      expect(result.value.removedFiles).toHaveLength(0);
    }
  });
});

// ── validateCheckpointIntegrity Tests ────────────────────────────────

describe('validateCheckpointIntegrity()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('returns empty array when no checkpoints exist', async () => {
    mockReaddir.mockResolvedValue([]);

    const result = await validateCheckpointIntegrity();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(0);
  });

  it('marks valid checkpoints as valid', async () => {
    const crypto = await import('node:crypto');
    const content = 'file content';
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    const manifest = makeManifest('snap-1');
    for (const key of Object.keys(manifest.files)) {
      manifest.files[key]!.hash = hash;
    }

    // listSnapshots: readdir returns one directory
    mockReaddir.mockResolvedValueOnce([
      { name: 'snap-1', isDirectory: () => true },
    ]);
    // listSnapshots: reads manifest
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest));

    // validateCheckpointIntegrity: reads each file (4 files)
    mockReadFile.mockResolvedValueOnce(content);
    mockReadFile.mockResolvedValueOnce(content);
    mockReadFile.mockResolvedValueOnce(content);
    mockReadFile.mockResolvedValueOnce(content);

    const result = await validateCheckpointIntegrity();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.valid).toBe(true);
      expect(result.value[0]!.corruptedFiles).toHaveLength(0);
    }
  });

  it('detects corrupted files in checkpoints', async () => {
    const manifest = makeManifest('snap-corrupt');

    mockReaddir.mockResolvedValueOnce([
      { name: 'snap-corrupt', isDirectory: () => true },
    ]);
    mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest));

    // All files return content that won't match expected hashes
    mockReadFile.mockResolvedValueOnce('wrong content');
    mockReadFile.mockResolvedValueOnce('wrong content');
    mockReadFile.mockResolvedValueOnce('wrong content');
    mockReadFile.mockResolvedValueOnce('wrong content');

    const result = await validateCheckpointIntegrity();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.valid).toBe(false);
      expect(result.value[0]!.corruptedFiles.length).toBeGreaterThan(0);
    }
  });
});
