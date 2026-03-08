import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockWriteNow = vi.fn(async (path: string, data: unknown) => {
  fileContents[path] = JSON.stringify(data);
});
vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { writeNow: (...args: unknown[]) => mockWriteNow(...args) },
}));

vi.mock('../../src/agents/config/agent-config.js', () => ({
  loadAllAgentConfigs: vi.fn(),
}));

vi.mock('../../src/core/database.js', () => ({
  getDb: vi.fn(() => { throw new Error('DB not available in test'); }),
}));

let existingFiles: Set<string> = new Set();
let dirContents: string[] = [];
let fileContents: Record<string, string> = {};

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn(async (path: string) => {
    if (existingFiles.has(path)) return;
    throw new Error('ENOENT');
  }),
  readdir: vi.fn(async () => dirContents),
  readFile: vi.fn(async (path: string) => {
    const content = fileContents[path];
    if (content !== undefined) return content;
    throw new Error('ENOENT');
  }),
}));

import { snapshotDailyStats, getAgentTrends, addAgentToSnapshot } from '../../src/agents/monitoring/stats-snapshot.js';
import { loadAllAgentConfigs } from '../../src/agents/config/agent-config.js';
import type { AgentConfig } from '../../src/agents/config/agent-config.js';
import { join } from 'node:path';

const STATS_DIR = join(process.cwd(), 'soul', 'agent-stats', 'daily');

// ── Helpers ─────────────────────────────────────────────────────────

function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: '',
    enabled: true,
    schedule: 'manual',
    systemPrompt: '',
    model: '',
    maxTurns: 100,
    timeout: 120_000,
    dailyCostLimit: 0.50,
    notifyChat: false,
    targets: {},
    lastRun: null,
    totalCostToday: 0,
    costResetDate: '2026-03-01',
    totalRuns: 10,
    createdAt: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('stats-snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existingFiles = new Set();
    dirContents = [];
    fileContents = {};
  });

  describe('snapshotDailyStats()', () => {
    it('creates snapshot with agent stats for matching costResetDate', async () => {
      const agents = [
        makeAgent('explorer', { costResetDate: '2026-03-01', runsToday: 3, totalCostToday: 0.15, valueScore: 0.8 }),
        makeAgent('programmer', { costResetDate: '2026-03-01', runsToday: 5, totalCostToday: 0.30, valueScore: 0.9, failureCount7d: 1 }),
      ];
      vi.mocked(loadAllAgentConfigs).mockResolvedValue(agents);

      await snapshotDailyStats('2026-03-01');

      expect(mockWriteNow).toHaveBeenCalledTimes(2); // per-agent writes
      // Last call contains merged data for all agents
      const [filePath, data] = mockWriteNow.mock.calls[1];
      expect(filePath).toBe(join(STATS_DIR, '2026-03-01.json'));
      expect(data.date).toBe('2026-03-01');
      expect(data.agents.explorer).toEqual({
        runs: 3,
        failures: 0,
        totalCost: 0.15,
        avgConfidence: 0.8,
        avgDuration: 0,
        topFailureReason: undefined,
      });
      expect(data.agents.programmer.runs).toBe(5);
      expect(data.agents.programmer.failures).toBe(1);
      expect(data.systemTotals.totalRuns).toBe(8);
      expect(data.systemTotals.totalCost).toBeCloseTo(0.45);
      expect(data.systemTotals.activeAgents).toBe(2);
    });

    it('skips agents with non-matching costResetDate', async () => {
      const agents = [
        makeAgent('explorer', { costResetDate: '2026-03-01', runsToday: 3, totalCostToday: 0.15 }),
        makeAgent('stale', { costResetDate: '2026-02-28', runsToday: 2, totalCostToday: 0.10 }),
      ];
      vi.mocked(loadAllAgentConfigs).mockResolvedValue(agents);

      await snapshotDailyStats('2026-03-01');

      const [, data] = mockWriteNow.mock.calls[0];
      expect(data.agents.explorer).toBeDefined();
      expect(data.agents.stale).toBeUndefined();
      expect(data.systemTotals.activeAgents).toBe(1);
    });

    it('skips agents with zero runs and zero cost', async () => {
      const agents = [
        makeAgent('idle', { costResetDate: '2026-03-01', runsToday: 0, totalCostToday: 0 }),
      ];
      vi.mocked(loadAllAgentConfigs).mockResolvedValue(agents);

      await snapshotDailyStats('2026-03-01');

      expect(mockWriteNow).not.toHaveBeenCalled();
    });

    it('is additive — merges new agent data with existing snapshot', async () => {
      // Pre-existing snapshot with explorer data
      fileContents[join(STATS_DIR, '2026-03-01.json')] = JSON.stringify({
        date: '2026-03-01',
        agents: { explorer: { runs: 3, failures: 0, totalCost: 0.15, avgConfidence: 0.8, avgDuration: 0 } },
        systemTotals: { totalCost: 0.15, totalRuns: 3, totalFailures: 0, activeAgents: 1 },
      });

      const agents = [
        makeAgent('programmer', { costResetDate: '2026-03-01', runsToday: 5, totalCostToday: 0.30 }),
      ];
      vi.mocked(loadAllAgentConfigs).mockResolvedValue(agents);

      await snapshotDailyStats('2026-03-01');

      expect(mockWriteNow).toHaveBeenCalledOnce();
      const [, data] = mockWriteNow.mock.calls[0];
      // Both agents present: explorer from existing + programmer from new
      expect(data.agents.explorer).toBeDefined();
      expect(data.agents.programmer).toBeDefined();
      expect(data.systemTotals.activeAgents).toBe(2);
      expect(data.systemTotals.totalRuns).toBe(8);
      expect(data.systemTotals.totalCost).toBeCloseTo(0.45);
    });

    it('writes avgDuration as 0 (not timeout)', async () => {
      const agents = [
        makeAgent('explorer', { costResetDate: '2026-03-01', runsToday: 1, totalCostToday: 0.05, timeout: 900_000 }),
      ];
      vi.mocked(loadAllAgentConfigs).mockResolvedValue(agents);

      await snapshotDailyStats('2026-03-01');

      const [, data] = mockWriteNow.mock.calls[0];
      expect(data.agents.explorer.avgDuration).toBe(0);
    });
  });

  describe('addAgentToSnapshot()', () => {
    it('creates new snapshot when file does not exist', async () => {
      await addAgentToSnapshot('2026-03-01', 'explorer', {
        runs: 3, failures: 0, totalCost: 0.15, avgConfidence: 0.8, avgDuration: 120,
      });

      expect(mockWriteNow).toHaveBeenCalledOnce();
      const [filePath, data] = mockWriteNow.mock.calls[0];
      expect(filePath).toBe(join(STATS_DIR, '2026-03-01.json'));
      expect(data.date).toBe('2026-03-01');
      expect(data.agents.explorer.runs).toBe(3);
      expect(data.agents.explorer.avgDuration).toBe(120);
      expect(data.systemTotals.activeAgents).toBe(1);
      expect(data.systemTotals.totalCost).toBeCloseTo(0.15);
    });

    it('merges into existing snapshot', async () => {
      fileContents[join(STATS_DIR, '2026-03-01.json')] = JSON.stringify({
        date: '2026-03-01',
        agents: { explorer: { runs: 3, failures: 0, totalCost: 0.15, avgConfidence: 0.8, avgDuration: 0 } },
        systemTotals: { totalCost: 0.15, totalRuns: 3, totalFailures: 0, activeAgents: 1 },
      });

      await addAgentToSnapshot('2026-03-01', 'programmer', {
        runs: 5, failures: 1, totalCost: 0.30, avgConfidence: 0.9, avgDuration: 60,
      });

      expect(mockWriteNow).toHaveBeenCalledOnce();
      const [, data] = mockWriteNow.mock.calls[0];
      expect(data.agents.explorer).toBeDefined();
      expect(data.agents.programmer.runs).toBe(5);
      expect(data.systemTotals.activeAgents).toBe(2);
      expect(data.systemTotals.totalRuns).toBe(8);
      expect(data.systemTotals.totalCost).toBeCloseTo(0.45);
    });

    it('skips inactive agents (zero runs + zero cost)', async () => {
      await addAgentToSnapshot('2026-03-01', 'idle', {
        runs: 0, failures: 0, totalCost: 0, avgConfidence: 0, avgDuration: 0,
      });

      expect(mockWriteNow).not.toHaveBeenCalled();
    });

    it('overwrites same agent data on re-snapshot', async () => {
      fileContents[join(STATS_DIR, '2026-03-01.json')] = JSON.stringify({
        date: '2026-03-01',
        agents: { explorer: { runs: 2, failures: 0, totalCost: 0.10, avgConfidence: 0.5, avgDuration: 0 } },
        systemTotals: { totalCost: 0.10, totalRuns: 2, totalFailures: 0, activeAgents: 1 },
      });

      await addAgentToSnapshot('2026-03-01', 'explorer', {
        runs: 5, failures: 1, totalCost: 0.25, avgConfidence: 0.9, avgDuration: 90,
      });

      const [, data] = mockWriteNow.mock.calls[0];
      expect(data.agents.explorer.runs).toBe(5);
      expect(data.agents.explorer.avgDuration).toBe(90);
      expect(data.systemTotals.totalRuns).toBe(5);
      expect(data.systemTotals.activeAgents).toBe(1);
    });
  });

  describe('getAgentTrends()', () => {
    it('returns empty trends when no snapshot files exist', async () => {
      dirContents = [];

      const result = await getAgentTrends('explorer', 7);

      expect(result.agentName).toBe('explorer');
      expect(result.costTrend).toHaveLength(0);
      expect(result.failureTrend).toHaveLength(0);
      expect(result.confidenceTrend).toHaveLength(0);
      expect(result.summary.costChangePercent).toBeNull();
      expect(result.summary.failureChangePercent).toBeNull();
    });

    it('returns trend data from multiple daily snapshots', async () => {
      dirContents = ['2026-02-27.json', '2026-02-28.json', '2026-03-01.json'];

      const snapshots: Record<string, object> = {
        '2026-02-27.json': {
          date: '2026-02-27',
          agents: { explorer: { runs: 2, failures: 0, totalCost: 0.10, avgConfidence: 0.7, avgDuration: 0 } },
          systemTotals: { totalCost: 0.10, totalRuns: 2, totalFailures: 0, activeAgents: 1 },
        },
        '2026-02-28.json': {
          date: '2026-02-28',
          agents: { explorer: { runs: 3, failures: 1, totalCost: 0.20, avgConfidence: 0.8, avgDuration: 0 } },
          systemTotals: { totalCost: 0.20, totalRuns: 3, totalFailures: 1, activeAgents: 1 },
        },
        '2026-03-01.json': {
          date: '2026-03-01',
          agents: { explorer: { runs: 5, failures: 0, totalCost: 0.30, avgConfidence: 0.9, avgDuration: 0 } },
          systemTotals: { totalCost: 0.30, totalRuns: 5, totalFailures: 0, activeAgents: 1 },
        },
      };

      for (const [file, data] of Object.entries(snapshots)) {
        fileContents[join(STATS_DIR, file)] = JSON.stringify(data);
      }

      const result = await getAgentTrends('explorer', 7);

      expect(result.costTrend).toHaveLength(3);
      expect(result.costTrend[0]).toEqual({ date: '2026-02-27', value: 0.10 });
      expect(result.costTrend[2]).toEqual({ date: '2026-03-01', value: 0.30 });
      expect(result.failureTrend[1]).toEqual({ date: '2026-02-28', value: 1 });
    });

    it('fills zero for days where agent had no activity', async () => {
      dirContents = ['2026-03-01.json'];
      fileContents[join(STATS_DIR, '2026-03-01.json')] = JSON.stringify({
        date: '2026-03-01',
        agents: { programmer: { runs: 1, failures: 0, totalCost: 0.05, avgConfidence: 0.5, avgDuration: 0 } },
        systemTotals: { totalCost: 0.05, totalRuns: 1, totalFailures: 0, activeAgents: 1 },
      });

      const result = await getAgentTrends('explorer', 7);

      expect(result.costTrend).toHaveLength(1);
      expect(result.costTrend[0]).toEqual({ date: '2026-03-01', value: 0 });
    });

    it('detects increasing failure trend', async () => {
      dirContents = ['2026-02-27.json', '2026-02-28.json', '2026-03-01.json', '2026-03-02.json'];

      const snapshots: Record<string, object> = {
        '2026-02-27.json': {
          date: '2026-02-27',
          agents: { explorer: { runs: 5, failures: 1, totalCost: 0.10, avgConfidence: 0.8, avgDuration: 0 } },
          systemTotals: { totalCost: 0.10, totalRuns: 5, totalFailures: 1, activeAgents: 1 },
        },
        '2026-02-28.json': {
          date: '2026-02-28',
          agents: { explorer: { runs: 5, failures: 1, totalCost: 0.10, avgConfidence: 0.7, avgDuration: 0 } },
          systemTotals: { totalCost: 0.10, totalRuns: 5, totalFailures: 1, activeAgents: 1 },
        },
        '2026-03-01.json': {
          date: '2026-03-01',
          agents: { explorer: { runs: 5, failures: 4, totalCost: 0.10, avgConfidence: 0.5, avgDuration: 0 } },
          systemTotals: { totalCost: 0.10, totalRuns: 5, totalFailures: 4, activeAgents: 1 },
        },
        '2026-03-02.json': {
          date: '2026-03-02',
          agents: { explorer: { runs: 5, failures: 5, totalCost: 0.10, avgConfidence: 0.3, avgDuration: 0 } },
          systemTotals: { totalCost: 0.10, totalRuns: 5, totalFailures: 5, activeAgents: 1 },
        },
      };

      for (const [file, data] of Object.entries(snapshots)) {
        fileContents[join(STATS_DIR, file)] = JSON.stringify(data);
      }

      const result = await getAgentTrends('explorer', 7);

      expect(result.summary.failureChangePercent).toBeGreaterThan(50);
      expect(result.summary.recommendation).toContain('Failures increasing');
    });

    it('limits to requested number of days', async () => {
      dirContents = ['2026-02-25.json', '2026-02-26.json', '2026-02-27.json', '2026-02-28.json', '2026-03-01.json'];

      for (const file of dirContents) {
        const date = file.replace('.json', '');
        fileContents[join(STATS_DIR, file)] = JSON.stringify({
          date,
          agents: { explorer: { runs: 1, failures: 0, totalCost: 0.05, avgConfidence: 0.5, avgDuration: 0 } },
          systemTotals: { totalCost: 0.05, totalRuns: 1, totalFailures: 0, activeAgents: 1 },
        });
      }

      const result = await getAgentTrends('explorer', 3);

      expect(result.costTrend).toHaveLength(3);
      expect(result.costTrend[0].date).toBe('2026-02-27');
    });

    it('populates handoffFeedbackRateTrend and durationCvTrend from snapshots', async () => {
      dirContents = ['2026-03-01.json', '2026-03-02.json'];

      const snapshots: Record<string, object> = {
        '2026-03-01.json': {
          date: '2026-03-01',
          agents: {
            explorer: {
              runs: 5, failures: 0, totalCost: 0.10, avgConfidence: 0.8, avgDuration: 100,
              handoffsSent: 3, handoffsReceived: 2, feedbackRounds: 1, durationCv: 0.3,
            },
          },
          systemTotals: { totalCost: 0.10, totalRuns: 5, totalFailures: 0, activeAgents: 1 },
        },
        '2026-03-02.json': {
          date: '2026-03-02',
          agents: {
            explorer: {
              runs: 4, failures: 1, totalCost: 0.15, avgConfidence: 0.7, avgDuration: 120,
              handoffsSent: 2, handoffsReceived: 1, feedbackRounds: 2, durationCv: 0.5,
            },
          },
          systemTotals: { totalCost: 0.15, totalRuns: 4, totalFailures: 1, activeAgents: 1 },
        },
      };

      for (const [file, data] of Object.entries(snapshots)) {
        fileContents[join(STATS_DIR, file)] = JSON.stringify(data);
      }

      const result = await getAgentTrends('explorer', 7);

      expect(result.handoffFeedbackRateTrend).toHaveLength(2);
      // Day 1: feedbackRounds / (sent + received) = 1 / 5 = 0.2
      expect(result.handoffFeedbackRateTrend[0]).toEqual({ date: '2026-03-01', value: 0.2 });
      // Day 2: 2 / 3 ≈ 0.667
      expect(result.handoffFeedbackRateTrend[1].value).toBeCloseTo(0.667, 2);

      expect(result.durationCvTrend).toHaveLength(2);
      expect(result.durationCvTrend[0]).toEqual({ date: '2026-03-01', value: 0.3 });
      expect(result.durationCvTrend[1]).toEqual({ date: '2026-03-02', value: 0.5 });
    });

    it('fills zero for coordination metrics when agent has no handoff data', async () => {
      dirContents = ['2026-03-01.json'];
      fileContents[join(STATS_DIR, '2026-03-01.json')] = JSON.stringify({
        date: '2026-03-01',
        agents: { explorer: { runs: 2, failures: 0, totalCost: 0.10, avgConfidence: 0.8, avgDuration: 0 } },
        systemTotals: { totalCost: 0.10, totalRuns: 2, totalFailures: 0, activeAgents: 1 },
      });

      const result = await getAgentTrends('explorer', 7);

      // No handoff fields in snapshot → defaults to 0
      expect(result.handoffFeedbackRateTrend).toHaveLength(1);
      expect(result.handoffFeedbackRateTrend[0]).toEqual({ date: '2026-03-01', value: 0 });
      expect(result.durationCvTrend[0]).toEqual({ date: '2026-03-01', value: 0 });
    });
  });
});
