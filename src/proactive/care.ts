/**
 * Owner care — track important dates and deliver care messages.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writer } from '../core/debounced-writer.js';
import { logger } from '../core/logger.js';
import { canDeliver, recordDelivery } from './constraints.js';
import { getTodayString, getLocalDateParts } from '../core/timezone.js';

const CARE_PATH = join(process.cwd(), 'data', 'care-dates.json');

export interface ImportantDate {
  userId: number;
  label: string;
  date: string;       // MM-DD format for recurring, or YYYY-MM-DD for one-time
  recurring: boolean;
  type: 'birthday' | 'deadline' | 'anniversary' | 'custom';
}

interface CareFile {
  version: number;
  dates: ImportantDate[];
}

let careData: CareFile | null = null;

async function load(): Promise<CareFile> {
  if (careData) return careData;
  try {
    const raw = await readFile(CARE_PATH, 'utf-8');
    careData = JSON.parse(raw) as CareFile;
  } catch {
    careData = { version: 1, dates: [] };
  }
  return careData;
}

function persist(): void {
  if (!careData) return;
  writer.schedule(CARE_PATH, careData);
}

export async function trackImportantDates(
  userId: number,
  dates: Omit<ImportantDate, 'userId'>[],
): Promise<void> {
  const data = await load();

  for (const d of dates) {
    // Avoid duplicates
    const exists = data.dates.some(
      (existing) =>
        existing.userId === userId &&
        existing.label === d.label &&
        existing.date === d.date,
    );
    if (!exists) {
      data.dates.push({ ...d, userId });
    }
  }

  persist();
  await logger.info('Care', `Tracked ${dates.length} important dates for user ${userId}`);
}

export async function removeDate(userId: number, label: string): Promise<boolean> {
  const data = await load();
  const idx = data.dates.findIndex(
    (d) => d.userId === userId && d.label === label,
  );
  if (idx === -1) return false;
  data.dates.splice(idx, 1);
  persist();
  return true;
}

export async function checkUpcomingReminders(): Promise<
  { userId: number; message: string }[]
> {
  const data = await load();
  const todayParts = getLocalDateParts();
  const todayMMDD = `${String(todayParts.month).padStart(2, '0')}-${String(todayParts.day).padStart(2, '0')}`;
  const todayISO = getTodayString();

  // Also check tomorrow (advance by 1 day in local time)
  const tomorrowDate = new Date(Date.now() + 86400_000);
  const tomorrowParts = getLocalDateParts(tomorrowDate);
  const tomorrowMMDD = `${String(tomorrowParts.month).padStart(2, '0')}-${String(tomorrowParts.day).padStart(2, '0')}`;
  const tomorrowISO = getTodayString(tomorrowDate);

  const reminders: { userId: number; message: string }[] = [];

  for (const entry of data.dates) {
    if (!canDeliver('care', entry.userId)) continue;

    const matchDate = entry.recurring ? entry.date : entry.date;

    // Today match
    if (
      (entry.recurring && matchDate === todayMMDD) ||
      (!entry.recurring && matchDate === todayISO)
    ) {
      const message = generateCareMessage(entry, 'today');
      if (message) {
        reminders.push({ userId: entry.userId, message });
        recordDelivery('care', entry.userId);
      }
    }

    // Tomorrow match (early reminder for deadlines)
    if (entry.type === 'deadline') {
      if (
        (entry.recurring && matchDate === tomorrowMMDD) ||
        (!entry.recurring && matchDate === tomorrowISO)
      ) {
        const message = generateCareMessage(entry, 'tomorrow');
        if (message) {
          reminders.push({ userId: entry.userId, message });
          recordDelivery('reminder', entry.userId);
        }
      }
    }
  }

  return reminders;
}

function generateCareMessage(entry: ImportantDate, when: 'today' | 'tomorrow'): string | null {
  const prefix = when === 'today' ? '今天' : '明天';

  switch (entry.type) {
    case 'birthday':
      return when === 'today'
        ? `生日快樂！今天是${entry.label}的特別日子，祝一切美好。`
        : null; // Don't remind birthday in advance
    case 'deadline':
      return `提醒：${prefix}是「${entry.label}」的截止日。加油！`;
    case 'anniversary':
      return when === 'today'
        ? `今天是${entry.label}的紀念日，特別的日子值得被記住。`
        : null;
    case 'custom':
      return `${prefix}有個重要的事：${entry.label}`;
    default:
      return null;
  }
}

export async function getDates(userId: number): Promise<ImportantDate[]> {
  const data = await load();
  return data.dates.filter((d) => d.userId === userId);
}
