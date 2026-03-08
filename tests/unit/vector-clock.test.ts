/**
 * Tests for vector-clock.ts — causal ordering proof.
 *
 * Pure function tests: create, increment, merge, compare, isMonotonicSuccessor
 * Module state tests: tick, initFromSnapshot, getClock
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createClock,
  increment,
  merge,
  compare,
  isMonotonicSuccessor,
  getClock,
  tick,
  initFromSnapshot,
  __testing,
} from '../../src/lifecycle/vector-clock.js';

describe('VectorClock', () => {
  beforeEach(() => {
    __testing.reset();
  });

  describe('createClock', () => {
    it('creates clock with default bot process', () => {
      const clock = createClock();
      expect(clock).toEqual({ bot: 0 });
    });

    it('creates clock with custom process IDs', () => {
      const clock = createClock(['bot', 'cli', 'worker']);
      expect(clock).toEqual({ bot: 0, cli: 0, worker: 0 });
    });

    it('creates empty clock with no arguments', () => {
      const clock = createClock([]);
      expect(clock).toEqual({});
    });
  });

  describe('increment', () => {
    it('increments specified process', () => {
      const clock = createClock(['bot']);
      const next = increment(clock, 'bot');
      expect(next.bot).toBe(1);
    });

    it('does not mutate original', () => {
      const clock = createClock(['bot']);
      increment(clock, 'bot');
      expect(clock.bot).toBe(0);
    });

    it('creates new process entry if not present', () => {
      const clock = createClock(['bot']);
      const next = increment(clock, 'cli');
      expect(next).toEqual({ bot: 0, cli: 1 });
    });

    it('increments multiple times', () => {
      let clock = createClock(['bot']);
      clock = increment(clock, 'bot');
      clock = increment(clock, 'bot');
      clock = increment(clock, 'bot');
      expect(clock.bot).toBe(3);
    });
  });

  describe('merge', () => {
    it('takes element-wise max', () => {
      const a = { bot: 3, cli: 1 };
      const b = { bot: 1, cli: 5 };
      expect(merge(a, b)).toEqual({ bot: 3, cli: 5 });
    });

    it('handles disjoint keys', () => {
      const a = { bot: 2 };
      const b = { cli: 3 };
      expect(merge(a, b)).toEqual({ bot: 2, cli: 3 });
    });

    it('does not mutate originals', () => {
      const a = { bot: 1 };
      const b = { bot: 2 };
      merge(a, b);
      expect(a.bot).toBe(1);
      expect(b.bot).toBe(2);
    });
  });

  describe('compare', () => {
    it('detects equal clocks', () => {
      expect(compare({ bot: 1 }, { bot: 1 })).toBe('equal');
      expect(compare({}, {})).toBe('equal');
    });

    it('detects happened-before', () => {
      expect(compare({ bot: 1 }, { bot: 2 })).toBe('happened-before');
      expect(compare({ bot: 1, cli: 0 }, { bot: 1, cli: 1 })).toBe('happened-before');
    });

    it('detects happened-after', () => {
      expect(compare({ bot: 3 }, { bot: 1 })).toBe('happened-after');
    });

    it('detects concurrent events', () => {
      // a has higher bot, b has higher cli — no causal ordering
      expect(compare({ bot: 2, cli: 1 }, { bot: 1, cli: 2 })).toBe('concurrent');
    });

    it('handles missing keys as 0', () => {
      expect(compare({ bot: 1 }, { cli: 1 })).toBe('concurrent');
      expect(compare({ bot: 0 }, { cli: 1 })).toBe('happened-before');
    });
  });

  describe('isMonotonicSuccessor', () => {
    it('returns true for valid successor', () => {
      expect(isMonotonicSuccessor({ bot: 1 }, { bot: 2 })).toBe(true);
      expect(isMonotonicSuccessor({ bot: 1 }, { bot: 1 })).toBe(true); // equal is valid
    });

    it('returns false for regression', () => {
      expect(isMonotonicSuccessor({ bot: 3 }, { bot: 2 })).toBe(false);
    });

    it('returns true when new keys are added', () => {
      expect(isMonotonicSuccessor({ bot: 1 }, { bot: 1, cli: 1 })).toBe(true);
    });

    it('returns false when any component decreases', () => {
      expect(isMonotonicSuccessor({ bot: 2, cli: 3 }, { bot: 2, cli: 1 })).toBe(false);
    });
  });

  describe('module state (tick, getClock, initFromSnapshot)', () => {
    it('starts at bot:0', () => {
      expect(getClock()).toEqual({ bot: 0 });
    });

    it('tick increments bot counter', () => {
      const c1 = tick();
      expect(c1).toEqual({ bot: 1 });
      const c2 = tick();
      expect(c2).toEqual({ bot: 2 });
    });

    it('getClock returns copy', () => {
      tick();
      const c = getClock();
      c.bot = 999;
      expect(getClock().bot).toBe(1);
    });

    it('initFromSnapshot restores state', () => {
      tick(); tick(); tick();
      expect(getClock().bot).toBe(3);

      initFromSnapshot({ bot: 10, cli: 5 });
      expect(getClock()).toEqual({ bot: 10, cli: 5 });
    });

    it('reset restores to genesis', () => {
      tick(); tick();
      __testing.reset();
      expect(getClock()).toEqual({ bot: 0 });
    });
  });
});
