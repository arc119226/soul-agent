import { getDb } from '../core/database.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { getCurrentHour } from '../lifecycle/awareness.js';
import type { UserRow } from '../core/db-types.js';

export interface UserProfile {
  id: number;
  name: string;
  username: string;
  firstSeen: string;
  lastSeen: string;
  messageCount: number;
  facts: string[];
  preferences: Record<string, string>;
  activityHours?: number[];
}

let activityRestored = false;

function rowToProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    messageCount: row.message_count,
    facts: JSON.parse(row.facts) as string[],
    preferences: JSON.parse(row.preferences) as Record<string, string>,
    activityHours: JSON.parse(row.activity_hours) as number[],
  };
}

async function restoreActivityHours(): Promise<void> {
  if (activityRestored) return;
  activityRestored = true;
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, activity_hours FROM users').all() as Pick<UserRow, 'id' | 'activity_hours'>[];
    const { loadActivityHours } = await import('../lifecycle/awareness.js');
    for (const row of rows) {
      const hours = JSON.parse(row.activity_hours) as number[];
      if (hours.length) {
        loadActivityHours(row.id, hours);
      }
    }
  } catch {
    // Non-fatal: awareness may not be initialized
  }
}

export async function getUser(userId: number): Promise<UserProfile | undefined> {
  await restoreActivityHours();
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  return row ? rowToProfile(row) : undefined;
}

export async function getAllUsers(): Promise<Record<string, UserProfile>> {
  await restoreActivityHours();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users').all() as UserRow[];
  const result: Record<string, UserProfile> = {};
  for (const row of rows) {
    result[String(row.id)] = rowToProfile(row);
  }
  return result;
}

export async function updateUser(
  userId: number,
  info: { name?: string; username?: string },
): Promise<UserProfile> {
  await restoreActivityHours();
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;

  if (!existing) {
    const activityHours = [getCurrentHour()];
    db.prepare(
      `INSERT INTO users (id, name, username, first_seen, last_seen, message_count, facts, preferences, activity_hours)
       VALUES (?, ?, ?, ?, ?, 1, '[]', '{}', ?)`,
    ).run(userId, info.name ?? '', info.username ?? '', now, now, JSON.stringify(activityHours));
    await logger.info('UserStore', `New user registered: ${userId}`);
    return {
      id: userId,
      name: info.name ?? '',
      username: info.username ?? '',
      firstSeen: now,
      lastSeen: now,
      messageCount: 1,
      facts: [],
      preferences: {},
      activityHours,
    };
  }

  // Update activity hours
  const hours = JSON.parse(existing.activity_hours) as number[];
  hours.push(getCurrentHour());
  if (hours.length > 200) {
    hours.splice(0, hours.length - 200);
  }

  db.prepare(
    `UPDATE users SET last_seen = ?, message_count = message_count + 1,
     name = COALESCE(?, name), username = COALESCE(?, username),
     activity_hours = ? WHERE id = ?`,
  ).run(now, info.name ?? null, info.username ?? null, JSON.stringify(hours), userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
  return rowToProfile(updated);
}

export async function addFact(userId: number, fact: string): Promise<boolean> {
  const db = getDb();
  const row = db.prepare('SELECT facts FROM users WHERE id = ?').get(userId) as Pick<UserRow, 'facts'> | undefined;
  if (!row) return false;

  const facts = JSON.parse(row.facts) as string[];
  const normalized = fact.trim();
  if (facts.some((f) => f.toLowerCase() === normalized.toLowerCase())) {
    return false;
  }

  const limit = config.USER_FACT_LIMIT;
  if (limit > 0 && facts.length >= limit) {
    facts.shift();
  }

  facts.push(normalized);
  db.prepare('UPDATE users SET facts = ? WHERE id = ?').run(JSON.stringify(facts), userId);
  return true;
}

export async function removeFact(userId: number, factSubstring: string): Promise<boolean> {
  const db = getDb();
  const row = db.prepare('SELECT facts FROM users WHERE id = ?').get(userId) as Pick<UserRow, 'facts'> | undefined;
  if (!row) return false;

  const facts = JSON.parse(row.facts) as string[];
  const lower = factSubstring.toLowerCase();
  const idx = facts.findIndex((f) => f.toLowerCase().includes(lower));
  if (idx === -1) return false;

  facts.splice(idx, 1);
  db.prepare('UPDATE users SET facts = ? WHERE id = ?').run(JSON.stringify(facts), userId);
  return true;
}

export async function getFacts(userId: number): Promise<string[]> {
  const user = await getUser(userId);
  return user?.facts ?? [];
}

export async function setPreference(
  userId: number,
  key: string,
  value: string,
): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT preferences FROM users WHERE id = ?').get(userId) as Pick<UserRow, 'preferences'> | undefined;
  if (!row) return;
  const prefs = JSON.parse(row.preferences) as Record<string, string>;
  prefs[key] = value;
  db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(prefs), userId);
}

export function resetCache(): void {
  // No longer needed — SQLite is the source of truth.
  // Kept for API compatibility.
}
