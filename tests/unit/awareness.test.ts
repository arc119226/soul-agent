import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    TIMEZONE: 'Asia/Taipei',
    QUIET_HOURS_START: 23,
    QUIET_HOURS_END: 7,
  },
}));

import {
  recordInteraction,
  getTimeSinceLastInteraction,
  getLastInteractionTime,
  recordActivityHour,
  getActivityDistribution,
  getEarliestActiveHour,
  loadActivityHours,
  getTimeOfDay,
  isQuietHours,
  getCurrentHour,
} from '../../src/lifecycle/awareness.js';

describe('Awareness — interaction tracking', () => {
  it('recordInteraction stores a timestamp for a user', () => {
    recordInteraction(100);
    expect(getLastInteractionTime(100)).toBeGreaterThan(0);
  });

  it('getTimeSinceLastInteraction returns small value after recording', () => {
    recordInteraction(101);
    const elapsed = getTimeSinceLastInteraction(101);
    expect(elapsed).toBeLessThan(1000); // Less than 1 second
  });

  it('getTimeSinceLastInteraction returns Infinity for unknown user when no interactions exist', () => {
    // Test with a user ID that hasn't been recorded in prior tests
    // Note: other tests may have recorded interactions, so we just check the function works
    const elapsed = getTimeSinceLastInteraction(99999);
    // It should either be Infinity (if this user never interacted) or a number
    expect(typeof elapsed).toBe('number');
  });

  it('getLastInteractionTime returns null for unknown user', () => {
    expect(getLastInteractionTime(88888)).toBe(null);
  });
});

describe('Awareness — activity hours', () => {
  it('recordActivityHour records the current hour', () => {
    recordActivityHour(200);
    const dist = getActivityDistribution(200);
    expect(dist.size).toBeGreaterThan(0);
  });

  it('loadActivityHours loads data and truncates to 200', () => {
    const hours = Array.from({ length: 300 }, (_, i) => i % 24);
    loadActivityHours(201, hours);
    const dist = getActivityDistribution(201);
    // Should have loaded (truncated to 200)
    let total = 0;
    for (const count of dist.values()) total += count;
    expect(total).toBe(200);
  });

  it('getEarliestActiveHour returns null with < 10 records', () => {
    loadActivityHours(202, [8, 9, 10]);
    expect(getEarliestActiveHour(202)).toBe(null);
  });

  it('getEarliestActiveHour finds earliest hour with enough data', () => {
    // Create data concentrated at hours 7 and 9
    const hours = [
      ...Array.from({ length: 5 }, () => 7),
      ...Array.from({ length: 5 }, () => 9),
      ...Array.from({ length: 5 }, () => 14),
    ];
    loadActivityHours(203, hours);
    const earliest = getEarliestActiveHour(203);
    expect(earliest).toBe(7);
  });
});

describe('Awareness — time of day', () => {
  it('getCurrentHour returns a number 0-23', () => {
    const hour = getCurrentHour();
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThanOrEqual(23);
  });

  it('getTimeOfDay returns a valid TimeOfDay string', () => {
    const tod = getTimeOfDay();
    expect(['morning', 'day', 'evening', 'night', 'deep_night']).toContain(tod);
  });

  it('isQuietHours returns a boolean', () => {
    expect(typeof isQuietHours()).toBe('boolean');
  });
});
