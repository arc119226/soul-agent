/**
 * Multi-agent system type definitions.
 */

export enum AgentRole {
  Coordinator = 'coordinator',
  Analyst = 'analyst',
  Executor = 'executor',
  Reviewer = 'reviewer',
  MemoryManager = 'memory_manager',
}

export type MessageType =
  | 'task'
  | 'result'
  | 'query'
  | 'response'
  | 'error'
  | 'status'
  | 'evolve'
  | 'suggest_strategy'
  | 'analyze'
  | 'execute'
  | 'review'
  | 'memory_op'
  | 'store_memory'
  | 'retrieve_memory'
  | 'store_fact'
  | 'get_user'
  | 'search_memory'
  | 'compress_memory';

export interface AgentMessage {
  id: string;
  from: AgentRole;
  to: AgentRole;
  type: MessageType | string;
  payload: unknown;
  timestamp: number;
  replyTo?: string;
}

export interface AgentResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface Agent {
  role: AgentRole;
  handle(msg: AgentMessage): Promise<AgentResponse>;
  dispose?(): void | Promise<void>;
}

/** Helper to create an AgentMessage */
export function createMessage(
  from: AgentRole,
  to: AgentRole,
  type: MessageType | string,
  payload: unknown,
  replyTo?: string,
): Omit<AgentMessage, 'id' | 'timestamp'> {
  return { from, to, type, payload, replyTo };
}

/** Task payload for coordinator decomposition */
export interface TaskPayload {
  description: string;
  context?: Record<string, unknown>;
  priority?: number;
}

/** Analysis payload from analyst */
export interface AnalysisPayload {
  metrics: Record<string, number>;
  suggestions: string[];
  patterns: string[];
}

/** Execution payload for executor */
export interface ExecutionPayload {
  prompt: string;
  cwd?: string;
  timeout?: number;
}

/** Review payload from reviewer */
export interface ReviewPayload {
  passed: boolean;
  issues: string[];
  recommendations: string[];
}

/** Memory operation payload */
export interface MemoryOpPayload {
  operation: 'read' | 'write' | 'search' | 'compress';
  key?: string;
  value?: unknown;
  query?: string;
  chatId?: number;
  userId?: number;
}
