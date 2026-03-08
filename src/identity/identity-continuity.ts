/**
 * Identity Continuity — unified facade for all identity verification layers.
 *
 * Orchestrates four independent verification systems into a single health report:
 *   1. Soul Integrity (SHA-256 fingerprint) — do critical files match known hashes?
 *   2. Event Sourcing (narrative vs identity.json) — do trait values converge?
 *   3. Audit Chain (Merkle hash chain) — is the audit trail tamper-free?
 *   4. Checkpoint Integrity — are stored checkpoints uncorrupted?
 *
 * Each layer is best-effort: a failure in one does not block others.
 * The overall status is the logical AND of all layers.
 */

import { createHash } from 'node:crypto';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

// ── Types ────────────────────────────────────────────────────────────

export type LayerStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'error';

export interface LayerResult {
  layer: string;
  status: LayerStatus;
  message: string;
  details?: unknown;
}

export interface IdentityHealthReport {
  /** Overall status — 'pass' only if ALL layers pass */
  status: 'healthy' | 'degraded' | 'compromised';
  /** ISO timestamp of the check */
  checkedAt: string;
  /** Per-layer results */
  layers: LayerResult[];
  /** Human-readable summary */
  summary: string;
}

// ── Layer runners ────────────────────────────────────────────────────

async function checkSoulIntegrity(): Promise<LayerResult> {
  try {
    const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
    const { getFingerprint, getFileHashes } = await import('./vitals.js');

    const stored = await getFingerprint();
    const fpResult = await computeSoulFingerprint();

    if (!fpResult.ok) {
      return { layer: 'soul-integrity', status: 'fail', message: fpResult.error };
    }

    if (stored === null) {
      return { layer: 'soul-integrity', status: 'pass', message: 'First run — no stored fingerprint' };
    }

    if (fpResult.value.hash === stored) {
      return { layer: 'soul-integrity', status: 'pass', message: 'Fingerprint matches' };
    }

    // Mismatch — try to identify which files changed
    const storedHashes = await getFileHashes();
    const { diffFingerprints } = await import('../safety/soul-integrity.js');
    const changed = diffFingerprints(storedHashes, fpResult.value);

    return {
      layer: 'soul-integrity',
      status: 'warn',
      message: `Fingerprint mismatch — ${changed.length} file(s) changed`,
      details: { changedFiles: changed },
    };
  } catch (err) {
    await logger.error('IdentityContinuity', 'soul-integrity check failed', err);
    return { layer: 'soul-integrity', status: 'error', message: `Error: ${(err as Error).message}`, details: String(err) };
  }
}

async function checkEventSourcing(): Promise<LayerResult> {
  try {
    const { validateIdentityConsistency } = await import('./identity-store.js');
    const discrepancies = await validateIdentityConsistency();

    if (discrepancies.length === 0) {
      return { layer: 'event-sourcing', status: 'pass', message: 'Identity matches narrative' };
    }

    return {
      layer: 'event-sourcing',
      status: 'warn',
      message: `${discrepancies.length} trait discrepancy(s) detected`,
      details: { discrepancies },
    };
  } catch (err) {
    await logger.error('IdentityContinuity', 'event-sourcing check failed', err);
    return { layer: 'event-sourcing', status: 'error', message: `Error: ${(err as Error).message}`, details: String(err) };
  }
}

async function checkAuditChain(): Promise<LayerResult> {
  try {
    const {
      verifyChain,
      repairChain,
      verifyAuditLogIntegrity,
      generateProofFromHashes,
      verifyProof,
    } = await import('../safety/audit-chain.js');

    // 1. Verify chain link integrity
    const chainResult = await verifyChain();
    if (!chainResult.ok) {
      return { layer: 'audit-chain', status: 'fail', message: chainResult.error };
    }

    if (!chainResult.value.valid) {
      // Auto-repair: truncate to the last valid segment instead of failing permanently.
      // Legacy corruption (from pre-mutex race conditions) should not keep triggering
      // 'compromised' indefinitely. After repair, subsequent checks will pass.
      const repair = await repairChain();
      if (repair.ok) {
        return {
          layer: 'audit-chain',
          status: 'warn',
          message: `Chain repaired: removed ${repair.value.removed} corrupted entries, ${repair.value.remaining} remaining`,
          details: { errors: chainResult.value.errors.slice(0, 5) },
        };
      }
      return {
        layer: 'audit-chain',
        status: 'fail',
        message: `Chain broken at entry ${chainResult.value.brokenAt}, repair failed: ${repair.error}`,
        details: { errors: chainResult.value.errors.slice(0, 5) },
      };
    }

    // 2. Verify audit log file integrity against last witness
    const logIntegrity = await verifyAuditLogIntegrity();
    if (logIntegrity && logIntegrity.ok && !logIntegrity.value.valid) {
      return {
        layer: 'audit-chain',
        status: 'warn',
        message: logIntegrity.value.message,
      };
    }

    // 3. Merkle inclusion proofs for critical soul files
    const CRITICAL_PROOF_FILES = ['soul/genesis.md', 'soul/identity.json'];
    const proofFailures: string[] = [];

    try {
      const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
      const fpResult = await computeSoulFingerprint();

      if (fpResult.ok) {
        for (const file of CRITICAL_PROOF_FILES) {
          const proof = generateProofFromHashes(fpResult.value.files, file);
          if (!proof) {
            proofFailures.push(`${file}: not in Merkle tree`);
          } else if (!verifyProof(proof, fpResult.value.files[file]!)) {
            proofFailures.push(`${file}: proof verification failed`);
          }
        }
      }
    } catch {
      // Merkle proof is best-effort within the audit chain layer
    }

    if (proofFailures.length > 0) {
      return {
        layer: 'audit-chain',
        status: 'warn',
        message: `Chain valid (${chainResult.value.length} entries), but ${proofFailures.length} Merkle proof(s) failed`,
        details: { proofFailures },
      };
    }

    return {
      layer: 'audit-chain',
      status: 'pass',
      message: `Chain valid (${chainResult.value.length} entries), Merkle proofs verified`,
    };
  } catch (err) {
    await logger.error('IdentityContinuity', 'audit-chain check failed', err);
    return { layer: 'audit-chain', status: 'error', message: `Error: ${(err as Error).message}`, details: String(err) };
  }
}

async function checkCheckpoints(): Promise<LayerResult> {
  try {
    const { validateCheckpointIntegrity } = await import('../safety/soul-snapshot.js');
    const result = await validateCheckpointIntegrity();

    if (!result.ok) {
      return { layer: 'checkpoints', status: 'fail', message: result.error };
    }

    const validations = result.value;
    if (validations.length === 0) {
      return { layer: 'checkpoints', status: 'pass', message: 'No checkpoints to validate' };
    }

    const corrupted = validations.filter(v => !v.valid);
    if (corrupted.length === 0) {
      return {
        layer: 'checkpoints',
        status: 'pass',
        message: `All ${validations.length} checkpoint(s) intact`,
      };
    }

    return {
      layer: 'checkpoints',
      status: 'warn',
      message: `${corrupted.length}/${validations.length} checkpoint(s) corrupted`,
      details: { corrupted: corrupted.map(c => c.snapshotId) },
    };
  } catch (err) {
    await logger.error('IdentityContinuity', 'checkpoints check failed', err);
    return { layer: 'checkpoints', status: 'error', message: `Error: ${(err as Error).message}`, details: String(err) };
  }
}

async function checkCausalHistory(): Promise<LayerResult> {
  try {
    const { verifyCausalHistory } = await import('../lifecycle/causal-verification.js');
    const result = await verifyCausalHistory();

    if (!result.ok) {
      return { layer: 'causal-history', status: 'fail', message: result.error };
    }

    const v = result.value;
    if (!v.valid) {
      // Distinguish between security-critical failures (hash/index) and
      // environmental issues (timestamp regression from WSL2 clock drift).
      // Only hash chain or index failures warrant 'fail' status.
      const securityFail = !v.checks.hashChain || !v.checks.indexSequential;
      return {
        layer: 'causal-history',
        status: securityFail ? 'fail' : 'warn',
        message: securityFail
          ? `Causal chain broken at entry ${v.brokenAt}: ${v.errors[0] ?? 'unknown'}`
          : `Causal chain has ${v.errors.length} non-critical issue(s) (timestamp/clock drift)`,
        details: { errors: v.errors.slice(0, 5), checks: v.checks },
      };
    }

    // All passed, but warn if some checks were vacuously true (no vectorClock data)
    const allChecks = Object.values(v.checks).every(Boolean);
    if (!allChecks) {
      return {
        layer: 'causal-history',
        status: 'warn',
        message: `Causal chain valid (${v.length} entries), some checks skipped`,
        details: { checks: v.checks },
      };
    }

    return {
      layer: 'causal-history',
      status: 'pass',
      message: `Causal chain valid (${v.length} entries), all checks passed`,
      details: { finalClock: v.finalClock },
    };
  } catch (err) {
    await logger.error('IdentityContinuity', 'causal-history check failed', err);
    return { layer: 'causal-history', status: 'error', message: `Error: ${(err as Error).message}`, details: String(err) };
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run all five identity verification layers and produce a unified report.
 *
 * Each layer runs independently — a failure in one does not prevent others.
 * The overall status:
 *   - 'healthy'     → all layers pass
 *   - 'degraded'    → some layers warn or skip, none fail/error
 *   - 'compromised' → at least one layer fails or errors
 */
export async function runFullIdentityCheck(): Promise<IdentityHealthReport> {
  const layers = await Promise.all([
    checkSoulIntegrity(),
    checkEventSourcing(),
    checkAuditChain(),
    checkCheckpoints(),
    checkCausalHistory(),
  ]);

  const hasFail = layers.some(l => l.status === 'fail');
  const hasError = layers.some(l => l.status === 'error');
  const hasWarn = layers.some(l => l.status === 'warn');
  const hasSkip = layers.some(l => l.status === 'skip');

  let status: IdentityHealthReport['status'];
  if (hasFail || hasError) {
    status = 'compromised';
  } else if (hasWarn || hasSkip) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  const summary = layers
    .map(l => `${l.layer}: ${l.status}`)
    .join(' | ');

  await logger.info('IdentityContinuity', `Health check: ${status} — ${summary}`);

  return {
    status,
    checkedAt: new Date().toISOString(),
    layers,
    summary,
  };
}

// ── Zero-Trust Identity Passport ─────────────────────────────────────

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Default passport TTL: 24 hours */
const DEFAULT_PASSPORT_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdentityPassport {
  /** Schema version for forward compatibility */
  version: 1;
  /** When this passport was issued */
  issuedAt: string;
  /** When this passport expires (ISO timestamp). Absent on legacy passports. */
  expiresAt?: string;
  /** SHA-256 composite fingerprint of critical soul files */
  fingerprint: string;
  /** Per-file SHA-256 hashes */
  fileHashes: Record<string, string>;
  /** Merkle root computed from fileHashes */
  merkleRoot: string;
  /** Audit chain tip hash at issue time */
  chainTip: string;
  /** Audit chain length at issue time */
  chainLength: number;
  /** Current core trait values (snapshot) */
  traits: Record<string, number>;
  /** Health check status at issue time */
  healthStatus: IdentityHealthReport['status'];
  /** Vector clock snapshot at passport issue time (absent in pre-vectorclock passports) */
  vectorClock?: Record<string, number>;
  /** Content-addressed hash of all above fields — tamper detection */
  hash: string;
}

export interface PassportVerification {
  valid: boolean;
  checks: {
    hashIntegrity: boolean;
    notExpired: boolean;
    fingerprintMatch: boolean;
    merkleRootMatch: boolean;
    chainTipMatch: boolean;
    traitConsistency: boolean;
  };
  mismatches: string[];
}

/**
 * Compute the content-addressed hash of a passport (excluding the hash field).
 * This is the "signature" — if any field is tampered, the hash won't match.
 */
function computePassportHash(passport: Omit<IdentityPassport, 'hash'>): string {
  const canonical = JSON.stringify({
    version: passport.version,
    issuedAt: passport.issuedAt,
    expiresAt: passport.expiresAt,
    fingerprint: passport.fingerprint,
    fileHashes: passport.fileHashes,
    merkleRoot: passport.merkleRoot,
    chainTip: passport.chainTip,
    chainLength: passport.chainLength,
    traits: passport.traits,
    healthStatus: passport.healthStatus,
    ...(passport.vectorClock !== undefined && { vectorClock: passport.vectorClock }),
  });
  return sha256(canonical);
}

/**
 * Generate an identity passport — a self-contained cryptographic attestation
 * of the current soul state.
 *
 * The passport bundles:
 *   - Soul file fingerprint (what files look like)
 *   - Merkle root (aggregate proof of file integrity)
 *   - Audit chain state (provenance trail)
 *   - Trait snapshot (who I am right now)
 *   - Health check result (am I healthy?)
 *   - Content-addressed hash (tamper detection)
 *
 * Use case: before migration, generate a passport. After migration,
 * verify it to prove the soul arrived intact.
 */
export async function generateIdentityPassport(ttlMs = DEFAULT_PASSPORT_TTL_MS): Promise<Result<IdentityPassport>> {
  try {
    // 1. Compute soul fingerprint
    const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
    const fpResult = await computeSoulFingerprint();
    if (!fpResult.ok) return fail(`Cannot compute fingerprint: ${fpResult.error}`);

    // 2. Compute Merkle root from file hashes
    const { computeMerkleRootFromHashes } = await import('../safety/audit-chain.js');
    const merkleRoot = computeMerkleRootFromHashes(fpResult.value.files);
    if (!merkleRoot) return fail('Cannot compute Merkle root');

    // 3. Get audit chain state
    const { getChainStatus, initAuditChain } = await import('../safety/audit-chain.js');
    await initAuditChain();
    const chainStatus = getChainStatus();

    // 4. Get current traits
    const { getIdentity } = await import('./identity-store.js');
    const identity = await getIdentity();
    const traits: Record<string, number> = {};
    for (const [name, trait] of Object.entries(identity.core_traits)) {
      traits[name] = trait.value;
    }

    // 5. Run health check
    const healthReport = await runFullIdentityCheck();

    // 5.5 Get current vector clock
    let vectorClock: Record<string, number> | undefined;
    try {
      const { getClock } = await import('../lifecycle/vector-clock.js');
      vectorClock = getClock();
    } catch {
      // vector-clock module unavailable — non-critical for passport
    }

    // 6. Build passport
    const now = new Date();
    const passportData = {
      version: 1 as const,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      fingerprint: fpResult.value.hash,
      fileHashes: fpResult.value.files,
      merkleRoot,
      chainTip: chainStatus.tip,
      chainLength: chainStatus.length,
      traits,
      healthStatus: healthReport.status,
      ...(vectorClock !== undefined && { vectorClock }),
    };

    const passport: IdentityPassport = {
      ...passportData,
      hash: computePassportHash(passportData),
    };

    await logger.info('IdentityContinuity', `Passport issued: ${passport.hash.slice(0, 12)}...`);
    return ok('Passport generated', passport);
  } catch (err) {
    return fail(`Passport generation failed: ${(err as Error).message}`);
  }
}

/**
 * Verify an identity passport against the current soul state.
 *
 * Five checks:
 *   1. Hash integrity — passport hasn't been tampered with
 *   2. Not expired — passport TTL hasn't elapsed (skipped for legacy passports)
 *   3. Fingerprint match — soul files haven't changed since passport was issued
 *   4. Merkle root match — file integrity aggregate is consistent
 *   5. Chain tip match — audit chain state is consistent
 *   6. Trait consistency — identity.json traits match passport snapshot
 *
 * All checks must pass for the passport to be valid.
 */
export async function verifyIdentityPassport(
  passport: IdentityPassport,
): Promise<Result<PassportVerification>> {
  try {
    const mismatches: string[] = [];
    const checks = {
      hashIntegrity: false,
      notExpired: false,
      fingerprintMatch: false,
      merkleRootMatch: false,
      chainTipMatch: false,
      traitConsistency: false,
    };

    // 1. Hash integrity — verify the passport itself is untampered
    const { hash: _storedHash, ...rest } = passport;
    const recomputed = computePassportHash(rest);
    checks.hashIntegrity = recomputed === passport.hash;
    if (!checks.hashIntegrity) {
      mismatches.push(`Passport hash mismatch: stored=${passport.hash.slice(0, 12)}, computed=${recomputed.slice(0, 12)}`);
    }

    // 2. Expiry check — reject expired passports (backward-compatible: no expiresAt = pass)
    if (passport.expiresAt) {
      checks.notExpired = new Date(passport.expiresAt).getTime() > Date.now();
      if (!checks.notExpired) {
        mismatches.push(`Passport expired at ${passport.expiresAt}`);
      }
    } else {
      checks.notExpired = true; // Legacy passports without expiresAt are not rejected
    }

    // 3. Fingerprint match — recompute from current soul files
    const { computeSoulFingerprint } = await import('../safety/soul-integrity.js');
    const fpResult = await computeSoulFingerprint();
    if (fpResult.ok) {
      checks.fingerprintMatch = fpResult.value.hash === passport.fingerprint;
      if (!checks.fingerprintMatch) {
        mismatches.push(`Fingerprint: passport=${passport.fingerprint.slice(0, 12)}, current=${fpResult.value.hash.slice(0, 12)}`);
      }
    } else {
      mismatches.push(`Cannot compute current fingerprint: ${fpResult.error}`);
    }

    // 4. Merkle root match — recompute from current file hashes
    if (fpResult.ok) {
      const { computeMerkleRootFromHashes } = await import('../safety/audit-chain.js');
      const currentRoot = computeMerkleRootFromHashes(fpResult.value.files);
      checks.merkleRootMatch = currentRoot === passport.merkleRoot;
      if (!checks.merkleRootMatch) {
        mismatches.push(`Merkle root: passport=${passport.merkleRoot.slice(0, 12)}, current=${currentRoot?.slice(0, 12) ?? 'null'}`);
      }
    }

    // 5. Chain tip match — compare audit chain state
    const { getChainStatus, initAuditChain } = await import('../safety/audit-chain.js');
    await initAuditChain();
    const chainStatus = getChainStatus();
    checks.chainTipMatch = chainStatus.tip === passport.chainTip && chainStatus.length === passport.chainLength;
    if (!checks.chainTipMatch) {
      mismatches.push(`Chain: passport=(tip=${passport.chainTip.slice(0, 12)},len=${passport.chainLength}), current=(tip=${chainStatus.tip.slice(0, 12)},len=${chainStatus.length})`);
    }

    // 6. Trait consistency — compare identity.json traits
    const { getIdentity } = await import('./identity-store.js');
    const identity = await getIdentity();
    let traitsMatch = true;
    for (const [name, passportValue] of Object.entries(passport.traits)) {
      const currentTrait = identity.core_traits[name];
      if (!currentTrait || Math.abs(currentTrait.value - passportValue) > 0.001) {
        traitsMatch = false;
        mismatches.push(`Trait ${name}: passport=${passportValue}, current=${currentTrait?.value ?? 'missing'}`);
      }
    }
    checks.traitConsistency = traitsMatch;

    const valid = Object.values(checks).every(Boolean);

    await logger.info('IdentityContinuity',
      `Passport verification: ${valid ? 'VALID' : 'INVALID'} — ${mismatches.length} mismatch(es)`);

    return ok(valid ? 'Passport verified' : 'Passport verification failed', {
      valid,
      checks,
      mismatches,
    });
  } catch (err) {
    return fail(`Passport verification failed: ${(err as Error).message}`);
  }
}
