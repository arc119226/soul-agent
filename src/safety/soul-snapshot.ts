/**
 * Soul Snapshot — immutable on-disk snapshots of critical soul files.
 *
 * Creates persistent snapshots when the bot enters rest/dormant state,
 * enabling recovery if soul files are corrupted or tampered with.
 *
 * Snapshots are stored under soul/checkpoints/{timestamp}/ and include:
 *   - Copies of all critical soul files
 *   - A manifest.json with per-file hashes for verification
 *
 * Lifecycle:
 *   - Created automatically on rest/dormant transitions (via checkpoint listener)
 *   - Verified on wake-up to detect tampering during rest
 *   - Pruned to keep only the N most recent snapshots
 *   - Protected by soul-guard (evolution cannot touch soul/checkpoints/)
 */

import { readFile, writeFile, mkdir, readdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { computeSoulFingerprint, CRITICAL_FILES, type SoulFingerprint } from './soul-integrity.js';
import { logger } from '../core/logger.js';
import { ok, fail, type Result } from '../result.js';

const PROJECT_ROOT = process.cwd();
const SNAPSHOT_DIR = join(PROJECT_ROOT, 'soul', 'checkpoints');
const MAX_SNAPSHOTS = 5;

export interface SnapshotManifest {
  id: string;
  createdAt: string;
  trigger: 'resting' | 'dormant' | 'pre-evolution' | 'manual';
  fingerprint: SoulFingerprint;
  files: Record<string, { hash: string; size: number }>;
  /** Narrative state at checkpoint time — hash + metadata (not a full copy).
   *  Added in v2; absent in older manifests (backward compatible). */
  narrativeState?: {
    hash: string;
    entryCount: number;
    lastTimestamp?: string;
  };
}

/**
 * Create an immutable snapshot of all critical soul files.
 *
 * Each snapshot is a directory under soul/checkpoints/{timestamp}/
 * containing copies of all critical files plus a manifest.json.
 */
export async function createSnapshot(
  trigger: SnapshotManifest['trigger'],
): Promise<Result<SnapshotManifest>> {
  try {
    // 1. Compute fingerprint (includes per-file hashes)
    const fpResult = await computeSoulFingerprint();
    if (!fpResult.ok) {
      return fail(`Snapshot failed: ${fpResult.error}`);
    }
    const fp = fpResult.value;

    // 2. Create snapshot directory with timestamp-based ID
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotDir = join(SNAPSHOT_DIR, id);
    await mkdir(snapshotDir, { recursive: true });

    // 3. Copy critical files into snapshot
    const fileInfo: Record<string, { hash: string; size: number }> = {};

    for (const filePath of CRITICAL_FILES) {
      const src = join(PROJECT_ROOT, filePath);
      const filename = filePath.split('/').pop()!;
      const dest = join(snapshotDir, filename);

      try {
        await copyFile(src, dest);
        // Re-hash the COPIED file to avoid race condition:
        // source file (e.g. vitals.json) may change between fingerprint
        // computation and copyFile, so the manifest must reflect the copy.
        const copied = await readFile(dest);
        const actualHash = createHash('sha256').update(copied).digest('hex');
        fileInfo[filePath] = {
          hash: actualHash,
          size: copied.length,
        };
      } catch (err) {
        await logger.warn('Snapshot', `Failed to copy ${filePath}: ${err}`);
      }
    }

    // 3b. Hash narrative.jsonl (don't copy — it's append-only and can be large)
    let narrativeState: SnapshotManifest['narrativeState'];
    try {
      const narrativePath = join(PROJECT_ROOT, 'soul', 'narrative.jsonl');
      const narrativeContent = await readFile(narrativePath, 'utf-8');
      const narrativeHash = createHash('sha256').update(narrativeContent).digest('hex');
      const narrativeLines = narrativeContent.split('\n').filter(l => l.trim());
      let lastTimestamp: string | undefined;
      if (narrativeLines.length > 0) {
        try {
          const lastEntry = JSON.parse(narrativeLines[narrativeLines.length - 1]!);
          lastTimestamp = lastEntry.timestamp;
        } catch { /* ignore parse error on last line */ }
      }
      narrativeState = { hash: narrativeHash, entryCount: narrativeLines.length, lastTimestamp };
    } catch {
      // narrative.jsonl may not exist yet — acceptable
    }

    // 4. Write manifest
    const manifest: SnapshotManifest = {
      id,
      createdAt: new Date().toISOString(),
      trigger,
      fingerprint: fp,
      files: fileInfo,
      narrativeState,
    };

    await writeFile(
      join(snapshotDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    // 5. Prune old snapshots
    await pruneSnapshots();

    await logger.info(
      'Snapshot',
      `Created: ${id} (trigger=${trigger}, hash=${fp.hash.slice(0, 12)}...)`,
    );

    return ok('Snapshot created', manifest);
  } catch (err) {
    return fail(`Snapshot creation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Verify a snapshot's integrity — all files match their recorded hashes.
 */
export async function verifySnapshot(snapshotId: string): Promise<Result<boolean>> {
  try {
    const manifestPath = join(SNAPSHOT_DIR, snapshotId, 'manifest.json');
    const raw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as SnapshotManifest;

    for (const [filePath, info] of Object.entries(manifest.files)) {
      const filename = filePath.split('/').pop()!;
      const snapshotFile = join(SNAPSHOT_DIR, snapshotId, filename);

      try {
        const content = await readFile(snapshotFile, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');

        if (hash !== info.hash) {
          return ok('Snapshot corrupted', false);
        }
      } catch {
        return ok('Snapshot file missing', false);
      }
    }

    return ok('Snapshot verified', true);
  } catch (err) {
    return fail(`Snapshot verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * List available snapshots, newest first.
 */
export async function listSnapshots(): Promise<SnapshotManifest[]> {
  try {
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    const entries = await readdir(SNAPSHOT_DIR, { withFileTypes: true });
    const manifests: SnapshotManifest[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await readFile(join(SNAPSHOT_DIR, entry.name, 'manifest.json'), 'utf-8');
        manifests.push(JSON.parse(raw));
      } catch {
        // Incomplete snapshot — skip
      }
    }

    // Sort newest first
    manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return manifests;
  } catch {
    return [];
  }
}

/**
 * Restore soul files from a verified snapshot.
 *
 * Steps:
 *   1. Verify snapshot integrity (all file hashes match)
 *   2. Copy each critical file from snapshot back to soul/
 *   3. Recompute fingerprint and update vitals.json
 *   4. Record restoration in audit chain
 *
 * Returns the restored manifest on success.
 */
export async function restoreSnapshot(snapshotId: string): Promise<Result<SnapshotManifest>> {
  try {
    // 1. Verify snapshot is intact before restoring
    const verifyResult = await verifySnapshot(snapshotId);
    if (!verifyResult.ok) {
      return fail(`Cannot restore: ${verifyResult.error}`);
    }
    if (!verifyResult.value) {
      return fail(`Snapshot ${snapshotId} is corrupted — cannot restore from damaged snapshot`);
    }

    // 2. Read manifest
    const manifestPath = join(SNAPSHOT_DIR, snapshotId, 'manifest.json');
    const raw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as SnapshotManifest;

    // 3. Copy files back to soul/
    const restoredFiles: string[] = [];
    for (const filePath of CRITICAL_FILES) {
      const filename = filePath.split('/').pop()!;
      const src = join(SNAPSHOT_DIR, snapshotId, filename);
      const dest = join(PROJECT_ROOT, filePath);

      try {
        await copyFile(src, dest);
        restoredFiles.push(filePath);
      } catch (err) {
        // If any file fails to restore, log but continue with others
        await logger.warn('Snapshot', `Failed to restore ${filePath}: ${err}`);
      }
    }

    if (restoredFiles.length === 0) {
      return fail('No files were restored from snapshot');
    }

    // 4. Recompute fingerprint and update vitals.json
    try {
      const newFp = await computeSoulFingerprint();
      if (newFp.ok) {
        const vitalsPath = join(PROJECT_ROOT, 'soul', 'vitals.json');
        const vitalsRaw = await readFile(vitalsPath, 'utf-8');
        const vitals = JSON.parse(vitalsRaw);
        vitals.identity_fingerprint = newFp.value.hash;
        vitals.identity_file_hashes = newFp.value.files;
        await writeFile(vitalsPath, JSON.stringify(vitals, null, 2));
      }
    } catch {
      // Fingerprint update is best-effort — soul files are already restored
    }

    // 5. Record in audit chain (non-blocking)
    try {
      const { appendAuditEntry } = await import('./audit-chain.js');
      await appendAuditEntry('integrity:mismatch', {
        witnessNote: `restored from snapshot ${snapshotId}`,
        filesChanged: restoredFiles,
        soulFileHashes: manifest.fingerprint.files,
      });
    } catch {
      // Audit recording is non-critical
    }

    await logger.info(
      'Snapshot',
      `Restored from ${snapshotId}: ${restoredFiles.length} files (${restoredFiles.join(', ')})`,
    );

    return ok('Snapshot restored', manifest);
  } catch (err) {
    return fail(`Snapshot restoration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface CheckpointDiff {
  /** Snapshot ID of the older checkpoint */
  olderSnapshot: string;
  /** Snapshot ID of the newer checkpoint */
  newerSnapshot: string;
  /** Files whose hash changed between the two checkpoints */
  changedFiles: string[];
  /** Files present in newer but not in older */
  addedFiles: string[];
  /** Files present in older but not in newer */
  removedFiles: string[];
  /** Whether the composite fingerprint hash changed */
  fingerprintChanged: boolean;
  /** Whether narrative state changed between checkpoints (undefined if either manifest lacks narrativeState) */
  narrativeChanged?: boolean;
  /** Number of narrative entries added between checkpoints */
  narrativeEntriesAdded?: number;
}

/**
 * Compare two checkpoints and return the differences.
 *
 * Files are compared by their SHA-256 hashes stored in each manifest.
 * Returns which files were changed, added, or removed between the two snapshots.
 */
export async function diffCheckpoints(
  olderSnapshotId: string,
  newerSnapshotId: string,
): Promise<Result<CheckpointDiff>> {
  try {
    const olderManifest = await readManifest(olderSnapshotId);
    if (!olderManifest) return fail(`Snapshot not found: ${olderSnapshotId}`);

    const newerManifest = await readManifest(newerSnapshotId);
    if (!newerManifest) return fail(`Snapshot not found: ${newerSnapshotId}`);

    const olderFiles = olderManifest.files;
    const newerFiles = newerManifest.files;
    const allPaths = new Set([...Object.keys(olderFiles), ...Object.keys(newerFiles)]);

    const changedFiles: string[] = [];
    const addedFiles: string[] = [];
    const removedFiles: string[] = [];

    for (const path of allPaths) {
      const inOlder = path in olderFiles;
      const inNewer = path in newerFiles;
      if (inOlder && inNewer) {
        if (olderFiles[path]!.hash !== newerFiles[path]!.hash) {
          changedFiles.push(path);
        }
      } else if (inNewer) {
        addedFiles.push(path);
      } else {
        removedFiles.push(path);
      }
    }

    // Narrative state diff (undefined if either manifest lacks narrativeState)
    let narrativeChanged: boolean | undefined;
    let narrativeEntriesAdded: number | undefined;
    if (olderManifest.narrativeState && newerManifest.narrativeState) {
      narrativeChanged = olderManifest.narrativeState.hash !== newerManifest.narrativeState.hash;
      narrativeEntriesAdded = newerManifest.narrativeState.entryCount - olderManifest.narrativeState.entryCount;
    }

    return ok('Diff computed', {
      olderSnapshot: olderSnapshotId,
      newerSnapshot: newerSnapshotId,
      changedFiles,
      addedFiles,
      removedFiles,
      fingerprintChanged: olderManifest.fingerprint.hash !== newerManifest.fingerprint.hash,
      narrativeChanged,
      narrativeEntriesAdded,
    });
  } catch (err) {
    return fail(`Diff failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface CheckpointValidation {
  snapshotId: string;
  valid: boolean;
  /** Which files failed verification (empty if valid) */
  corruptedFiles: string[];
}

/**
 * Validate the integrity of ALL checkpoints.
 *
 * Iterates over every stored checkpoint, verifies each file against its
 * manifest hash, and returns a per-checkpoint summary.
 */
export async function validateCheckpointIntegrity(): Promise<Result<CheckpointValidation[]>> {
  try {
    const snapshots = await listSnapshots();
    if (snapshots.length === 0) return ok('No checkpoints to validate', []);

    const results: CheckpointValidation[] = [];

    for (const snapshot of snapshots) {
      const corruptedFiles: string[] = [];

      for (const [filePath, info] of Object.entries(snapshot.files)) {
        const filename = filePath.split('/').pop()!;
        const snapshotFile = join(SNAPSHOT_DIR, snapshot.id, filename);
        try {
          const content = await readFile(snapshotFile, 'utf-8');
          const hash = createHash('sha256').update(content).digest('hex');
          if (hash !== info.hash) corruptedFiles.push(filePath);
        } catch {
          corruptedFiles.push(filePath);
        }
      }

      results.push({
        snapshotId: snapshot.id,
        valid: corruptedFiles.length === 0,
        corruptedFiles,
      });
    }

    return ok('Validation completed', results);
  } catch (err) {
    return fail(`Validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Read a snapshot's manifest.json — returns null if not found. */
async function readManifest(snapshotId: string): Promise<SnapshotManifest | null> {
  try {
    const raw = await readFile(join(SNAPSHOT_DIR, snapshotId, 'manifest.json'), 'utf-8');
    return JSON.parse(raw) as SnapshotManifest;
  } catch {
    return null;
  }
}

/**
 * Prune old snapshots, keeping only the MAX_SNAPSHOTS most recent.
 */
async function pruneSnapshots(): Promise<void> {
  try {
    const snapshots = await listSnapshots();
    if (snapshots.length <= MAX_SNAPSHOTS) return;

    const toRemove = snapshots.slice(MAX_SNAPSHOTS);
    for (const snapshot of toRemove) {
      const dir = join(SNAPSHOT_DIR, snapshot.id);
      await rm(dir, { recursive: true, force: true });
      await logger.debug('Snapshot', `Pruned old snapshot: ${snapshot.id}`);
    }
  } catch (err) {
    await logger.warn('Snapshot', `Prune failed: ${err}`);
  }
}
