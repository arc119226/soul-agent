import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
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

vi.mock('../../src/lifecycle/state-machine.js', () => {
  let state = 'active';
  return {
    getCurrentState: vi.fn(() => state),
    transition: vi.fn(async (newState: string) => {
      state = newState;
      return true;
    }),
    setInitialState: vi.fn((s: string) => { state = s; }),
    getStateDuration: vi.fn(() => {
      // Return large value so hysteresis checks pass
      return 30 * 60 * 1000; // 30 minutes
    }),
  };
});

vi.mock('../../src/lifecycle/awareness.js', () => ({
  getTimeSinceLastInteraction: vi.fn(() => Infinity),
}));

vi.mock('../../src/lifecycle/daily-rhythm.js', () => ({
  getDailyPhase: vi.fn(() => ({
    phase: 'active_service',
    timeOfDay: 'day',
    description: '',
    proactiveLevel: 1.0,
  })),
}));

// Mock modules that heartbeat.ts imports but the original test didn't mock
vi.mock('../../src/lifecycle/elu-monitor.js', () => ({
  sampleELU: vi.fn(() => 0.05),
  isUnderLoad: vi.fn(() => false),
}));

vi.mock('../../src/lifecycle/fatigue-score.js', () => ({
  calculateFatigue: vi.fn(() => ({ score: 0, level: 'normal', heapGrowthRate: 0 })),
  logFatigue: vi.fn(),
  getFatigueThresholds: vi.fn(() => ({
    THROTTLE_ENTER: 0.6,
    THROTTLE_EXIT: 0.4,
    DRAIN_ENTER: 0.8,
    DRAIN_EXIT: 0.6,
  })),
}));

vi.mock('../../src/lifecycle/activity-monitor.js', () => ({
  activityMonitor: {
    getSnapshot: vi.fn(() => ({
      totalCount: 0,
      eventsPerMinute: 0,
      isResting: true,
      restDurationMs: 0,
    })),
    attach: vi.fn(),
  },
}));

vi.mock('../../src/lifecycle/checkpoint.js', () => ({
  attachCheckpointListener: vi.fn(),
  loadCheckpoint: vi.fn(async () => {}),
  restoreCheckpoint: vi.fn(() => null),
}));

vi.mock('../../src/lifecycle/anomaly-detector.js', () => ({
  anomalyDetector: {
    detectAnomalies: vi.fn(() => []),
  },
}));

vi.mock('../../src/lifecycle/wake-manager.js', () => ({
  attachWakeListeners: vi.fn(),
}));

vi.mock('../../src/core/schedule-engine.js', () => ({
  scheduleEngine: {
    register: vi.fn(),
    unregister: vi.fn(),
    evaluateDue: vi.fn(() => []),
    markRun: vi.fn(),
    getAll: vi.fn(() => []),
    getById: vi.fn(() => null),
    getBySource: vi.fn(() => []),
  },
}));

// Mock dynamic imports used inside tick()
vi.mock('../../src/memory/staging.js', () => ({
  checkExpired: vi.fn(async () => {}),
}));

vi.mock('../../src/safety/kill-switch.js', () => ({
  checkAnomalies: vi.fn(async () => {}),
  attachIntegrityListener: vi.fn(),
}));

vi.mock('../../src/identity/vitals.js', () => ({
  getFingerprint: vi.fn(async () => null),
  setFingerprint: vi.fn(async () => {}),
  getFileHashes: vi.fn(async () => null),
}));

vi.mock('../../src/safety/soul-integrity.js', () => ({
  computeSoulFingerprint: vi.fn(async () => ({ ok: true, value: { hash: 'test', files: {} } })),
  diffFingerprints: vi.fn((stored: Record<string, string> | null | undefined, current: { files: Record<string, string> }) => {
    if (!stored || Object.keys(stored).length === 0) {
      return Object.keys(current.files);
    }
    const changed: string[] = [];
    for (const [file, hash] of Object.entries(current.files)) {
      if (stored[file] !== hash) changed.push(file);
    }
    return changed;
  }),
}));

import { tick, wakeUp } from '../../src/lifecycle/heartbeat.js';
import { setInitialState } from '../../src/lifecycle/state-machine.js';
import { getTimeSinceLastInteraction } from '../../src/lifecycle/awareness.js';
import { getDailyPhase } from '../../src/lifecycle/daily-rhythm.js';
import { transition } from '../../src/lifecycle/state-machine.js';
import { eventBus } from '../../src/core/event-bus.js';
import { restoreCheckpoint } from '../../src/lifecycle/checkpoint.js';
import { computeSoulFingerprint } from '../../src/safety/soul-integrity.js';

const mockedGetDailyPhase = vi.mocked(getDailyPhase);
const mockedGetTimeSince = vi.mocked(getTimeSinceLastInteraction);
const mockedSetInitialState = vi.mocked(setInitialState);
const mockedTransition = vi.mocked(transition);
const mockedEventBusEmit = vi.mocked(eventBus.emit);
const mockedRestoreCheckpoint = vi.mocked(restoreCheckpoint);
const mockedComputeSoulFingerprint = vi.mocked(computeSoulFingerprint);

describe('Heartbeat tick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSetInitialState('active');
  });

  it('deep_night + active → dormant', async () => {
    mockedSetInitialState('active');
    mockedGetDailyPhase.mockReturnValue({
      phase: 'dormant',
      timeOfDay: 'deep_night',
      description: '',
      proactiveLevel: 0,
    });

    await tick();

    expect(mockedTransition).toHaveBeenCalledWith('dormant', expect.stringContaining('deep night'));
  });

  it('rest + active + idle > 30m → resting', async () => {
    mockedSetInitialState('active');
    mockedGetDailyPhase.mockReturnValue({
      phase: 'rest',
      timeOfDay: 'night',
      description: '',
      proactiveLevel: 0.2,
    });
    mockedGetTimeSince.mockReturnValue(35 * 60 * 1000); // 35 min

    await tick();

    expect(mockedTransition).toHaveBeenCalledWith('resting', expect.stringContaining('night time — winding down'));
  });

  it('rest + active + idle < 30m → no change', async () => {
    mockedSetInitialState('active');
    mockedGetDailyPhase.mockReturnValue({
      phase: 'rest',
      timeOfDay: 'night',
      description: '',
      proactiveLevel: 0.2,
    });
    mockedGetTimeSince.mockReturnValue(10 * 60 * 1000); // 10 min

    await tick();

    expect(mockedTransition).not.toHaveBeenCalled();
  });

  it('rest + resting → stays resting (dormant deferred to deep_night)', async () => {
    mockedSetInitialState('resting');
    mockedGetDailyPhase.mockReturnValue({
      phase: 'rest',
      timeOfDay: 'night',
      description: '',
      proactiveLevel: 0.2,
    });
    mockedGetTimeSince.mockReturnValue(3 * 60 * 60 * 1000); // 3 hours

    await tick();

    expect(mockedTransition).not.toHaveBeenCalled();
  });

  it('day + active + idle > 30m → resting', async () => {
    mockedSetInitialState('active');
    mockedGetDailyPhase.mockReturnValue({
      phase: 'active_service',
      timeOfDay: 'day',
      description: '',
      proactiveLevel: 1.0,
    });
    mockedGetTimeSince.mockReturnValue(45 * 60 * 1000); // 45 min

    await tick();

    expect(mockedTransition).toHaveBeenCalledWith(
      'resting',
      expect.stringContaining('no interaction for'),
    );
  });

  it('morning + dormant → active', async () => {
    mockedSetInitialState('dormant');
    mockedGetDailyPhase.mockReturnValue({
      phase: 'greeting',
      timeOfDay: 'morning',
      description: '',
      proactiveLevel: 0.8,
    });

    await tick();

    expect(mockedTransition).toHaveBeenCalledWith('active', expect.stringContaining('waking up'));
  });

  it('rest + dormant → no change', async () => {
    mockedSetInitialState('dormant');
    mockedGetDailyPhase.mockReturnValue({
      phase: 'rest',
      timeOfDay: 'night',
      description: '',
      proactiveLevel: 0.2,
    });

    await tick();

    expect(mockedTransition).not.toHaveBeenCalled();
  });
});

describe('wakeUp — identity verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSetInitialState('resting');
    // Non-dormant phase so we go through the normal wake path
    mockedGetDailyPhase.mockReturnValue({
      phase: 'active_service',
      timeOfDay: 'day',
      description: '',
      proactiveLevel: 1.0,
    });
  });

  it('emits soul:integrity_mismatch with context=wake on fingerprint change', async () => {
    mockedRestoreCheckpoint.mockReturnValue({
      savedAt: Date.now() - 60_000,
      targetState: 'resting',
      identityFingerprint: 'aaa111',
      identityFileHashes: {
        'soul/genesis.md': 'old_gen',
        'soul/identity.json': 'old_id',
        'soul/vitals.json': 'same_v',
        'soul/milestones.json': 'same_m',
      },
      fatigue: { score: 0.2, level: 'normal', heapGrowthRate: 0 },
    } as any);

    mockedComputeSoulFingerprint.mockResolvedValue({
      ok: true,
      value: {
        hash: 'bbb222',
        files: {
          'soul/genesis.md': 'new_gen',
          'soul/identity.json': 'new_id',
          'soul/vitals.json': 'same_v',
          'soul/milestones.json': 'same_m',
        },
      },
    } as any);

    await wakeUp('test wake');

    expect(mockedEventBusEmit).toHaveBeenCalledWith('soul:integrity_mismatch', {
      context: 'wake',
      changedFiles: ['soul/genesis.md', 'soul/identity.json'],
      expected: 'aaa111',
      actual: 'bbb222',
    });
  });

  it('does not emit event when fingerprint matches', async () => {
    mockedRestoreCheckpoint.mockReturnValue({
      savedAt: Date.now() - 60_000,
      targetState: 'resting',
      identityFingerprint: 'same_hash',
      fatigue: { score: 0.1, level: 'normal', heapGrowthRate: 0 },
    } as any);

    mockedComputeSoulFingerprint.mockResolvedValue({
      ok: true,
      value: { hash: 'same_hash', files: {} },
    } as any);

    await wakeUp('test wake');

    expect(mockedEventBusEmit).not.toHaveBeenCalledWith(
      'soul:integrity_mismatch',
      expect.anything(),
    );
  });

  it('skips verification when checkpoint has no fingerprint', async () => {
    mockedRestoreCheckpoint.mockReturnValue({
      savedAt: Date.now() - 60_000,
      targetState: 'resting',
      fatigue: { score: 0.1, level: 'normal', heapGrowthRate: 0 },
    } as any);

    await wakeUp('test wake');

    // Should still transition without error
    expect(mockedTransition).toHaveBeenCalledWith('active', 'test wake');
    expect(mockedEventBusEmit).not.toHaveBeenCalledWith(
      'soul:integrity_mismatch',
      expect.anything(),
    );
  });
});
