/**
 * Causal Verification — proves the transition chain is causally consistent.
 *
 * Four checks on every entry:
 *   1. Hash chain continuity (prevHash links correctly)
 *   2. Vector clock monotonic non-decreasing
 *   3. Timestamp monotonic non-decreasing
 *   4. Index sequential (0, 1, 2, ...)
 *
 * Backward-compatible: entries without vectorClock (pre-feature)
 * are skipped for check #2 but still verified on all other checks.
 */

import { ok, fail, type Result } from '../result.js';
import { isMonotonicSuccessor, type VectorClockSnapshot } from './vector-clock.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface CausalVerificationResult {
  /** Overall validity — false if any check fails on any entry */
  valid: boolean;
  /** Number of entries verified */
  length: number;
  /** List of error descriptions */
  errors: string[];
  /** Index of first violation, or -1 if all valid */
  brokenAt: number;
  /** The final vector clock from the verified chain (null if no entries have one) */
  finalClock: VectorClockSnapshot | null;
  /** Which checks passed across the entire chain */
  checks: {
    hashChain: boolean;
    vectorClockMonotonic: boolean;
    timestampMonotonic: boolean;
    indexSequential: boolean;
  };
}

// ── Core ──────────────────────────────────────────────────────────────

/**
 * Verify the causal history of all recorded transitions.
 *
 * Loads the full transition chain from disk and performs four-check
 * verification. Safe to call at any time — read-only operation.
 */
export async function verifyCausalHistory(): Promise<Result<CausalVerificationResult>> {
  try {
    const { getRecentTransitions, computeTransitionHash } = await import('./transition-log.js');
    const entries = await getRecentTransitions(100000);

    if (entries.length === 0) {
      return ok('Empty chain', {
        valid: true,
        length: 0,
        errors: [],
        brokenAt: -1,
        finalClock: null,
        checks: { hashChain: true, vectorClockMonotonic: true, timestampMonotonic: true, indexSequential: true },
      });
    }

    const errors: string[] = [];
    let brokenAt = -1;
    let hashChainOk = true;
    let vectorClockOk = true;
    let timestampOk = true;
    let indexOk = true;
    let lastClock: VectorClockSnapshot | null = null;
    let hasAnyVectorClock = false;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      // Check 1: Hash chain — entry hash matches recomputed hash
      const { hash: storedHash, ...rest } = entry;
      const computed = computeTransitionHash(rest);
      if (computed !== storedHash) {
        const msg = `#${entry.index}: hash mismatch (stored=${storedHash.slice(0, 8)}, computed=${computed.slice(0, 8)})`;
        errors.push(msg);
        hashChainOk = false;
        if (brokenAt === -1) brokenAt = entry.index;
      }

      // Check 1b: prevHash links to previous entry
      if (i > 0) {
        const prev = entries[i - 1]!;
        if (entry.prevHash !== prev.hash) {
          const msg = `#${entry.index}: prevHash doesn't link to #${prev.index}`;
          errors.push(msg);
          hashChainOk = false;
          if (brokenAt === -1) brokenAt = entry.index;
        }
      }

      // Check 2: Vector clock monotonic (skip entries without vectorClock)
      const entryClock = (entry as { vectorClock?: VectorClockSnapshot }).vectorClock;
      if (entryClock) {
        hasAnyVectorClock = true;
        if (lastClock !== null && !isMonotonicSuccessor(lastClock, entryClock)) {
          const msg = `#${entry.index}: vector clock regression (${JSON.stringify(lastClock)} → ${JSON.stringify(entryClock)})`;
          errors.push(msg);
          vectorClockOk = false;
          if (brokenAt === -1) brokenAt = entry.index;
        }
        lastClock = entryClock;
      }

      // Check 3: Timestamp monotonic
      if (i > 0) {
        const prevTs = new Date(entries[i - 1]!.timestamp).getTime();
        const curTs = new Date(entry.timestamp).getTime();
        if (curTs < prevTs) {
          const msg = `#${entry.index}: timestamp regression (${entries[i - 1]!.timestamp} → ${entry.timestamp})`;
          errors.push(msg);
          timestampOk = false;
          if (brokenAt === -1) brokenAt = entry.index;
        }
      }

      // Check 4: Index sequential
      if (entry.index !== i) {
        // Allow for chains that don't start at 0 (partial reads)
        if (i > 0 && entry.index !== entries[i - 1]!.index + 1) {
          const msg = `#${entry.index}: index gap (expected ${entries[i - 1]!.index + 1})`;
          errors.push(msg);
          indexOk = false;
          if (brokenAt === -1) brokenAt = entry.index;
        }
      }
    }

    // If no entries had vectorClock, the check is vacuously true but noted
    if (!hasAnyVectorClock) {
      vectorClockOk = true; // vacuously — no data to fail on
    }

    const valid = hashChainOk && vectorClockOk && timestampOk && indexOk;

    return ok(valid ? 'Causal chain verified' : 'Causal chain broken', {
      valid,
      length: entries.length,
      errors,
      brokenAt,
      finalClock: lastClock,
      checks: {
        hashChain: hashChainOk,
        vectorClockMonotonic: vectorClockOk,
        timestampMonotonic: timestampOk,
        indexSequential: indexOk,
      },
    });
  } catch (err) {
    return fail(`Causal verification failed: ${(err as Error).message}`);
  }
}
