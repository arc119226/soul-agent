/**
 * Tests that kill-switch reacts to lifecycle:anomaly events (Phase 2 wiring).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
  },
}));

// Use real EventBus so we can test event wiring
import { eventBus } from '../../src/core/event-bus.js';
import {
  attachIntegrityListener,
  getSafetyLevel,
  forceReset,
  SafetyLevel,
} from '../../src/safety/kill-switch.js';

describe('kill-switch — lifecycle:anomaly listener', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await forceReset();
  });

  it('attachIntegrityListener registers lifecycle:anomaly handler', () => {
    // Should not throw
    attachIntegrityListener();
  });

  it('records failures for mild anomalies (Z ≤ 3.5)', async () => {
    attachIntegrityListener();

    // Emit mild anomaly — Z-scores below 3.5 only record failures (no direct escalation)
    await eventBus.emit('lifecycle:anomaly', {
      metrics: [
        { metric: 'elu', current: 0.3, mean: 0.1, zScore: 3.0 },
        { metric: 'heap', current: 200, mean: 100, zScore: 2.8 },
      ],
      timestamp: Date.now(),
    });

    // Mild anomalies only call recordFailure() — not enough to escalate
    expect(getSafetyLevel()).toBe(SafetyLevel.NORMAL);
  });

  it('escalates to RESTRICTED for severe anomalies (Z > 3.5)', async () => {
    attachIntegrityListener();

    await eventBus.emit('lifecycle:anomaly', {
      metrics: [
        { metric: 'elu', current: 0.8, mean: 0.1, zScore: 4.0 },
      ],
      timestamp: Date.now(),
    });

    expect(getSafetyLevel()).toBe(SafetyLevel.RESTRICTED);
  });

  it('escalates to EMERGENCY for critical anomalies (Z > 4.5)', async () => {
    attachIntegrityListener();

    await eventBus.emit('lifecycle:anomaly', {
      metrics: [
        { metric: 'elu', current: 0.95, mean: 0.1, zScore: 8.0 },
      ],
      timestamp: Date.now(),
    });

    expect(getSafetyLevel()).toBe(SafetyLevel.EMERGENCY);
  });

  it('records failures from soul:integrity_mismatch', async () => {
    attachIntegrityListener();

    await eventBus.emit('soul:integrity_mismatch', {
      changedFiles: ['soul/genesis.md'],
      expected: 'aaa',
      actual: 'bbb',
    });

    // Single mismatch should not escalate
    expect(getSafetyLevel()).toBe(SafetyLevel.NORMAL);
  });
});
