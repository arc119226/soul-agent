/**
 * Vector Clock — causal ordering proof for state transitions.
 *
 * Each transition carries a vector clock snapshot that proves
 * "this moment existed in this causal position." Unlike wall-clock
 * timestamps, vector clocks are immune to clock skew and provide
 * a partial ordering based on causality, not time.
 *
 * Zero external dependencies. ~60 lines of pure logic.
 */

// ── Types ─────────────────────────────────────────────────────────────

/** Maps process IDs to monotonically increasing counters. */
export type VectorClockSnapshot = Record<string, number>;

/** Causal relationship between two vector clocks. */
export type ClockRelation =
  | 'equal'           // identical snapshots
  | 'happened-before' // a causally precedes b
  | 'happened-after'  // a causally follows b
  | 'concurrent';     // parallel, no causal link

// ── Pure Functions ────────────────────────────────────────────────────

/** Create a new vector clock with zero counters. */
export function createClock(processIds: string[] = ['bot']): VectorClockSnapshot {
  const clock: VectorClockSnapshot = {};
  for (const id of processIds) clock[id] = 0;
  return clock;
}

/** Increment the counter for a specific process. Returns a new snapshot. */
export function increment(clock: VectorClockSnapshot, processId: string): VectorClockSnapshot {
  return { ...clock, [processId]: (clock[processId] ?? 0) + 1 };
}

/** Merge two clocks: element-wise max. Returns a new snapshot. */
export function merge(a: VectorClockSnapshot, b: VectorClockSnapshot): VectorClockSnapshot {
  const result: VectorClockSnapshot = { ...a };
  for (const [key, val] of Object.entries(b)) {
    result[key] = Math.max(result[key] ?? 0, val);
  }
  return result;
}

/** Compare two vector clocks to determine causal relationship. */
export function compare(a: VectorClockSnapshot, b: VectorClockSnapshot): ClockRelation {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aLessOrEqual = true;
  let bLessOrEqual = true;

  for (const key of allKeys) {
    const va = a[key] ?? 0;
    const vb = b[key] ?? 0;
    if (va > vb) aLessOrEqual = false; // a has a component > b, so a is NOT <= b
    if (vb > va) bLessOrEqual = false; // b has a component > a, so b is NOT <= a
  }

  if (aLessOrEqual && bLessOrEqual) return 'equal';
  if (aLessOrEqual) return 'happened-before';
  if (bLessOrEqual) return 'happened-after';
  return 'concurrent';
}

/** Check if b is a valid monotonic successor of a (all components >= a). */
export function isMonotonicSuccessor(a: VectorClockSnapshot, b: VectorClockSnapshot): boolean {
  for (const [key, val] of Object.entries(a)) {
    if ((b[key] ?? 0) < val) return false;
  }
  return true;
}

// ── Module State ──────────────────────────────────────────────────────

const PROCESS_ID = 'bot';
let currentClock: VectorClockSnapshot = createClock([PROCESS_ID]);

/** Get a read-only copy of the current vector clock. */
export function getClock(): VectorClockSnapshot {
  return { ...currentClock };
}

/** Tick the clock for the bot process and return the new snapshot. */
export function tick(): VectorClockSnapshot {
  currentClock = increment(currentClock, PROCESS_ID);
  return { ...currentClock };
}

/** Merge an external clock into ours (e.g. from CLI session). */
export function mergeExternal(externalClock: VectorClockSnapshot): VectorClockSnapshot {
  currentClock = increment(merge(currentClock, externalClock), PROCESS_ID);
  return { ...currentClock };
}

/** Restore clock from a persisted snapshot (called during init). */
export function initFromSnapshot(snapshot: VectorClockSnapshot): void {
  currentClock = { ...snapshot };
}

// ── Testing ───────────────────────────────────────────────────────────

export const __testing = {
  reset: () => { currentClock = createClock([PROCESS_ID]); },
  getCurrent: () => currentClock,
};
