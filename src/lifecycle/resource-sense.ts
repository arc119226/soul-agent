/**
 * Resource awareness — track token/API usage and determine rest needs.
 */

import { logger } from '../core/logger.js';
import { getTodayString } from '../core/timezone.js';

interface DailyUsage {
  tokens: number;
  apiCalls: number;
  cost: number;
  date: string;
}

const COST_PER_1K_TOKENS = 0.003; // rough estimate
const REST_TOKEN_THRESHOLD = 500_000;
const REST_API_CALL_THRESHOLD = 200;

let usage: DailyUsage = createEmpty();

function todayStr(): string {
  return getTodayString();
}

function createEmpty(): DailyUsage {
  return { tokens: 0, apiCalls: 0, cost: 0, date: todayStr() };
}

function ensureToday(): void {
  if (usage.date !== todayStr()) {
    logger.info('ResourceSense', `New day — resetting counters (prev: ${usage.tokens} tokens, ${usage.apiCalls} calls)`);
    usage = createEmpty();
  }
}

export function recordTokens(count: number): void {
  ensureToday();
  usage.tokens += count;
  usage.cost = (usage.tokens / 1000) * COST_PER_1K_TOKENS;
}

export function recordApiCall(tokenEstimate?: number): void {
  ensureToday();
  usage.apiCalls++;
  if (tokenEstimate) {
    usage.tokens += tokenEstimate;
    usage.cost = (usage.tokens / 1000) * COST_PER_1K_TOKENS;
  }
}

export function shouldRest(): boolean {
  ensureToday();
  return usage.tokens >= REST_TOKEN_THRESHOLD || usage.apiCalls >= REST_API_CALL_THRESHOLD;
}

export function getDailyUsage(): DailyUsage {
  ensureToday();
  return { ...usage };
}

export function resetCounters(): void {
  usage = createEmpty();
}
