import { describe, it, expect } from 'vitest';

describe('run_tests step integration', () => {
  it('pipeline-state includes run_tests in step order', async () => {
    const { getStepOrder } = await import('../../src/evolution/pipeline-state.js');
    const steps = getStepOrder();
    expect(steps).toContain('run_tests');
    // Verify ordering: run_tests comes after basic_validation, before layered_validation
    const runTestsIdx = steps.indexOf('run_tests');
    const basicIdx = steps.indexOf('basic_validation');
    const layeredIdx = steps.indexOf('layered_validation');
    expect(runTestsIdx).toBeGreaterThan(basicIdx);
    expect(runTestsIdx).toBeLessThan(layeredIdx);
  });

  it('pipeline has 11 steps', async () => {
    const { getTotalSteps } = await import('../../src/evolution/pipeline-state.js');
    expect(getTotalSteps()).toBe(11);
  });

  it('run_tests step index is 7 (0-based)', async () => {
    const { getStepIndex } = await import('../../src/evolution/pipeline-state.js');
    expect(getStepIndex('run_tests')).toBe(7);
  });
});
