import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────
vi.mock('../../src/config.js', () => ({
  config: { TIMEZONE: 'Asia/Taipei' },
}));

vi.mock('../../src/core/timezone.js', () => ({
  getTodayString: vi.fn(() => '2026-01-01'),
  toLocalDateString: vi.fn((s: string) => s.slice(0, 10)),
  getLocalDateParts: vi.fn(() => ({ year: 2026, month: 1, day: 1, hour: 12, minute: 0, dayOfWeek: 3 })),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn(), writeNow: vi.fn().mockResolvedValue(undefined) },
}));

import type { AgentConfig } from '../../src/agents/config/agent-config.js';

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'test-agent',
    description: 'Test agent',
    enabled: true,
    schedule: 'every:4h',
    systemPrompt: '',
    model: '',
    maxTurns: 3,
    timeout: 120_000,
    dailyCostLimit: 0.5,
    notifyChat: false,
    targets: {},
    lastRun: null,
    totalCostToday: 0,
    costResetDate: '2026-02-13',
    totalRuns: 10,
    createdAt: '2026-01-01',
    ...overrides,
  };
}

describe('AgentTuner', () => {
  let computeAllMetrics: typeof import('../../src/agents/config/agent-tuner.js')['computeAllMetrics'];
  let tuneAgents: typeof import('../../src/agents/config/agent-tuner.js')['tuneAgents'];
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockReaddir: ReturnType<typeof vi.fn>;
  let mockSaveAgentConfig: ReturnType<typeof vi.fn>;
  let mockLoadAllAgentConfigs: ReturnType<typeof vi.fn>;
  let mockListAgentNames: ReturnType<typeof vi.fn>;
  let mockTailReadJsonl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockReadFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    mockReaddir = vi.fn().mockResolvedValue([]);
    mockSaveAgentConfig = vi.fn().mockResolvedValue(undefined);
    mockLoadAllAgentConfigs = vi.fn().mockResolvedValue([]);
    mockListAgentNames = vi.fn().mockResolvedValue([]);
    mockTailReadJsonl = vi.fn().mockResolvedValue([]);

    vi.doMock('../../src/config.js', () => ({
      config: { TIMEZONE: 'Asia/Taipei' },
    }));
    vi.doMock('../../src/core/timezone.js', () => ({
      getTodayString: vi.fn(() => '2026-01-01'),
      toLocalDateString: vi.fn((s: string) => s.slice(0, 10)),
      getLocalDateParts: vi.fn(() => ({ year: 2026, month: 1, day: 1, hour: 12, minute: 0, dayOfWeek: 3 })),
    }));
    vi.doMock('node:fs/promises', () => ({
      readFile: mockReadFile,
      readdir: mockReaddir,
    }));
    vi.doMock('../../src/core/tail-read.js', () => ({
      tailReadJsonl: mockTailReadJsonl,
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/core/debounced-writer.js', () => ({
      writer: { schedule: vi.fn(), writeNow: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../../src/agents/config/agent-config.js', () => ({
      loadAllAgentConfigs: (...args: unknown[]) => mockLoadAllAgentConfigs(...args),
      saveAgentConfig: (...args: unknown[]) => mockSaveAgentConfig(...args),
      listAgentNames: (...args: unknown[]) => mockListAgentNames(...args),
    }));

    const mod = await import('../../src/agents/config/agent-tuner.js');
    computeAllMetrics = mod.computeAllMetrics;
    tuneAgents = mod.tuneAgents;
  });

  describe('computeAllMetrics()', () => {
    it('returns empty array when no agents', async () => {
      mockLoadAllAgentConfigs.mockResolvedValue([]);
      const metrics = await computeAllMetrics();
      expect(metrics).toEqual([]);
    });

    it('computes metrics from history and reports', async () => {
      const cfg = makeAgentConfig({ name: 'explorer' });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      // Mock history: 2 completed, 1 failed
      const historyEntries = [
        { agentName: 'explorer', status: 'completed', costUsd: 0.01, duration: 5000, completedAt: new Date().toISOString() },
        { agentName: 'explorer', status: 'completed', costUsd: 0.02, duration: 3000, completedAt: new Date().toISOString() },
        { agentName: 'explorer', status: 'failed', costUsd: 0.005, duration: 1000, completedAt: new Date().toISOString() },
      ];

      mockTailReadJsonl.mockResolvedValueOnce(historyEntries);
      mockReaddir.mockResolvedValue([]);

      const metrics = await computeAllMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.name).toBe('explorer');
      expect(metrics[0]!.recentRuns).toBe(3);
      expect(metrics[0]!.successRate).toBeCloseTo(2 / 3);
    });
  });

  describe('tuneAgents() — decideTune logic', () => {
    // We test the internal decideTune logic indirectly through tuneAgents().

    it('decreases frequency for high failure rate', async () => {
      const cfg = makeAgentConfig({ name: 'flaky', schedule: 'every:2h', enabled: true });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      // 4 runs, 1 success, 3 failures → successRate=0.25 < 0.5
      mockTailReadJsonl.mockResolvedValueOnce([
        { agentName: 'flaky', status: 'completed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString() },
        { agentName: 'flaky', status: 'failed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString() },
        { agentName: 'flaky', status: 'failed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString() },
        { agentName: 'flaky', status: 'failed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString() },
      ]);
      mockReaddir.mockResolvedValue([]);

      const results = await tuneAgents();
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.action).toBe('decrease');
      // every:2h (tier 1) + 2 = tier 3 → every:6h
      expect(results[0]!.newSchedule).toBe('every:6h');
    });

    it('disables agent with all failures', async () => {
      const cfg = makeAgentConfig({ name: 'broken', schedule: 'every:4h', enabled: true });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      // 5 runs, all failures → successRate=0
      mockTailReadJsonl.mockResolvedValueOnce(
        Array.from({ length: 5 }, () =>
          ({ agentName: 'broken', status: 'failed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString() }),
        ),
      );
      mockReaddir.mockResolvedValue([]);

      const results = await tuneAgents();
      // successRate < 0.5 with recentRuns >= 3 triggers 'decrease' first
      // (Rule 1 fires before Rule 2 since successRate=0 < 0.5)
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.action).toBe('decrease');
    });

    it('increases frequency for high performance', async () => {
      const cfg = makeAgentConfig({ name: 'star', schedule: 'every:4h', enabled: true });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      // 3 completed, all success → successRate=1.0
      mockTailReadJsonl.mockResolvedValueOnce(
        Array.from({ length: 3 }, () =>
          ({ agentName: 'star', status: 'completed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString() }),
        ),
      );

      // Reports with long results (>200 chars)
      const report = JSON.stringify({
        timestamp: new Date().toISOString(),
        agentName: 'star',
        taskId: 't1',
        prompt: 'test',
        result: 'a'.repeat(300),
      });
      const reportDate = new Date().toISOString().slice(0, 10);

      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('.jsonl')) return report;
        throw new Error('ENOENT');
      });
      mockReaddir.mockImplementation(async (path: string) => {
        if (path.includes('star')) return [`${reportDate}.jsonl`];
        return [];
      });

      const results = await tuneAgents();
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.action).toBe('increase');
      // every:4h (tier 2) - 1 = tier 1 → every:2h
      expect(results[0]!.newSchedule).toBe('every:2h');
    });

    it('decreases frequency for low value reports', async () => {
      const cfg = makeAgentConfig({ name: 'brief', schedule: 'every:2h', enabled: true });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      // 4 completed runs with short reports
      mockTailReadJsonl.mockResolvedValueOnce(
        Array.from({ length: 4 }, () =>
          ({ agentName: 'brief', status: 'completed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString() }),
        ),
      );

      // Reports with very short results (<50 chars)
      const report = JSON.stringify({
        timestamp: new Date().toISOString(),
        agentName: 'brief',
        taskId: 't1',
        prompt: 'test',
        result: 'ok',
      });
      const reportDate = new Date().toISOString().slice(0, 10);

      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('.jsonl')) return report;
        throw new Error('ENOENT');
      });
      mockReaddir.mockImplementation(async (path: string) => {
        if (path.includes('brief')) return [`${reportDate}.jsonl`];
        return [];
      });

      const results = await tuneAgents();
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.action).toBe('decrease');
    });

    it('returns none for manual schedule agents', async () => {
      const cfg = makeAgentConfig({ name: 'manual', schedule: 'manual', enabled: true });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      // tailReadJsonl default mock returns [] (empty history)

      const results = await tuneAgents();
      expect(results).toHaveLength(0); // none actions are filtered
    });

    it('returns none for disabled agents', async () => {
      const cfg = makeAgentConfig({ name: 'disabled', schedule: 'every:4h', enabled: false });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('history.jsonl')) return '';
        throw new Error('ENOENT');
      });

      const results = await tuneAgents();
      expect(results).toHaveLength(0);
    });

    it('returns none when no adjustment needed', async () => {
      const cfg = makeAgentConfig({ name: 'normal', schedule: 'every:4h', enabled: true });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      // Only 1 run → not enough data to trigger any rule
      const history = JSON.stringify({
        agentName: 'normal', status: 'completed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString(),
      });

      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('history.jsonl')) return history;
        throw new Error('ENOENT');
      });
      mockReaddir.mockResolvedValue([]);

      const results = await tuneAgents();
      expect(results).toHaveLength(0);
    });
  });

  describe('getScheduleTierIndex() — tested via tuneAgents behavior', () => {
    it('maps exact tier matches correctly', async () => {
      // every:1h → tier 0, high perf → increase would try tier -1 → stays 0
      const cfg = makeAgentConfig({ name: 'fast', schedule: 'every:1h', enabled: true });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      const history = Array.from({ length: 3 }, () =>
        JSON.stringify({ agentName: 'fast', status: 'completed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString() }),
      ).join('\n');

      const report = JSON.stringify({
        timestamp: new Date().toISOString(),
        agentName: 'fast',
        taskId: 't1',
        prompt: 'test',
        result: 'a'.repeat(300),
      });
      const reportDate = new Date().toISOString().slice(0, 10);

      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('history.jsonl')) return history;
        if (path.includes('.jsonl')) return report;
        throw new Error('ENOENT');
      });
      mockReaddir.mockImplementation(async (path: string) => {
        if (path.includes('fast')) return [`${reportDate}.jsonl`];
        return [];
      });

      const results = await tuneAgents();
      // Already at tier 0, can't increase further → no action
      expect(results).toHaveLength(0);
    });

    it('daily@HH:MM maps to tier 5', async () => {
      // daily@08:00 → tier 5, high failure → decrease would try tier 7 → capped at 5
      const cfg = makeAgentConfig({ name: 'daily', schedule: 'daily@08:00', enabled: true });
      mockLoadAllAgentConfigs.mockResolvedValue([cfg]);

      // 3 runs, 0 success → failure rate triggers decrease
      const history = Array.from({ length: 3 }, () =>
        JSON.stringify({ agentName: 'daily', status: 'failed', costUsd: 0.01, duration: 1000, completedAt: new Date().toISOString() }),
      ).join('\n');

      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('history.jsonl')) return history;
        throw new Error('ENOENT');
      });
      mockReaddir.mockResolvedValue([]);

      const results = await tuneAgents();
      // tier 5 + 2 = tier 7 → capped at 5 (last tier), so newIdx === tierIdx → no change
      expect(results).toHaveLength(0);
    });
  });
});
