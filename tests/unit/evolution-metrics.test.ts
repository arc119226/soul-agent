import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/writer before importing the module
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { appendJsonl: vi.fn().mockResolvedValue(undefined), schedule: vi.fn() },
}));
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readFile } from 'node:fs/promises';
import { computeStats, computeZScores, type EvolutionMetric } from '../../src/evolution/evolution-metrics.js';

const mockReadFile = vi.mocked(readFile);

function makeMetric(overrides: Partial<EvolutionMetric> = {}): EvolutionMetric {
  return {
    timestamp: new Date().toISOString(),
    goalId: 'test-goal',
    success: true,
    duration: 5000,
    filesChanged: 3,
    ...overrides,
  };
}

describe('computeStats', () => {
  it('returns zeros for empty metrics', () => {
    const stats = computeStats([]);
    expect(stats.total).toBe(0);
    expect(stats.failureRate).toBe(0);
    expect(stats.avgDuration).toBe(0);
  });

  it('computes correct failure rate', () => {
    const metrics = [
      makeMetric({ success: true }),
      makeMetric({ success: true }),
      makeMetric({ success: false }),
      makeMetric({ success: false }),
    ];
    const stats = computeStats(metrics);
    expect(stats.total).toBe(4);
    expect(stats.successes).toBe(2);
    expect(stats.failures).toBe(2);
    expect(stats.failureRate).toBe(0.5);
  });

  it('computes average duration', () => {
    const metrics = [
      makeMetric({ duration: 1000 }),
      makeMetric({ duration: 3000 }),
      makeMetric({ duration: 5000 }),
    ];
    const stats = computeStats(metrics);
    expect(stats.avgDuration).toBe(3000);
  });

  it('computes duration standard deviation', () => {
    const metrics = [
      makeMetric({ duration: 2000 }),
      makeMetric({ duration: 4000 }),
      makeMetric({ duration: 6000 }),
    ];
    const stats = computeStats(metrics);
    expect(stats.stddevDuration).toBeCloseTo(2000, 0);
  });
});

describe('computeZScores', () => {
  it('returns zero scores when insufficient data', () => {
    const metrics = [makeMetric(), makeMetric()];
    const zScores = computeZScores(metrics);
    expect(zScores.failureRateZ).toBe(0);
    expect(zScores.durationZ).toBe(0);
    expect(zScores.isAnomaly).toBe(false);
    expect(zScores.message).toContain('Insufficient');
  });

  it('detects anomalous failure rate spike', () => {
    // Baseline: 7 successes (70% of 10)
    const baseline = Array.from({ length: 7 }, (_, i) =>
      makeMetric({
        success: true,
        timestamp: new Date(Date.now() - (10 - i) * 3600_000).toISOString(),
      }),
    );
    // Recent: 3 failures (30% of 10)
    const recent = Array.from({ length: 3 }, (_, i) =>
      makeMetric({
        success: false,
        timestamp: new Date(Date.now() - (3 - i) * 60_000).toISOString(),
      }),
    );
    const metrics = [...baseline, ...recent];
    const zScores = computeZScores(metrics, 2.0); // Lower threshold for test
    expect(zScores.failureRateZ).toBeGreaterThan(0);
  });

  it('reports normal when everything succeeds', () => {
    const metrics = Array.from({ length: 10 }, (_, i) =>
      makeMetric({
        success: true,
        duration: 5000,
        timestamp: new Date(Date.now() - (10 - i) * 3600_000).toISOString(),
      }),
    );
    const zScores = computeZScores(metrics);
    expect(zScores.isAnomaly).toBe(false);
    expect(zScores.message).toContain('Normal');
  });

  it('detects anomalous duration spike', () => {
    // Baseline: 7 fast runs
    const baseline = Array.from({ length: 7 }, (_, i) =>
      makeMetric({
        success: true,
        duration: 5000,
        timestamp: new Date(Date.now() - (10 - i) * 3600_000).toISOString(),
      }),
    );
    // Recent: 3 very slow runs (100x slower)
    const recent = Array.from({ length: 3 }, (_, i) =>
      makeMetric({
        success: true,
        duration: 500_000,
        timestamp: new Date(Date.now() - (3 - i) * 60_000).toISOString(),
      }),
    );
    const metrics = [...baseline, ...recent];
    const zScores = computeZScores(metrics, 2.0);
    expect(zScores.durationZ).toBeGreaterThan(2.0);
  });

  it('handles all failures gracefully', () => {
    const metrics = Array.from({ length: 6 }, (_, i) =>
      makeMetric({
        success: false,
        timestamp: new Date(Date.now() - (6 - i) * 3600_000).toISOString(),
      }),
    );
    const zScores = computeZScores(metrics);
    // All failures in baseline and recent — consistent failure, not an anomaly
    expect(zScores.isAnomaly).toBe(false);
    // Z-score may be non-zero due to Laplace smoothing but should be small
    expect(Math.abs(zScores.failureRateZ)).toBeLessThan(3.0);
  });
});

describe('getRecentMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const { getRecentMetrics } = await import('../../src/evolution/evolution-metrics.js');
    const metrics = await getRecentMetrics();
    expect(metrics).toEqual([]);
  });

  it('filters metrics within time window', async () => {
    const oldMetric = makeMetric({ timestamp: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() });
    const newMetric = makeMetric({ timestamp: new Date().toISOString() });
    mockReadFile.mockResolvedValue(
      [JSON.stringify(oldMetric), JSON.stringify(newMetric)].join('\n'),
    );
    const { getRecentMetrics } = await import('../../src/evolution/evolution-metrics.js');
    const metrics = await getRecentMetrics(7 * 24 * 3600_000);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.timestamp).toBe(newMetric.timestamp);
  });
});
