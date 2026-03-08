/**
 * Transition Log — cryptographic proof that intermediate states existed.
 *
 * Records EVERY lifecycle state transition with context snapshot and
 * hash chain linking. Unlike narrative-listener (which only records
 * "significant" transitions), this captures the full path:
 *   active → throttled → drained → resting
 *
 * Each entry is SHA-256 hashed and linked to the previous entry,
 * creating an append-only tamper-evident chain.
 *
 * Storage: soul/logs/transitions.jsonl (JSONL, append-only)
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from '../core/database.js';
import type { TransitionRow } from '../core/db-types.js';
import { writer } from '../core/debounced-writer.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import type { VectorClockSnapshot } from './vector-clock.js';

export type { VectorClockSnapshot };

// ── Types ─────────────────────────────────────────────────────────────

export interface TransitionContext {
  dailyPhase: string;
  fatigueScore?: number;
  elu?: number;
  idleMs?: number;
}

export interface TransitionEntry {
  /** Sequential index (0-based) */
  index: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Previous state */
  from: string;
  /** New state */
  to: string;
  /** Human-readable reason */
  reason: string;
  /** Time spent in previous state (ms) */
  durationMs: number;
  /** Context snapshot at transition time */
  context: TransitionContext;
  /** SHA-256 of previous entry (genesis seed for first) */
  prevHash: string;
  /** SHA-256 of this entry */
  hash: string;
  /** Vector clock snapshot at this transition (absent in pre-vectorclock entries) */
  vectorClock?: VectorClockSnapshot;
}

// ── Constants ─────────────────────────────────────────────────────────

const TRANSITIONS_PATH = join(process.cwd(), 'soul', 'logs', 'transitions.jsonl');
const GENESIS_HASH = createHash('sha256').update('soul-agent:transition-log:genesis').digest('hex');

// ── SQLite Helpers ────────────────────────────────────────────────────

/** Convert a SQLite row to a TransitionEntry */
function rowToEntry(row: TransitionRow): TransitionEntry {
  return {
    index: row.idx,
    timestamp: row.timestamp,
    from: row.from_state,
    to: row.to_state,
    reason: row.reason,
    durationMs: row.duration_ms,
    context: JSON.parse(row.context) as TransitionContext,
    prevHash: row.prev_hash,
    hash: row.hash,
    vectorClock: row.vector_clock ? JSON.parse(row.vector_clock) as VectorClockSnapshot : undefined,
  };
}

/** Insert a transition entry into SQLite (non-throwing) */
function insertTransitionToDb(entry: TransitionEntry): void {
  try {
    getDb().prepare(
      `INSERT OR IGNORE INTO transitions (idx, timestamp, from_state, to_state, reason, duration_ms, context, prev_hash, hash, vector_clock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.index, entry.timestamp, entry.from, entry.to,
      entry.reason, entry.durationMs, JSON.stringify(entry.context),
      entry.prevHash, entry.hash,
      entry.vectorClock ? JSON.stringify(entry.vectorClock) : null
    );
  } catch (err) {
    logger.error('TransitionLog', 'Failed to write transition to SQLite', err);
  }
}

// ── State ─────────────────────────────────────────────────────────────

let nextIndex = 0;
let lastHash = GENESIS_HASH;
let attached = false;

// ── Core Functions ────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash for a transition entry (excluding the hash field itself).
 */
export function computeTransitionHash(entry: Omit<TransitionEntry, 'hash'>): string {
  const payload = JSON.stringify({
    index: entry.index,
    timestamp: entry.timestamp,
    from: entry.from,
    to: entry.to,
    reason: entry.reason,
    durationMs: entry.durationMs,
    context: entry.context,
    prevHash: entry.prevHash,
    // Only include vectorClock if present — preserves hash backward compatibility
    // for pre-vectorclock entries whose hashes were computed without this field
    ...(entry.vectorClock !== undefined && { vectorClock: entry.vectorClock }),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Record a state transition with full context.
 */
export async function recordTransition(
  from: string,
  to: string,
  reason: string,
  durationMs: number,
  context: TransitionContext,
): Promise<TransitionEntry> {
  // Tick the vector clock — each transition gets a unique causal position
  const { tick: tickClock } = await import('./vector-clock.js');
  const vectorClock = tickClock();

  const partial: Omit<TransitionEntry, 'hash'> = {
    index: nextIndex,
    timestamp: new Date().toISOString(),
    from,
    to,
    reason,
    durationMs,
    context,
    prevHash: lastHash,
    vectorClock,
  };

  const hash = computeTransitionHash(partial);
  const entry: TransitionEntry = { ...partial, hash };

  // Dual-write: SQLite first (non-blocking on failure), then JSONL
  insertTransitionToDb(entry);
  await writer.appendJsonl(TRANSITIONS_PATH, entry);

  // Update chain state
  lastHash = hash;
  nextIndex++;

  // Emit event for other systems
  await eventBus.emit('transition:recorded', {
    index: entry.index,
    from: entry.from,
    to: entry.to,
    hash: entry.hash,
    vectorClock: entry.vectorClock,
  });

  // Push to audit chain (non-blocking, non-critical)
  try {
    const { appendAuditEntry } = await import('../safety/audit-chain.js');
    await appendAuditEntry('transition:state', {
      description: `${from} → ${to}: ${reason}`,
      details: { durationMs, context, transitionHash: hash, vectorClock },
    });
  } catch {
    // audit-chain unavailable — non-critical
  }

  await logger.debug(
    'TransitionLog',
    `#${entry.index} ${from} → ${to} (${Math.round(durationMs / 1000)}s in ${from}) [${hash.slice(0, 8)}]`,
  );

  return entry;
}

// ── Query Functions ───────────────────────────────────────────────────

/**
 * Get recent transition entries — SQLite first, JSONL fallback.
 */
export async function getRecentTransitions(n: number = 20): Promise<TransitionEntry[]> {
  // Try SQLite first
  try {
    const rows = getDb().prepare(
      `SELECT * FROM transitions ORDER BY idx DESC LIMIT ?`
    ).all(n) as TransitionRow[];
    if (rows.length > 0) {
      // Reverse to chronological order (ASC)
      return rows.reverse().map(rowToEntry);
    }
  } catch {
    // SQLite unavailable — fall through to JSONL
  }

  // Fallback: read from JSONL
  let raw: string;
  try {
    raw = await readFile(TRANSITIONS_PATH, 'utf-8');
  } catch {
    return [];
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const recent = lines.slice(-n);
  const entries: TransitionEntry[] = [];

  for (const line of recent) {
    try {
      entries.push(JSON.parse(line) as TransitionEntry);
    } catch {
      // skip malformed
    }
  }

  return entries;
}

/**
 * Verify the integrity of the transition chain.
 * Returns { valid, brokenAt } where brokenAt is the index of the first broken link.
 */
export async function verifyTransitionChain(): Promise<{ valid: boolean; length: number; brokenAt?: number }> {
  const entries = await getRecentTransitions(10000);
  if (entries.length === 0) return { valid: true, length: 0 };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const { hash, ...rest } = entry;
    const computed = computeTransitionHash(rest);

    if (computed !== hash) {
      return { valid: false, length: entries.length, brokenAt: entry.index };
    }

    // Check chain linkage (first entry should link to genesis or prior chain tail)
    if (i > 0) {
      const prev = entries[i - 1]!;
      if (entry.prevHash !== prev.hash) {
        return { valid: false, length: entries.length, brokenAt: entry.index };
      }
    }
  }

  return { valid: true, length: entries.length };
}

/**
 * Compute statistics from transition history — SQLite aggregate first, JSONL fallback.
 */
export async function getTransitionStats(): Promise<{
  totalTransitions: number;
  avgDurationByState: Record<string, number>;
  transitionCounts: Record<string, number>;
}> {
  // Try SQLite aggregate queries first
  try {
    const db = getDb();

    const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM transitions').get() as { cnt: number };
    const totalTransitions = totalRow.cnt;

    if (totalTransitions > 0) {
      const avgRows = db.prepare(
        'SELECT from_state, ROUND(AVG(duration_ms)) as avg_dur FROM transitions GROUP BY from_state'
      ).all() as Array<{ from_state: string; avg_dur: number }>;

      const avgDurationByState: Record<string, number> = {};
      for (const row of avgRows) {
        avgDurationByState[row.from_state] = row.avg_dur;
      }

      const countRows = db.prepare(
        `SELECT from_state || '→' || to_state as path, COUNT(*) as cnt FROM transitions GROUP BY from_state, to_state`
      ).all() as Array<{ path: string; cnt: number }>;

      const transitionCounts: Record<string, number> = {};
      for (const row of countRows) {
        transitionCounts[row.path] = row.cnt;
      }

      return { totalTransitions, avgDurationByState, transitionCounts };
    }
  } catch {
    // SQLite unavailable — fall through to JSONL
  }

  // Fallback: compute from JSONL entries
  const entries = await getRecentTransitions(10000);

  const durationSums = new Map<string, number>();
  const durationCounts = new Map<string, number>();
  const transitionCounts = new Map<string, number>();

  for (const entry of entries) {
    // Duration by state
    const prevSum = durationSums.get(entry.from) ?? 0;
    durationSums.set(entry.from, prevSum + entry.durationMs);
    durationCounts.set(entry.from, (durationCounts.get(entry.from) ?? 0) + 1);

    // Transition path counts
    const key = `${entry.from}\u2192${entry.to}`;
    transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1);
  }

  const avgDurationByState: Record<string, number> = {};
  for (const [state, sum] of durationSums) {
    avgDurationByState[state] = Math.round(sum / (durationCounts.get(state) ?? 1));
  }

  return {
    totalTransitions: entries.length,
    avgDurationByState,
    transitionCounts: Object.fromEntries(transitionCounts),
  };
}

// ── Initialization ────────────────────────────────────────────────────

/**
 * Initialize transition log by loading chain tail — SQLite first, JSONL fallback.
 */
export async function initTransitionLog(): Promise<void> {
  // Try SQLite first
  try {
    const row = getDb().prepare(
      'SELECT * FROM transitions ORDER BY idx DESC LIMIT 1'
    ).get() as TransitionRow | undefined;

    if (row) {
      const last = rowToEntry(row);
      nextIndex = last.index + 1;
      lastHash = last.hash;

      if (last.vectorClock) {
        const { initFromSnapshot } = await import('./vector-clock.js');
        initFromSnapshot(last.vectorClock);
      }

      await logger.info('TransitionLog', `loaded chain tail from SQLite: index=${last.index}, hash=${last.hash.slice(0, 8)}`);
      return;
    }
  } catch {
    // SQLite unavailable — fall through to JSONL
  }

  // Fallback: read from JSONL
  try {
    const raw = await readFile(TRANSITIONS_PATH, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    if (lines.length > 0) {
      const last = JSON.parse(lines[lines.length - 1]!) as TransitionEntry;
      nextIndex = last.index + 1;
      lastHash = last.hash;

      // Restore vector clock from last entry (if present)
      if (last.vectorClock) {
        const { initFromSnapshot } = await import('./vector-clock.js');
        initFromSnapshot(last.vectorClock);
      }

      await logger.info('TransitionLog', `loaded chain tail from JSONL: index=${last.index}, hash=${last.hash.slice(0, 8)}`);
    }
  } catch {
    // No existing log — start fresh
    await logger.info('TransitionLog', 'starting fresh chain (no prior log)');
  }
}

/**
 * Attach to EventBus — record all lifecycle:state transitions.
 * Call once during startup (from heartbeat.ts).
 */
export async function attachTransitionListener(): Promise<void> {
  if (attached) return;

  await initTransitionLog();

  eventBus.on('lifecycle:state', async (data) => {
    try {
      // Gather context snapshot (dynamic imports to avoid circular deps)
      const [
        { getDailyPhase },
        { calculateFatigue },
        { getELUAverage },
        { getTimeSinceLastInteraction },
        { getStateDuration },
      ] = await Promise.all([
        import('./daily-rhythm.js'),
        import('./fatigue-score.js'),
        import('./elu-monitor.js'),
        import('./awareness.js'),
        import('./state-machine.js'),
      ]);

      const phase = getDailyPhase();
      const fatigue = calculateFatigue();
      const elu = getELUAverage();
      const idle = getTimeSinceLastInteraction();
      const duration = getStateDuration();

      await recordTransition(data.from, data.to, data.reason, duration, {
        dailyPhase: phase.phase,
        fatigueScore: fatigue.score,
        elu,
        idleMs: idle === Infinity ? undefined : idle,
      });
    } catch (err) {
      await logger.error('TransitionLog', 'failed to record transition', err);
    }
  });

  attached = true;
  await logger.info('TransitionLog', 'listener attached to lifecycle:state');
}

// ── Exports for testing ───────────────────────────────────────────────

export const __testing = {
  getGenesisHash: () => GENESIS_HASH,
  getNextIndex: () => nextIndex,
  getLastHash: () => lastHash,
  reset: () => {
    nextIndex = 0;
    lastHash = GENESIS_HASH;
    attached = false;
    import('./vector-clock.js').then(vc => vc.__testing.reset()).catch(() => {});
  },
};
