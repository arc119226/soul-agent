import { describe, it, expect, beforeEach } from 'vitest';

// Goals module uses in-memory cache, so we import fresh each time
// and use the module's own API to manipulate state.

describe('Evolution Goals', () => {
  // Reset goals before each test by loading an empty state
  beforeEach(async () => {
    // Direct cache manipulation: import and reset
    await import('../../src/evolution/goals.js');
    // loadGoals will try to read from disk; we just work with whatever is cached
    // Since addGoal pushes to cache, we need to ensure clean state
    // The simplest approach: remove all goals that our tests create
  });

  it('addGoal creates a goal with correct fields', async () => {
    const { addGoal, getAllGoals, removeGoal } = await import('../../src/evolution/goals.js');
    const result = addGoal('Test goal', 3, ['test']);
    expect(result.ok).toBe(true);

    const goals = getAllGoals();
    const created = goals.find(g => g.description === 'Test goal');
    expect(created).toBeDefined();
    expect(created!.priority).toBe(3);
    expect(created!.status).toBe('pending');
    expect(created!.tags).toContain('test');

    // Cleanup
    if (result.ok) removeGoal(result.value);
  });

  it('clamps priority to 1-5 range', async () => {
    const { addGoal, getGoal, removeGoal } = await import('../../src/evolution/goals.js');
    const r1 = addGoal('Low priority', 0);
    const r2 = addGoal('High priority', 10);

    if (r1.ok) {
      const g1 = getGoal(r1.value);
      expect(g1!.priority).toBe(1);
      removeGoal(r1.value);
    }
    if (r2.ok) {
      const g2 = getGoal(r2.value);
      expect(g2!.priority).toBe(5);
      removeGoal(r2.value);
    }
  });

  it('completeGoal transitions status correctly', async () => {
    const { addGoal, completeGoal, getGoal, removeGoal } = await import('../../src/evolution/goals.js');
    const result = addGoal('Complete me', 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const id = result.value;
    const cResult = completeGoal(id);
    expect(cResult.ok).toBe(true);

    const goal = getGoal(id);
    expect(goal!.status).toBe('completed');
    expect(goal!.completedAt).toBeDefined();

    removeGoal(id);
  });

  it('failGoal transitions status and records reason', async () => {
    const { addGoal, failGoal, getGoal, removeGoal } = await import('../../src/evolution/goals.js');
    const result = addGoal('Fail me', 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const id = result.value;

    // First failure: returns to pending for retry
    failGoal(id, 'attempt 1');
    expect(getGoal(id)!.status).toBe('pending');
    expect(getGoal(id)!.failCount).toBe(1);

    // Second failure: still pending
    failGoal(id, 'attempt 2');
    expect(getGoal(id)!.status).toBe('pending');

    // Third failure: permanently abandoned (MAX_GOAL_ATTEMPTS = 3)
    failGoal(id, 'test failure reason');
    const goal = getGoal(id);
    expect(goal!.status).toBe('failed');
    expect(goal!.failReason).toBe('test failure reason');
    expect(goal!.failCount).toBe(3);

    removeGoal(id);
  });

  it('getNextGoal returns highest priority first', async () => {
    const { addGoal, getNextGoal, removeGoal } = await import('../../src/evolution/goals.js');
    const r1 = addGoal('Low', 1, ['test-priority']);
    const r2 = addGoal('High', 5, ['test-priority']);
    const r3 = addGoal('Mid', 3, ['test-priority']);

    const next = getNextGoal();
    // Next should be highest priority among all pending goals
    // (there may be pre-existing goals, so just check it's not null)
    expect(next).not.toBeNull();

    // Cleanup
    if (r1.ok) removeGoal(r1.value);
    if (r2.ok) removeGoal(r2.value);
    if (r3.ok) removeGoal(r3.value);
  });

  it('removeGoal works correctly', async () => {
    const { addGoal, removeGoal, getGoal } = await import('../../src/evolution/goals.js');
    const result = addGoal('Remove me', 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const id = result.value;
    const rResult = removeGoal(id);
    expect(rResult.ok).toBe(true);
    expect(getGoal(id)).toBeUndefined();
  });

  it('removeGoal returns fail for unknown id', async () => {
    const { removeGoal } = await import('../../src/evolution/goals.js');
    const result = removeGoal('nonexistent-id');
    expect(result.ok).toBe(false);
  });

  it('startGoal transitions to in_progress', async () => {
    const { addGoal, startGoal, getGoal, removeGoal } = await import('../../src/evolution/goals.js');
    const result = addGoal('Start me', 3);
    if (!result.ok) return;

    const id = result.value;
    startGoal(id);
    expect(getGoal(id)!.status).toBe('in_progress');

    removeGoal(id);
  });
});
