/**
 * Agent system initialization — registers selected agents on the bus.
 * Strategy: Coordinator + Analyst + MemoryManager only.
 * Executor/Reviewer are excluded (overlap with evolution pipeline).
 */

import { agentBus } from './governance/agent-bus.js';
import { coordinator } from './coordinator.js';
import { analyst } from './analyst.js';
import { memoryManager } from './memory-manager.js';
import { logger } from '../core/logger.js';

export function initAgents(): void {
  agentBus.register(coordinator);
  agentBus.register(analyst);
  agentBus.register(memoryManager);
  logger.info('agents', `Agents initialized: ${agentBus.getRegisteredRoles().join(', ')}`);
}

export async function disposeAgents(): Promise<void> {
  await agentBus.disposeAll();
}
