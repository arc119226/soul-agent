/**
 * Barrel re-exports for the agents subsystem.
 *
 * Consumers should import types and key functions from here
 * rather than reaching into subdirectories directly.
 */

// ── Types ────────────────────────────────────────────────────────────
export type {
  AgentRole,
  MessageType,
  AgentMessage,
  AgentResponse,
  Agent,
  TaskPayload,
  AnalysisPayload,
  ExecutionPayload,
  ReviewPayload,
  MemoryOpPayload,
} from './types.js';

export type {
  TaskStatus,
  ExecutionTrace,
  AgentTask,
  TaskQueue,
  PromptMetrics,
  AgentReport,
} from './task-types.js';

export type { AgentConfig } from './config/agent-config.js';

// ── Re-exports from key modules ──────────────────────────────────────
export {
  enqueueTask,
  getQueueStatus,
  getRecentReports,
  MAX_CONCURRENT_WORKERS,
} from './worker-scheduler.js';

export {
  loadAgentConfig,
  loadAllAgentConfigs,
  saveAgentConfig,
  listAgentNames,
} from './config/agent-config.js';
