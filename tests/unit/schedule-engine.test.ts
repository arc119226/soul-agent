import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

vi.mock('../../src/config.js', () => ({
  config: { TIMEZONE: 'Asia/Taipei' },
}));

vi.mock('../../src/core/timezone.js', () => ({
  getTodayString: vi.fn(() => '2026-01-01'),
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn(), writeNow: vi.fn() },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('ScheduleEngine', () => {
  let engine: typeof import('../../src/core/schedule-engine.js');

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    }));
    vi.doMock('../../src/config.js', () => ({
      config: { TIMEZONE: 'Asia/Taipei' },
    }));
    vi.doMock('../../src/core/timezone.js', () => ({
      getTodayString: vi.fn(() => '2026-01-01'),
    }));
    vi.doMock('../../src/core/debounced-writer.js', () => ({
      writer: { schedule: vi.fn(), writeNow: vi.fn() },
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    engine = await import('../../src/core/schedule-engine.js');
    engine.scheduleEngine.clear();
  });

  describe('parseCronExpr()', () => {
    it('parses daily@HH:MM', () => {
      const result = engine.parseCronExpr('daily@08:00');
      expect(result).toEqual({ type: 'daily', hour: 8, minute: 0 });
    });

    it('parses every:Nm', () => {
      const result = engine.parseCronExpr('every:30m');
      expect(result).toEqual({ type: 'interval', ms: 30 * 60 * 1000 });
    });

    it('parses every:Nh', () => {
      const result = engine.parseCronExpr('every:2h');
      expect(result).toEqual({ type: 'interval', ms: 2 * 60 * 60 * 1000 });
    });

    it('returns null for manual', () => {
      expect(engine.parseCronExpr('manual')).toBeNull();
    });

    it('returns null for invalid expressions', () => {
      expect(engine.parseCronExpr('cron:* * * * *')).toBeNull();
    });
  });

  describe('register() / getAll() / getById()', () => {
    it('registers and retrieves entries', () => {
      engine.scheduleEngine.register({
        id: 'test:a', cronExpr: 'every:1h',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });

      expect(engine.scheduleEngine.getAll()).toHaveLength(1);
      expect(engine.scheduleEngine.getById('test:a')).not.toBeNull();
      expect(engine.scheduleEngine.getById('test:a')!.cronExpr).toBe('every:1h');
    });

    it('replaces entry with same id', () => {
      engine.scheduleEngine.register({
        id: 'dup', cronExpr: 'every:1h',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });
      engine.scheduleEngine.register({
        id: 'dup', cronExpr: 'every:2h',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });

      expect(engine.scheduleEngine.getAll()).toHaveLength(1);
      expect(engine.scheduleEngine.getById('dup')!.cronExpr).toBe('every:2h');
    });
  });

  describe('unregister()', () => {
    it('removes an entry', () => {
      engine.scheduleEngine.register({
        id: 'to-remove', cronExpr: 'every:1h',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });

      engine.scheduleEngine.unregister('to-remove');
      expect(engine.scheduleEngine.getAll()).toHaveLength(0);
    });

    it('no-ops for nonexistent id', () => {
      expect(() => engine.scheduleEngine.unregister('nonexistent')).not.toThrow();
    });
  });

  describe('evaluateDue()', () => {
    it('returns interval entry when elapsed time >= interval', () => {
      engine.scheduleEngine.register({
        id: 'interval-task', cronExpr: 'every:30m',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });

      // No lastRun → should be due immediately
      const due = engine.scheduleEngine.evaluateDue(new Date());
      expect(due).toHaveLength(1);
      expect(due[0]!.id).toBe('interval-task');
    });

    it('skips interval entry when not enough time elapsed', async () => {
      const now = new Date('2026-01-01T12:00:00+08:00');
      engine.scheduleEngine.register({
        id: 'interval-task', cronExpr: 'every:30m',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });

      // Mark as just run
      await engine.scheduleEngine.markRun('interval-task', 'success', now);

      // 10 minutes later — not due yet
      const later = new Date(now.getTime() + 10 * 60 * 1000);
      const due = engine.scheduleEngine.evaluateDue(later);
      expect(due).toHaveLength(0);
    });

    it('skips disabled entries', () => {
      engine.scheduleEngine.register({
        id: 'disabled', cronExpr: 'every:1m',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: false, lastRun: null, source: 'proactive',
      });

      const due = engine.scheduleEngine.evaluateDue(new Date());
      expect(due).toHaveLength(0);
    });

    it('skips selfManaged entries', () => {
      engine.scheduleEngine.register({
        id: 'self-managed', cronExpr: 'every:1m',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'evolution',
        selfManaged: true,
      });

      const due = engine.scheduleEngine.evaluateDue(new Date());
      expect(due).toHaveLength(0);
    });
  });

  describe('markRun()', () => {
    it('updates lastRun and meta', async () => {
      engine.scheduleEngine.register({
        id: 'mark-test', cronExpr: 'every:1h',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });

      const now = new Date('2026-01-01T14:00:00Z');
      await engine.scheduleEngine.markRun('mark-test', 'success', now);

      const entry = engine.scheduleEngine.getById('mark-test');
      expect(entry!.lastRun).toBe(now.toISOString());
      expect(entry!.meta?.lastResult).toBe('success');
      expect(entry!.meta?.runCount).toBe(1);
    });
  });

  describe('reschedule()', () => {
    it('updates cron expression', () => {
      engine.scheduleEngine.register({
        id: 'reschedule-test', cronExpr: 'every:1h',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });

      engine.scheduleEngine.reschedule('reschedule-test', 'every:2h');
      expect(engine.scheduleEngine.getById('reschedule-test')!.cronExpr).toBe('every:2h');
    });
  });

  describe('getBySource()', () => {
    it('filters entries by source', () => {
      engine.scheduleEngine.register({
        id: 'proactive:a', cronExpr: 'daily@08:00',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });
      engine.scheduleEngine.register({
        id: 'agent:explorer', cronExpr: 'daily@21:00',
        executor: { type: 'agent', agentName: 'explorer' },
        enabled: true, lastRun: null, source: 'agent',
      });

      expect(engine.scheduleEngine.getBySource('proactive')).toHaveLength(1);
      expect(engine.scheduleEngine.getBySource('agent')).toHaveLength(1);
      expect(engine.scheduleEngine.getBySource('heartbeat')).toHaveLength(0);
    });
  });

  describe('meetsConstraints()', () => {
    it('returns true when no constraints', () => {
      expect(engine.meetsConstraints(undefined)).toBe(true);
    });

    it('rejects when outside activeHours', () => {
      // Create a date at 3am Taipei time
      const at3am = new Date('2026-01-01T03:00:00+08:00');
      expect(engine.meetsConstraints({ activeHours: [8, 22] }, at3am)).toBe(false);
    });

    it('accepts when inside activeHours', () => {
      const at14 = new Date('2026-01-01T14:00:00+08:00');
      expect(engine.meetsConstraints({ activeHours: [8, 22] }, at14)).toBe(true);
    });
  });

  describe('clear()', () => {
    it('removes all entries', () => {
      engine.scheduleEngine.register({
        id: 'a', cronExpr: 'every:1h',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });
      engine.scheduleEngine.register({
        id: 'b', cronExpr: 'every:2h',
        executor: { type: 'callback', fn: vi.fn() },
        enabled: true, lastRun: null, source: 'proactive',
      });

      engine.scheduleEngine.clear();
      expect(engine.scheduleEngine.getAll()).toHaveLength(0);
    });
  });
});
