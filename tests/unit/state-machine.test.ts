import { describe, it, expect, beforeEach } from 'vitest';

// Mock dependencies
import { vi } from 'vitest';

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

import {
  getCurrentState,
  setInitialState,
  transition,
  getStateDuration,
  getStateEnteredAt,
} from '../../src/lifecycle/state-machine.js';

describe('StateMachine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setInitialState('active');
  });

  it('starts in the set initial state', () => {
    expect(getCurrentState()).toBe('active');
  });

  it('tracks stateEnteredAt as a recent timestamp', () => {
    const before = Date.now();
    setInitialState('active');
    expect(getStateEnteredAt()).toBeGreaterThanOrEqual(before);
    expect(getStateEnteredAt()).toBeLessThanOrEqual(Date.now());
  });

  it('getStateDuration returns non-negative value', () => {
    setInitialState('active');
    expect(getStateDuration()).toBeGreaterThanOrEqual(0);
  });

  it('allows valid transition: active → thinking', async () => {
    const ok = await transition('thinking', 'test');
    expect(ok).toBe(true);
    expect(getCurrentState()).toBe('thinking');
  });

  it('allows valid transition: active → dormant', async () => {
    const ok = await transition('dormant', 'test');
    expect(ok).toBe(true);
    expect(getCurrentState()).toBe('dormant');
  });

  it('rejects invalid transition: thinking → dormant', async () => {
    await transition('thinking', 'setup');
    const ok = await transition('dormant', 'test');
    expect(ok).toBe(false);
    expect(getCurrentState()).toBe('thinking');
  });

  it('rejects invalid transition: dormant → thinking', async () => {
    await transition('dormant', 'setup');
    const ok = await transition('thinking', 'test');
    expect(ok).toBe(false);
    expect(getCurrentState()).toBe('dormant');
  });

  it('transition to same state returns true without changing timestamp', async () => {
    const ts1 = getStateEnteredAt();
    const ok = await transition('active', 'noop');
    expect(ok).toBe(true);
    // Same state = no re-entry, so timestamp stays
    expect(getStateEnteredAt()).toBe(ts1);
  });
});
