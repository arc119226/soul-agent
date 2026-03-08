import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, fail as resultFail } from '../../src/result.js';

/**
 * Plan Manager tests.
 *
 * Since plan-manager does heavy file I/O, we mock the debounced-writer
 * and fs modules to focus on business logic.
 */

// In-memory store for plans written via the mocked writer
const planStore = new Map<string, string>();
let appendedLines: Array<{ path: string; data: unknown }> = [];

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    writeNow: vi.fn(async (path: string, data: unknown) => {
      planStore.set(path, JSON.stringify(data));
    }),
    appendJsonl: vi.fn(async (path: string, data: unknown) => {
      appendedLines.push({ path, data });
    }),
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...orig,
    readFile: vi.fn(async (path: string) => {
      const content = planStore.get(path);
      if (content) return content;
      throw new Error('ENOENT');
    }),
    readdir: vi.fn(async () => {
      // Return filenames derived from planStore keys
      const files: string[] = [];
      for (const key of planStore.keys()) {
        const parts = key.replace(/\\/g, '/').split('/');
        const filename = parts[parts.length - 1];
        if (filename.endsWith('.json') && !filename.startsWith('_')) {
          files.push(filename);
        }
      }
      return files;
    }),
  };
});

// Mock logger to silence output
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock eventBus to capture events
const emittedEvents: Array<{ event: string; data: unknown }> = [];
vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn(async (event: string, data: unknown) => {
      emittedEvents.push({ event, data });
    }),
    on: vi.fn(),
  },
}));

describe('Plan Manager', () => {
  beforeEach(() => {
    planStore.clear();
    appendedLines = [];
    emittedEvents.length = 0;
  });

  it('createPlan returns ok with plan object', async () => {
    const { createPlan } = await import('../../src/planning/plan-manager.js');

    const result = await createPlan({
      title: 'Test Plan',
      intention: 'To test the plan system',
      approach: 'Write unit tests',
      steps: ['Step 1: Write tests', 'Step 2: Run tests'],
      triggeredBy: 'user',
      triggerContext: 'Testing session',
      successCriteria: 'All tests pass',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const plan = result.value;
    expect(plan.title).toBe('Test Plan');
    expect(plan.intention).toBe('To test the plan system');
    expect(plan.status).toBe('draft');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].completed).toBe(false);
    expect(plan.steps[0].id).toBe(1);
    expect(plan.steps[1].id).toBe(2);
  });

  it('createPlan emits plan:created event', async () => {
    const { createPlan } = await import('../../src/planning/plan-manager.js');

    await createPlan({
      title: 'Event Test',
      intention: 'Check events',
      approach: 'Verify',
      steps: ['One step'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Event emitted',
    });

    const planEvent = emittedEvents.find(e => e.event === 'plan:created');
    expect(planEvent).toBeDefined();
    expect((planEvent!.data as { title: string }).title).toBe('Event Test');
  });

  it('createPlan appends to index', async () => {
    const { createPlan } = await import('../../src/planning/plan-manager.js');

    await createPlan({
      title: 'Index Test',
      intention: 'Check index',
      approach: 'Verify',
      steps: ['Step'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Index entry exists',
    });

    expect(appendedLines.length).toBeGreaterThan(0);
    const entry = appendedLines[appendedLines.length - 1].data as { title: string; status: string };
    expect(entry.title).toBe('Index Test');
    expect(entry.status).toBe('draft');
  });

  it('activatePlan sets status to active and records startedAt', async () => {
    const { createPlan, activatePlan } = await import('../../src/planning/plan-manager.js');

    const createResult = await createPlan({
      title: 'Activate Test',
      intention: 'Test activation',
      approach: 'Call activate',
      steps: ['Step'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Status is active',
    });
    if (!createResult.ok) return;

    const result = await activatePlan(createResult.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('active');
    expect(result.value.startedAt).toBeDefined();
  });

  it('activatePlan returns fail for nonexistent plan', async () => {
    const { activatePlan } = await import('../../src/planning/plan-manager.js');
    const result = await activatePlan('nonexistent');
    expect(result.ok).toBe(false);
  });

  it('completeStep marks a step as completed', async () => {
    const { createPlan, completeStep } = await import('../../src/planning/plan-manager.js');

    const createResult = await createPlan({
      title: 'Step Test',
      intention: 'Test step completion',
      approach: 'Complete steps',
      steps: ['Step 1', 'Step 2'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Steps completed',
    });
    if (!createResult.ok) return;

    const result = await completeStep(createResult.value.id, 1, 'Done with notes');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const step1 = result.value.steps.find(s => s.id === 1);
    expect(step1!.completed).toBe(true);
    expect(step1!.completedAt).toBeDefined();
    expect(step1!.notes).toBe('Done with notes');

    // Step 2 should still be incomplete
    const step2 = result.value.steps.find(s => s.id === 2);
    expect(step2!.completed).toBe(false);
  });

  it('completing all steps auto-completes an active plan', async () => {
    const { createPlan, activatePlan, completeStep } = await import('../../src/planning/plan-manager.js');

    const createResult = await createPlan({
      title: 'Auto-Complete Test',
      intention: 'Test auto-completion',
      approach: 'Complete all steps',
      steps: ['Step 1', 'Step 2'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Plan auto-completes',
    });
    if (!createResult.ok) return;

    await activatePlan(createResult.value.id);
    await completeStep(createResult.value.id, 1);
    const result = await completeStep(createResult.value.id, 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('completed');
    expect(result.value.completedAt).toBeDefined();
  });

  it('completeStep returns fail for nonexistent step', async () => {
    const { createPlan, completeStep } = await import('../../src/planning/plan-manager.js');

    const createResult = await createPlan({
      title: 'Bad Step Test',
      intention: 'Test',
      approach: 'Try bad step',
      steps: ['Step 1'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Fail returned',
    });
    if (!createResult.ok) return;

    const result = await completeStep(createResult.value.id, 999);
    expect(result.ok).toBe(false);
  });

  it('abandonPlan sets status and records reason', async () => {
    const { createPlan, abandonPlan } = await import('../../src/planning/plan-manager.js');

    const createResult = await createPlan({
      title: 'Abandon Test',
      intention: 'Test abandonment',
      approach: 'Abandon it',
      steps: ['Step'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Plan abandoned',
    });
    if (!createResult.ok) return;

    const result = await abandonPlan(createResult.value.id, 'No longer needed');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('abandoned');
    expect(result.value.retrospective).toContain('No longer needed');
  });

  it('abandonPlan emits plan:abandoned event', async () => {
    const { createPlan, abandonPlan } = await import('../../src/planning/plan-manager.js');

    const createResult = await createPlan({
      title: 'Event Abandon Test',
      intention: 'Test event',
      approach: 'Abandon',
      steps: ['Step'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Event emitted',
    });
    if (!createResult.ok) return;

    await abandonPlan(createResult.value.id, 'Testing');

    const abandonEvent = emittedEvents.find(e => e.event === 'plan:abandoned');
    expect(abandonEvent).toBeDefined();
  });

  it('completePlan clamps satisfactionLevel to 1-5', async () => {
    const { createPlan, completePlan } = await import('../../src/planning/plan-manager.js');

    const createResult = await createPlan({
      title: 'Satisfaction Test',
      intention: 'Test clamping',
      approach: 'Complete with extreme value',
      steps: ['Step'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Clamped',
    });
    if (!createResult.ok) return;

    const result = await completePlan(
      createResult.value.id,
      'Great work',
      'Learned a lot',
      10, // should clamp to 5
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.satisfactionLevel).toBe(5);
  });

  it('getPlansSummary returns formatted string for active plans', async () => {
    const { createPlan, activatePlan, getPlansSummary } = await import('../../src/planning/plan-manager.js');

    const createResult = await createPlan({
      title: 'Summary Test Plan',
      intention: 'Test summary output',
      approach: 'Check format',
      steps: ['Step 1', 'Step 2', 'Step 3'],
      triggeredBy: 'test',
      triggerContext: 'unit test',
      successCriteria: 'Summary generated',
    });
    if (!createResult.ok) return;

    await activatePlan(createResult.value.id);

    const summary = await getPlansSummary();
    expect(summary).toContain('你目前的計劃');
    expect(summary).toContain('Summary Test Plan');
    expect(summary).toContain('0/3 步驟完成');
  });

  it('getPlansSummary returns empty string when no active plans', async () => {
    const { getPlansSummary } = await import('../../src/planning/plan-manager.js');
    const summary = await getPlansSummary();
    expect(summary).toBe('');
  });
});
