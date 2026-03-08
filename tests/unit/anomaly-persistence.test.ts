import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn(), appendJsonl: vi.fn() },
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
import { writer } from '../../src/core/debounced-writer.js';
import { AnomalyDetector, type RollingStatsSnapshot } from '../../src/lifecycle/anomaly-detector.js';

const mockReadFile = vi.mocked(readFile);
const mockSchedule = vi.mocked(writer.schedule);

describe('AnomalyDetector baseline persistence', () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new AnomalyDetector({ windowSize: 10, minSamples: 3, zScoreThreshold: 2.5 });
  });

  describe('exportBaselines / importBaselines', () => {
    it('exports empty baselines for fresh detector', () => {
      const baselines = detector.exportBaselines();
      expect(Object.keys(baselines)).toHaveLength(0);
    });

    it('exports populated baselines after recording', () => {
      detector.record('cpu', 50);
      detector.record('cpu', 60);
      detector.record('memory', 70);

      const baselines = detector.exportBaselines();
      expect(Object.keys(baselines)).toHaveLength(2);
      expect(baselines['cpu']!.values).toEqual([50, 60]);
      expect(baselines['cpu']!.maxSize).toBe(10);
      expect(baselines['memory']!.values).toEqual([70]);
    });

    it('round-trips through export/import', () => {
      // Record data
      for (let i = 0; i < 5; i++) {
        detector.record('elu', 0.1 + i * 0.05);
        detector.record('fatigue', 20 + i * 5);
      }

      // Export
      const exported = detector.exportBaselines();

      // Create new detector and import
      const detector2 = new AnomalyDetector({ windowSize: 10, minSamples: 3, zScoreThreshold: 2.5 });
      const restored = detector2.importBaselines(exported);
      expect(restored).toBe(2);

      // Verify the imported detector has the same summary
      const summary1 = detector.getSummary();
      const summary2 = detector2.getSummary();
      expect(summary2['elu']!.count).toBe(summary1['elu']!.count);
      expect(summary2['elu']!.mean).toBeCloseTo(summary1['elu']!.mean, 5);
      expect(summary2['fatigue']!.count).toBe(summary1['fatigue']!.count);
    });

    it('import respects window size (trims excess)', () => {
      const bigBaseline: Record<string, RollingStatsSnapshot> = {
        metric: { values: Array.from({ length: 100 }, (_, i) => i), maxSize: 10 },
      };
      const restored = detector.importBaselines(bigBaseline);
      expect(restored).toBe(1);

      const summary = detector.getSummary();
      expect(summary['metric']!.count).toBe(10); // trimmed to maxSize
    });

    it('skips empty values during import', () => {
      const baselines: Record<string, RollingStatsSnapshot> = {
        empty: { values: [], maxSize: 10 },
        valid: { values: [1, 2, 3], maxSize: 10 },
      };
      const restored = detector.importBaselines(baselines);
      expect(restored).toBe(1); // Only 'valid' restored
    });
  });

  describe('saveBaselines / loadBaselines', () => {
    it('saves baselines via writer.schedule', async () => {
      detector.record('cpu', 50);
      detector.record('cpu', 60);

      await detector.saveBaselines('/test/baselines.json');

      expect(mockSchedule).toHaveBeenCalledTimes(1);
      const [path, data] = mockSchedule.mock.calls[0]!;
      expect(path).toBe('/test/baselines.json');
      expect(data).toHaveProperty('savedAt');
      expect(data).toHaveProperty('baselines');
      expect((data as { baselines: Record<string, unknown> }).baselines).toHaveProperty('cpu');
    });

    it('does not save when no baselines exist', async () => {
      await detector.saveBaselines('/test/baselines.json');
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it('loads baselines from disk', async () => {
      // Prepare saved data
      detector.record('elu', 0.15);
      detector.record('elu', 0.20);
      detector.record('elu', 0.25);
      const exported = detector.exportBaselines();

      const savedContent = JSON.stringify({
        savedAt: new Date().toISOString(),
        baselines: exported,
      });
      mockReadFile.mockResolvedValue(savedContent);

      // Create fresh detector and load
      const detector2 = new AnomalyDetector({ windowSize: 10, minSamples: 3, zScoreThreshold: 2.5 });
      const count = await detector2.loadBaselines('/test/baselines.json');
      expect(count).toBe(1);

      const summary = detector2.getSummary();
      expect(summary['elu']!.count).toBe(3);
      expect(summary['elu']!.mean).toBeCloseTo(0.2, 5);
    });

    it('returns 0 when file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const count = await detector.loadBaselines('/nonexistent.json');
      expect(count).toBe(0);
    });

    it('detection works immediately after loading baselines', async () => {
      // Build baselines: 5 records of low elu with slight variance
      const eluValues = [0.08, 0.10, 0.12, 0.09, 0.11];
      for (const v of eluValues) {
        detector.record('elu', v);
      }
      const exported = detector.exportBaselines();

      // New detector with restored baselines
      const detector2 = new AnomalyDetector({ windowSize: 10, minSamples: 3, zScoreThreshold: 2.5 });
      detector2.importBaselines(exported);

      // Now detect — high elu should be anomalous (0.9 is ~50 stddevs above mean)
      const result = detector2.check('elu', 0.9);
      expect(result.isAnomaly).toBe(true);
      expect(result.zScore).toBeGreaterThan(2.5);
    });
  });
});
