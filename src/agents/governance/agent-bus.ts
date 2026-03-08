/**
 * In-process agent message bus.
 * Routes messages between singleton agent objects.
 * Each agent processes messages sequentially via an async queue.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../../core/logger.js';
import { type Agent, type AgentMessage, type AgentResponse, AgentRole } from '../types.js';

interface QueueEntry {
  message: AgentMessage;
  resolve: (result: AgentResponse) => void;
  reject: (error: Error) => void;
}

class AgentBus {
  private agents = new Map<AgentRole, Agent>();
  private queues = new Map<AgentRole, QueueEntry[]>();
  private processing = new Set<AgentRole>();

  /** Register an agent on the bus */
  register(agent: Agent): void {
    if (this.agents.has(agent.role)) {
      logger.warn('agent-bus', `Replacing existing agent for role: ${agent.role}`);
    }
    this.agents.set(agent.role, agent);
    if (!this.queues.has(agent.role)) {
      this.queues.set(agent.role, []);
    }
    logger.info('agent-bus', `Registered agent: ${agent.role}`);
  }

  /** Unregister an agent */
  async unregister(role: AgentRole): Promise<void> {
    const agent = this.agents.get(role);
    if (agent?.dispose) {
      await agent.dispose();
    }
    this.agents.delete(role);
    this.queues.delete(role);
    this.processing.delete(role);
    logger.info('agent-bus', `Unregistered agent: ${role}`);
  }

  /** Send a message to a specific agent, returns the response */
  async send(msg: Omit<AgentMessage, 'id' | 'timestamp'>): Promise<AgentResponse> {
    const fullMsg: AgentMessage = {
      ...msg,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    const agent = this.agents.get(msg.to);
    if (!agent) {
      return { success: false, error: `Agent not found: ${msg.to}` };
    }

    return new Promise<AgentResponse>((resolve, reject) => {
      const queue = this.queues.get(msg.to);
      if (!queue) {
        resolve({ success: false, error: `No queue for role: ${msg.to}` });
        return;
      }

      queue.push({ message: fullMsg, resolve, reject });
      this.processQueue(msg.to);
    });
  }

  /** Process the queue for a specific agent role */
  private async processQueue(role: AgentRole): Promise<void> {
    if (this.processing.has(role)) return;
    this.processing.add(role);

    const queue = this.queues.get(role);
    const agent = this.agents.get(role);

    if (!queue || !agent) {
      this.processing.delete(role);
      return;
    }

    while (queue.length > 0) {
      const entry = queue.shift()!;
      try {
        logger.debug('agent-bus', `${entry.message.from} -> ${role}: ${entry.message.type}`);
        const response = await agent.handle(entry.message);
        entry.resolve(response);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('agent-bus', `Agent ${role} error handling ${entry.message.type}`, err);
        entry.resolve({ success: false, error: errorMsg });
      }
    }

    this.processing.delete(role);
  }

  /** Broadcast a message to all registered agents (except sender) */
  async broadcast(msg: Omit<AgentMessage, 'id' | 'timestamp' | 'to'>): Promise<AgentResponse[]> {
    const results: Promise<AgentResponse>[] = [];

    for (const role of this.agents.keys()) {
      if (role === msg.from) continue;
      results.push(this.send({ ...msg, to: role }));
    }

    return Promise.all(results);
  }

  /** Get a registered agent */
  getAgent(role: AgentRole): Agent | undefined {
    return this.agents.get(role);
  }

  /** Check if an agent is registered */
  hasAgent(role: AgentRole): boolean {
    return this.agents.has(role);
  }

  /** Get all registered agent roles */
  getRegisteredRoles(): AgentRole[] {
    return [...this.agents.keys()];
  }

  /** Get queue depth for a role */
  getQueueDepth(role: AgentRole): number {
    return this.queues.get(role)?.length ?? 0;
  }

  /** Dispose all agents and clear bus */
  async disposeAll(): Promise<void> {
    for (const role of [...this.agents.keys()]) {
      await this.unregister(role);
    }
    logger.info('agent-bus', 'All agents disposed');
  }
}

export const agentBus = new AgentBus();
