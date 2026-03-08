import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    TIMEZONE: 'Asia/Taipei',
    QUIET_HOURS_START: 23,
    QUIET_HOURS_END: 7,
  },
}));

// We test getDailyPhase and getRecommendedAction by mocking getTimeOfDay
vi.mock('../../src/lifecycle/awareness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lifecycle/awareness.js')>();
  return {
    ...actual,
    getTimeOfDay: vi.fn(() => 'morning' as const),
  };
});

import { getDailyPhase, getRecommendedAction } from '../../src/lifecycle/daily-rhythm.js';
import { getTimeOfDay } from '../../src/lifecycle/awareness.js';

const mockedGetTimeOfDay = vi.mocked(getTimeOfDay);

describe('DailyRhythm — phase mapping', () => {
  it('morning → greeting phase', () => {
    mockedGetTimeOfDay.mockReturnValue('morning');
    const info = getDailyPhase();
    expect(info.phase).toBe('greeting');
    expect(info.proactiveLevel).toBe(0.8);
  });

  it('day → active_service phase', () => {
    mockedGetTimeOfDay.mockReturnValue('day');
    const info = getDailyPhase();
    expect(info.phase).toBe('active_service');
    expect(info.proactiveLevel).toBe(1.0);
  });

  it('evening → reflection phase', () => {
    mockedGetTimeOfDay.mockReturnValue('evening');
    const info = getDailyPhase();
    expect(info.phase).toBe('reflection');
    expect(info.proactiveLevel).toBe(0.5);
  });

  it('night → rest phase', () => {
    mockedGetTimeOfDay.mockReturnValue('night');
    const info = getDailyPhase();
    expect(info.phase).toBe('rest');
    expect(info.proactiveLevel).toBe(0.2);
  });

  it('deep_night → dormant phase with proactiveLevel 0', () => {
    mockedGetTimeOfDay.mockReturnValue('deep_night');
    const info = getDailyPhase();
    expect(info.phase).toBe('dormant');
    expect(info.proactiveLevel).toBe(0);
  });
});

describe('DailyRhythm — recommended actions', () => {
  it('morning → send_greeting', () => {
    mockedGetTimeOfDay.mockReturnValue('morning');
    expect(getRecommendedAction()).toBe('send_greeting');
  });

  it('day → be_available', () => {
    mockedGetTimeOfDay.mockReturnValue('day');
    expect(getRecommendedAction()).toBe('be_available');
  });

  it('evening → trigger_reflection', () => {
    mockedGetTimeOfDay.mockReturnValue('evening');
    expect(getRecommendedAction()).toBe('trigger_reflection');
  });

  it('night → reduce_activity', () => {
    mockedGetTimeOfDay.mockReturnValue('night');
    expect(getRecommendedAction()).toBe('reduce_activity');
  });

  it('deep_night → enter_dormant', () => {
    mockedGetTimeOfDay.mockReturnValue('deep_night');
    expect(getRecommendedAction()).toBe('enter_dormant');
  });
});
