import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock isQuietHours — default returns false
const mockIsQuietHours = vi.fn(() => false);
vi.mock('../../src/lifecycle/awareness.js', () => ({
  isQuietHours: () => mockIsQuietHours(),
}));

vi.mock('../../src/config.js', () => ({
  config: {},
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Proactive Constraints', () => {
  let canDeliver: typeof import('../../src/proactive/constraints.js')['canDeliver'];
  let recordDelivery: typeof import('../../src/proactive/constraints.js')['recordDelivery'];
  let recordIgnored: typeof import('../../src/proactive/constraints.js')['recordIgnored'];
  let recordResponse: typeof import('../../src/proactive/constraints.js')['recordResponse'];
  let resetThrottle: typeof import('../../src/proactive/constraints.js')['resetThrottle'];
  let getDeliveryStats: typeof import('../../src/proactive/constraints.js')['getDeliveryStats'];

  const userId = 12345;

  beforeEach(async () => {
    vi.resetModules();
    mockIsQuietHours.mockReturnValue(false);
    vi.doMock('../../src/lifecycle/awareness.js', () => ({
      isQuietHours: () => mockIsQuietHours(),
    }));
    vi.doMock('../../src/config.js', () => ({ config: {} }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const mod = await import('../../src/proactive/constraints.js');
    canDeliver = mod.canDeliver;
    recordDelivery = mod.recordDelivery;
    recordIgnored = mod.recordIgnored;
    recordResponse = mod.recordResponse;
    resetThrottle = mod.resetThrottle;
    getDeliveryStats = mod.getDeliveryStats;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('canDeliver() — quiet hours', () => {
    it('blocks delivery during quiet hours', () => {
      mockIsQuietHours.mockReturnValue(true);
      expect(canDeliver('greeting', userId)).toBe(false);
    });

    it('allows delivery outside quiet hours', () => {
      mockIsQuietHours.mockReturnValue(false);
      expect(canDeliver('greeting', userId)).toBe(true);
    });
  });

  describe('canDeliver() — ignored throttle', () => {
    it('blocks after 3 consecutive ignored messages', () => {
      recordIgnored();
      recordIgnored();
      recordIgnored();
      expect(canDeliver('greeting', userId)).toBe(false);
    });

    it('allows when ignored count < 3', () => {
      recordIgnored();
      recordIgnored();
      expect(canDeliver('greeting', userId)).toBe(true);
    });
  });

  describe('canDeliver() — per-type daily cap', () => {
    it('blocks greeting after daily cap (1)', () => {
      recordDelivery('greeting', userId);
      expect(canDeliver('greeting', userId)).toBe(false);
    });

    it('allows care up to daily cap (2)', () => {
      recordDelivery('care', userId);
      expect(canDeliver('care', userId)).toBe(true);
      recordDelivery('care', userId);
      expect(canDeliver('care', userId)).toBe(false);
    });

    it('allows reminder up to daily cap (5)', () => {
      for (let i = 0; i < 4; i++) recordDelivery('reminder', userId);
      expect(canDeliver('reminder', userId)).toBe(true);
      recordDelivery('reminder', userId);
      expect(canDeliver('reminder', userId)).toBe(false);
    });
  });

  describe('canDeliver() — total daily cap', () => {
    it('blocks non-reminder types after 3 total proactive messages', () => {
      // Use different types to avoid per-type cap
      recordDelivery('greeting', userId);   // 1
      recordDelivery('care', userId);        // 2
      recordDelivery('reflection', userId);  // 3 — total cap reached
      expect(canDeliver('care', userId)).toBe(false);
    });

    it('reminders are excluded from total daily cap', () => {
      recordDelivery('greeting', userId);
      recordDelivery('care', userId);
      recordDelivery('reflection', userId);
      // Total cap reached for non-reminders, but reminder should still pass
      expect(canDeliver('reminder', userId)).toBe(true);
    });
  });

  describe('canDeliver() — checkin 24h cooldown', () => {
    it('blocks checkin within 24h of last checkin', () => {
      recordDelivery('checkin', userId);
      expect(canDeliver('checkin', userId)).toBe(false);
    });

    it('allows checkin after 24h', () => {
      // Record checkin at a past time
      recordDelivery('checkin', userId);

      // Move time forward by 25 hours
      const now = Date.now();
      vi.setSystemTime(now + 25 * 60 * 60 * 1000);

      expect(canDeliver('checkin', userId)).toBe(true);
    });
  });

  describe('recordDelivery()', () => {
    it('records delivery and updates stats', () => {
      recordDelivery('greeting', userId);
      const stats = getDeliveryStats(userId);
      expect(stats.today).toBe(1);
      expect(stats.byType['greeting']).toBe(1);
    });
  });

  describe('recordIgnored() / recordResponse() / resetThrottle()', () => {
    it('recordResponse resets ignored count', () => {
      recordIgnored();
      recordIgnored();
      recordIgnored();
      expect(canDeliver('greeting', userId)).toBe(false);

      recordResponse();
      expect(canDeliver('greeting', userId)).toBe(true);
    });

    it('resetThrottle resets ignored count', () => {
      recordIgnored();
      recordIgnored();
      recordIgnored();
      resetThrottle();

      const stats = getDeliveryStats(userId);
      expect(stats.ignoredStreak).toBe(0);
    });
  });

  describe('getDeliveryStats()', () => {
    it('returns correct structure', () => {
      const stats = getDeliveryStats(userId);
      expect(stats).toHaveProperty('today');
      expect(stats).toHaveProperty('ignoredStreak');
      expect(stats).toHaveProperty('byType');
      expect(stats.today).toBe(0);
      expect(stats.ignoredStreak).toBe(0);
    });

    it('tracks multiple delivery types', () => {
      recordDelivery('greeting', userId);
      recordDelivery('care', userId);
      recordDelivery('care', userId);
      const stats = getDeliveryStats(userId);
      expect(stats.today).toBe(3);
      expect(stats.byType['greeting']).toBe(1);
      expect(stats.byType['care']).toBe(2);
    });
  });
});
