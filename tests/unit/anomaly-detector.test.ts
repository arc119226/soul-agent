/**
 * Tests for the statistical anomaly detector (Z-score based).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { AnomalyDetector } from '../../src/lifecycle/anomaly-detector.js';

describe('AnomalyDetector', () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    detector = new AnomalyDetector({
      windowSize: 10,
      zScoreThreshold: 2.0,
      minSamples: 5,
    });
  });

  describe('RollingStats via record + check', () => {
    it('returns no anomaly when below minSamples', () => {
      // Only 3 samples, minSamples is 5
      detector.record('elu', 0.1);
      detector.record('elu', 0.12);
      detector.record('elu', 0.11);

      const result = detector.check('elu', 0.5);
      expect(result.isAnomaly).toBe(false);
      expect(result.zScore).toBe(0); // Not enough data
    });

    it('detects anomaly when value is >2 stddev above mean', () => {
      // Build a baseline with enough variance (stddev > MIN_STDDEV of 0.01)
      const baseline = [0.08, 0.12, 0.15, 0.10, 0.18, 0.11, 0.14, 0.09];
      for (const v of baseline) {
        detector.record('elu', v);
      }

      // Spike to 0.9 — should be a massive Z-score
      const result = detector.check('elu', 0.9);
      expect(result.isAnomaly).toBe(true);
      expect(result.zScore).toBeGreaterThan(2.0);
    });

    it('does not flag normal variation', () => {
      // Build baseline with natural variance around 0.1
      const values = [0.08, 0.12, 0.09, 0.11, 0.10, 0.13, 0.09, 0.11];
      for (const v of values) {
        detector.record('elu', v);
      }

      // 0.12 is within normal range
      const result = detector.check('elu', 0.12);
      expect(result.isAnomaly).toBe(false);
    });

    it('returns zero Z-score when all values are identical (no variance)', () => {
      for (let i = 0; i < 8; i++) {
        detector.record('mem', 100);
      }

      const result = detector.check('mem', 100);
      expect(result.zScore).toBe(0);
      expect(result.isAnomaly).toBe(false);
    });
  });

  describe('detectAnomalies()', () => {
    it('records and checks in one call', () => {
      // Warm up with naturally varying values (prevents near-zero stddev)
      const eluBaseline = [0.08, 0.12, 0.09, 0.11, 0.10, 0.13];
      const heapBaseline = [95, 105, 98, 102, 100, 107];
      for (let i = 0; i < 6; i++) {
        detector.detectAnomalies({ elu: eluBaseline[i]!, heap: heapBaseline[i]! });
      }

      // Normal values → no anomalies
      const normal = detector.detectAnomalies({ elu: 0.11, heap: 101 });
      expect(normal).toHaveLength(0);

      // Spike → anomaly
      const spike = detector.detectAnomalies({ elu: 0.9, heap: 500 });
      expect(spike.length).toBeGreaterThan(0);
      expect(spike.some((a) => a.metric === 'elu')).toBe(true);
    });

    it('returns only anomalous metrics', () => {
      const eluBaseline = [0.08, 0.12, 0.09, 0.11, 0.10, 0.13];
      const heapBaseline = [95, 105, 98, 102, 100, 107];
      for (let i = 0; i < 6; i++) {
        detector.detectAnomalies({ elu: eluBaseline[i]!, heap: heapBaseline[i]! });
      }

      // Only heap spikes, elu stays within range
      const result = detector.detectAnomalies({ elu: 0.10, heap: 500 });
      expect(result.every((a) => a.metric === 'heap')).toBe(true);
    });
  });

  describe('getSummary()', () => {
    it('returns count/mean/stddev for each tracked metric', () => {
      detector.record('elu', 0.1);
      detector.record('elu', 0.2);
      detector.record('heap', 100);

      const summary = detector.getSummary();
      expect(summary['elu']!.count).toBe(2);
      expect(summary['elu']!.mean).toBeCloseTo(0.15, 2);
      expect(summary['heap']!.count).toBe(1);
    });
  });

  describe('reset()', () => {
    it('clears all tracked data', () => {
      detector.record('elu', 0.1);
      detector.reset();

      const summary = detector.getSummary();
      expect(Object.keys(summary)).toHaveLength(0);
    });
  });

  describe('windowSize limit', () => {
    it('evicts oldest values when window is full', () => {
      // Window size is 10
      for (let i = 0; i < 15; i++) {
        detector.record('metric', i);
      }

      const summary = detector.getSummary();
      expect(summary['metric']!.count).toBe(10);
      // Mean should reflect values 5-14 (oldest 0-4 evicted)
      // Mean of 5..14 = (5+6+7+8+9+10+11+12+13+14)/10 = 9.5
      expect(summary['metric']!.mean).toBeCloseTo(9.5, 1);
    });
  });

  describe('custom config', () => {
    it('respects custom zScoreThreshold', () => {
      const strict = new AnomalyDetector({
        windowSize: 10,
        zScoreThreshold: 1.0, // Very strict
        minSamples: 5,
      });

      for (let i = 0; i < 8; i++) {
        strict.record('x', 10);
      }

      // Even a modest deviation should trigger with threshold 1.0
      // Add some variance first
      strict.record('x', 10);
      strict.record('x', 11);

      const result = strict.check('x', 15);
      expect(result.zScore).toBeGreaterThan(1.0);
      expect(result.isAnomaly).toBe(true);
    });
  });
});
