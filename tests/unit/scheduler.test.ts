import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  config: { TIMEZONE: 'Asia/Taipei' },
}));

vi.mock('../../src/core/timezone.js', () => ({
  getTodayString: vi.fn(() => '2026-01-01'),
  toLocalDateString: vi.fn((s: string) => s.slice(0, 10)),
  getLocalDateParts: vi.fn(() => ({ year: 2026, month: 1, day: 1, hour: 12, minute: 0, dayOfWeek: 3 })),
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn() },
}));

vi.mock('../../src/lifecycle/awareness.js', () => ({
  getCurrentHour: vi.fn(() => 14),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Scheduler', () => {
  let schedule: typeof import('../../src/proactive/scheduler.js')['schedule'];
  let cancel: typeof import('../../src/proactive/scheduler.js')['cancel'];
  let getSchedules: typeof import('../../src/proactive/scheduler.js')['getSchedules'];
  let stopAll: typeof import('../../src/proactive/scheduler.js')['stopAll'];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    vi.doMock('node:fs/promises', () => ({ readFile: vi.fn().mockRejectedValue(new Error('ENOENT')) }));
    vi.doMock('../../src/config.js', () => ({
      config: { TIMEZONE: 'Asia/Taipei' },
    }));
    vi.doMock('../../src/core/timezone.js', () => ({
      getTodayString: vi.fn(() => '2026-01-01'),
      toLocalDateString: vi.fn((s: string) => s.slice(0, 10)),
      getLocalDateParts: vi.fn(() => ({ year: 2026, month: 1, day: 1, hour: 12, minute: 0, dayOfWeek: 3 })),
    }));
    vi.doMock('../../src/core/debounced-writer.js', () => ({ writer: { schedule: vi.fn() } }));
    vi.doMock('../../src/lifecycle/awareness.js', () => ({ getCurrentHour: vi.fn(() => 14) }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const mod = await import('../../src/proactive/scheduler.js');
    schedule = mod.schedule;
    cancel = mod.cancel;
    getSchedules = mod.getSchedules;
    stopAll = mod.stopAll;
  });

  afterEach(() => {
    stopAll();
    vi.useRealTimers();
  });

  describe('parseCronExpr() — tested via schedule() behavior', () => {
    it('accepts "daily@08:00" format', () => {
      const handler = vi.fn();
      schedule('daily-task', 'daily@08:00', handler);
      const all = getSchedules();
      expect(all).toHaveLength(1);
      expect(all[0]!.cronExpr).toBe('daily@08:00');
    });

    it('accepts "every:30m" format', () => {
      const handler = vi.fn();
      schedule('interval-m', 'every:30m', handler);
      const all = getSchedules();
      expect(all).toHaveLength(1);
      expect(all[0]!.cronExpr).toBe('every:30m');
    });

    it('accepts "every:2h" format', () => {
      const handler = vi.fn();
      schedule('interval-h', 'every:2h', handler);
      const all = getSchedules();
      expect(all).toHaveLength(1);
      expect(all[0]!.cronExpr).toBe('every:2h');
    });

    it('rejects invalid expressions (schedule not added)', () => {
      const handler = vi.fn();
      schedule('invalid', 'cron:* * * * *', handler);
      const all = getSchedules();
      expect(all).toHaveLength(0);
    });
  });

  describe('schedule()', () => {
    it('registers a schedule and sets timer', () => {
      const handler = vi.fn();
      schedule('test-schedule', 'every:1h', handler);

      const all = getSchedules();
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe('test-schedule');
    });

    it('replaces existing schedule with same id', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      schedule('dup', 'every:1h', handler1);
      schedule('dup', 'every:2h', handler2);

      const all = getSchedules();
      expect(all).toHaveLength(1);
      expect(all[0]!.cronExpr).toBe('every:2h');
    });

    it('fires interval handler at correct time', async () => {
      const handler = vi.fn();
      schedule('min-task', 'every:30m', handler);

      // Advance by 30 minutes
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(handler).toHaveBeenCalledTimes(1);

      // Advance another 30 minutes
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('fires hourly interval handler correctly', async () => {
      const handler = vi.fn();
      schedule('hour-task', 'every:2h', handler);

      // Advance by 2 hours
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel()', () => {
    it('removes schedule and clears timer', () => {
      const handler = vi.fn();
      schedule('to-cancel', 'every:1h', handler);
      expect(getSchedules()).toHaveLength(1);

      cancel('to-cancel');
      expect(getSchedules()).toHaveLength(0);
    });

    it('no-ops when id does not exist', () => {
      expect(() => cancel('nonexistent')).not.toThrow();
    });
  });

  describe('getSchedules()', () => {
    it('lists all schedules with id, cronExpr, lastRun', () => {
      schedule('a', 'every:1h', vi.fn());
      schedule('b', 'daily@09:00', vi.fn());

      const all = getSchedules();
      expect(all).toHaveLength(2);
      expect(all[0]).toHaveProperty('id');
      expect(all[0]).toHaveProperty('cronExpr');
      expect(all[0]).toHaveProperty('lastRun');
    });
  });

  describe('stopAll()', () => {
    it('stops all schedules and clears the list', () => {
      schedule('x', 'every:1h', vi.fn());
      schedule('y', 'every:2h', vi.fn());

      stopAll();
      expect(getSchedules()).toHaveLength(0);
    });

    it('prevents handlers from firing after stop', async () => {
      const handler = vi.fn();
      schedule('stopped', 'every:30m', handler);
      stopAll();

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
