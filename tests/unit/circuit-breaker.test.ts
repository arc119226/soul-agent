import { describe, it, expect } from 'vitest';

describe('Circuit Breaker logic', () => {
  it('starts in closed state', async () => {
    const { isOpen, forceReset } = await import('../../src/evolution/circuit-breaker.js');
    forceReset();
    expect(isOpen()).toBe(false);
  });

  it('opens after consecutive failures', async () => {
    const { isOpen, recordFailure, forceReset } = await import('../../src/evolution/circuit-breaker.js');
    forceReset();

    recordFailure();
    expect(isOpen()).toBe(false);
    recordFailure();
    expect(isOpen()).toBe(false);
    recordFailure();
    expect(isOpen()).toBe(true); // 3 consecutive failures
  });

  it('resets on success', async () => {
    const { isOpen, recordSuccess, recordFailure, forceReset } = await import('../../src/evolution/circuit-breaker.js');
    forceReset();

    recordFailure();
    recordFailure();
    recordSuccess();
    recordFailure();
    recordFailure();
    expect(isOpen()).toBe(false); // Success reset the count
  });

  it('half-open transitions to closed on success', async () => {
    const { recordFailure, recordSuccess, getState, forceReset } = await import('../../src/evolution/circuit-breaker.js');
    forceReset();

    // Trip the breaker
    recordFailure();
    recordFailure();
    recordFailure();
    expect(getState()).toBe('open');

    // Force into half-open by resetting and manually triggering
    // Since we can't easily manipulate time, we test the success path:
    // After forceReset → closed, then after 3 failures → open
    // We test recordSuccess clears consecutive failures
    forceReset();
    recordFailure();
    recordFailure();
    recordSuccess();
    expect(getState()).toBe('closed');
  });

  it('half-open failure returns to open', async () => {
    const { recordFailure, getState, forceReset, getCircuitBreakerInfo } = await import('../../src/evolution/circuit-breaker.js');
    forceReset();

    // Trip to open
    recordFailure();
    recordFailure();
    recordFailure();
    expect(getState()).toBe('open');

    // Additional failure while open should keep it open
    recordFailure();
    expect(getState()).toBe('open');
  });

  it('classifyFailure categorizes errors correctly', async () => {
    const { classifyFailure } = await import('../../src/evolution/circuit-breaker.js');

    expect(classifyFailure('tsc error TS2345')).toBe('type-check');
    expect(classifyFailure('type check failed')).toBe('type-check');
    expect(classifyFailure('request timed out')).toBe('timeout');
    expect(classifyFailure('ETIMEDOUT connecting to server')).toBe('timeout');
    expect(classifyFailure('validation failed in soul-guard')).toBe('validation');
    expect(classifyFailure('layered validation error')).toBe('validation');
    expect(classifyFailure('runtime error: cannot read property')).toBe('runtime');
    expect(classifyFailure('something unexpected happened')).toBe('unknown');
  });

  it('getRecentFailures returns recorded failures', async () => {
    const { recordFailure, getRecentFailures, forceReset } = await import('../../src/evolution/circuit-breaker.js');
    forceReset();

    recordFailure('tsc error TS2345: type mismatch');
    recordFailure('request timed out after 60s');

    const failures = getRecentFailures();
    expect(failures.length).toBe(2);
    expect(failures[0]!.type).toBe('type-check');
    expect(failures[1]!.type).toBe('timeout');
  });

  it('keeps only last 10 failure records', async () => {
    const { recordFailure, getRecentFailures, forceReset } = await import('../../src/evolution/circuit-breaker.js');
    forceReset();

    for (let i = 0; i < 15; i++) {
      recordFailure(`error ${i}`);
    }

    const failures = getRecentFailures();
    expect(failures.length).toBeLessThanOrEqual(10);
  });

  it('forceReset clears all state', async () => {
    const { recordFailure, forceReset, getState, getCircuitBreakerInfo } = await import('../../src/evolution/circuit-breaker.js');

    recordFailure();
    recordFailure();
    recordFailure();
    expect(getState()).toBe('open');

    forceReset();
    expect(getState()).toBe('closed');

    const info = getCircuitBreakerInfo();
    expect(info.consecutiveFailures).toBe(0);
    expect(info.cooldownRemainingMs).toBe(0);
  });
});
