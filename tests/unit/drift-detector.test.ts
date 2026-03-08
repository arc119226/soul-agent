import { describe, it, expect } from 'vitest';
import { pageHinkleyTest, detectAgentDrift } from '../../src/agents/monitoring/drift-detector.js';
import type { TrendPoint } from '../../src/agents/monitoring/stats-snapshot.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeTrend(values: number[], startDate = '2026-02-25'): TrendPoint[] {
  const [y, m, d] = startDate.split('-').map(Number);
  return values.map((value, i) => {
    const date = new Date(y!, m! - 1, d! + i);
    const dateStr = date.toISOString().slice(0, 10);
    return { date: dateStr, value };
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe('drift-detector', () => {
  describe('pageHinkleyTest()', () => {
    it('returns no drift for stable series', () => {
      const points = makeTrend([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
      const result = pageHinkleyTest(points, 'cost');

      expect(result.detected).toBe(false);
      expect(result.direction).toBe('none');
    });

    it('returns insufficient data when less than minSamples', () => {
      const points = makeTrend([0.5, 0.6, 0.7]);
      const result = pageHinkleyTest(points, 'cost');

      expect(result.detected).toBe(false);
      expect(result.summary).toContain('Insufficient data');
    });

    it('detects upward drift', () => {
      // Stable low then sustained high — strong enough to exceed lambda=3
      const points = makeTrend([0.1, 0.1, 0.1, 0.1, 0.1, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0]);
      const result = pageHinkleyTest(points, 'cost');

      expect(result.detected).toBe(true);
      expect(result.direction).toBe('increase');
    });

    it('detects downward drift', () => {
      // Stable high then sustained low — needs enough data to accumulate past lambda=4
      const points = makeTrend([
        0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9,
        0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
      ]);
      const result = pageHinkleyTest(points, 'confidence');

      expect(result.detected).toBe(true);
      expect(result.direction).toBe('decrease');
    });
  });

  describe('detectAgentDrift() — coordination metrics', () => {
    it('detects handoffFeedbackRate drift', () => {
      const costTrend = makeTrend([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
      const confTrend = makeTrend([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8]);
      const failTrend = makeTrend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      // Feedback rate: stable low then sustained high (delta=0.1, lambda=4)
      const fbRateTrend = makeTrend([0, 0, 0, 0, 0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0]);
      const durCvTrend = makeTrend([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);

      const report = detectAgentDrift('test-agent', costTrend, confTrend, failTrend, fbRateTrend, durCvTrend);

      expect(report.hasDrift).toBe(true);
      const fbDrift = report.drifts.find(d => d.metric === 'handoffFeedbackRate');
      expect(fbDrift).toBeDefined();
      expect(fbDrift!.detected).toBe(true);
      expect(fbDrift!.direction).toBe('increase');
    });

    it('detects durationCv drift', () => {
      const costTrend = makeTrend([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
      const confTrend = makeTrend([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8]);
      const failTrend = makeTrend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const fbRateTrend = makeTrend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      // Duration CV: stable low then sustained high (delta=0.05, lambda=4)
      const durCvTrend = makeTrend([0.1, 0.1, 0.1, 0.1, 0.1, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0]);

      const report = detectAgentDrift('test-agent', costTrend, confTrend, failTrend, fbRateTrend, durCvTrend);

      expect(report.hasDrift).toBe(true);
      const cvDrift = report.drifts.find(d => d.metric === 'durationCv');
      expect(cvDrift).toBeDefined();
      expect(cvDrift!.detected).toBe(true);
      expect(cvDrift!.direction).toBe('increase');
    });

    it('reports no coordination drift when trends are stable', () => {
      const costTrend = makeTrend([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
      const confTrend = makeTrend([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8]);
      const failTrend = makeTrend([0, 0, 0, 0, 0, 0, 0]);
      const fbRateTrend = makeTrend([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
      const durCvTrend = makeTrend([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);

      const report = detectAgentDrift('test-agent', costTrend, confTrend, failTrend, fbRateTrend, durCvTrend);

      expect(report.hasDrift).toBe(false);
      expect(report.drifts).toHaveLength(5); // 3 base + 2 coordination
      expect(report.drifts.every(d => !d.detected)).toBe(true);
    });

    it('includes 5 drift results when coordination trends provided', () => {
      const costTrend = makeTrend([0.1, 0.1, 0.1, 0.1, 0.1]);
      const confTrend = makeTrend([0.8, 0.8, 0.8, 0.8, 0.8]);
      const failTrend = makeTrend([0, 0, 0, 0, 0]);
      const fbRateTrend = makeTrend([0, 0, 0, 0, 0]);
      const durCvTrend = makeTrend([0.2, 0.2, 0.2, 0.2, 0.2]);

      const report = detectAgentDrift('test-agent', costTrend, confTrend, failTrend, fbRateTrend, durCvTrend);

      const metrics = report.drifts.map(d => d.metric);
      expect(metrics).toContain('cost');
      expect(metrics).toContain('confidence');
      expect(metrics).toContain('failures');
      expect(metrics).toContain('handoffFeedbackRate');
      expect(metrics).toContain('durationCv');
    });

    it('gracefully handles empty coordination trends (backward compat)', () => {
      const costTrend = makeTrend([0.1, 0.1, 0.1, 0.1, 0.1]);
      const confTrend = makeTrend([0.8, 0.8, 0.8, 0.8, 0.8]);
      const failTrend = makeTrend([0, 0, 0, 0, 0]);

      const report = detectAgentDrift('test-agent', costTrend, confTrend, failTrend);

      // Only base 3 metrics when coordination trends not provided
      expect(report.drifts).toHaveLength(3);
    });
  });
});
