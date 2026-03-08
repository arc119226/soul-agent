import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Goal } from '../../src/evolution/goals.js';

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    AUTO_PUSH_ENABLED: false,
    AUTO_PUSH_REQUIRE_APPROVAL: 'high',
    APPROVAL_TIMEOUT: 5_000,
  },
}));

// Mock event bus
vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock debounced writer
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn(), writeNow: vi.fn() },
}));

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'push-test-01',
    description: 'Test push feature',
    priority: 3,
    status: 'completed',
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('git-push module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns disabled when AUTO_PUSH_ENABLED is false', async () => {
    const { pushAfterEvolution } = await import('../../src/evolution/git-push.js');
    const result = await pushAfterEvolution(makeGoal(), 'low', 'abc123');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('disabled');
    }
  });

  it('returns no-commit when commitHash is empty', async () => {
    // Temporarily enable push
    const configModule = await import('../../src/config.js');
    const original = configModule.config.AUTO_PUSH_ENABLED;
    (configModule.config as Record<string, unknown>).AUTO_PUSH_ENABLED = true;

    const { pushAfterEvolution } = await import('../../src/evolution/git-push.js');
    const result = await pushAfterEvolution(makeGoal(), 'low', '');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('no-commit');
    }

    // Restore
    (configModule.config as Record<string, unknown>).AUTO_PUSH_ENABLED = original;
  });
});
