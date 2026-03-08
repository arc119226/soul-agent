/**
 * Timezone utilities — centralized date/time helpers using configured timezone.
 *
 * All "what day is today?" logic MUST go through these helpers to avoid
 * the UTC vs Asia/Taipei date mismatch bug (UTC+0 and UTC+8 differ
 * between 00:00–08:00 local time).
 *
 * Pure timestamp recording (new Date().toISOString()) should remain UTC —
 * that's the standard for storage. These helpers are for date *comparison*
 * and *display* only.
 */

import { config } from '../config.js';

/**
 * Get today's date string (YYYY-MM-DD) in configured timezone.
 *
 * Use this instead of `new Date().toISOString().slice(0, 10)` whenever
 * you need to know "what day is it right now in the bot's timezone".
 */
export function getTodayString(now: Date = new Date()): string {
  const local = new Date(now.toLocaleString('en-US', { timeZone: config.TIMEZONE }));
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const d = String(local.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Convert a UTC timestamp string to a YYYY-MM-DD in configured timezone.
 *
 * Useful for comparing stored timestamps against "today".
 */
export function toLocalDateString(isoTimestamp: string): string {
  return getTodayString(new Date(isoTimestamp));
}

/**
 * Get date/time parts in configured timezone.
 *
 * Use this instead of raw `getMonth()`, `getDate()`, `getDay()` etc.
 * which return UTC values.
 */
export function getLocalDateParts(now: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  const local = new Date(now.toLocaleString('en-US', { timeZone: config.TIMEZONE }));
  return {
    year: local.getFullYear(),
    month: local.getMonth() + 1,
    day: local.getDate(),
    hour: local.getHours(),
    minute: local.getMinutes(),
    dayOfWeek: local.getDay(),
  };
}
