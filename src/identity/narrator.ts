import { readFile, writeFile, mkdir, appendFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writer } from '../core/debounced-writer.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';
import { computeRelevance } from '../memory/text-relevance.js';
import { getDb } from '../core/database.js';
import type { NarrativeRow } from '../core/db-types.js';
import type Database from 'better-sqlite3';

const NARRATIVE_PATH = join(process.cwd(), 'soul', 'narrative.jsonl');

export type NarrativeType =
  | 'interaction'
  | 'evolution'
  | 'reflection'
  | 'milestone'
  | 'identity_change'
  | 'boot'
  | 'shutdown';

export interface NarrativeEntry {
  timestamp: string;
  type: NarrativeType;
  summary: string;
  emotion?: string;
  significance: number; // 1-5
  related_to?: string;
  /** Structured payload for machine-readable reconstruction (type-dependent).
   *  For identity_change: { oldValue: number, newValue: number, reason: string } */
  data?: Record<string, unknown>;
}

export interface AppendOptions {
  emotion?: string;
  significance?: number;
  related_to?: string;
  /** Structured machine-readable data for this event */
  data?: Record<string, unknown>;
}

// ── Lazy-init prepared statements ────────────────────────────────────

let _insertStmt: Database.Statement | null = null;
let _recentStmt: Database.Statement | null = null;
let _byTypeStmt: Database.Statement | null = null;
let _significantStmt: Database.Statement | null = null;
let _searchStmt: Database.Statement | null = null;
let _identityChangeStmt: Database.Statement | null = null;

function getInsertStmt(): Database.Statement {
  if (!_insertStmt) {
    _insertStmt = getDb().prepare(
      `INSERT INTO narrative (timestamp, type, summary, emotion, significance, related_to, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }
  return _insertStmt;
}

function getRecentStmt(): Database.Statement {
  if (!_recentStmt) {
    _recentStmt = getDb().prepare(
      `SELECT * FROM narrative ORDER BY id DESC LIMIT ?`,
    );
  }
  return _recentStmt;
}

function getByTypeStmt(): Database.Statement {
  if (!_byTypeStmt) {
    _byTypeStmt = getDb().prepare(
      `SELECT * FROM narrative WHERE type = ? ORDER BY id DESC LIMIT ?`,
    );
  }
  return _byTypeStmt;
}

function getSignificantStmt(): Database.Statement {
  if (!_significantStmt) {
    _significantStmt = getDb().prepare(
      `SELECT * FROM narrative WHERE significance >= ? ORDER BY id DESC LIMIT ?`,
    );
  }
  return _significantStmt;
}

function getSearchStmt(): Database.Statement {
  if (!_searchStmt) {
    _searchStmt = getDb().prepare(
      `SELECT * FROM narrative WHERE summary LIKE ? ORDER BY id DESC LIMIT ?`,
    );
  }
  return _searchStmt;
}

function getIdentityChangeStmt(): Database.Statement {
  if (!_identityChangeStmt) {
    _identityChangeStmt = getDb().prepare(
      `SELECT * FROM narrative WHERE type = 'identity_change' ORDER BY id ASC`,
    );
  }
  return _identityChangeStmt;
}

// ── Row ↔ Entry conversion ───────────────────────────────────────────

function rowToEntry(row: NarrativeRow): NarrativeEntry {
  const entry: NarrativeEntry = {
    timestamp: row.timestamp,
    type: row.type as NarrativeType,
    summary: row.summary,
    significance: row.significance,
  };
  if (row.emotion) entry.emotion = row.emotion;
  if (row.related_to) entry.related_to = row.related_to;
  if (row.data) {
    try { entry.data = JSON.parse(row.data) as Record<string, unknown>; }
    catch { /* malformed JSON — skip data field */ }
  }
  return entry;
}

// ── Public API (dual-write: SQLite + JSONL) ──────────────────────────

export async function appendNarrative(
  type: NarrativeType,
  summary: string,
  opts?: AppendOptions,
): Promise<NarrativeEntry> {
  const entry: NarrativeEntry = {
    timestamp: new Date().toISOString(),
    type,
    summary,
    significance: opts?.significance ?? 3,
  };

  if (opts?.emotion) entry.emotion = opts.emotion;
  if (opts?.related_to) entry.related_to = opts.related_to;
  if (opts?.data) entry.data = opts.data;

  // 1. Write to SQLite
  try {
    getInsertStmt().run(
      entry.timestamp,
      entry.type,
      entry.summary,
      entry.emotion ?? null,
      entry.significance,
      entry.related_to ?? null,
      entry.data ? JSON.stringify(entry.data) : null,
    );
  } catch (err) {
    await logger.error('narrator', 'Failed to write narrative to SQLite', err);
  }

  // 2. Write to JSONL (dual-write backup — removed in Phase 5)
  await writer.appendJsonl(NARRATIVE_PATH, entry);

  await eventBus.emit('narrative:entry', { type, summary });

  return entry;
}

export async function getRecentNarrative(n: number): Promise<NarrativeEntry[]> {
  try {
    const rows = getRecentStmt().all(n) as NarrativeRow[];
    // Reverse to chronological order (query returns newest-first)
    return rows.reverse().map(rowToEntry);
  } catch {
    // Fallback to JSONL if SQLite fails
    return getRecentNarrativeFallback(n);
  }
}

export async function getNarrativeByType(
  type: NarrativeType,
  limit: number = 10,
): Promise<NarrativeEntry[]> {
  try {
    const rows = getByTypeStmt().all(type, limit) as NarrativeRow[];
    return rows.reverse().map(rowToEntry);
  } catch {
    const all = await getRecentNarrativeFallback(200);
    return all.filter((e) => e.type === type).slice(-limit);
  }
}

export async function getSignificantNarrative(
  minSignificance: number = 4,
  limit: number = 20,
): Promise<NarrativeEntry[]> {
  try {
    const rows = getSignificantStmt().all(minSignificance, limit) as NarrativeRow[];
    return rows.reverse().map(rowToEntry);
  } catch {
    const all = await getRecentNarrativeFallback(500);
    return all
      .filter((e) => e.significance >= minSignificance)
      .slice(-limit);
  }
}

/** Search narrative entries by text relevance. Returns entries sorted by score. */
export async function searchNarrative(
  query: string,
  limit: number = 10,
): Promise<Array<NarrativeEntry & { score: number }>> {
  try {
    // Use SQL LIKE for initial filtering, then score with computeRelevance
    const likePattern = `%${query}%`;
    const rows = getSearchStmt().all(likePattern, 500) as NarrativeRow[];
    const entries = rows.map(rowToEntry);

    const scored = entries
      .map((entry) => ({
        ...entry,
        score: computeRelevance(query, entry.summary),
      }))
      .filter((e) => e.score > 0.1);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } catch {
    // Fallback to JSONL
    const all = await getRecentNarrativeFallback(500);
    const scored = all
      .map((entry) => ({
        ...entry,
        score: computeRelevance(query, entry.summary),
      }))
      .filter((e) => e.score > 0.1);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

// ── Trait reconstruction from narrative ──────────────────────────────

/**
 * Reconstruct trait values by scanning identity_change events in narrative.
 *
 * Reads all identity_change events from SQLite (no TTL — permanent retention).
 * Prefers structured `data.newValue` (new format) over regex parsing (legacy).
 * Validates that values are finite and in [0, 1] range.
 *
 * Returns a map of traitName → lastRecordedValue.
 * Returns empty map if no identity_change events found.
 */
export async function reconstructTraitsFromNarrative(): Promise<Record<string, number>> {
  let entries: NarrativeEntry[];

  try {
    const rows = getIdentityChangeStmt().all() as NarrativeRow[];
    entries = rows.map(rowToEntry);
  } catch {
    // Fallback to JSONL
    return reconstructTraitsFromJsonl();
  }

  const traits: Record<string, number> = {};

  for (const entry of entries) {
    if (!entry.related_to) continue;

    let value: number | undefined;

    // Prefer structured data (new format)
    if (entry.data && typeof entry.data.newValue === 'number') {
      value = entry.data.newValue;
    } else {
      // Fallback: regex parsing (legacy format)
      const match = entry.summary.match(/到\s*([\d.]+)/);
      if (match) {
        value = parseFloat(match[1]!);
      }
    }

    // Validate: trait values must be finite and in [0, 1]
    if (value !== undefined && isFinite(value) && value >= 0 && value <= 1) {
      traits[entry.related_to] = value;
    }
  }

  return traits;
}

// ── Narrative archival / compaction ─────────────────────────────────

const ARCHIVE_DIR = join(process.cwd(), 'soul', 'narrative-archive');
const MAX_RECENT_DAYS = 7;

/**
 * Archive narrative entries older than 7 days.
 * Old entries → soul/narrative-archive/YYYY-MM.jsonl
 * Recent entries rewrite narrative.jsonl in place.
 *
 * Note: This still operates on the JSONL file for backward compat.
 * SQLite narrative data has no TTL (permanent retention).
 *
 * Returns the number of entries archived.
 */
export async function archiveOldNarrative(): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(NARRATIVE_PATH, 'utf-8');
  } catch {
    return 0;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 100) return 0; // Don't bother if small

  const cutoff = Date.now() - MAX_RECENT_DAYS * 24 * 60 * 60 * 1000;
  const recent: string[] = [];
  const toArchive = new Map<string, string[]>(); // "YYYY-MM" → lines

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as NarrativeEntry;
      const entryTime = new Date(entry.timestamp).getTime();

      if (entryTime >= cutoff) {
        recent.push(line);
      } else {
        // Group by month for archive
        const month = entry.timestamp.slice(0, 7); // "YYYY-MM"
        const bucket = toArchive.get(month) ?? [];
        bucket.push(line);
        toArchive.set(month, bucket);
      }
    } catch {
      // Keep malformed lines in recent (don't lose data)
      recent.push(line);
    }
  }

  if (toArchive.size === 0) return 0;

  // Write archive files
  await mkdir(ARCHIVE_DIR, { recursive: true });
  let totalArchived = 0;

  for (const [month, archivedLines] of toArchive) {
    const archivePath = join(ARCHIVE_DIR, `${month}.jsonl`);
    const content = archivedLines.join('\n') + '\n';
    await appendFile(archivePath, content, 'utf-8');
    totalArchived += archivedLines.length;
  }

  // Atomic rewrite: write to tmp file first, then rename (crash-safe)
  const tmpPath = join(dirname(NARRATIVE_PATH), `.tmp-narrative-${randomUUID()}`);
  await writeFile(tmpPath, recent.join('\n') + '\n', 'utf-8');
  await rename(tmpPath, NARRATIVE_PATH);

  await logger.info('narrator', `Archived ${totalArchived} narrative entries (${toArchive.size} months), kept ${recent.length} recent`);

  return totalArchived;
}

// ── JSONL fallback (used when SQLite is unavailable) ─────────────────

async function getRecentNarrativeFallback(n: number): Promise<NarrativeEntry[]> {
  let raw: string;
  try {
    raw = await readFile(NARRATIVE_PATH, 'utf-8');
  } catch {
    return [];
  }

  const lines = raw
    .split('\n')
    .filter((line) => line.trim().length > 0);

  const recent = lines.slice(-n);
  const entries: NarrativeEntry[] = [];

  for (const line of recent) {
    try {
      entries.push(JSON.parse(line) as NarrativeEntry);
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

async function reconstructTraitsFromJsonl(): Promise<Record<string, number>> {
  let raw: string;
  try {
    raw = await readFile(NARRATIVE_PATH, 'utf-8');
  } catch {
    return {};
  }

  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const traits: Record<string, number> = {};

  for (const line of lines) {
    let entry: NarrativeEntry;
    try {
      entry = JSON.parse(line) as NarrativeEntry;
    } catch {
      continue;
    }

    if (entry.type !== 'identity_change' || !entry.related_to) continue;

    let value: number | undefined;

    if (entry.data && typeof entry.data.newValue === 'number') {
      value = entry.data.newValue;
    } else {
      const match = entry.summary.match(/到\s*([\d.]+)/);
      if (match) {
        value = parseFloat(match[1]!);
      }
    }

    if (value !== undefined && isFinite(value) && value >= 0 && value <= 1) {
      traits[entry.related_to] = value;
    }
  }

  return traits;
}
