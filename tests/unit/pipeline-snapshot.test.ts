/**
 * Tests that the evolution pipeline creates a soul snapshot
 * before beginning evolution steps (Phase 1A wiring).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Static dependency mocks ──────────────────────────────────────
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: { ADMIN_USER_ID: '1', ALLOWED_USERS: [] },
}));

vi.mock('../../src/evolution/goals.js', () => ({
  getGoal: vi.fn(() => ({
    id: 'test-goal',
    description: 'test evolution',
    status: 'pending',
    priority: 'medium',
  })),
  startGoal: vi.fn(),
  completeGoal: vi.fn(),
  failGoal: vi.fn(),
}));

vi.mock('../../src/evolution/rollback.js', () => ({
  createSafetyTag: vi.fn(async () => ({ ok: true, value: 'evo-test-goal' })),
  rollback: vi.fn(),
  cleanupSafetyTag: vi.fn(),
  commitEvolutionWithMessage: vi.fn(),
}));

vi.mock('../../src/evolution/circuit-breaker.js', () => ({
  isOpen: vi.fn(() => false),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  getRecentFailures: vi.fn(() => []),
}));

vi.mock('../../src/evolution/pipeline-state.js', () => ({
  startPipeline: vi.fn(async () => {}),
  advanceStep: vi.fn(async () => {}),
  recordPipelineError: vi.fn(async () => {}),
  clearPipeline: vi.fn(async () => {}),
  getPipelineState: vi.fn(() => null),
  hasInterruptedPipeline: vi.fn(() => false),
  getResumeStep: vi.fn(() => null),
  getStepIndex: vi.fn(() => 0),
  getTotalSteps: vi.fn(() => 11),
}));

vi.mock('../../src/evolution/evolution-prompt.js', () => ({
  buildEvolutionPrompt: vi.fn(),
}));

vi.mock('../../src/evolution/validator.js', () => ({
  validateSyntax: vi.fn(),
  layeredValidation: vi.fn(),
}));

vi.mock('../../src/evolution/cleanup.js', () => ({
  runPostEvolutionCleanup: vi.fn(),
}));

vi.mock('../../src/evolution/commit-message.js', () => ({
  buildConventionalCommitMessage: vi.fn(),
}));

vi.mock('../../src/evolution/claude-md-sync.js', () => ({
  syncClaudeMd: vi.fn(),
}));

vi.mock('../../src/evolution/git-push.js', () => ({
  pushAfterEvolution: vi.fn(),
}));

vi.mock('../../src/evolution/changelog.js', () => ({
  appendChangelog: vi.fn(),
}));

vi.mock('../../src/evolution/capabilities.js', () => ({
  getCapabilities: vi.fn(() => []),
}));

vi.mock('../../src/evolution/intention-recorder.js', () => ({
  recordIntention: vi.fn(),
}));

vi.mock('../../src/evolution/evolution-metrics.js', () => ({
  recordEvolutionMetric: vi.fn(),
}));

// ── Dynamic import mocks ──────────────────────────────────────
vi.mock('../../src/safety/kill-switch.js', () => ({
  isRestricted: vi.fn(() => false),
}));

const mockCreateSnapshot = vi.fn(async () => ({
  ok: true,
  value: { id: 'snap-test-001' },
}));

vi.mock('../../src/safety/soul-snapshot.js', () => ({
  createSnapshot: mockCreateSnapshot,
}));

vi.mock('../../src/safety/soul-integrity.js', () => ({
  computeSoulFingerprint: vi.fn(async () => ({
    ok: true,
    value: { hash: 'test-hash', files: {} },
  })),
  CRITICAL_FILES: [],
}));

vi.mock('../../src/identity/vitals.js', () => ({
  getFingerprint: vi.fn(async () => null),
  setFingerprint: vi.fn(async () => {}),
}));

// ── Import under test ──────────────────────────────────────
import { executePipeline } from '../../src/evolution/pipeline.js';

describe('Pipeline pre-evolution snapshot (Phase 1A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls createSnapshot("pre-evolution") after safety tag creation', async () => {
    // Pipeline will fail at some step, but snapshot should be called before steps begin
    await executePipeline('test-goal').catch(() => {});

    expect(mockCreateSnapshot).toHaveBeenCalledTimes(1);
    expect(mockCreateSnapshot).toHaveBeenCalledWith('pre-evolution');
  });

  it('continues pipeline when snapshot fails', async () => {
    mockCreateSnapshot.mockResolvedValueOnce({
      ok: false,
      error: 'disk full',
    } as any);

    // Should not throw — snapshot failure is non-fatal
    await executePipeline('test-goal').catch(() => {});

    // Snapshot was attempted
    expect(mockCreateSnapshot).toHaveBeenCalledWith('pre-evolution');
    // Pipeline continued past snapshot (startGoal was called)
    const { startGoal } = await import('../../src/evolution/goals.js');
    expect(startGoal).toHaveBeenCalledWith('test-goal');
  });

  it('continues pipeline when snapshot throws', async () => {
    mockCreateSnapshot.mockRejectedValueOnce(new Error('unexpected'));

    await executePipeline('test-goal').catch(() => {});

    expect(mockCreateSnapshot).toHaveBeenCalledWith('pre-evolution');
    const { startGoal } = await import('../../src/evolution/goals.js');
    expect(startGoal).toHaveBeenCalledWith('test-goal');
  });
});
