import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    schedule: vi.fn(),
    writeNow: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  loadPipelineState,
  startPipeline,
  advanceStep,
  clearPipeline,
  getPipelineState,
  hasInterruptedPipeline,
  getResumeStep,
  getStepOrder,
  getStepIndex,
  getTotalSteps,
  recordPipelineError,
} from '../../src/evolution/pipeline-state.js';
import { writer } from '../../src/core/debounced-writer.js';

describe('Pipeline State', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset state by clearing the pipeline
    await clearPipeline();
  });

  describe('getStepOrder()', () => {
    it('returns 11 steps', () => {
      expect(getStepOrder()).toHaveLength(11);
    });

    it('returns a copy (not a reference)', () => {
      const a = getStepOrder();
      const b = getStepOrder();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('starts with fetch_knowledge and ends with post_actions', () => {
      const steps = getStepOrder();
      expect(steps[0]).toBe('fetch_knowledge');
      expect(steps[steps.length - 1]).toBe('post_actions');
    });
  });

  describe('getTotalSteps()', () => {
    it('returns 11', () => {
      expect(getTotalSteps()).toBe(11);
    });
  });

  describe('getStepIndex()', () => {
    it('returns correct index for each step', () => {
      expect(getStepIndex('fetch_knowledge')).toBe(0);
      expect(getStepIndex('build_strategy')).toBe(1);
      expect(getStepIndex('post_actions')).toBe(10);
    });

    it('returns -1 for idle (not a pipeline step)', () => {
      expect(getStepIndex('idle')).toBe(-1);
    });
  });

  describe('startPipeline()', () => {
    it('initializes state with first step', async () => {
      await startPipeline('goal-001');

      const state = getPipelineState();
      expect(state).not.toBeNull();
      expect(state!.goalId).toBe('goal-001');
      expect(state!.currentStep).toBe('fetch_knowledge');
      expect(state!.completedSteps).toEqual([]);
      expect(state!.startedAt).toBeTruthy();
    });

    it('calls writeNow to persist', async () => {
      await startPipeline('goal-002');
      expect(writer.writeNow).toHaveBeenCalled();
    });
  });

  describe('advanceStep()', () => {
    it('advances through steps in order', async () => {
      await startPipeline('goal-003');

      await advanceStep();
      const state = getPipelineState();
      expect(state!.currentStep).toBe('build_strategy');
      expect(state!.completedSteps).toContain('fetch_knowledge');
    });

    it('advances through all 11 steps to idle', async () => {
      await startPipeline('goal-004');

      for (let i = 0; i < 11; i++) {
        await advanceStep();
      }

      const state = getPipelineState();
      expect(state!.currentStep).toBe('idle');
      expect(state!.completedSteps).toHaveLength(11);
    });

    it('records changedFiles when provided', async () => {
      await startPipeline('goal-005');
      await advanceStep(['src/foo.ts', 'src/bar.ts']);

      const state = getPipelineState();
      expect(state!.changedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
    });

    it('does nothing when no pipeline is active', async () => {
      await clearPipeline();
      await advanceStep(); // should not throw
      expect(getPipelineState()).toBeNull();
    });
  });

  describe('clearPipeline()', () => {
    it('clears the state to null', async () => {
      await startPipeline('goal-006');
      await clearPipeline();

      expect(getPipelineState()).toBeNull();
    });
  });

  describe('hasInterruptedPipeline()', () => {
    it('returns false when no pipeline', async () => {
      expect(hasInterruptedPipeline()).toBe(false);
    });

    it('returns true when pipeline is active', async () => {
      await startPipeline('goal-007');
      expect(hasInterruptedPipeline()).toBe(true);
    });

    it('returns false when pipeline completed (idle)', async () => {
      await startPipeline('goal-008');
      for (let i = 0; i < 11; i++) {
        await advanceStep();
      }
      expect(hasInterruptedPipeline()).toBe(false);
    });
  });

  describe('getResumeStep()', () => {
    it('returns null when no pipeline', async () => {
      expect(getResumeStep()).toBeNull();
    });

    it('returns current step when pipeline is active', async () => {
      await startPipeline('goal-009');
      expect(getResumeStep()).toBe('fetch_knowledge');

      await advanceStep();
      expect(getResumeStep()).toBe('build_strategy');
    });

    it('returns null when pipeline reached idle', async () => {
      await startPipeline('goal-010');
      for (let i = 0; i < 11; i++) {
        await advanceStep();
      }
      expect(getResumeStep()).toBeNull();
    });
  });

  describe('recordPipelineError()', () => {
    it('records error in pipeline state', async () => {
      await startPipeline('goal-011');
      await recordPipelineError('type check failed');

      const state = getPipelineState();
      expect(state!.error).toBe('type check failed');
    });

    it('does nothing when no pipeline', async () => {
      await recordPipelineError('no pipeline');
      expect(getPipelineState()).toBeNull();
    });
  });

  describe('getPipelineState()', () => {
    it('returns a copy, not the internal reference', async () => {
      await startPipeline('goal-012');
      const a = getPipelineState();
      const b = getPipelineState();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('loadPipelineState()', () => {
    it('loads state from disk', async () => {
      const { readFile } = await import('node:fs/promises');
      const mockRead = vi.mocked(readFile);
      mockRead.mockResolvedValueOnce(JSON.stringify({
        version: 1,
        pipeline: {
          goalId: 'loaded-goal',
          currentStep: 'build_prompt',
          completedSteps: ['fetch_knowledge', 'build_strategy', 'record_intention'],
          startedAt: '2026-02-13T00:00:00Z',
          lastUpdatedAt: '2026-02-13T00:05:00Z',
        },
      }));

      await loadPipelineState();
      const state = getPipelineState();
      expect(state!.goalId).toBe('loaded-goal');
      expect(state!.currentStep).toBe('build_prompt');
    });

    it('sets null when file not found', async () => {
      const { readFile } = await import('node:fs/promises');
      const mockRead = vi.mocked(readFile);
      mockRead.mockRejectedValueOnce(new Error('ENOENT'));

      await loadPipelineState();
      expect(getPipelineState()).toBeNull();
    });
  });
});
