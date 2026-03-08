/**
 * Context awareness — time-of-day detection, quiet hours, owner state estimation.
 */

import { config } from '../config.js';

/* ── constants ────────────────────────────────── */
const MAX_ACTIVITY_RECORDS = 200;
const MIN_DATA_POINTS = 10;
const ACTIVE_HOUR_PERCENTAGE = 0.05;
const EARLIEST_SCAN_START = 5;
const EARLIEST_SCAN_END = 12;
const BUSY_THRESHOLD_MS = 5 * 60 * 1000;    // 5 min
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;   // 30 min

export type TimeOfDay = 'morning' | 'day' | 'evening' | 'night' | 'deep_night';

/** Last interaction timestamp per user (userId → epoch ms) */
const lastInteraction = new Map<number, number>();

/** Activity hour records per user (userId → hours[]) */
const activityHours = new Map<number, number[]>();

/** 記錄用戶活動小時 */
export function recordActivityHour(userId: number): void {
  const hour = getCurrentHour();
  if (!activityHours.has(userId)) {
    activityHours.set(userId, []);
  }
  const hours = activityHours.get(userId)!;
  hours.push(hour);
  // 限制筆數，避免無限增長
  if (hours.length > MAX_ACTIVITY_RECORDS) {
    hours.splice(0, hours.length - MAX_ACTIVITY_RECORDS);
  }
}

/** 取得活動時段分布 */
export function getActivityDistribution(userId: number): Map<number, number> {
  const hours = activityHours.get(userId) ?? [];
  const dist = new Map<number, number>();
  for (const h of hours) {
    dist.set(h, (dist.get(h) ?? 0) + 1);
  }
  return dist;
}

/** 找到用戶最早活躍時段（需 >= 10 筆資料），用於問候排程 */
export function getEarliestActiveHour(userId: number): number | null {
  const hours = activityHours.get(userId) ?? [];
  if (hours.length < MIN_DATA_POINTS) return null;

  const dist = getActivityDistribution(userId);
  const total = hours.length;

  // 掃描早晨時段，找出有 >= ACTIVE_HOUR_PERCENTAGE 記錄的最早小時
  for (let h = EARLIEST_SCAN_START; h <= EARLIEST_SCAN_END; h++) {
    const count = dist.get(h) ?? 0;
    if (count / total >= ACTIVE_HOUR_PERCENTAGE) return h;
  }
  return null;
}

/** 載入歷史活動小時資料（從 user-store 恢復） */
export function loadActivityHours(userId: number, hours: number[]): void {
  activityHours.set(userId, hours.slice(-MAX_ACTIVITY_RECORDS));
}

/** Record a user interaction */
export function recordInteraction(userId: number): void {
  lastInteraction.set(userId, Date.now());
}

/** Get current hour in configured timezone */
export function getCurrentHour(): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.TIMEZONE,
    hour: 'numeric',
    hour12: false,
  });
  // Intl hour12:false returns 24 at midnight instead of 0 — normalize
  return Number(formatter.format(now)) % 24;
}

export function getTimeOfDay(): TimeOfDay {
  const hour = getCurrentHour();
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'day';
  if (hour >= 18 && hour < 22) return 'evening';
  if (hour >= 22 || hour < 1) return 'night';
  return 'deep_night'; // 1-6
}

export function isQuietHours(): boolean {
  const hour = getCurrentHour();
  const start = config.QUIET_HOURS_START;
  const end = config.QUIET_HOURS_END;

  if (start < end) {
    return hour >= start && hour < end;
  }
  // Wraps midnight (e.g. 23-7)
  return hour >= start || hour < end;
}

export type OwnerState = 'busy' | 'idle' | 'sleeping' | 'unknown';

export function estimateOwnerState(userId?: number): OwnerState {
  const timeOfDay = getTimeOfDay();

  if (timeOfDay === 'deep_night') return 'sleeping';
  if (timeOfDay === 'night') {
    // If we've seen them recently, they're still up
    const lastMs = getTimeSinceLastInteraction(userId);
    if (lastMs < IDLE_THRESHOLD_MS) return 'idle';
    return 'sleeping';
  }

  if (!userId) return 'unknown';

  const lastMs = getTimeSinceLastInteraction(userId);
  if (lastMs === Infinity) return 'unknown';
  if (lastMs < BUSY_THRESHOLD_MS) return 'busy';   // active in last 5min
  if (lastMs < IDLE_THRESHOLD_MS) return 'idle';   // seen within 30min
  return 'unknown';
}

export function getTimeSinceLastInteraction(userId?: number): number {
  if (userId) {
    const ts = lastInteraction.get(userId);
    if (ts) return Date.now() - ts;
  }
  // Check any user
  let latest = 0;
  for (const ts of lastInteraction.values()) {
    if (ts > latest) latest = ts;
  }
  return latest > 0 ? Date.now() - latest : Infinity;
}

export function getLastInteractionTime(userId?: number): number | null {
  if (userId) return lastInteraction.get(userId) ?? null;
  let latest = 0;
  for (const ts of lastInteraction.values()) {
    if (ts > latest) latest = ts;
  }
  return latest > 0 ? latest : null;
}
