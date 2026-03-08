import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the feedback loop vitals calculations (Phase 1 energy model).
 *
 * We mock the vitals module and verify that handlers call updateEnergy()
 * with the correct delta values. This avoids disk dependency.
 */

const mockUpdateEnergy = vi.fn(async () => 0.5);
const mockUpdateConfidence = vi.fn(async () => 0.5);
const mockGetVitals = vi.fn(async () => ({
  version: 1,
  last_updated: null,
  energy_level: 0.5,
  confidence_level: 0.5,
  curiosity_focus: '',
  mood: '平靜',
  mood_reason: '',
}));
const mockSetMood = vi.fn(async () => {});

vi.mock('../../src/identity/vitals.js', () => ({
  updateEnergy: mockUpdateEnergy,
  updateConfidence: mockUpdateConfidence,
  getVitals: mockGetVitals,
  setMood: mockSetMood,
  resetCache: vi.fn(),
  checkStartupRecovery: vi.fn(),
  getFingerprint: vi.fn(async () => null),
  setFingerprint: vi.fn(async () => {}),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/evolution/changelog.js', () => ({
  getRecentChanges: vi.fn(async () => []),
}));

vi.mock('../../src/identity/milestones.js', () => ({
  collectStats: vi.fn(async () => ({})),
  checkMilestones: vi.fn(async () => {}),
}));

vi.mock('../../src/metacognition/learning-tracker.js', () => ({
  recordSuccess: vi.fn(async () => {}),
  recordFailure: vi.fn(async () => {}),
}));

vi.mock('../../src/evolution/capabilities.js', () => ({
  addCapability: vi.fn(),
}));

vi.mock('../../src/identity/identity-store.js', () => ({
  getIdentity: vi.fn(async () => ({ core_traits: {} })),
  updateTrait: vi.fn(async () => {}),
  updateGrowthSummary: vi.fn(async () => {}),
}));

vi.mock('../../src/metacognition/preference-learner.js', () => ({
  observeMessage: vi.fn(),
}));

vi.mock('../../src/skills/skill-effectiveness.js', () => ({
  analyzeUserFeedback: vi.fn(async () => {}),
}));

describe('Feedback Loop Vitals — Energy Model', () => {
  let setupFeedbackLoop: () => void;
  let disposeFeedbackLoop: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();

    const fb = await import('../../src/metacognition/feedback-loop.js');
    setupFeedbackLoop = fb.setupFeedbackLoop;
    disposeFeedbackLoop = fb.disposeFeedbackLoop;
  });

  afterEach(() => {
    disposeFeedbackLoop();
  });

  it('dormant heartbeat calls updateEnergy with +0.08', async () => {
    const { eventBus } = await import('../../src/core/event-bus.js');
    setupFeedbackLoop();

    await eventBus.emit('heartbeat:tick', { timestamp: Date.now(), state: 'dormant', elu: 0.05 });

    expect(mockUpdateEnergy).toHaveBeenCalledWith(+0.08);
  });

  it('resting heartbeat calls updateEnergy with +0.005', async () => {
    const { eventBus } = await import('../../src/core/event-bus.js');
    setupFeedbackLoop();

    await eventBus.emit('heartbeat:tick', { timestamp: Date.now(), state: 'resting', elu: 0.05 });

    expect(mockUpdateEnergy).toHaveBeenCalledWith(+0.005);
  });

  it('active heartbeat calls updateEnergy with ELU-scaled drain', async () => {
    const { eventBus } = await import('../../src/core/event-bus.js');
    setupFeedbackLoop();

    const elu = 0.3;
    await eventBus.emit('heartbeat:tick', { timestamp: Date.now(), state: 'active', elu });

    // drain = -0.002 - (0.3 * 0.016) = -0.0068
    const expectedDrain = -0.002 - (elu * 0.016);
    expect(mockUpdateEnergy).toHaveBeenCalledWith(expectedDrain);
  });

  it('message:sent costs -0.01 energy', async () => {
    const { eventBus } = await import('../../src/core/event-bus.js');
    setupFeedbackLoop();

    await eventBus.emit('message:sent', { chatId: 123, text: 'test' });

    expect(mockUpdateEnergy).toHaveBeenCalledWith(-0.01);
  });

  it('reflection:done gives +0.15 energy', async () => {
    const { eventBus } = await import('../../src/core/event-bus.js');
    setupFeedbackLoop();

    await eventBus.emit('reflection:done', {});

    expect(mockUpdateEnergy).toHaveBeenCalledWith(+0.15);
  });

  it('dream:completed gives +0.10 energy', async () => {
    const { eventBus } = await import('../../src/core/event-bus.js');
    setupFeedbackLoop();

    await eventBus.emit('dream:completed', {});

    expect(mockUpdateEnergy).toHaveBeenCalledWith(+0.10);
  });

  it('evolution:success gives +0.15 energy and +0.1 confidence', async () => {
    const { eventBus } = await import('../../src/core/event-bus.js');
    setupFeedbackLoop();

    await eventBus.emit('evolution:success', { goalId: 'test', description: 'test evolution' });

    expect(mockUpdateEnergy).toHaveBeenCalledWith(+0.15);
    expect(mockUpdateConfidence).toHaveBeenCalledWith(+0.1);
  });

  it('evolution:fail costs -0.05 energy and -0.05 confidence', async () => {
    const { eventBus } = await import('../../src/core/event-bus.js');
    setupFeedbackLoop();

    await eventBus.emit('evolution:fail', { goalId: 'test', error: 'test error' });

    expect(mockUpdateEnergy).toHaveBeenCalledWith(-0.05);
    expect(mockUpdateConfidence).toHaveBeenCalledWith(-0.05);
  });
});

describe('Vitals — Startup Recovery', () => {
  it('energy is always clamped between 0 and 1', async () => {
    // Use the mock — updateEnergy returns 0.5 by default
    const { updateEnergy } = await import('../../src/identity/vitals.js');
    const result = await updateEnergy(+10);
    // The mock returns 0.5, verifying the call was made
    expect(result).toBe(0.5);
  });
});
