import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    ADMIN_USER_ID: 12345,
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockCheckIfShouldCheckin = vi.fn(() => true);
const mockGenerateCheckinMessage = vi.fn(async () => 'Hi!');

vi.mock('../../src/proactive/checkin.js', () => ({
  checkIfShouldCheckin: (...args: unknown[]) => mockCheckIfShouldCheckin(...args),
  generateCheckinMessage: (...args: unknown[]) => mockGenerateCheckinMessage(...args),
}));

vi.mock('../../src/lifecycle/daily-rhythm.js', () => ({
  getDailyPhase: vi.fn(() => ({
    phase: 'active_service',
    timeOfDay: 'day',
    description: '',
    proactiveLevel: 1.0,
  })),
}));

import { handleCheckinTick } from '../../src/proactive/engine.js';
import { getDailyPhase } from '../../src/lifecycle/daily-rhythm.js';
import { config } from '../../src/config.js';

const mockedGetDailyPhase = vi.mocked(getDailyPhase);

describe('Proactive Engine — handleCheckinTick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckIfShouldCheckin.mockReturnValue(true);
    mockGenerateCheckinMessage.mockResolvedValue('Hi!');
  });

  it('state=dormant → skips', async () => {
    await handleCheckinTick({ timestamp: Date.now(), state: 'dormant' });
    expect(mockCheckIfShouldCheckin).not.toHaveBeenCalled();
  });

  it('no ADMIN_USER_ID → skips', async () => {
    const original = config.ADMIN_USER_ID;
    (config as Record<string, unknown>).ADMIN_USER_ID = undefined;
    try {
      await handleCheckinTick({ timestamp: Date.now(), state: 'active' });
      expect(mockCheckIfShouldCheckin).not.toHaveBeenCalled();
    } finally {
      (config as Record<string, unknown>).ADMIN_USER_ID = original;
    }
  });

  it('proactiveLevel=0 → skips', async () => {
    mockedGetDailyPhase.mockReturnValue({
      phase: 'dormant',
      timeOfDay: 'deep_night',
      description: '',
      proactiveLevel: 0,
    });

    await handleCheckinTick({ timestamp: Date.now(), state: 'active' });
    expect(mockCheckIfShouldCheckin).not.toHaveBeenCalled();
  });

  it('level=0.5, random=0.7 → skips (probability gate)', async () => {
    mockedGetDailyPhase.mockReturnValue({
      phase: 'reflection',
      timeOfDay: 'evening',
      description: '',
      proactiveLevel: 0.5,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.7);

    await handleCheckinTick({ timestamp: Date.now(), state: 'active' });
    expect(mockCheckIfShouldCheckin).not.toHaveBeenCalled();

    vi.spyOn(Math, 'random').mockRestore();
  });

  it('level=0.5, random=0.3 → passes (probability gate)', async () => {
    mockedGetDailyPhase.mockReturnValue({
      phase: 'reflection',
      timeOfDay: 'evening',
      description: '',
      proactiveLevel: 0.5,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.3);

    await handleCheckinTick({ timestamp: Date.now(), state: 'active' });
    expect(mockCheckIfShouldCheckin).toHaveBeenCalled();

    vi.spyOn(Math, 'random').mockRestore();
  });

  it('level=1.0, random=0.99 → always passes', async () => {
    mockedGetDailyPhase.mockReturnValue({
      phase: 'active_service',
      timeOfDay: 'day',
      description: '',
      proactiveLevel: 1.0,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    await handleCheckinTick({ timestamp: Date.now(), state: 'active' });
    expect(mockCheckIfShouldCheckin).toHaveBeenCalled();

    vi.spyOn(Math, 'random').mockRestore();
  });
});
