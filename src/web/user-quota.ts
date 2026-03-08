/**
 * User Quota & Tier System — per-user usage tracking and rate limiting.
 *
 * Tiers:
 *   - free:    3 research requests/day, basic agents only
 *   - premium: unlimited research, all agents, priority queue
 *
 * Usage is tracked in SQLite. Premium status is managed via
 * Telegram Stars payments or manual admin override.
 *
 * Schema is auto-migrated on first access.
 */

import { getDb } from '../core/database.js';
import { logger } from '../core/logger.js';
import { getTodayString } from '../core/timezone.js';

// ── Types ────────────────────────────────────────────────────────────

export type UserTier = 'free' | 'premium';

export interface UserQuota {
  userId: number;
  tier: UserTier;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  totalLifetime: number;
  premiumUntil: string | null;
}

export interface UsageRecord {
  userId: number;
  agentName: string;
  costUsd: number;
  timestamp: string;
}

// ── Constants ────────────────────────────────────────────────────────

const FREE_DAILY_LIMIT = 3;
const PREMIUM_DAILY_LIMIT = 50; // Soft ceiling for abuse prevention

// ── Schema Migration ─────────────────────────────────────────────────

let migrated = false;

function ensureSchema(): void {
  if (migrated) return;
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_quota (
      user_id        INTEGER PRIMARY KEY,
      tier           TEXT    NOT NULL DEFAULT 'free',
      premium_until  TEXT,
      total_usage    INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      agent_name  TEXT    NOT NULL,
      cost_usd    REAL    NOT NULL DEFAULT 0,
      date        TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_log(user_id, date);
  `);

  migrated = true;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Get the current quota status for a user.
 */
export function getUserQuota(userId: number): UserQuota {
  ensureSchema();
  const db = getDb();
  const today = getTodayString();

  // Ensure user exists
  db.prepare(
    `INSERT OR IGNORE INTO user_quota (user_id) VALUES (?)`
  ).run(userId);

  const row = db.prepare(
    `SELECT tier, premium_until, total_usage FROM user_quota WHERE user_id = ?`
  ).get(userId) as { tier: string; premium_until: string | null; total_usage: number };

  // Check if premium has expired
  let tier: UserTier = row.tier as UserTier;
  if (tier === 'premium' && row.premium_until) {
    if (new Date(row.premium_until) < new Date()) {
      // Premium expired → downgrade
      db.prepare(`UPDATE user_quota SET tier = 'free' WHERE user_id = ?`).run(userId);
      tier = 'free';
    }
  }

  const dailyLimit = tier === 'premium' ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;

  // Count today's usage
  const usageRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM usage_log WHERE user_id = ? AND date = ?`
  ).get(userId, today) as { cnt: number };
  const usedToday = usageRow.cnt;

  return {
    userId,
    tier,
    dailyLimit,
    usedToday,
    remaining: Math.max(0, dailyLimit - usedToday),
    totalLifetime: row.total_usage,
    premiumUntil: row.premium_until,
  };
}

/**
 * Check if a user can make a research request.
 * Returns { allowed, reason } — check before dispatching.
 */
export function checkQuota(userId: number): { allowed: boolean; reason?: string } {
  const quota = getUserQuota(userId);

  if (quota.remaining <= 0) {
    return {
      allowed: false,
      reason: quota.tier === 'free'
        ? `Free tier limit reached (${quota.dailyLimit}/day). Upgrade to premium for unlimited access.`
        : `Daily limit reached (${quota.dailyLimit}/day).`,
    };
  }

  return { allowed: true };
}

/**
 * Record a research usage event.
 * Call after successfully dispatching a research task.
 */
export function recordUsage(userId: number, agentName: string, costUsd: number = 0): void {
  ensureSchema();
  const db = getDb();
  const today = getTodayString();

  db.prepare(
    `INSERT INTO usage_log (user_id, agent_name, cost_usd, date) VALUES (?, ?, ?, ?)`
  ).run(userId, agentName, costUsd, today);

  db.prepare(
    `UPDATE user_quota SET total_usage = total_usage + 1 WHERE user_id = ?`
  ).run(userId);
}

/**
 * Upgrade a user to premium tier.
 * @param durationDays — how many days of premium access
 */
export function upgradeToPremium(userId: number, durationDays: number): void {
  ensureSchema();
  const db = getDb();

  const until = new Date(Date.now() + durationDays * 86400_000).toISOString();

  db.prepare(
    `INSERT INTO user_quota (user_id, tier, premium_until)
     VALUES (?, 'premium', ?)
     ON CONFLICT(user_id) DO UPDATE SET tier = 'premium', premium_until = ?`
  ).run(userId, until, until);

  logger.info('UserQuota', `User ${userId} upgraded to premium until ${until}`);
}

/**
 * Downgrade a user to free tier (admin command).
 */
export function downgradeToFree(userId: number): void {
  ensureSchema();
  const db = getDb();

  db.prepare(
    `UPDATE user_quota SET tier = 'free', premium_until = NULL WHERE user_id = ?`
  ).run(userId);

  logger.info('UserQuota', `User ${userId} downgraded to free`);
}

/**
 * Get usage stats for a user (for /quota command).
 */
export function getUserUsageStats(userId: number): {
  today: number;
  last7d: number;
  totalCost: number;
} {
  ensureSchema();
  const db = getDb();
  const today = getTodayString();

  const todayRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM usage_log WHERE user_id = ? AND date = ?`
  ).get(userId, today) as { cnt: number };

  const weekRow = db.prepare(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(cost_usd), 0) as cost
     FROM usage_log WHERE user_id = ? AND date >= date(?, '-7 days')`
  ).get(userId, today) as { cnt: number; cost: number };

  return {
    today: todayRow.cnt,
    last7d: weekRow.cnt,
    totalCost: weekRow.cost,
  };
}
