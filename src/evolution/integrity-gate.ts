/**
 * Integrity Gate — evolution-specific wrapper around soul-integrity.
 *
 * Provides pre/post evolution integrity checks and records attestation logs.
 * Integrates with the evolution pipeline as a validation gate:
 *   - Pre-evolution: verify soul files haven't been tampered with before starting
 *   - Post-evolution: verify evolution didn't accidentally modify soul files
 *
 * Attestation log: soul/evolution/integrity-attestations.jsonl (append-only)
 */

import { join } from 'node:path';
import { computeSoulFingerprint, type SoulFingerprint } from '../safety/soul-integrity.js';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';
import { config } from '../config.js';

const ATTESTATION_LOG = join(process.cwd(), 'soul', 'evolution', 'integrity-attestations.jsonl');

export interface IntegrityAttestation {
  timestamp: string;
  goalId: string;
  phase: 'pre-evolution' | 'post-evolution';
  fingerprint: SoulFingerprint;
  previousHash: string | null;
  status: 'match' | 'mismatch' | 'first-check';
  verdict: 'pass' | 'block' | 'warn';
}

/**
 * Pre-evolution integrity gate.
 *
 * Called before basic_validation (Step 7) in the pipeline.
 * Records the "before" fingerprint. If soul files were tampered with
 * since last known good state, blocks evolution.
 */
export async function preEvolutionCheck(
  goalId: string,
  expectedHash: string | null,
): Promise<Result<SoulFingerprint>> {
  const fpResult = await computeSoulFingerprint();
  if (!fpResult.ok) {
    return fail(`Pre-evolution integrity check failed: ${fpResult.error}`);
  }

  const fp = fpResult.value;
  let status: IntegrityAttestation['status'];
  let verdict: IntegrityAttestation['verdict'];

  if (expectedHash === null) {
    status = 'first-check';
    verdict = 'pass';
  } else if (fp.hash === expectedHash) {
    status = 'match';
    verdict = 'pass';
  } else {
    status = 'mismatch';
    verdict = config.EVOLUTION_PRE_CHECK_STRICT ? 'block' : 'warn';
    await logger.warn(
      'IntegrityGate',
      `Pre-evolution mismatch (verdict: ${verdict}): expected ${expectedHash.slice(0, 12)}..., got ${fp.hash.slice(0, 12)}...`,
    );
  }

  await recordAttestation({
    timestamp: new Date().toISOString(),
    goalId,
    phase: 'pre-evolution',
    fingerprint: fp,
    previousHash: expectedHash,
    status,
    verdict,
  });

  if (verdict === 'block') {
    return fail(
      `Pre-evolution integrity mismatch blocked: expected ${expectedHash!.slice(0, 12)}..., got ${fp.hash.slice(0, 12)}...`,
    );
  }

  return ok('Pre-evolution check passed', fp);
}

/**
 * Post-evolution integrity gate.
 *
 * Called at the start of post_actions (Step 11), before committing.
 * Verifies that evolution did NOT modify soul files.
 * If soul files changed during evolution, this is a critical violation.
 */
export async function postEvolutionCheck(
  goalId: string,
  preHash: string,
): Promise<Result<SoulFingerprint>> {
  const fpResult = await computeSoulFingerprint();
  if (!fpResult.ok) {
    return fail(`Post-evolution integrity check failed: ${fpResult.error}`);
  }

  const fp = fpResult.value;
  const status: IntegrityAttestation['status'] = fp.hash === preHash ? 'match' : 'mismatch';
  const verdict: IntegrityAttestation['verdict'] = status === 'match' ? 'pass' : 'block';

  await recordAttestation({
    timestamp: new Date().toISOString(),
    goalId,
    phase: 'post-evolution',
    fingerprint: fp,
    previousHash: preHash,
    status,
    verdict,
  });

  if (verdict === 'block') {
    return fail(
      `Soul files modified during evolution! ` +
      `Pre: ${preHash.slice(0, 12)}..., Post: ${fp.hash.slice(0, 12)}... ` +
      `This is a critical violation — triggering rollback.`,
    );
  }

  return ok('Post-evolution check passed — soul files intact', fp);
}

async function recordAttestation(attestation: IntegrityAttestation): Promise<void> {
  try {
    await writer.appendJsonl(ATTESTATION_LOG, attestation);
  } catch (err) {
    await logger.warn('IntegrityGate', 'Failed to write attestation (non-fatal)', err);
  }
}
