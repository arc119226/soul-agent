import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { TIMEZONE: 'Asia/Taipei' },
}));

vi.mock('../../src/core/timezone.js', () => {
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    getTodayString: vi.fn((now?: Date) => fmt(now ?? new Date())),
    toLocalDateString: vi.fn((iso: string) => fmt(new Date(iso))),
    getLocalDateParts: vi.fn((now?: Date) => {
      const d = now ?? new Date();
      return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), dayOfWeek: d.getDay() };
    }),
  };
});

// Mock logger before importing the module
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('ResourceSense', () => {
  let recordTokens: typeof import('../../src/lifecycle/resource-sense.js')['recordTokens'];
  let recordApiCall: typeof import('../../src/lifecycle/resource-sense.js')['recordApiCall'];
  let shouldRest: typeof import('../../src/lifecycle/resource-sense.js')['shouldRest'];
  let getDailyUsage: typeof import('../../src/lifecycle/resource-sense.js')['getDailyUsage'];
  let resetCounters: typeof import('../../src/lifecycle/resource-sense.js')['resetCounters'];

  beforeEach(async () => {
    vi.resetModules();
    // Re-mock after resetModules
    vi.doMock('../../src/config.js', () => ({
      config: { TIMEZONE: 'Asia/Taipei' },
    }));
    vi.doMock('../../src/core/timezone.js', () => {
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return {
        getTodayString: vi.fn((now?: Date) => fmt(now ?? new Date())),
        toLocalDateString: vi.fn((iso: string) => fmt(new Date(iso))),
        getLocalDateParts: vi.fn((now?: Date) => {
          const d = now ?? new Date();
          return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), dayOfWeek: d.getDay() };
        }),
      };
    });
    vi.doMock('../../src/core/logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));
    const mod = await import('../../src/lifecycle/resource-sense.js');
    recordTokens = mod.recordTokens;
    recordApiCall = mod.recordApiCall;
    shouldRest = mod.shouldRest;
    getDailyUsage = mod.getDailyUsage;
    resetCounters = mod.resetCounters;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recordTokens()', () => {
    it('accumulates token count', () => {
      recordTokens(1000);
      recordTokens(2000);
      const usage = getDailyUsage();
      expect(usage.tokens).toBe(3000);
    });

    it('computes cost based on tokens', () => {
      recordTokens(10000);
      const usage = getDailyUsage();
      // COST_PER_1K_TOKENS = 0.003
      expect(usage.cost).toBeCloseTo(0.03, 5);
    });
  });

  describe('recordApiCall()', () => {
    it('increments API call count', () => {
      recordApiCall();
      recordApiCall();
      const usage = getDailyUsage();
      expect(usage.apiCalls).toBe(2);
    });

    it('adds optional token estimate', () => {
      recordApiCall(5000);
      const usage = getDailyUsage();
      expect(usage.tokens).toBe(5000);
      expect(usage.apiCalls).toBe(1);
    });
  });

  describe('shouldRest()', () => {
    it('returns false initially', () => {
      expect(shouldRest()).toBe(false);
    });

    it('returns true when tokens >= 500000', () => {
      recordTokens(500000);
      expect(shouldRest()).toBe(true);
    });

    it('returns true when apiCalls >= 200', () => {
      for (let i = 0; i < 200; i++) recordApiCall();
      expect(shouldRest()).toBe(true);
    });
  });

  describe('getDailyUsage()', () => {
    it('returns a copy (mutations do not affect internal state)', () => {
      recordTokens(100);
      const usage = getDailyUsage();
      usage.tokens = 999999;
      expect(getDailyUsage().tokens).toBe(100);
    });

    it('includes today date string', () => {
      const usage = getDailyUsage();
      expect(usage.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('resetCounters()', () => {
    it('sets all counters to zero', () => {
      recordTokens(10000);
      recordApiCall();
      resetCounters();
      const usage = getDailyUsage();
      expect(usage.tokens).toBe(0);
      expect(usage.apiCalls).toBe(0);
      expect(usage.cost).toBe(0);
    });
  });

  describe('date rollover', () => {
    it('resets counters when date changes', () => {
      recordTokens(1000);

      // Simulate date change — move clock to next day
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      vi.setSystemTime(tomorrow);

      // Next call should detect new day and reset
      const usage = getDailyUsage();
      expect(usage.tokens).toBe(0);
      expect(usage.apiCalls).toBe(0);

      vi.useRealTimers();
    });
  });
});
