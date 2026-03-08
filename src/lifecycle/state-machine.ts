/**
 * Bot lifecycle state machine.
 * States are ephemeral (in-memory only) — the bot starts fresh each boot.
 */

import { eventBus } from '../core/event-bus.js';
import { logger } from '../core/logger.js';

export type BotState =
  | 'active'
  | 'thinking'
  | 'working'
  | 'resting'
  | 'planning'
  | 'dormant'
  | 'throttled'
  | 'drained';

/** Valid transitions: from → set of allowed targets */
const VALID_TRANSITIONS: Record<BotState, Set<BotState>> = {
  active:    new Set(['thinking', 'working', 'resting', 'planning', 'dormant', 'throttled']),
  thinking:  new Set(['active', 'working', 'resting', 'throttled']),
  working:   new Set(['active', 'thinking', 'resting', 'throttled']),
  resting:   new Set(['active', 'dormant']),
  planning:  new Set(['active', 'working']),
  dormant:   new Set(['active', 'resting']),
  throttled: new Set(['active', 'drained', 'resting']),
  drained:   new Set(['throttled', 'resting']),
};

let currentState: BotState = 'active';
let stateEnteredAt: number = Date.now();

export function getCurrentState(): BotState {
  return currentState;
}

export function getStateEnteredAt(): number {
  return stateEnteredAt;
}

export function getStateDuration(): number {
  return Date.now() - stateEnteredAt;
}

export async function transition(newState: BotState, reason: string): Promise<boolean> {
  if (newState === currentState) return true;

  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed.has(newState)) {
    await logger.warn(
      'StateMachine',
      `Invalid transition: ${currentState} -> ${newState} (reason: ${reason})`,
    );
    return false;
  }

  const from = currentState;
  currentState = newState;
  stateEnteredAt = Date.now();

  await logger.info('StateMachine', `${from} -> ${newState}: ${reason}`);
  await eventBus.emit('lifecycle:state', { from, to: newState, reason });

  return true;
}

/** Force state without transition validation (for boot) */
export function setInitialState(state: BotState): void {
  currentState = state;
  stateEnteredAt = Date.now();
}
