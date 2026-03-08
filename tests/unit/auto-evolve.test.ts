import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    TIMEZONE: 'Asia/Taipei',
    QUIET_HOURS_START: 23,
    QUIET_HOURS_END: 7,
    MAX_AUTO_EVOLVES_PER_DAY: 3,
  },
}));

vi.mock('../../src/evolution/goals.js', () => ({
  getNextGoal: vi.fn(() => null),
}));

vi.mock('../../src/evolution/pipeline.js', () => ({
  executePipeline: vi.fn(async () => ({ ok: true, value: undefined, message: 'ok' })),
}));

vi.mock('../../src/evolution/circuit-breaker.js', () => ({
  isOpen: vi.fn(() => false),
  getCircuitBreakerInfo: vi.fn(() => ({
    state: 'closed',
    consecutiveFailures: 0,
    cooldownRemainingMs: 0,
  })),
}));

vi.mock('../../src/result.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/result.js')>();
  return { ...actual };
});

describe('Auto-Evolve', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Stop scheduler to prevent timer leaks
    vi.useRealTimers();
  });

  it('getAutoEvolveStatus returns correct structure', async () => {
    const { getAutoEvolveStatus, stopAutoEvolve } = await import('../../src/evolution/auto-evolve.js');
    stopAutoEvolve();

    const status = getAutoEvolveStatus();

    expect(status).toHaveProperty('active');
    expect(status).toHaveProperty('evolvesToday');
    expect(status).toHaveProperty('maxPerDay');
    expect(status).toHaveProperty('currentIntervalMin');
    expect(status).toHaveProperty('running');
    expect(typeof status.active).toBe('boolean');
    expect(typeof status.evolvesToday).toBe('number');
    expect(typeof status.maxPerDay).toBe('number');
    expect(typeof status.currentIntervalMin).toBe('number');
    expect(typeof status.running).toBe('boolean');
  });

  it('isAutoEvolveActive is false initially', async () => {
    const { isAutoEvolveActive, stopAutoEvolve } = await import('../../src/evolution/auto-evolve.js');
    stopAutoEvolve();

    expect(isAutoEvolveActive()).toBe(false);
  });

  it('startAutoEvolve activates the scheduler', async () => {
    const { startAutoEvolve, isAutoEvolveActive, stopAutoEvolve } = await import('../../src/evolution/auto-evolve.js');
    stopAutoEvolve();

    startAutoEvolve();
    expect(isAutoEvolveActive()).toBe(true);

    stopAutoEvolve();
  });

  it('stopAutoEvolve deactivates the scheduler', async () => {
    const { startAutoEvolve, stopAutoEvolve, isAutoEvolveActive } = await import('../../src/evolution/auto-evolve.js');

    startAutoEvolve();
    expect(isAutoEvolveActive()).toBe(true);

    stopAutoEvolve();
    expect(isAutoEvolveActive()).toBe(false);
  });

  it('triggerNow skips when no pending goals', async () => {
    const { triggerNow, stopAutoEvolve } = await import('../../src/evolution/auto-evolve.js');
    const { executePipeline } = await import('../../src/evolution/pipeline.js');
    const { getNextGoal } = await import('../../src/evolution/goals.js');

    stopAutoEvolve();
    vi.mocked(getNextGoal).mockReturnValue(null);

    await triggerNow();

    expect(executePipeline).not.toHaveBeenCalled();
    stopAutoEvolve();
  });

  it('triggerNow skips when circuit breaker is open', async () => {
    const { triggerNow, stopAutoEvolve } = await import('../../src/evolution/auto-evolve.js');
    const { executePipeline } = await import('../../src/evolution/pipeline.js');
    const { isOpen } = await import('../../src/evolution/circuit-breaker.js');

    stopAutoEvolve();
    vi.mocked(isOpen).mockReturnValue(true);

    await triggerNow();

    expect(executePipeline).not.toHaveBeenCalled();

    vi.mocked(isOpen).mockReturnValue(false);
    stopAutoEvolve();
  });

  it('quiet hours: skips during configured quiet period', async () => {
    const { triggerNow, stopAutoEvolve } = await import('../../src/evolution/auto-evolve.js');
    const { executePipeline } = await import('../../src/evolution/pipeline.js');
    const { getNextGoal } = await import('../../src/evolution/goals.js');

    stopAutoEvolve();

    // Set time to 01:00 Taipei (within quiet hours 23-7)
    // UTC 17:00 previous day = Taipei 01:00
    vi.setSystemTime(new Date('2026-02-13T17:00:00.000Z'));
    vi.mocked(getNextGoal).mockReturnValue({
      id: 'g1', description: 'test', priority: 3,
      tags: [], status: 'pending', createdAt: '',
    });

    await triggerNow();

    expect(executePipeline).not.toHaveBeenCalled();
    stopAutoEvolve();
  });

  it('getAutoEvolveStatus reflects maxPerDay from config', async () => {
    const { getAutoEvolveStatus, stopAutoEvolve } = await import('../../src/evolution/auto-evolve.js');
    stopAutoEvolve();

    const status = getAutoEvolveStatus();
    expect(status.maxPerDay).toBe(3);
  });
});
