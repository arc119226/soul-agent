/**
 * Type-safe EventEmitter for inter-module communication.
 */

type Handler<T = unknown> = (data: T) => void | Promise<void>;

export interface BotEvents {
  'message:received': { chatId: number; userId: number; text: string };
  'message:sent': { chatId: number; text: string };
  'evolution:start': { goalId: string; description: string };
  'evolution:success': { goalId: string; description: string };
  'evolution:fail': { goalId: string; error: string };
  'evolution:rollback': { goalId: string; reason: string };
  'evolution:intention': { goalId: string; complexity: string; motivation: string };
  'evolution:push:request': { goalId: string; complexity: string; summary: string };
  'evolution:push:approved': { goalId: string };
  'evolution:push:denied': { goalId: string; reason: string };
  'evolution:push:success': { goalId: string; commitHash: string };
  'evolution:push:failed': { goalId: string; error: string };
  'plugin:loaded': { name: string };
  'plugin:reloaded': { name: string };
  'plugin:error': { name: string; error: string };
  'memory:updated': { chatId: number; type: string; index?: number };
  'memory:compressed': { chatId: number; count: number };
  'identity:changed': { field: string; oldValue: unknown; newValue: unknown };
  'lifecycle:state': { from: string; to: string; reason: string };
  'heartbeat:tick': { timestamp: number; state: string; elu: number; fatigueScore?: number; fatigueLevel?: string };
  'milestone:reached': { type: string; description: string };
  'narrative:entry': { type: string; summary: string };
  'plan:created': { planId: string; title: string; intention: string };
  'plan:completed': { planId: string; title: string; satisfactionLevel: number };
  'plan:abandoned': { planId: string; title: string; reason: string };
  'agent:task:completed': { agentName: string; taskId: string; result: string; costUsd?: number };
  'agent:task:failed': { agentName: string; taskId: string; error: string; costUsd?: number };
  'reflection:done': Record<string, never>;
  'dream:completed': Record<string, never>;
  'shutdown:start': { reason: string };
  'shutdown:complete': Record<string, never>;
  'bot:ready': Record<string, never>;
  'bot:error': { error: string; module: string };
  'upgrade:suggested': { skillName: string; reason: string; priority: 'high' | 'medium'; estimatedSaving: number; notifiedAt: string };
  'upgrade:batch_sent': { count: number };
  'exploration:synthesize': { daysBack?: number };
  'staging:promoted': { id: string; category: string; content: string };
  'staging:expired': { id: string; category: string; content: string };
  'safety:level_changed': { from: string; to: string; reason: string; timestamp: number };
  'soul:integrity_mismatch': { changedFiles: string[]; expected: string; actual: string; context?: 'tick' | 'wake' | 'startup' };
  'lifecycle:anomaly': { metrics: Array<{ metric: string; current: number; mean: number; zScore: number }>; timestamp: number };
  'audit:witness': { merkleRoot: string; chainLength: number; state: string };
  'identity:health_check': { status: 'healthy' | 'degraded' | 'compromised'; summary: string; context: 'startup' | 'heartbeat' };
  'identity:passport': { action: 'generated' | 'verified'; hash: string; valid?: boolean; context: 'pre-evolution' | 'post-evolution' };
  'transition:recorded': { index: number; from: string; to: string; hash: string; vectorClock?: Record<string, number> };

  // ── Document Processing Events ──
  'document:received': { chatId: number; userId: number; type: string; fileName: string };
  'document:processed': { chatId: number; type: string; fileName: string; durationMs: number };
  'document:error': { chatId: number; type: string; fileName: string; error: string };

  // ── Team Pipeline Events ──
  'team:pipeline:started': { teamName: string; runId: string; prompt: string; resumedFrom?: string };
  'team:pipeline:completed': { teamName: string; runId: string; stages: number };
  'team:pipeline:aborted': { teamName: string; runId: string; reason: string };
  'team:pipeline:stage:completed': { teamName: string; runId: string; stageId: string; agentName: string };
  'team:pipeline:stage:failed': { teamName: string; runId: string; stageId: string; agentName: string; error: string };
  'team:pipeline:escalation': { teamName: string; runId: string; stageId: string; agentName: string; summary: string; to: string[] };

  // ── Concept Drift Events ──
  'agent:drift:detected': { agentName: string; metric: string; direction: 'increase' | 'decrease'; changeDate: string; phStatistic: number };
  // ── Dead Letter Queue Events ──
  'agent:dead-letter': { agentName: string; taskId: string; source: string; totalCost: number };
  // ── Worker Circuit Breaker ──
  'worker:circuit-open': { consecutiveFailures: number; cooldownMs: number };
  // ── Code Merge Events ──
  'code:merged': { taskId: string; prUrl: string; branchName: string; agentName: string };

  'cost:incurred': { source: 'main' | 'agent'; tier?: string; agentName?: string; costUsd: number; chatId?: number };
  'cost:anomaly': { agentName: string; costUsd: number; zScore: number; action: 'alert' | 'pause' };
}

export type EventName = keyof BotEvents;

class TypedEventBus {
  private handlers = new Map<string, Set<Handler>>();

  on<K extends EventName>(event: K, handler: Handler<BotEvents[K]>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as Handler);
  }

  off<K extends EventName>(event: K, handler: Handler<BotEvents[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler);
  }

  async emit<K extends EventName>(event: K, data: BotEvents[K]): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    const promises: Promise<void>[] = [];
    for (const handler of handlers) {
      try {
        const result = handler(data);
        if (result instanceof Promise) promises.push(result);
      } catch (err) {
        console.error(`[EventBus] Error in handler for ${event}:`, err);
      }
    }
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  listenerCount<K extends EventName>(event: K): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  listenerCounts(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [event, handlers] of this.handlers) {
      result[event] = handlers.size;
    }
    return result;
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const eventBus = new TypedEventBus();
