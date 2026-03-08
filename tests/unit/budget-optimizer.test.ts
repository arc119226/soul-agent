import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (before imports) ──────────────────────────────────────────

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { appendJsonl: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/agents/config/agent-config.js', () => ({
  loadAllAgentConfigs: vi.fn(),
  saveAgentConfig: vi.fn().mockResolvedValue(undefined),
}));

import { optimizeBudgets } from '../../src/agents/budget-optimizer.js';
import { loadAllAgentConfigs, saveAgentConfig } from '../../src/agents/config/agent-config.js';
import type { AgentConfig } from '../../src/agents/config/agent-config.js';

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
    costResetDate: '2026-02-21',
    totalRuns: 10,
    createdAt: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('BudgetOptimizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result when fewer than 2 enabled agents', async () => {
    vi.mocked(loadAllAgentConfigs).mockResolvedValueOnce([makeAgent('a')]);
    const result = await optimizeBudgets();
    expect(result.agents).toHaveLength(0);
    expect(result.changed).toBe(0);
  });

  it('returns empty result when agents have zero dailyCostLimit', async () => {
    vi.mocked(loadAllAgentConfigs).mockResolvedValueOnce([
      makeAgent('a', { dailyCostLimit: 0 }),
      makeAgent('b', { dailyCostLimit: 0 }),
    ]);
    const result = await optimizeBudgets();
    expect(result.agents).toHaveLength(0);
  });

  it('distributes budget proportionally based on efficiency', async () => {
    const agentA = makeAgent('agent-a', {
      valueScore: 0.9, runsToday: 2, totalCostToday: 0.10,
      failureCount7d: 0, dailyCostLimit: 0.50,
    });
    const agentB = makeAgent('agent-b', {
      valueScore: 0.3, runsToday: 2, totalCostToday: 0.40,
      failureCount7d: 0, dailyCostLimit: 0.50,
    });
    vi.mocked(loadAllAgentConfigs).mockResolvedValueOnce([agentA, agentB]);

    const result = await optimizeBudgets();
    expect(result.totalBudget).toBeCloseTo(1.0);
    const a = result.agents.find((x) => x.name === 'agent-a')!;
    const b = result.agents.find((x) => x.name === 'agent-b')!;
    expect(a.newBudget).toBeGreaterThan(b.newBudget);
  });

  it('enforces minimum $0.10 floor per agent', async () => {
    const agentA = makeAgent('agent-a', {
      valueScore: 0.01, runsToday: 5, totalCostToday: 2.00, dailyCostLimit: 2.00,
    });
    const agentB = makeAgent('agent-b', {
      valueScore: 0.9, runsToday: 5, totalCostToday: 0.10, dailyCostLimit: 2.00,
    });
    vi.mocked(loadAllAgentConfigs).mockResolvedValueOnce([agentA, agentB]);

    const result = await optimizeBudgets();
    const a = result.agents.find((x) => x.name === 'agent-a')!;
    expect(a.newBudget).toBeGreaterThanOrEqual(0.10);
  });

  it('conserves total budget sum', async () => {
    const agents = [
      makeAgent('a', { valueScore: 0.8, runsToday: 3, totalCostToday: 0.30, dailyCostLimit: 1.00 }),
      makeAgent('b', { valueScore: 0.5, runsToday: 3, totalCostToday: 0.50, dailyCostLimit: 1.00 }),
      makeAgent('c', { valueScore: 0.2, runsToday: 3, totalCostToday: 0.20, dailyCostLimit: 1.00 }),
    ];
    vi.mocked(loadAllAgentConfigs).mockResolvedValueOnce(agents);

    const result = await optimizeBudgets();
    const newTotal = result.agents.reduce((s, a) => s + a.newBudget, 0);
    expect(newTotal).toBeCloseTo(3.0, 1);
  });

  it('saves updated configs when budgets change', async () => {
    const agentA = makeAgent('agent-a', {
      valueScore: 0.9, runsToday: 5, totalCostToday: 0.05, dailyCostLimit: 0.50,
    });
    const agentB = makeAgent('agent-b', {
      valueScore: 0.1, runsToday: 5, totalCostToday: 0.45, dailyCostLimit: 0.50,
    });
    vi.mocked(loadAllAgentConfigs).mockResolvedValueOnce([agentA, agentB]);

    const result = await optimizeBudgets();
    expect(result.changed).toBeGreaterThan(0);
    expect(vi.mocked(saveAgentConfig)).toHaveBeenCalled();
  });
});
