/**
 * Coordinator agent — decomposes high-level tasks, routes to specialist agents,
 * collects and summarizes results.
 */

import { agentBus } from './governance/agent-bus.js';
import { type Agent, type AgentMessage, type AgentResponse, AgentRole } from './types.js';
import { logger } from '../core/logger.js';
import { getAgentCapabilities, matchCapabilities } from './config/capability-registry.js';

export const coordinator: Agent = {
  role: AgentRole.Coordinator,

  async handle(msg: AgentMessage): Promise<AgentResponse> {
    switch (msg.type) {
      case 'evolve':
        return handleEvolve(msg);
      case 'task':
        return handleTask(msg);
      case 'query':
        return handleQuery(msg);
      case 'memory_op':
        return handleMemoryOp(msg);
      case 'status':
        return handleStatus();
      default:
        return { success: false, error: `Coordinator cannot handle: ${msg.type}` };
    }
  },
};

/** Handle evolution request — orchestrate analyst -> executor -> reviewer */
async function handleEvolve(msg: AgentMessage): Promise<AgentResponse> {
  const { goalId, description } = msg.payload as { goalId: string; description: string };
  await logger.info('coordinator', `Orchestrating evolution for goal: ${description}`);

  // Step 1: Ask Analyst for strategy
  let strategy: unknown = null;
  if (agentBus.hasAgent(AgentRole.Analyst)) {
    const strategyResult = await agentBus.send({
      from: AgentRole.Coordinator,
      to: AgentRole.Analyst,
      type: 'suggest_strategy',
      payload: { goalId, description },
    });
    if (strategyResult.success) {
      strategy = strategyResult.data;
    } else {
      await logger.warn('coordinator', `Analyst strategy failed: ${strategyResult.error}, proceeding without`);
    }
  }

  // Step 2: Execute via Executor
  if (!agentBus.hasAgent(AgentRole.Executor)) {
    return { success: false, error: 'Executor agent not available' };
  }

  const execResult = await agentBus.send({
    from: AgentRole.Coordinator,
    to: AgentRole.Executor,
    type: 'execute',
    payload: { goalId, description, strategy },
  });

  if (!execResult.success) {
    await logger.warn('coordinator', `Execution failed: ${execResult.error}`);
    return { success: false, error: `Execution failed: ${execResult.error}` };
  }

  // Step 3: Review via Reviewer
  if (agentBus.hasAgent(AgentRole.Reviewer)) {
    const reviewResult = await agentBus.send({
      from: AgentRole.Coordinator,
      to: AgentRole.Reviewer,
      type: 'review',
      payload: { goalId, executionResult: execResult.data },
    });

    if (!reviewResult.success) {
      await logger.warn('coordinator', `Review failed: ${reviewResult.error}`);
      return {
        success: false,
        error: `Review failed: ${reviewResult.error}`,
        data: { executionResult: execResult.data, reviewResult: reviewResult.data },
      };
    }

    return {
      success: true,
      data: {
        strategy,
        executionResult: execResult.data,
        reviewResult: reviewResult.data,
      },
    };
  }

  // No reviewer available — return execution result directly
  return { success: true, data: { strategy, executionResult: execResult.data } };
}

/** Handle generic high-level task — decompose and route */
async function handleTask(msg: AgentMessage): Promise<AgentResponse> {
  const { description, context } = msg.payload as { description: string; context?: Record<string, unknown> };
  await logger.info('coordinator', `Decomposing task: ${description}`);

  const desc = description.toLowerCase();
  const results: Array<{ agent: string; response: AgentResponse }> = [];

  // Dynamic capability matching (augments hardcoded keywords)
  let capMatches: ReturnType<typeof matchCapabilities> = [];
  try {
    const agentCaps = await getAgentCapabilities();
    capMatches = matchCapabilities(description, agentCaps);
  } catch { /* capability registry unavailable — fall through to keyword matching */ }

  const hasCap = (cap: string, threshold = 0.3) =>
    capMatches.some(m => m.capability === cap && m.score >= threshold);

  // Determine which agents to involve (capability match OR keyword fallback)
  const shouldAnalyze = hasCap('analysis') || hasCap('research') ||
    desc.includes('analyze') || desc.includes('suggest') ||
    desc.includes('pattern') || desc.includes('metric');

  const shouldExecute = hasCap('code') ||
    desc.includes('implement') || desc.includes('create') ||
    desc.includes('fix') || desc.includes('add') ||
    desc.includes('modify') || desc.includes('evolve') ||
    desc.includes('build');

  const shouldReview = hasCap('review') ||
    desc.includes('review') || desc.includes('validate') ||
    desc.includes('check') || shouldExecute;

  const shouldMemory = hasCap('memory') ||
    desc.includes('remember') || desc.includes('memory') ||
    desc.includes('knowledge') || desc.includes('learn') ||
    desc.includes('recall');

  // Route in parallel where possible
  const promises: Promise<void>[] = [];

  if (shouldAnalyze && agentBus.hasAgent(AgentRole.Analyst)) {
    promises.push(
      agentBus.send({
        from: AgentRole.Coordinator,
        to: AgentRole.Analyst,
        type: 'analyze',
        payload: { question: description, context },
      }).then((r) => { results.push({ agent: 'analyst', response: r }); }),
    );
  }

  if (shouldMemory && agentBus.hasAgent(AgentRole.MemoryManager)) {
    promises.push(
      agentBus.send({
        from: AgentRole.Coordinator,
        to: AgentRole.MemoryManager,
        type: 'search_memory',
        payload: { query: description },
      }).then((r) => { results.push({ agent: 'memory', response: r }); }),
    );
  }

  await Promise.allSettled(promises);

  // Sequential: execute then review
  if (shouldExecute && agentBus.hasAgent(AgentRole.Executor)) {
    const execResult = await agentBus.send({
      from: AgentRole.Coordinator,
      to: AgentRole.Executor,
      type: 'execute',
      payload: { goalId: 'task', description, strategy: results.find((r) => r.agent === 'analyst')?.response.data },
    });
    results.push({ agent: 'executor', response: execResult });

    if (shouldReview && execResult.success && agentBus.hasAgent(AgentRole.Reviewer)) {
      const reviewResult = await agentBus.send({
        from: AgentRole.Coordinator,
        to: AgentRole.Reviewer,
        type: 'review',
        payload: { goalId: 'task', executionResult: execResult.data },
      });
      results.push({ agent: 'reviewer', response: reviewResult });
    }
  }

  // If nothing was routed, send to analyst as a fallback
  if (results.length === 0 && agentBus.hasAgent(AgentRole.Analyst)) {
    const fallbackResult = await agentBus.send({
      from: AgentRole.Coordinator,
      to: AgentRole.Analyst,
      type: 'analyze',
      payload: { question: description, context },
    });
    results.push({ agent: 'analyst', response: fallbackResult });
  }

  const allSuccess = results.every((r) => r.response.success);
  const errors = results.filter((r) => !r.response.success).map((r) => `${r.agent}: ${r.response.error}`);

  return {
    success: allSuccess || results.some((r) => r.response.success),
    data: {
      subResults: results.map((r) => ({ agent: r.agent, ...r.response })),
      summary: `Routed to ${results.length} agent(s): ${results.map((r) => r.agent).join(', ')}`,
    },
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}

/** Route a query to the analyst */
async function handleQuery(msg: AgentMessage): Promise<AgentResponse> {
  const { question } = msg.payload as { question: string };

  if (agentBus.hasAgent(AgentRole.Analyst)) {
    return agentBus.send({
      from: AgentRole.Coordinator,
      to: AgentRole.Analyst,
      type: 'analyze',
      payload: { question },
    });
  }

  return { success: false, error: 'Analyst agent not available' };
}

/** Route memory operation to memory manager */
async function handleMemoryOp(msg: AgentMessage): Promise<AgentResponse> {
  if (!agentBus.hasAgent(AgentRole.MemoryManager)) {
    return { success: false, error: 'MemoryManager agent not available' };
  }

  return agentBus.send({
    from: AgentRole.Coordinator,
    to: AgentRole.MemoryManager,
    type: msg.type,
    payload: msg.payload,
  });
}

/** Report status of the agent system */
async function handleStatus(): Promise<AgentResponse> {
  const roles = agentBus.getRegisteredRoles();
  const queueDepths = Object.fromEntries(
    roles.map((r) => [r, agentBus.getQueueDepth(r)]),
  );

  return {
    success: true,
    data: {
      registeredAgents: roles,
      queueDepths,
      agentCount: roles.length,
    },
  };
}
