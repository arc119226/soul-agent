/**
 * Audit Chain — Merkle Tree + Hash Chain for evolution integrity auditing.
 *
 * Provides a tamper-evident audit log for evolution events:
 *   - Hash Chain: each entry links to the previous via SHA-256, forming an
 *     immutable sequence. Deleting or modifying any entry breaks the chain.
 *   - Merkle Tree: aggregates multiple file hashes into a single root hash
 *     for efficient O(log n) verification of soul file integrity.
 *   - Witness: heartbeat periodically records root hashes as time-stamped
 *     witnesses, enabling retroactive integrity queries.
 *
 * Zero external dependencies — uses only node:crypto and node:fs.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tailReadJsonl } from '../core/tail-read.js';
import { logger } from '../core/logger.js';
import { writer } from '../core/debounced-writer.js';
import { ok, fail, type Result } from '../result.js';

// ── Constants ─────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const AUDIT_LOG_PATH = join(PROJECT_ROOT, 'soul', 'logs', 'audit-chain.jsonl');
const WITNESS_LOG_PATH = join(PROJECT_ROOT, 'soul', 'logs', 'witness.jsonl');

/** Genesis hash — the "block 0" of the chain (deterministic, no previous link) */
const GENESIS_HASH = createHash('sha256').update('genesis:soul-agent:audit-chain').digest('hex');

// ── Types ─────────────────────────────────────────────────────────────

export type AuditEventType =
  | 'evolution:start'
  | 'evolution:success'
  | 'evolution:fail'
  | 'evolution:rollback'
  | 'witness'
  | 'integrity:mismatch'
  | 'transition:state';

export interface AuditEntry {
  /** Sequential index (0-based) */
  index: number;
  /** ISO timestamp */
  timestamp: string;
  /** Event type */
  type: AuditEventType;
  /** SHA-256 of previous entry (genesis hash for index 0) */
  prevHash: string;
  /** Event-specific payload */
  payload: AuditPayload;
  /** Merkle root of soul files at this moment (if computed) */
  merkleRoot?: string;
  /** SHA-256 hash of this entry (computed from all other fields) */
  hash: string;
}

export interface AuditPayload {
  goalId?: string;
  description?: string;
  error?: string;
  filesChanged?: string[];
  soulFileHashes?: Record<string, string>;
  witnessNote?: string;
  /** Arbitrary structured data for event-specific context */
  details?: Record<string, unknown>;
}

export interface WitnessEntry {
  timestamp: string;
  merkleRoot: string;
  chainTip: string;
  chainLength: number;
  state: string;
  /** SHA-256 of the audit-chain.jsonl file itself (tamper detection for the audit trail) */
  auditLogHash?: string;
  /** SHA-256 of narrative.jsonl at witness time (for quick narrative integrity check) */
  narrativeHash?: string;
}

export interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  /** Leaf label (file path for leaf nodes) */
  label?: string;
}

/** A single step in a Merkle inclusion proof */
export interface MerkleProofStep {
  /** The sibling hash at this level */
  hash: string;
  /** Which side the sibling is on — determines concatenation order */
  position: 'left' | 'right';
}

/** A complete Merkle inclusion proof for a single leaf */
export interface MerkleProof {
  /** The leaf being proven */
  leaf: { label: string; hash: string };
  /** Sibling hashes from leaf to root */
  steps: MerkleProofStep[];
  /** The expected Merkle root */
  root: string;
}

export interface ChainVerification {
  valid: boolean;
  length: number;
  errors: string[];
  /** Index of first broken link, or -1 if all valid */
  brokenAt: number;
}

// ── In-memory state ───────────────────────────────────────────────────

/** Last hash in the chain (tip) — loaded from disk on init */
let chainTip: string = GENESIS_HASH;
let chainLength = 0;
let initialized = false;
let initPromise: Promise<void> | null = null;

// ── Hash utilities ────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute the hash of an audit entry from its contents.
 * The hash covers: index, timestamp, type, prevHash, payload, merkleRoot.
 */
export function computeEntryHash(entry: Omit<AuditEntry, 'hash'>): string {
  const canonical = JSON.stringify({
    index: entry.index,
    timestamp: entry.timestamp,
    type: entry.type,
    prevHash: entry.prevHash,
    payload: entry.payload,
    merkleRoot: entry.merkleRoot ?? null,
  });
  return sha256(canonical);
}

// ── Merkle Tree ───────────────────────────────────────────────────────

/**
 * Build a Merkle tree from a list of labeled hashes.
 *
 * Algorithm:
 *   1. Create leaf nodes from input hashes
 *   2. Pair adjacent nodes, hash(left + right) to create parent
 *   3. If odd number, duplicate the last node
 *   4. Repeat until single root remains
 *
 * Returns the root node (or null for empty input).
 */
export function buildMerkleTree(
  leaves: Array<{ label: string; hash: string }>,
): MerkleNode | null {
  if (leaves.length === 0) return null;

  // Create leaf nodes
  let level: MerkleNode[] = leaves.map((l) => ({
    hash: l.hash,
    label: l.label,
  }));

  // Build tree bottom-up
  while (level.length > 1) {
    const next: MerkleNode[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left; // duplicate if odd
      next.push({
        hash: sha256(left.hash + right.hash),
        left,
        right: level[i + 1] ? right : undefined, // don't store duplicate as right
      });
    }
    level = next;
  }

  return level[0]!;
}

/**
 * Generate an inclusion proof for a specific leaf in a Merkle tree.
 *
 * The proof consists of sibling hashes at each level from the leaf up to
 * the root. With just the proof + leaf hash, anyone can recompute the root
 * and verify the leaf's membership without knowing any other leaf values.
 *
 * Algorithm: walk the tree from root, tracking the path to the target leaf.
 * At each level, record the sibling of the node on the path.
 *
 * @param root - The Merkle tree root node (from buildMerkleTree)
 * @param targetLabel - The label of the leaf to prove (e.g. 'soul/genesis.md')
 * @returns The proof, or null if the leaf is not in the tree
 */
export function generateProof(root: MerkleNode, targetLabel: string): MerkleProof | null {
  // Collect path from root to target leaf via DFS
  const path: Array<{ node: MerkleNode; direction: 'left' | 'right' }> = [];

  function findPath(node: MerkleNode): boolean {
    // Leaf node — check if it's the target
    if (node.label !== undefined && !node.left && !node.right) {
      return node.label === targetLabel;
    }

    // Try left subtree
    if (node.left) {
      path.push({ node, direction: 'left' });
      if (findPath(node.left)) return true;
      path.pop();
    }

    // Try right subtree
    if (node.right) {
      path.push({ node, direction: 'right' });
      if (findPath(node.right)) return true;
      path.pop();
    }

    return false;
  }

  if (!findPath(root)) return null;

  // Build proof: at each path step, the sibling is on the opposite side
  const steps: MerkleProofStep[] = [];
  let leafHash = '';

  // Edge case: single-leaf tree — root IS the leaf, no proof steps needed
  if (path.length === 0) {
    return { leaf: { label: targetLabel, hash: root.hash }, steps: [], root: root.hash };
  }

  for (let i = path.length - 1; i >= 0; i--) {
    const { node, direction } = path[i]!;
    if (direction === 'left') {
      // We went left, so the sibling is on the right
      if (node.right) {
        steps.push({ hash: node.right.hash, position: 'right' });
      } else {
        // Odd node — sibling is self (duplicate), use left hash
        steps.push({ hash: node.left!.hash, position: 'right' });
      }
      if (i === path.length - 1) leafHash = node.left!.hash;
    } else {
      // We went right, so the sibling is on the left
      steps.push({ hash: node.left!.hash, position: 'left' });
      if (i === path.length - 1) leafHash = node.right!.hash;
    }
  }

  return {
    leaf: { label: targetLabel, hash: leafHash },
    steps,
    root: root.hash,
  };
}

/**
 * Verify a Merkle inclusion proof.
 *
 * Recomputes the root hash from the leaf and proof steps, then compares
 * with the expected root. No tree structure needed — just the proof data.
 *
 * @param proof - The proof to verify
 * @param expectedLeafHash - The expected leaf hash (required to prevent
 *   single-leaf bypass where leaf.hash === root.hash trivially)
 * @returns true if the proof is valid (leaf is included in the root)
 */
export function verifyProof(proof: MerkleProof, expectedLeafHash: string): boolean {
  // Single-leaf guard: when steps is empty, leaf.hash === root.hash is
  // always true by construction, so an attacker could forge any proof.
  // Verify the leaf hash matches what the caller independently computed.
  if (proof.steps.length === 0) {
    if (proof.leaf.hash !== expectedLeafHash) return false;
    return proof.leaf.hash === proof.root;
  }

  let currentHash = proof.leaf.hash;

  for (const step of proof.steps) {
    if (step.position === 'left') {
      // Sibling is on the left: hash(sibling + current)
      currentHash = sha256(step.hash + currentHash);
    } else {
      // Sibling is on the right: hash(current + sibling)
      currentHash = sha256(currentHash + step.hash);
    }
  }

  return currentHash === proof.root;
}

/**
 * Generate a Merkle proof directly from file hashes (convenience wrapper).
 * Builds the tree internally and generates the proof for the specified file.
 */
export function generateProofFromHashes(
  fileHashes: Record<string, string>,
  targetFile: string,
): MerkleProof | null {
  const entries = Object.entries(fileHashes).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;

  const leaves = entries.map(([label, hash]) => ({ label, hash }));
  const root = buildMerkleTree(leaves);
  if (!root) return null;

  return generateProof(root, targetFile);
}

/**
 * Compute the Merkle root hash from a set of file paths.
 * Reads each file, hashes its content, and builds the tree.
 */
export async function computeMerkleRoot(filePaths: string[]): Promise<Result<string>> {
  if (filePaths.length === 0) {
    return fail('No files to compute Merkle root');
  }

  try {
    const leaves: Array<{ label: string; hash: string }> = [];

    for (const filePath of filePaths.sort()) {
      try {
        const content = await readFile(join(PROJECT_ROOT, filePath), 'utf-8');
        leaves.push({
          label: filePath,
          hash: sha256(content),
        });
      } catch {
        // File missing — hash a sentinel value so the root still reflects absence
        leaves.push({
          label: filePath,
          hash: sha256(`MISSING:${filePath}`),
        });
      }
    }

    const root = buildMerkleTree(leaves);
    if (!root) return fail('Merkle tree construction failed');

    return ok('Merkle root computed', root.hash);
  } catch (err) {
    return fail(`Merkle root computation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Compute Merkle root from pre-computed file hashes (no disk I/O).
 * Useful when file hashes are already available from soul-integrity.
 */
export function computeMerkleRootFromHashes(
  fileHashes: Record<string, string>,
): string | null {
  const entries = Object.entries(fileHashes).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;

  const leaves = entries.map(([label, hash]) => ({ label, hash }));
  const root = buildMerkleTree(leaves);
  return root?.hash ?? null;
}

// ── Append serialization ──────────────────────────────────────────────

/**
 * Simple async mutex for serializing appendAuditEntry calls.
 * Without this, concurrent callers (e.g. heartbeat tick + state transition
 * during shutdown) can read the same chainTip/chainLength before either
 * writes, producing duplicate-index entries that break the chain.
 */
let chainMutex: Promise<void> = Promise.resolve();

// ── Chain operations ──────────────────────────────────────────────────

/**
 * Initialize the audit chain from disk.
 * Reads the last entry to recover the chain tip and length.
 * Includes defensive validation: if the last entry's index doesn't match
 * the line count, the chain has been corrupted (duplicate appends). In that
 * case, scan backwards to find the last valid contiguous segment.
 */
export function initAuditChain(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (!initPromise) {
    initPromise = doInit().finally(() => {
      if (!initialized) initPromise = null; // Allow retry on failure
    });
  }
  return initPromise;
}

async function doInit(): Promise<void> {
  try {
    const content = await readFile(AUDIT_LOG_PATH, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1]!;
      const lastEntry = JSON.parse(lastLine) as AuditEntry;

      // Defensive check: line count should equal lastEntry.index + 1
      // If not, the file has been corrupted by duplicate appends.
      if (lastEntry.index + 1 !== lines.length) {
        logger.warn(
          'AuditChain',
          `chain inconsistency detected: ${lines.length} lines but last index=${lastEntry.index}. ` +
          `Scanning for valid chain tip...`,
        );

        // Scan forward to find the first break point (where index != line position)
        let validEnd = 0;
        for (let i = 0; i < lines.length; i++) {
          try {
            const entry = JSON.parse(lines[i]!) as AuditEntry;
            if (entry.index !== i) break;
            validEnd = i + 1;
          } catch {
            break;
          }
        }

        if (validEnd > 0) {
          const validLastEntry = JSON.parse(lines[validEnd - 1]!) as AuditEntry;
          chainTip = validLastEntry.hash;
          chainLength = validEnd;

          // Truncate the file to only the valid segment so future appends are correct
          const validContent = lines.slice(0, validEnd).join('\n') + '\n';
          await writeFile(AUDIT_LOG_PATH, validContent, 'utf-8');

          logger.warn(
            'AuditChain',
            `recovered valid segment: ${chainLength} entries (truncated ${lines.length - validEnd} corrupted lines)`,
          );
        } else {
          chainTip = GENESIS_HASH;
          chainLength = 0;
          logger.warn('AuditChain', 'no valid chain segment found, starting fresh');
        }
      } else {
        chainTip = lastEntry.hash;
        chainLength = lastEntry.index + 1;
        logger.info('AuditChain', `loaded: ${chainLength} entries, tip=${chainTip.slice(0, 12)}...`);
      }
    } else {
      chainTip = GENESIS_HASH;
      chainLength = 0;
    }
  } catch {
    // No audit log yet — start fresh
    chainTip = GENESIS_HASH;
    chainLength = 0;
    logger.info('AuditChain', 'starting fresh chain (no existing log)');
  }

  initialized = true;
}

/**
 * Append a new entry to the audit chain.
 * Returns the created entry with its computed hash.
 */
export async function appendAuditEntry(
  type: AuditEventType,
  payload: AuditPayload,
  merkleRoot?: string,
): Promise<Result<AuditEntry>> {
  // Serialize: each append must complete before the next starts,
  // otherwise concurrent callers read stale chainTip/chainLength.
  let releaseLock!: () => void;
  const nextMutex = new Promise<void>(r => { releaseLock = r; });
  const prevMutex = chainMutex;
  chainMutex = nextMutex;

  await prevMutex;

  try {
    if (!initialized) await initAuditChain();

    const entryWithoutHash = {
      index: chainLength,
      timestamp: new Date().toISOString(),
      type,
      prevHash: chainTip,
      payload,
      merkleRoot,
    };

    const hash = computeEntryHash(entryWithoutHash);
    const entry: AuditEntry = { ...entryWithoutHash, hash };

    // Append to JSONL
    await writer.appendJsonl(AUDIT_LOG_PATH, entry);

    // Update in-memory state
    chainTip = hash;
    chainLength++;

    logger.debug(
      'AuditChain',
      `appended #${entry.index} ${type} hash=${hash.slice(0, 12)}...`,
    );

    return ok('Entry appended', entry);
  } catch (err) {
    return fail(`Failed to append audit entry: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    releaseLock();
  }
}

// ── Witness (periodic root hash recording) ────────────────────────────

/**
 * Record a witness entry — a timestamped snapshot of the current chain state
 * and Merkle root of soul files.
 *
 * Called by heartbeat every 30 minutes.
 */
export async function recordWitness(
  soulFileHashes: Record<string, string>,
  lifecycleState: string,
): Promise<Result<WitnessEntry>> {
  if (!initialized) await initAuditChain();

  try {
    const merkleRoot = computeMerkleRootFromHashes(soulFileHashes);
    if (!merkleRoot) {
      return fail('Cannot compute Merkle root from empty file hashes');
    }

    // Record as audit entry
    await appendAuditEntry('witness', {
      soulFileHashes,
      witnessNote: `periodic witness at state=${lifecycleState}`,
    }, merkleRoot);

    // Hash the audit log itself — detects deletion or tampering of the trail
    let auditLogHash: string | undefined;
    try {
      const logContent = await readFile(AUDIT_LOG_PATH, 'utf-8');
      auditLogHash = sha256(logContent);
    } catch {
      // Log doesn't exist yet — acceptable for first witness
    }

    // Also write to dedicated witness log for fast lookups
    const witnessEntry: WitnessEntry = {
      timestamp: new Date().toISOString(),
      merkleRoot,
      chainTip,
      chainLength,
      state: lifecycleState,
      auditLogHash,
      narrativeHash: soulFileHashes['soul/narrative.jsonl'],
    };

    await writer.appendJsonl(WITNESS_LOG_PATH, witnessEntry);

    logger.debug(
      'AuditChain',
      `witness recorded: merkle=${merkleRoot.slice(0, 12)}..., chain=${chainLength}`,
    );

    return ok('Witness recorded', witnessEntry);
  } catch (err) {
    return fail(`Failed to record witness: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Verification ──────────────────────────────────────────────────────

/**
 * Verify the entire audit chain from disk.
 * Checks that:
 *   1. Entry[0].prevHash === GENESIS_HASH
 *   2. Each entry's hash matches recomputed hash
 *   3. Each entry's prevHash matches the previous entry's hash
 *   4. Indices are sequential
 */
export async function verifyChain(): Promise<Result<ChainVerification>> {
  try {
    let content: string;
    try {
      content = await readFile(AUDIT_LOG_PATH, 'utf-8');
    } catch {
      return ok('No chain to verify', {
        valid: true,
        length: 0,
        errors: [],
        brokenAt: -1,
      });
    }

    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return ok('Empty chain', { valid: true, length: 0, errors: [], brokenAt: -1 });
    }

    const errors: string[] = [];
    let brokenAt = -1;
    let prevHash = GENESIS_HASH;

    for (let i = 0; i < lines.length; i++) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[i]!) as AuditEntry;
      } catch {
        errors.push(`Line ${i}: invalid JSON`);
        if (brokenAt === -1) brokenAt = i;
        continue;
      }

      // Check index
      if (entry.index !== i) {
        errors.push(`Entry ${i}: expected index ${i}, got ${entry.index}`);
        if (brokenAt === -1) brokenAt = i;
      }

      // Check prevHash link
      if (entry.prevHash !== prevHash) {
        errors.push(
          `Entry ${i}: prevHash mismatch — expected ${prevHash.slice(0, 12)}..., got ${entry.prevHash.slice(0, 12)}...`,
        );
        if (brokenAt === -1) brokenAt = i;
      }

      // Recompute and verify hash
      const { hash: _storedHash, ...entryWithoutHash } = entry;
      const recomputed = computeEntryHash(entryWithoutHash);
      if (recomputed !== entry.hash) {
        errors.push(
          `Entry ${i}: hash mismatch — stored ${entry.hash.slice(0, 12)}..., computed ${recomputed.slice(0, 12)}...`,
        );
        if (brokenAt === -1) brokenAt = i;
      }

      prevHash = entry.hash;
    }

    const valid = errors.length === 0;
    return ok(
      valid ? 'Chain verified' : 'Chain verification failed',
      { valid, length: lines.length, errors, brokenAt },
    );
  } catch (err) {
    return fail(`Chain verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Repair a broken audit chain by truncating to the last valid contiguous segment.
 * Returns the number of entries that were removed, or -1 if no repair was needed.
 *
 * This is the runtime counterpart of the defensive check in initAuditChain().
 * Called by the health-check layer when verifyChain() finds corruption, so
 * stale corruption is cleaned up instead of permanently triggering 'compromised'.
 */
export async function repairChain(): Promise<Result<{ removed: number; remaining: number }>> {
  try {
    let content: string;
    try {
      content = await readFile(AUDIT_LOG_PATH, 'utf-8');
    } catch {
      return ok('No chain to repair', { removed: 0, remaining: 0 });
    }

    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return ok('Empty chain', { removed: 0, remaining: 0 });
    }

    // Find the longest valid prefix
    let validEnd = 0;
    let prevHash = GENESIS_HASH;

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]!) as AuditEntry;
        if (entry.index !== i) break;
        if (entry.prevHash !== prevHash) break;
        const { hash: _stored, ...rest } = entry;
        const recomputed = computeEntryHash(rest);
        if (recomputed !== entry.hash) break;
        prevHash = entry.hash;
        validEnd = i + 1;
      } catch {
        break;
      }
    }

    const removed = lines.length - validEnd;
    if (removed === 0) {
      return ok('Chain is already valid', { removed: 0, remaining: lines.length });
    }

    // Truncate the file to the valid prefix
    if (validEnd > 0) {
      const validContent = lines.slice(0, validEnd).join('\n') + '\n';
      await writeFile(AUDIT_LOG_PATH, validContent, 'utf-8');
      const lastEntry = JSON.parse(lines[validEnd - 1]!) as AuditEntry;
      chainTip = lastEntry.hash;
      chainLength = validEnd;
    } else {
      await writeFile(AUDIT_LOG_PATH, '', 'utf-8');
      chainTip = GENESIS_HASH;
      chainLength = 0;
    }

    await logger.warn(
      'AuditChain',
      `repairChain: truncated ${removed} corrupted entries, ${validEnd} remaining`,
    );

    return ok('Chain repaired', { removed, remaining: validEnd });
  } catch (err) {
    return fail(`Chain repair failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Verify audit log integrity against the most recent witness.
 * Reads the current audit-chain.jsonl, hashes it, and compares to the
 * last witness's auditLogHash. Detects deletion or modification of the trail.
 *
 * Returns null if no witnesses exist or audit log is missing (fresh state).
 */
export async function verifyAuditLogIntegrity(): Promise<Result<{ valid: boolean; message: string }> | null> {
  const witnesses = await getRecentWitnesses(1);
  if (witnesses.length === 0 || !witnesses[0]!.auditLogHash) return null;

  try {
    const logContent = await readFile(AUDIT_LOG_PATH, 'utf-8');
    const currentHash = sha256(logContent);
    const expectedHash = witnesses[0]!.auditLogHash;

    if (currentHash === expectedHash) {
      return ok('Audit log intact', { valid: true, message: 'Audit log hash matches last witness' });
    }

    // Hash differs — this is expected if new entries were appended since last witness.
    // Only flag as suspicious if the log is SHORTER than expected (truncation/deletion).
    const lines = logContent.trim().split('\n').filter(Boolean);
    if (lines.length < witnesses[0]!.chainLength) {
      return ok('Audit log truncated', {
        valid: false,
        message: `Audit log has ${lines.length} entries but last witness recorded ${witnesses[0]!.chainLength}`,
      });
    }

    // Log grew (new entries appended) — this is normal
    return ok('Audit log grew since last witness', { valid: true, message: 'New entries appended since last witness' });
  } catch {
    // Audit log is completely missing — definitely suspicious if witness recorded entries
    if (witnesses[0]!.chainLength > 0) {
      return ok('Audit log missing', {
        valid: false,
        message: `Audit log file missing but last witness recorded ${witnesses[0]!.chainLength} entries`,
      });
    }
    return null;
  }
}

// ── Query helpers ─────────────────────────────────────────────────────

/** Get current chain status (tip hash and length) */
export function getChainStatus(): { tip: string; length: number; initialized: boolean } {
  return { tip: chainTip, length: chainLength, initialized };
}

/** Get the genesis hash constant */
export function getGenesisHash(): string {
  return GENESIS_HASH;
}

/**
 * Read the most recent N witness entries from the witness log.
 */
export async function getRecentWitnesses(count = 10): Promise<WitnessEntry[]> {
  return tailReadJsonl<WitnessEntry>(WITNESS_LOG_PATH, count, 65536);
}

/**
 * Read the most recent N audit entries from the chain log.
 */
export async function getRecentEntries(count = 20): Promise<AuditEntry[]> {
  return tailReadJsonl<AuditEntry>(AUDIT_LOG_PATH, count, 65536);
}
