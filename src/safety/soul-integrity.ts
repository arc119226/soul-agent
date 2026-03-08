/**
 * Soul Integrity Verification — cryptographic fingerprinting of critical soul files.
 *
 * Computes SHA-256 hashes over the bot's core identity files and provides
 * verification against a stored fingerprint. This detects unexpected modifications
 * from bugs, evolution escapes, or external tampering.
 *
 * Design:
 *   - Per-file SHA-256 hashes for diagnostics (which file changed?)
 *   - Composite hash = SHA256(sorted per-file hashes joined by ':')
 *   - vitals.json is hashed WITHOUT its identity_fingerprint field (avoids circular hash)
 *   - All operations are non-blocking and wrapped in Result<T>
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ok, fail, type Result } from '../result.js';
import { logger } from '../core/logger.js';

const PROJECT_ROOT = process.cwd();

/**
 * Ordered list of critical soul files.
 * Order is fixed — changing order changes the composite hash.
 * New files should only be appended to the end.
 */
export const CRITICAL_FILES = [
  'soul/genesis.md',
  'soul/identity.json',
  'soul/vitals.json',
  'soul/milestones.json',
] as const;

export interface SoulFingerprint {
  /** Composite SHA-256 hash of all critical files */
  hash: string;
  /** Per-file hashes for diagnostics */
  files: Record<string, string>;
  /** When the fingerprint was computed */
  computedAt: string;
}

export interface IntegrityReport {
  valid: boolean;
  expected: string | null;
  actual: string;
  changedFiles: string[];
  message: string;
}

/**
 * Compute SHA-256 hash of a single file's content.
 *
 * Special handling for vitals.json: strips the identity_fingerprint field
 * before hashing to avoid the circular hash problem (the fingerprint is
 * stored in vitals.json, which is itself one of the hashed files).
 */
async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(join(PROJECT_ROOT, filePath), 'utf-8');

  // Strip volatile fields from vitals.json before hashing.
  // Two categories are removed:
  //   1. Identity meta-fields (written by the fingerprint/health system itself —
  //      including them would create a circular hash dependency)
  //   2. Runtime state fields (energy, mood, timestamps — these change every
  //      heartbeat tick and would cause perpetual fingerprint mismatches)
  // After stripping, only structural fields (e.g. "version") remain, keeping
  // the hash stable across normal runtime operation.
  if (filePath.endsWith('vitals.json')) {
    try {
      const parsed = JSON.parse(content);
      // Identity meta-fields (circularity)
      delete parsed.identity_fingerprint;
      delete parsed.identity_file_hashes;
      delete parsed.identity_health_status;
      delete parsed.identity_health_checked_at;
      // Runtime state fields (volatile)
      delete parsed.last_updated;
      delete parsed.energy_level;
      delete parsed.confidence_level;
      delete parsed.mood;
      delete parsed.mood_reason;
      delete parsed.curiosity_focus;
      const normalized = JSON.stringify(parsed, null, 2);
      return createHash('sha256').update(normalized).digest('hex');
    } catch {
      // If JSON parse fails, hash raw content
    }
  }

  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute a composite fingerprint of all critical soul files.
 *
 * The composite hash is derived from individual file hashes:
 *   composite = SHA256(hash1:hash2:hash3:...)
 *
 * This allows identifying exactly which file changed when verification fails.
 */
export async function computeSoulFingerprint(): Promise<Result<SoulFingerprint>> {
  try {
    const files: Record<string, string> = {};

    for (const filePath of CRITICAL_FILES) {
      try {
        files[filePath] = await computeFileHash(filePath);
      } catch (err) {
        return fail(
          `Failed to hash ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Composite: sorted file paths → their hashes joined by ':'
    const sortedHashes = CRITICAL_FILES.map((f) => files[f]!).join(':');
    const hash = createHash('sha256').update(sortedHashes).digest('hex');

    return ok('Fingerprint computed', {
      hash,
      files,
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    return fail(`Fingerprint computation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Verify the current soul files against a stored fingerprint hash.
 *
 * - If expected is null (first boot or migration), returns valid=true with the current hash.
 * - If hashes match, returns valid=true.
 * - If hashes differ, uses stored per-file hashes (when available) to pinpoint
 *   exactly which files changed. Legacy callers without per-file hashes get a
 *   fallback reporting all critical files as potentially changed.
 */
export async function verifySoulIntegrity(
  expected: string | null,
  storedFileHashes?: Record<string, string> | null,
): Promise<Result<IntegrityReport>> {
  const fpResult = await computeSoulFingerprint();
  if (!fpResult.ok) {
    return fail(fpResult.error);
  }

  const fp = fpResult.value;

  // First time — no stored hash to compare against
  if (expected === null) {
    return ok('First-time verification', {
      valid: true,
      expected: null,
      actual: fp.hash,
      changedFiles: [],
      message: 'No stored fingerprint — first-time initialization',
    });
  }

  // Match — all good
  if (fp.hash === expected) {
    return ok('Integrity verified', {
      valid: true,
      expected,
      actual: fp.hash,
      changedFiles: [],
      message: 'Soul integrity verified — fingerprint matches',
    });
  }

  // Mismatch — identify which files changed using per-file diff
  const changedFiles = diffFingerprints(storedFileHashes ?? null, fp);

  await logger.debug(
    'SoulIntegrity',
    `Mismatch detected. Changed files: [${changedFiles.join(', ')}]. Per-file hashes: ${JSON.stringify(fp.files)}`,
  );

  return ok('Integrity mismatch', {
    valid: false,
    expected,
    actual: fp.hash,
    changedFiles,
    message: `Soul integrity mismatch — expected: ${expected.slice(0, 12)}..., got: ${fp.hash.slice(0, 12)}...`,
  });
}

/**
 * Compare stored per-file hashes against current fingerprint to identify
 * exactly which files changed. Returns only the files with different hashes.
 *
 * If storedFileHashes is null/empty (legacy data), falls back to reporting
 * all critical files as potentially changed.
 */
export function diffFingerprints(
  storedFileHashes: Record<string, string> | null | undefined,
  current: SoulFingerprint,
): string[] {
  if (!storedFileHashes || Object.keys(storedFileHashes).length === 0) {
    // Legacy fallback: no per-file hashes stored, report all files
    return [...CRITICAL_FILES];
  }

  const changed: string[] = [];
  for (const filePath of CRITICAL_FILES) {
    const storedHash = storedFileHashes[filePath];
    const currentHash = current.files[filePath];
    if (!storedHash || storedHash !== currentHash) {
      changed.push(filePath);
    }
  }
  return changed;
}
