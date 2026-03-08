/**
 * Tests for identity-continuity.ts — unified facade.
 * Focus: combination logic (healthy / degraded / compromised), not per-layer internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all four layers ─────────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Soul integrity mocks
const mockComputeSoulFingerprint = vi.fn();
const mockDiffFingerprints = vi.fn();
vi.mock('../../src/safety/soul-integrity.js', () => ({
  computeSoulFingerprint: (...args: unknown[]) => mockComputeSoulFingerprint(...args),
  diffFingerprints: (...args: unknown[]) => mockDiffFingerprints(...args),
}));

const mockGetFingerprint = vi.fn();
const mockGetFileHashes = vi.fn();
vi.mock('../../src/identity/vitals.js', () => ({
  getFingerprint: (...args: unknown[]) => mockGetFingerprint(...args),
  getFileHashes: (...args: unknown[]) => mockGetFileHashes(...args),
}));

// Event sourcing + identity mocks
const mockValidateIdentityConsistency = vi.fn();
const mockGetIdentity = vi.fn();
vi.mock('../../src/identity/identity-store.js', () => ({
  validateIdentityConsistency: (...args: unknown[]) => mockValidateIdentityConsistency(...args),
  getIdentity: (...args: unknown[]) => mockGetIdentity(...args),
}));

// Audit chain mocks
const mockVerifyChain = vi.fn();
const mockRepairChain = vi.fn();
const mockVerifyAuditLogIntegrity = vi.fn();
const mockComputeMerkleRootFromHashes = vi.fn();
const mockGetChainStatus = vi.fn();
const mockInitAuditChain = vi.fn();
const mockGenerateProofFromHashes = vi.fn();
const mockVerifyProof = vi.fn();
vi.mock('../../src/safety/audit-chain.js', () => ({
  verifyChain: (...args: unknown[]) => mockVerifyChain(...args),
  repairChain: (...args: unknown[]) => mockRepairChain(...args),
  verifyAuditLogIntegrity: (...args: unknown[]) => mockVerifyAuditLogIntegrity(...args),
  computeMerkleRootFromHashes: (...args: unknown[]) => mockComputeMerkleRootFromHashes(...args),
  getChainStatus: (...args: unknown[]) => mockGetChainStatus(...args),
  initAuditChain: (...args: unknown[]) => mockInitAuditChain(...args),
  generateProofFromHashes: (...args: unknown[]) => mockGenerateProofFromHashes(...args),
  verifyProof: (...args: unknown[]) => mockVerifyProof(...args),
}));

// Checkpoint mock
const mockValidateCheckpointIntegrity = vi.fn();
vi.mock('../../src/safety/soul-snapshot.js', () => ({
  validateCheckpointIntegrity: (...args: unknown[]) => mockValidateCheckpointIntegrity(...args),
}));

// Causal verification mock
const mockVerifyCausalHistory = vi.fn();
vi.mock('../../src/lifecycle/causal-verification.js', () => ({
  verifyCausalHistory: (...args: unknown[]) => mockVerifyCausalHistory(...args),
}));

// Vector clock mock
const mockGetClock = vi.fn();
vi.mock('../../src/lifecycle/vector-clock.js', () => ({
  getClock: (...args: unknown[]) => mockGetClock(...args),
}));

import {
  runFullIdentityCheck,
  generateIdentityPassport,
  verifyIdentityPassport,
  type IdentityPassport,
} from '../../src/identity/identity-continuity.js';

// ── Helpers ──────────────────────────────────────────────────────────

const FILE_HASHES = { 'soul/genesis.md': 'aaa', 'soul/identity.json': 'bbb' };

function setupAllPassing() {
  // Soul integrity: pass
  mockGetFingerprint.mockResolvedValue('stored-hash');
  mockGetFileHashes.mockResolvedValue({});
  mockComputeSoulFingerprint.mockResolvedValue({
    ok: true, value: { hash: 'stored-hash', files: FILE_HASHES, computedAt: '' },
  });

  // Event sourcing: pass (no discrepancies)
  mockValidateIdentityConsistency.mockResolvedValue([]);

  // Identity
  mockGetIdentity.mockResolvedValue({
    core_traits: {
      curiosity_level: { value: 0.80, description: '' },
      warmth: { value: 1.00, description: '' },
    },
  });

  // Audit chain: pass
  mockVerifyChain.mockResolvedValue({
    ok: true, value: { valid: true, length: 5, errors: [], brokenAt: -1 },
  });
  mockRepairChain.mockResolvedValue({
    ok: true, value: { removed: 0, remaining: 5 },
  });
  mockVerifyAuditLogIntegrity.mockResolvedValue(null);
  mockComputeMerkleRootFromHashes.mockReturnValue('merkle-root-abc');
  mockGetChainStatus.mockReturnValue({ tip: 'chain-tip-xyz', length: 5, initialized: true });
  mockInitAuditChain.mockResolvedValue(undefined);
  mockGenerateProofFromHashes.mockReturnValue({ leaf: { label: 'soul/genesis.md', hash: 'aaa' }, steps: [], root: 'merkle-root-abc' });
  mockVerifyProof.mockReturnValue(true);

  // Checkpoints: pass
  mockValidateCheckpointIntegrity.mockResolvedValue({
    ok: true, value: [{ snapshotId: 'cp1', valid: true, corruptedFiles: [] }],
  });

  // Causal history: pass
  mockVerifyCausalHistory.mockResolvedValue({
    ok: true,
    value: {
      valid: true, length: 4, errors: [], brokenAt: -1,
      finalClock: { bot: 4 },
      checks: { hashChain: true, vectorClockMonotonic: true, timestampMonotonic: true, indexSequential: true },
    },
  });

  // Vector clock
  mockGetClock.mockReturnValue({ bot: 4 });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('runFullIdentityCheck()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns healthy when all layers pass', async () => {
    setupAllPassing();

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('healthy');
    expect(report.layers).toHaveLength(5);
    expect(report.layers.every(l => l.status === 'pass')).toBe(true);
  });

  it('returns degraded when one layer warns', async () => {
    setupAllPassing();
    // Event sourcing: warn (discrepancy found)
    mockValidateIdentityConsistency.mockResolvedValue([
      { trait: 'warmth', identityValue: 1.0, narrativeValue: 0.80, delta: 0.2 },
    ]);

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('degraded');

    const esLayer = report.layers.find(l => l.layer === 'event-sourcing');
    expect(esLayer?.status).toBe('warn');
  });

  it('returns degraded when audit chain has repairable corruption', async () => {
    setupAllPassing();
    // Audit chain: broken but repairable
    mockVerifyChain.mockResolvedValue({
      ok: true, value: { valid: false, length: 10, errors: ['Entry 3: prevHash mismatch'], brokenAt: 3 },
    });
    mockRepairChain.mockResolvedValue({
      ok: true, value: { removed: 7, remaining: 3 },
    });

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('degraded');

    const auditLayer = report.layers.find(l => l.layer === 'audit-chain');
    expect(auditLayer?.status).toBe('warn');
    expect(auditLayer?.message).toContain('repaired');
  });

  it('returns compromised when audit chain repair fails', async () => {
    setupAllPassing();
    // Audit chain: broken and unrepairable
    mockVerifyChain.mockResolvedValue({
      ok: true, value: { valid: false, length: 10, errors: ['Entry 3: prevHash mismatch'], brokenAt: 3 },
    });
    mockRepairChain.mockResolvedValue({
      ok: false, error: 'disk full',
    });

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('compromised');

    const auditLayer = report.layers.find(l => l.layer === 'audit-chain');
    expect(auditLayer?.status).toBe('fail');
  });

  it('marks layer as error (not skip) when it throws, overall compromised', async () => {
    setupAllPassing();
    // Checkpoint: throw
    mockValidateCheckpointIntegrity.mockRejectedValue(new Error('disk full'));

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('compromised');

    const cpLayer = report.layers.find(l => l.layer === 'checkpoints');
    expect(cpLayer?.status).toBe('error');
    expect(cpLayer?.message).toContain('disk full');
    expect(cpLayer?.details).toContain('disk full');
  });

  it('error in any layer results in compromised, not degraded', async () => {
    setupAllPassing();
    // Soul integrity: throw
    mockComputeSoulFingerprint.mockRejectedValue(new Error('I/O error'));

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('compromised');

    const siLayer = report.layers.find(l => l.layer === 'soul-integrity');
    expect(siLayer?.status).toBe('error');
  });

  it('error + fail both result in compromised', async () => {
    setupAllPassing();
    // Causal history: throw (error)
    mockVerifyCausalHistory.mockRejectedValue(new Error('timeout'));
    // Audit chain: fail (unrepairable)
    mockVerifyChain.mockResolvedValue({
      ok: true, value: { valid: false, length: 1, errors: ['broken'], brokenAt: 0 },
    });
    mockRepairChain.mockResolvedValue({ ok: false, error: 'disk full' });

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('compromised');

    const chLayer = report.layers.find(l => l.layer === 'causal-history');
    expect(chLayer?.status).toBe('error');
    const auditLayer = report.layers.find(l => l.layer === 'audit-chain');
    expect(auditLayer?.status).toBe('fail');
  });

  it('compromised overrides degraded when both present', async () => {
    setupAllPassing();
    // One warn (event-sourcing) + one fail (audit chain repair fails)
    mockValidateIdentityConsistency.mockResolvedValue([
      { trait: 'x', identityValue: 0.5, narrativeValue: 0.1, delta: 0.4 },
    ]);
    mockVerifyChain.mockResolvedValue({
      ok: true, value: { valid: false, length: 1, errors: ['broken'], brokenAt: 0 },
    });
    mockRepairChain.mockResolvedValue({
      ok: false, error: 'disk full',
    });

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('compromised');
  });

  it('handles first-run (no stored fingerprint)', async () => {
    setupAllPassing();
    mockGetFingerprint.mockResolvedValue(null);

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('healthy');

    const intLayer = report.layers.find(l => l.layer === 'soul-integrity');
    expect(intLayer?.status).toBe('pass');
    expect(intLayer?.message).toContain('First run');
  });

  it('warns on soul integrity mismatch with changed files', async () => {
    setupAllPassing();
    mockGetFingerprint.mockResolvedValue('old-hash');
    mockComputeSoulFingerprint.mockResolvedValue({
      ok: true, value: { hash: 'new-hash', files: { 'soul/identity.json': 'abc' }, computedAt: '' },
    });
    mockDiffFingerprints.mockReturnValue(['soul/identity.json']);

    const report = await runFullIdentityCheck();
    expect(report.status).toBe('degraded');

    const intLayer = report.layers.find(l => l.layer === 'soul-integrity');
    expect(intLayer?.status).toBe('warn');
    expect(intLayer?.message).toContain('1 file(s) changed');
  });

  it('includes summary with all layer statuses', async () => {
    setupAllPassing();

    const report = await runFullIdentityCheck();
    expect(report.summary).toContain('soul-integrity: pass');
    expect(report.summary).toContain('event-sourcing: pass');
    expect(report.summary).toContain('audit-chain: pass');
    expect(report.summary).toContain('checkpoints: pass');
    expect(report.summary).toContain('causal-history: pass');
  });

  it('runs all layers in parallel', async () => {
    setupAllPassing();
    const startTime = Date.now();

    // Each mock adds 50ms delay
    mockComputeSoulFingerprint.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      return { ok: true, value: { hash: 'stored-hash', files: FILE_HASHES, computedAt: '' } };
    });
    mockValidateIdentityConsistency.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      return [];
    });
    mockVerifyChain.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      return { ok: true, value: { valid: true, length: 1, errors: [], brokenAt: -1 } };
    });
    mockValidateCheckpointIntegrity.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      return { ok: true, value: [] };
    });
    mockVerifyCausalHistory.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      return {
        ok: true,
        value: {
          valid: true, length: 0, errors: [], brokenAt: -1,
          finalClock: null,
          checks: { hashChain: true, vectorClockMonotonic: true, timestampMonotonic: true, indexSequential: true },
        },
      };
    });

    const report = await runFullIdentityCheck();
    const elapsed = Date.now() - startTime;

    expect(report.status).toBe('healthy');
    // If sequential, would take ~250ms. Parallel should be ~50-100ms.
    expect(elapsed).toBeLessThan(200);
  });
});

// ── Passport Tests ─────────────────────────────────────────────────

describe('generateIdentityPassport()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates a valid passport with all fields', async () => {
    setupAllPassing();

    const result = await generateIdentityPassport();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const passport = result.value;
    expect(passport.version).toBe(1);
    expect(passport.issuedAt).toBeTruthy();
    expect(passport.fingerprint).toBe('stored-hash');
    expect(passport.fileHashes).toEqual(FILE_HASHES);
    expect(passport.merkleRoot).toBe('merkle-root-abc');
    expect(passport.chainTip).toBe('chain-tip-xyz');
    expect(passport.chainLength).toBe(5);
    expect(passport.traits).toEqual({ curiosity_level: 0.80, warmth: 1.00 });
    expect(passport.healthStatus).toBe('healthy');
    expect(passport.hash).toBeTruthy();
    expect(passport.hash.length).toBe(64); // SHA-256 hex
  });

  it('fails when fingerprint computation fails', async () => {
    setupAllPassing();
    mockComputeSoulFingerprint.mockResolvedValue({ ok: false, error: 'disk error' });

    const result = await generateIdentityPassport();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('fingerprint');
  });

  it('fails when Merkle root is null', async () => {
    setupAllPassing();
    mockComputeMerkleRootFromHashes.mockReturnValue(null);

    const result = await generateIdentityPassport();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Merkle root');
  });
});

describe('verifyIdentityPassport()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies a freshly generated passport as valid', async () => {
    setupAllPassing();

    const genResult = await generateIdentityPassport();
    expect(genResult.ok).toBe(true);
    if (!genResult.ok) return;

    const verResult = await verifyIdentityPassport(genResult.value);
    expect(verResult.ok).toBe(true);
    if (!verResult.ok) return;
    expect(verResult.value.valid).toBe(true);
    expect(verResult.value.mismatches).toHaveLength(0);
    expect(Object.values(verResult.value.checks).every(Boolean)).toBe(true);
  });

  it('detects tampered hash', async () => {
    setupAllPassing();

    const genResult = await generateIdentityPassport();
    if (!genResult.ok) return;

    const tampered: IdentityPassport = { ...genResult.value, hash: 'tampered-hash' };
    const verResult = await verifyIdentityPassport(tampered);
    expect(verResult.ok).toBe(true);
    if (!verResult.ok) return;
    expect(verResult.value.valid).toBe(false);
    expect(verResult.value.checks.hashIntegrity).toBe(false);
    expect(verResult.value.mismatches.some(m => m.includes('hash mismatch'))).toBe(true);
  });

  it('detects fingerprint drift after soul change', async () => {
    setupAllPassing();

    const genResult = await generateIdentityPassport();
    if (!genResult.ok) return;

    // Soul files changed between generate and verify
    mockComputeSoulFingerprint.mockResolvedValue({
      ok: true, value: { hash: 'different-hash', files: FILE_HASHES, computedAt: '' },
    });

    const verResult = await verifyIdentityPassport(genResult.value);
    expect(verResult.ok).toBe(true);
    if (!verResult.ok) return;
    expect(verResult.value.valid).toBe(false);
    expect(verResult.value.checks.fingerprintMatch).toBe(false);
  });

  it('detects chain tip drift after new audit entries', async () => {
    setupAllPassing();

    const genResult = await generateIdentityPassport();
    if (!genResult.ok) return;

    // New audit entries added after passport was generated
    mockGetChainStatus.mockReturnValue({ tip: 'new-chain-tip', length: 10, initialized: true });

    const verResult = await verifyIdentityPassport(genResult.value);
    expect(verResult.ok).toBe(true);
    if (!verResult.ok) return;
    expect(verResult.value.valid).toBe(false);
    expect(verResult.value.checks.chainTipMatch).toBe(false);
  });

  it('detects trait value changes', async () => {
    setupAllPassing();

    const genResult = await generateIdentityPassport();
    if (!genResult.ok) return;

    // Trait changed after passport was generated
    mockGetIdentity.mockResolvedValue({
      core_traits: {
        curiosity_level: { value: 0.95, description: '' }, // was 0.80
        warmth: { value: 1.00, description: '' },
      },
    });

    const verResult = await verifyIdentityPassport(genResult.value);
    expect(verResult.ok).toBe(true);
    if (!verResult.ok) return;
    expect(verResult.value.valid).toBe(false);
    expect(verResult.value.checks.traitConsistency).toBe(false);
    expect(verResult.value.mismatches.some(m => m.includes('curiosity_level'))).toBe(true);
  });

  it('returns all five check results even when some fail', async () => {
    setupAllPassing();

    const genResult = await generateIdentityPassport();
    if (!genResult.ok) return;

    // Multiple things changed
    mockComputeSoulFingerprint.mockResolvedValue({
      ok: true, value: { hash: 'changed', files: { 'soul/genesis.md': 'xxx' }, computedAt: '' },
    });
    mockComputeMerkleRootFromHashes.mockReturnValue('changed-root');
    mockGetChainStatus.mockReturnValue({ tip: 'changed-tip', length: 99, initialized: true });

    const verResult = await verifyIdentityPassport(genResult.value);
    expect(verResult.ok).toBe(true);
    if (!verResult.ok) return;
    expect(verResult.value.checks).toHaveProperty('hashIntegrity');
    expect(verResult.value.checks).toHaveProperty('fingerprintMatch');
    expect(verResult.value.checks).toHaveProperty('merkleRootMatch');
    expect(verResult.value.checks).toHaveProperty('chainTipMatch');
    expect(verResult.value.checks).toHaveProperty('traitConsistency');
  });
});
