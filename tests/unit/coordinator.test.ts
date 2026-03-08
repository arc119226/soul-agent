import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { TIMEZONE: 'Asia/Taipei' },
}));

vi.mock('../../src/core/timezone.js', () => ({
  getTodayString: vi.fn(() => '2026-01-01'),
  toLocalDateString: vi.fn((s: string) => s.slice(0, 10)),
  getLocalDateParts: vi.fn(() => ({ year: 2026, month: 1, day: 1, hour: 12, minute: 0, dayOfWeek: 3 })),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// We need to mock agentBus
const mockSend = vi.fn();
const mockHasAgent = vi.fn();
const mockGetRegisteredRoles = vi.fn();
const mockGetQueueDepth = vi.fn();

vi.mock('../../src/agents/governance/agent-bus.js', () => ({
  agentBus: {
    send: (...args: unknown[]) => mockSend(...args),
    hasAgent: (...args: unknown[]) => mockHasAgent(...args),
    getRegisteredRoles: () => mockGetRegisteredRoles(),
    getQueueDepth: (...args: unknown[]) => mockGetQueueDepth(...args),
  },
}));

import { AgentRole } from '../../src/agents/types.js';
import type { AgentMessage } from '../../src/agents/types.js';

describe('Coordinator', () => {
  let coordinator: typeof import('../../src/agents/coordinator.js')['coordinator'];

  beforeEach(async () => {
    vi.resetModules();
    mockSend.mockReset();
    mockHasAgent.mockReset();
    mockGetRegisteredRoles.mockReset();
    mockGetQueueDepth.mockReset();

    vi.doMock('../../src/config.js', () => ({
      config: { TIMEZONE: 'Asia/Taipei' },
    }));
    vi.doMock('../../src/core/timezone.js', () => ({
      getTodayString: vi.fn(() => '2026-01-01'),
      toLocalDateString: vi.fn((s: string) => s.slice(0, 10)),
      getLocalDateParts: vi.fn(() => ({ year: 2026, month: 1, day: 1, hour: 12, minute: 0, dayOfWeek: 3 })),
    }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../../src/agents/governance/agent-bus.js', () => ({
      agentBus: {
        send: (...args: unknown[]) => mockSend(...args),
        hasAgent: (...args: unknown[]) => mockHasAgent(...args),
        getRegisteredRoles: () => mockGetRegisteredRoles(),
        getQueueDepth: (...args: unknown[]) => mockGetQueueDepth(...args),
      },
    }));

    const mod = await import('../../src/agents/coordinator.js');
    coordinator = mod.coordinator;
  });

  function makeMsg(overrides: Partial<AgentMessage>): AgentMessage {
    return {
      id: 'test-id',
      from: AgentRole.Coordinator,
      to: AgentRole.Coordinator,
      type: 'task',
      payload: {},
      timestamp: Date.now(),
      ...overrides,
    };
  }

  describe('handle("evolve")', () => {
    it('orchestrates Analyst -> Executor -> Reviewer', async () => {
      mockHasAgent.mockReturnValue(true);
      mockSend
        .mockResolvedValueOnce({ success: true, data: 'strategy' })   // Analyst
        .mockResolvedValueOnce({ success: true, data: 'executed' })   // Executor
        .mockResolvedValueOnce({ success: true, data: 'reviewed' });  // Reviewer

      const result = await coordinator.handle(makeMsg({
        type: 'evolve',
        payload: { goalId: 'g1', description: 'Add feature' },
      }));

      expect(result.success).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('returns failure when Executor is missing', async () => {
      mockHasAgent.mockImplementation((role: AgentRole) =>
        role === AgentRole.Analyst ? true : false,
      );
      mockSend.mockResolvedValue({ success: true, data: 'strategy' });

      const result = await coordinator.handle(makeMsg({
        type: 'evolve',
        payload: { goalId: 'g1', description: 'Something' },
      }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Executor');
    });

    it('gracefully continues when Analyst fails', async () => {
      mockHasAgent.mockReturnValue(true);
      mockSend
        .mockResolvedValueOnce({ success: false, error: 'Analyst down' }) // Analyst fails
        .mockResolvedValueOnce({ success: true, data: 'executed' })        // Executor
        .mockResolvedValueOnce({ success: true, data: 'reviewed' });       // Reviewer

      const result = await coordinator.handle(makeMsg({
        type: 'evolve',
        payload: { goalId: 'g1', description: 'Test' },
      }));

      // Should still succeed because Executor + Reviewer worked
      expect(result.success).toBe(true);
    });

    it('returns execution result without reviewer', async () => {
      mockHasAgent.mockImplementation((role: AgentRole) =>
        role !== AgentRole.Reviewer,
      );
      mockSend
        .mockResolvedValueOnce({ success: true, data: 'strategy' })
        .mockResolvedValueOnce({ success: true, data: 'executed' });

      const result = await coordinator.handle(makeMsg({
        type: 'evolve',
        payload: { goalId: 'g1', description: 'Test' },
      }));

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>).executionResult).toBe('executed');
    });
  });

  describe('handle("task")', () => {
    it('routes "analyze" keyword to Analyst', async () => {
      mockHasAgent.mockReturnValue(true);
      mockSend.mockResolvedValue({ success: true, data: 'analyzed' });

      await coordinator.handle(makeMsg({
        type: 'task',
        payload: { description: 'analyze patterns in the data' },
      }));

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: AgentRole.Analyst }),
      );
    });

    it('routes "implement" keyword through Executor + Reviewer', async () => {
      mockHasAgent.mockReturnValue(true);
      mockSend.mockResolvedValue({ success: true, data: 'done' });

      await coordinator.handle(makeMsg({
        type: 'task',
        payload: { description: 'implement the new feature' },
      }));

      // Should have called Executor and Reviewer
      const sendCalls = mockSend.mock.calls;
      const targets = sendCalls.map((c) => (c[0] as { to: string }).to);
      expect(targets).toContain(AgentRole.Executor);
      expect(targets).toContain(AgentRole.Reviewer);
    });

    it('routes "memory" keyword to MemoryManager', async () => {
      mockHasAgent.mockReturnValue(true);
      mockSend.mockResolvedValue({ success: true, data: 'found' });

      await coordinator.handle(makeMsg({
        type: 'task',
        payload: { description: 'search memory for important data' },
      }));

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: AgentRole.MemoryManager }),
      );
    });

    it('falls back to Analyst when no keyword matches', async () => {
      mockHasAgent.mockReturnValue(true);
      mockSend.mockResolvedValue({ success: true, data: 'fallback' });

      const result = await coordinator.handle(makeMsg({
        type: 'task',
        payload: { description: 'something unrelated' },
      }));

      expect(result.success).toBe(true);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: AgentRole.Analyst, type: 'analyze' }),
      );
    });
  });

  describe('handle("query")', () => {
    it('routes to Analyst', async () => {
      mockHasAgent.mockReturnValue(true);
      mockSend.mockResolvedValue({ success: true, data: 'answer' });

      const result = await coordinator.handle(makeMsg({
        type: 'query',
        payload: { question: 'What is the status?' },
      }));

      expect(result.success).toBe(true);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: AgentRole.Analyst }),
      );
    });

    it('returns failure when Analyst is not available', async () => {
      mockHasAgent.mockReturnValue(false);

      const result = await coordinator.handle(makeMsg({
        type: 'query',
        payload: { question: 'test' },
      }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Analyst');
    });
  });

  describe('handle("memory_op")', () => {
    it('routes to MemoryManager', async () => {
      mockHasAgent.mockReturnValue(true);
      mockSend.mockResolvedValue({ success: true, data: 'stored' });

      const result = await coordinator.handle(makeMsg({
        type: 'memory_op',
        payload: { operation: 'read', key: 'test' },
      }));

      expect(result.success).toBe(true);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: AgentRole.MemoryManager }),
      );
    });

    it('returns failure when MemoryManager is not available', async () => {
      mockHasAgent.mockReturnValue(false);

      const result = await coordinator.handle(makeMsg({
        type: 'memory_op',
        payload: { operation: 'read' },
      }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('MemoryManager');
    });
  });

  describe('handle("status")', () => {
    it('returns registered agents info', async () => {
      mockGetRegisteredRoles.mockReturnValue([AgentRole.Analyst, AgentRole.Executor]);
      mockGetQueueDepth.mockReturnValue(0);

      const result = await coordinator.handle(makeMsg({ type: 'status' }));

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.agentCount).toBe(2);
      expect(data.registeredAgents).toEqual([AgentRole.Analyst, AgentRole.Executor]);
    });
  });

  describe('handle("unknown")', () => {
    it('returns cannot handle error', async () => {
      const result = await coordinator.handle(makeMsg({ type: 'some_unknown_type' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot handle');
    });
  });
});
