/**
 * Tests for SPEC-02: Atomic Budget Reservation
 *
 * Validates that per-agent budget locks prevent race conditions
 * when concurrent reserveBudget() calls execute simultaneously.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getTodayString } from '../../src/core/timezone.js';

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  mkdir: vi.fn(),
}));

vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    writeNow: vi.fn(),
    appendJsonl: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: { MODEL_TIER_SONNET: 'sonnet-test' },
}));

vi.mock('../../src/claude/claude-code.js', () => ({
  askClaudeCode: vi.fn(),
  isBusy: vi.fn().mockReturnValue(false),
  LIGHTWEIGHT_CWD: '/tmp',
}));

vi.mock('../../src/agents/config/agent-config.js', () => ({
  loadAgentConfig: vi.fn(),
  loadAllAgentConfigs: vi.fn().mockResolvedValue([]),
  recordAgentRun: vi.fn(),
  recordAgentFailure: vi.fn(),
  isOverDailyLimit: vi.fn().mockResolvedValue(false),
  parseScheduleInterval: vi.fn().mockReturnValue(null),
  isDailyScheduleDue: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/agents/governance/agent-permissions.js', () => ({
  getEffectivePermissions: vi.fn().mockReturnValue({ read: [], write: [], execute: [] }),
  buildPermissionPrompt: vi.fn().mockReturnValue(''),
}));

// In-memory SQLite
const testDb = new Database(':memory:');
testDb.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
  id              TEXT    PRIMARY KEY,
  agent_name      TEXT    NOT NULL,
  prompt          TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 5,
  source          TEXT,
  created_at      TEXT    NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  worker_id       INTEGER,
  result          TEXT,
  error           TEXT,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  duration        INTEGER,
  confidence      REAL,
  trace_summary   TEXT,
  pipeline_id     TEXT,
  stage_id        TEXT,
  parent_task_id  TEXT,
  chain_depth     INTEGER DEFAULT 0,
  retry_count     INTEGER DEFAULT 0,
  retry_after     TEXT,
  depends_on      TEXT,
  worktree_path   TEXT,
  branch_name     TEXT,
  trace           TEXT,
  metadata        TEXT,
  origin_agent    TEXT
)`);

vi.mock('../../src/core/database.js', () => ({
  getDb: () => testDb,
}));

describe('SPEC-02: Atomic Budget Reservation', () => {
  let __testing: typeof import('../../src/agents/worker-scheduler.js')['__testing'];
  let loadAgentConfig: ReturnType<typeof vi.fn>;
  let isOverDailyLimit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    testDb.exec('DELETE FROM agent_tasks');

    vi.doMock('../../src/core/database.js', () => ({
      getDb: () => testDb,
    }));

    vi.doMock('node:fs/promises', () => ({
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
      mkdir: vi.fn(),
    }));

    vi.doMock('../../src/core/event-bus.js', () => ({
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    }));

    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    vi.doMock('../../src/core/debounced-writer.js', () => ({
      writer: {
        writeNow: vi.fn(),
        appendJsonl: vi.fn(),
      },
    }));

    vi.doMock('../../src/config.js', () => ({
      config: { MODEL_TIER_SONNET: 'sonnet-test' },
    }));

    vi.doMock('../../src/claude/claude-code.js', () => ({
      askClaudeCode: vi.fn(),
      isBusy: vi.fn().mockReturnValue(false),
      LIGHTWEIGHT_CWD: '/tmp',
    }));

    // Setup agent-config mock with controllable functions
    loadAgentConfig = vi.fn();
    isOverDailyLimit = vi.fn().mockResolvedValue(false);

    vi.doMock('../../src/agents/config/agent-config.js', () => ({
      loadAgentConfig,
      loadAllAgentConfigs: vi.fn().mockResolvedValue([]),
      recordAgentRun: vi.fn(),
      recordAgentFailure: vi.fn(),
      isOverDailyLimit,
      parseScheduleInterval: vi.fn().mockReturnValue(null),
      isDailyScheduleDue: vi.fn().mockReturnValue(false),
    }));

    vi.doMock('../../src/agents/governance/agent-permissions.js', () => ({
      getEffectivePermissions: vi.fn().mockReturnValue({ read: [], write: [], execute: [] }),
      buildPermissionPrompt: vi.fn().mockReturnValue(''),
    }));

    const mod = await import('../../src/agents/worker-scheduler.js');
    __testing = mod.__testing;
  });

  function makeAgentConfig(overrides: Record<string, unknown> = {}) {
    return {
      name: 'test-agent',
      dailyCostLimit: 0.50,
      totalCostToday: 0,
      costResetDate: getTodayString(),
      ...overrides,
    };
  }

  it('withBudgetLock serializes concurrent calls for the same agent', async () => {
    const order: number[] = [];

    const p1 = __testing.withBudgetLock('agent-a', async () => {
      order.push(1);
      await new Promise(r => setTimeout(r, 50));
      order.push(2);
      return 'first';
    });

    const p2 = __testing.withBudgetLock('agent-a', async () => {
      order.push(3);
      return 'second';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('first');
    expect(r2).toBe('second');
    // p2 must wait for p1 to complete: 1,2 before 3
    expect(order).toEqual([1, 2, 3]);
  });

  it('withBudgetLock allows parallel calls for different agents', async () => {
    const order: string[] = [];

    const p1 = __testing.withBudgetLock('agent-a', async () => {
      order.push('a-start');
      await new Promise(r => setTimeout(r, 50));
      order.push('a-end');
    });

    const p2 = __testing.withBudgetLock('agent-b', async () => {
      order.push('b-start');
      await new Promise(r => setTimeout(r, 50));
      order.push('b-end');
    });

    await Promise.all([p1, p2]);
    // Both should start before either ends (parallel execution)
    expect(order.indexOf('a-start')).toBeLessThan(order.indexOf('a-end'));
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('b-end'));
    // b-start should occur before a-end (parallel, not sequential)
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
  });

  it('withBudgetLock releases lock on exception', async () => {
    try {
      await __testing.withBudgetLock('agent-a', async () => {
        throw new Error('boom');
      });
    } catch {
      // expected
    }

    // Should be able to acquire lock again immediately
    const result = await __testing.withBudgetLock('agent-a', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('5 concurrent reserveBudget calls with $0.50 limit → max 3 succeed', async () => {
    // Agent has $0.50 daily limit, $0.00 spent today, $0.15 per task
    // 3 * $0.15 = $0.45 < $0.50 ✓
    // 4 * $0.15 = $0.60 > $0.50 ✗
    const cfg = makeAgentConfig({ dailyCostLimit: 0.50, totalCostToday: 0 });
    loadAgentConfig.mockResolvedValue({ ...cfg });

    const results = await Promise.all([
      __testing.reserveBudget('test-agent', 0.15),
      __testing.reserveBudget('test-agent', 0.15),
      __testing.reserveBudget('test-agent', 0.15),
      __testing.reserveBudget('test-agent', 0.15),
      __testing.reserveBudget('test-agent', 0.15),
    ]);

    const successes = results.filter(r => r === true).length;
    const failures = results.filter(r => r === false).length;

    expect(successes).toBe(3); // 3 × $0.15 = $0.45 < $0.50
    expect(failures).toBe(2); // 4th would be $0.60, rejected
  });

  it('reserveBudget returns false when over daily limit', async () => {
    isOverDailyLimit.mockResolvedValue(true);
    loadAgentConfig.mockResolvedValue(makeAgentConfig());

    const result = await __testing.reserveBudget('test-agent', 0.15);
    expect(result).toBe(false);
  });

  it('reserveBudget returns false when agent config not found', async () => {
    loadAgentConfig.mockResolvedValue(null);

    const result = await __testing.reserveBudget('nonexistent', 0.15);
    expect(result).toBe(false);
  });

  it('reserveBudget allows unlimited budget (dailyCostLimit = 0)', async () => {
    loadAgentConfig.mockResolvedValue(makeAgentConfig({ dailyCostLimit: 0 }));

    const result = await __testing.reserveBudget('test-agent', 10.0);
    expect(result).toBe(true);
  });

  it('releaseBudget decrements reservation correctly', async () => {
    loadAgentConfig.mockResolvedValue(makeAgentConfig({ dailyCostLimit: 1.0 }));

    // Reserve
    await __testing.reserveBudget('test-agent', 0.30);
    expect(__testing.budgetReservations.get('test-agent')).toBeCloseTo(0.30);

    // Release
    await __testing.releaseBudget('test-agent', 0.30);
    expect(__testing.budgetReservations.has('test-agent')).toBe(false);
  });

  it('releaseBudget cleans up map entry when near zero', async () => {
    loadAgentConfig.mockResolvedValue(makeAgentConfig({ dailyCostLimit: 1.0 }));

    await __testing.reserveBudget('test-agent', 0.15);
    await __testing.releaseBudget('test-agent', 0.15);

    // Should be removed from map, not left as ~0
    expect(__testing.budgetReservations.has('test-agent')).toBe(false);
  });

  it('concurrent reservations for different agents are independent', async () => {
    const cfgA = makeAgentConfig({ name: 'agent-a', dailyCostLimit: 0.30 });
    const cfgB = makeAgentConfig({ name: 'agent-b', dailyCostLimit: 0.30 });

    loadAgentConfig.mockImplementation(async (name: string) => {
      if (name === 'agent-a') return { ...cfgA };
      if (name === 'agent-b') return { ...cfgB };
      return null;
    });

    // Both agents can reserve independently
    const results = await Promise.all([
      __testing.reserveBudget('agent-a', 0.15),
      __testing.reserveBudget('agent-b', 0.15),
      __testing.reserveBudget('agent-a', 0.15),
      __testing.reserveBudget('agent-b', 0.15),
    ]);

    // Each agent can take 2 × $0.15 = $0.30 (exactly at limit)
    expect(results).toEqual([true, true, true, true]);
  });

  it('accounts for existing daily spend in budget check', async () => {
    // Agent already spent $0.40 today, limit is $0.50
    loadAgentConfig.mockResolvedValue(
      makeAgentConfig({ dailyCostLimit: 0.50, totalCostToday: 0.40 })
    );

    // $0.40 + $0.15 = $0.55 > $0.50 → reject
    const result = await __testing.reserveBudget('test-agent', 0.15);
    expect(result).toBe(false);
  });

  it('resets daily cost when date changes', async () => {
    // costResetDate is yesterday → totalCostToday should be treated as 0
    loadAgentConfig.mockResolvedValue(
      makeAgentConfig({
        dailyCostLimit: 0.50,
        totalCostToday: 10.0,
        costResetDate: '1999-01-01',
      })
    );

    const result = await __testing.reserveBudget('test-agent', 0.15);
    expect(result).toBe(true);
  });
});
