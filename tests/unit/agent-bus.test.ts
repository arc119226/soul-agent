import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { AgentRole } from '../../src/agents/types.js';
import type { Agent, AgentMessage, AgentResponse } from '../../src/agents/types.js';

function createMockAgent(role: AgentRole, handler?: (msg: AgentMessage) => Promise<AgentResponse>): Agent {
  return {
    role,
    handle: handler ?? vi.fn(async () => ({ success: true, data: 'ok' })),
    dispose: vi.fn(),
  };
}

describe('AgentBus', () => {
  let agentBus: typeof import('../../src/agents/governance/agent-bus.js')['agentBus'];

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const mod = await import('../../src/agents/governance/agent-bus.js');
    agentBus = mod.agentBus;
  });

  describe('register()', () => {
    it('registers an agent', () => {
      const agent = createMockAgent(AgentRole.Analyst);
      agentBus.register(agent);
      expect(agentBus.hasAgent(AgentRole.Analyst)).toBe(true);
    });

    it('replaces existing agent for same role', () => {
      const agent1 = createMockAgent(AgentRole.Analyst);
      const agent2 = createMockAgent(AgentRole.Analyst);
      agentBus.register(agent1);
      agentBus.register(agent2);
      expect(agentBus.getAgent(AgentRole.Analyst)).toBe(agent2);
    });
  });

  describe('hasAgent() / getAgent()', () => {
    it('returns false/undefined for unregistered role', () => {
      expect(agentBus.hasAgent(AgentRole.Executor)).toBe(false);
      expect(agentBus.getAgent(AgentRole.Executor)).toBeUndefined();
    });

    it('returns true and the agent for registered role', () => {
      const agent = createMockAgent(AgentRole.Coordinator);
      agentBus.register(agent);
      expect(agentBus.hasAgent(AgentRole.Coordinator)).toBe(true);
      expect(agentBus.getAgent(AgentRole.Coordinator)).toBe(agent);
    });
  });

  describe('send()', () => {
    it('sends message and receives response', async () => {
      const agent = createMockAgent(AgentRole.Analyst, async () => ({
        success: true,
        data: 'analyzed',
      }));
      agentBus.register(agent);

      const result = await agentBus.send({
        from: AgentRole.Coordinator,
        to: AgentRole.Analyst,
        type: 'analyze',
        payload: { text: 'test' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe('analyzed');
    });

    it('returns failure when agent not registered', async () => {
      const result = await agentBus.send({
        from: AgentRole.Coordinator,
        to: AgentRole.Executor,
        type: 'execute',
        payload: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent not found');
    });

    it('catches agent handler errors and returns failure', async () => {
      const agent = createMockAgent(AgentRole.Executor, async () => {
        throw new Error('handler exploded');
      });
      agentBus.register(agent);

      const result = await agentBus.send({
        from: AgentRole.Coordinator,
        to: AgentRole.Executor,
        type: 'execute',
        payload: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('handler exploded');
    });

    it('processes messages sequentially for same agent', async () => {
      const order: number[] = [];
      const agent = createMockAgent(AgentRole.Analyst, async (msg) => {
        const idx = (msg.payload as { idx: number }).idx;
        // Simulate varying processing time
        await new Promise((r) => setTimeout(r, 10 - idx));
        order.push(idx);
        return { success: true };
      });
      agentBus.register(agent);

      await Promise.all([
        agentBus.send({ from: AgentRole.Coordinator, to: AgentRole.Analyst, type: 'analyze', payload: { idx: 0 } }),
        agentBus.send({ from: AgentRole.Coordinator, to: AgentRole.Analyst, type: 'analyze', payload: { idx: 1 } }),
        agentBus.send({ from: AgentRole.Coordinator, to: AgentRole.Analyst, type: 'analyze', payload: { idx: 2 } }),
      ]);

      // Sequential processing means order matches insertion order
      expect(order).toEqual([0, 1, 2]);
    });
  });

  describe('broadcast()', () => {
    it('sends to all agents except sender', async () => {
      const analyst = createMockAgent(AgentRole.Analyst);
      const executor = createMockAgent(AgentRole.Executor);
      const coordinator = createMockAgent(AgentRole.Coordinator);
      agentBus.register(analyst);
      agentBus.register(executor);
      agentBus.register(coordinator);

      const results = await agentBus.broadcast({
        from: AgentRole.Coordinator,
        type: 'status',
        payload: { status: 'ready' },
      });

      // Should send to analyst and executor, skip coordinator (sender)
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('returns empty array when only sender is registered', async () => {
      const coordinator = createMockAgent(AgentRole.Coordinator);
      agentBus.register(coordinator);

      const results = await agentBus.broadcast({
        from: AgentRole.Coordinator,
        type: 'status',
        payload: {},
      });

      expect(results).toHaveLength(0);
    });
  });

  describe('getRegisteredRoles()', () => {
    it('lists all registered roles', () => {
      agentBus.register(createMockAgent(AgentRole.Analyst));
      agentBus.register(createMockAgent(AgentRole.Executor));
      const roles = agentBus.getRegisteredRoles();
      expect(roles).toContain(AgentRole.Analyst);
      expect(roles).toContain(AgentRole.Executor);
      expect(roles).toHaveLength(2);
    });
  });

  describe('getQueueDepth()', () => {
    it('returns 0 for empty or unknown queue', () => {
      expect(agentBus.getQueueDepth(AgentRole.Analyst)).toBe(0);
    });
  });

  describe('unregister()', () => {
    it('removes agent and calls dispose', async () => {
      const agent = createMockAgent(AgentRole.Analyst);
      agentBus.register(agent);
      await agentBus.unregister(AgentRole.Analyst);

      expect(agentBus.hasAgent(AgentRole.Analyst)).toBe(false);
      expect(agent.dispose).toHaveBeenCalled();
    });
  });

  describe('disposeAll()', () => {
    it('disposes all agents and clears bus', async () => {
      const a1 = createMockAgent(AgentRole.Analyst);
      const a2 = createMockAgent(AgentRole.Executor);
      agentBus.register(a1);
      agentBus.register(a2);

      await agentBus.disposeAll();

      expect(agentBus.hasAgent(AgentRole.Analyst)).toBe(false);
      expect(agentBus.hasAgent(AgentRole.Executor)).toBe(false);
      expect(a1.dispose).toHaveBeenCalled();
      expect(a2.dispose).toHaveBeenCalled();
    });
  });
});
