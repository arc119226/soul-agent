/**
 * Tests for worker-scheduler improvements:
 *   - Execution Tracing (addTrace / ExecutionTrace)
 *   - Task Dependencies (dependsOn / checkDependencies)
 *
 * Since addTrace and checkDependencies are private functions, we test them
 * indirectly through the public API (enqueueTask, getQueueStatus).
 * The AgentTask interface changes are tested via type-level assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentTask, ExecutionTrace } from '../../src/agents/worker-scheduler.js';

// We test interface compatibility directly
describe('AgentTask Interface', () => {
  it('supports optional dependsOn field', () => {
    const task: AgentTask = {
      id: 'test-1',
      agentName: 'explorer',
      prompt: 'test',
      status: 'pending',
      priority: 5,
      createdAt: '2026-01-01T00:00:00Z',
      startedAt: null,
      completedAt: null,
      workerId: null,
      result: null,
      error: null,
      costUsd: 0,
      duration: 0,
      dependsOn: ['task-a', 'task-b'],
    };

    expect(task.dependsOn).toEqual(['task-a', 'task-b']);
  });

  it('supports optional trace field', () => {
    const task: AgentTask = {
      id: 'test-2',
      agentName: 'explorer',
      prompt: 'test',
      status: 'completed',
      priority: 5,
      createdAt: '2026-01-01T00:00:00Z',
      startedAt: '2026-01-01T00:01:00Z',
      completedAt: '2026-01-01T00:02:00Z',
      workerId: -1,
      result: 'done',
      error: null,
      costUsd: 0.01,
      duration: 60000,
      trace: [
        { phase: 'dispatch', ts: '2026-01-01T00:01:00Z', detail: 'Worker -1' },
        { phase: 'cli-completed', ts: '2026-01-01T00:02:00Z', detail: '60000ms' },
      ],
    };

    expect(task.trace).toHaveLength(2);
    expect(task.trace![0]!.phase).toBe('dispatch');
  });

  it('works without new optional fields (backward compat)', () => {
    const task: AgentTask = {
      id: 'test-3',
      agentName: 'explorer',
      prompt: 'test',
      status: 'pending',
      priority: 5,
      createdAt: '2026-01-01T00:00:00Z',
      startedAt: null,
      completedAt: null,
      workerId: null,
      result: null,
      error: null,
      costUsd: 0,
      duration: 0,
    };

    // Old tasks without dependsOn/trace should be valid
    expect(task.dependsOn).toBeUndefined();
    expect(task.trace).toBeUndefined();
  });
});

describe('ExecutionTrace Interface', () => {
  it('has phase, ts, and detail fields', () => {
    const trace: ExecutionTrace = {
      phase: 'config-loaded',
      ts: '2026-01-01T00:00:00Z',
      detail: 'model=default, maxTurns=100',
    };

    expect(trace.phase).toBe('config-loaded');
    expect(trace.ts).toBeDefined();
    expect(trace.detail).toBeDefined();
  });
});

// Integration test via module mock with in-memory file store
describe('Worker Scheduler Dependency Resolution', () => {
  // In-memory file store to simulate disk persistence
  const fileStore = new Map<string, string>();

  vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(),
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

  // In-memory SQLite for Phase 3a dual-write — fresh DB per test via beforeEach
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

  let enqueueTask: typeof import('../../src/agents/worker-scheduler.js')['enqueueTask'];
  let getQueueStatus: typeof import('../../src/agents/worker-scheduler.js')['getQueueStatus'];

  beforeEach(async () => {
    vi.resetModules();
    fileStore.clear();
    testDb.exec('DELETE FROM agent_tasks');

    vi.doMock('../../src/core/database.js', () => ({
      getDb: () => testDb,
    }));

    // readFile reads from in-memory store
    const mockReadFile = vi.fn().mockImplementation((path: string) => {
      const data = fileStore.get(path);
      if (data) return Promise.resolve(data);
      return Promise.reject(new Error('ENOENT'));
    });

    // writeNow persists to in-memory store
    const mockWriteNow = vi.fn().mockImplementation((path: string, data: unknown) => {
      fileStore.set(path, JSON.stringify(data, null, 2));
      return Promise.resolve();
    });

    vi.doMock('node:fs/promises', () => ({
      readFile: mockReadFile,
      mkdir: vi.fn(),
    }));

    vi.doMock('../../src/core/debounced-writer.js', () => ({
      writer: {
        writeNow: mockWriteNow,
        appendJsonl: vi.fn(),
      },
    }));

    vi.doMock('../../src/core/event-bus.js', () => ({
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    }));

    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    vi.doMock('../../src/config.js', () => ({
      config: { MODEL_TIER_SONNET: 'sonnet-test' },
    }));

    vi.doMock('../../src/claude/claude-code.js', () => ({
      askClaudeCode: vi.fn(),
      isBusy: vi.fn().mockReturnValue(false),
      LIGHTWEIGHT_CWD: '/tmp',
    }));

    vi.doMock('../../src/agents/config/agent-config.js', () => ({
      loadAgentConfig: vi.fn(),
      loadAllAgentConfigs: vi.fn().mockResolvedValue([]),
      recordAgentRun: vi.fn(),
      recordAgentFailure: vi.fn(),
      isOverDailyLimit: vi.fn().mockResolvedValue(false),
      parseScheduleInterval: vi.fn().mockReturnValue(null),
      isDailyScheduleDue: vi.fn().mockReturnValue(false),
    }));

    vi.doMock('../../src/agents/governance/agent-permissions.js', () => ({
      getEffectivePermissions: vi.fn().mockReturnValue({ read: [], write: [], execute: [] }),
      buildPermissionPrompt: vi.fn().mockReturnValue(''),
    }));

    const mod = await import('../../src/agents/worker-scheduler.js');
    enqueueTask = mod.enqueueTask;
    getQueueStatus = mod.getQueueStatus;
  });

  it('enqueueTask stores dependsOn when provided', async () => {
    const taskId = await enqueueTask('explorer', 'test', 5, { dependsOn: ['dep-1', 'dep-2'] });

    expect(taskId).toBeDefined();
    const status = await getQueueStatus();
    const task = status.tasks.find(t => t.id === taskId);
    expect(task?.dependsOn).toEqual(['dep-1', 'dep-2']);
  });

  it('enqueueTask omits dependsOn when empty', async () => {
    const taskId = await enqueueTask('explorer', 'test', 5, { dependsOn: [] });

    const status = await getQueueStatus();
    const task = status.tasks.find(t => t.id === taskId);
    expect(task?.dependsOn).toBeUndefined();
  });

  it('enqueueTask omits dependsOn when not provided', async () => {
    const taskId = await enqueueTask('explorer', 'test');

    const status = await getQueueStatus();
    const task = status.tasks.find(t => t.id === taskId);
    expect(task?.dependsOn).toBeUndefined();
  });

  it('getQueueStatus includes blocked count', async () => {
    await enqueueTask('explorer', 'test', 5, { dependsOn: ['non-existent-task'] });

    const status = await getQueueStatus();
    expect(status.blocked).toBe(1);
    expect(status.pending).toBe(0);
  });

  it('getQueueStatus counts unblocked tasks as pending', async () => {
    await enqueueTask('explorer', 'unblocked task');

    const status = await getQueueStatus();
    expect(status.blocked).toBe(0);
    expect(status.pending).toBe(1);
  });

  it('deduplicates tasks with same agentName+prompt', async () => {
    const id1 = await enqueueTask('explorer', 'same prompt');
    const id2 = await enqueueTask('explorer', 'same prompt');

    expect(id2).toBe(id1);
    const status = await getQueueStatus();
    expect(status.tasks).toHaveLength(1);
  });

  it('allows different prompts for same agent', async () => {
    await enqueueTask('explorer', 'prompt A');
    await enqueueTask('explorer', 'prompt B');

    const status = await getQueueStatus();
    expect(status.tasks).toHaveLength(2);
  });

  it('allows same prompt for different agents', async () => {
    await enqueueTask('explorer', 'shared prompt');
    await enqueueTask('blog-writer', 'shared prompt');

    const status = await getQueueStatus();
    expect(status.tasks).toHaveLength(2);
  });
});
