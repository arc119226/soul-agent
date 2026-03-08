/**
 * Mock askClaudeCode helper for integration tests.
 *
 * Provides a configurable mock that returns pre-set responses
 * based on agent name extracted from the options or prompt.
 */

import type { Result } from '../../src/result.js';
import type { ClaudeCodeResult } from '../../src/claude/claude-code.js';

export interface MockResponse {
  result: string;
  costUsd?: number;
  duration?: number;
  numTurns?: number;
  maxTurnsHit?: boolean;
}

/**
 * Create a mock askClaudeCode function that returns pre-configured responses.
 *
 * The mock matches responses by agent name. It inspects the system prompt
 * for agent name patterns (e.g. "你是「programmer」背景工作代理人") and
 * falls back to checking the prompt text for agent name keywords.
 *
 * @param responses - Map of agent name → mock response
 * @param fallback - Optional fallback response for unmatched agents
 */
export function createMockAskClaude(
  responses: Map<string, MockResponse>,
  fallback?: MockResponse,
) {
  const calls: Array<{ prompt: string; userId: number; opts?: Record<string, unknown> }> = [];

  const mockFn = async (
    prompt: string,
    userId: number,
    opts?: Record<string, unknown>,
  ): Promise<Result<ClaudeCodeResult>> => {
    calls.push({ prompt, userId, opts });

    // Extract agent name from system prompt (pattern: 你是「agentName」)
    const systemPrompt = (opts?.systemPrompt as string) ?? '';
    const agentMatch = systemPrompt.match(/你是「([^」]+)」/);
    const agentName = agentMatch?.[1] ?? '';

    // Try matching by agent name first, then by prompt content
    let response = responses.get(agentName);
    if (!response) {
      // Try matching by checking if any key appears in the prompt
      for (const [key, val] of responses) {
        if (prompt.includes(key) || systemPrompt.includes(key)) {
          response = val;
          break;
        }
      }
    }

    if (!response) {
      response = fallback;
    }

    if (!response) {
      return {
        ok: true,
        value: {
          result: `[mock] No response configured for agent "${agentName}"`,
          costUsd: 0.01,
          sessionId: null,
          duration: 100,
          numTurns: 1,
        },
        message: 'mock',
      };
    }

    return {
      ok: true,
      value: {
        result: response.result,
        costUsd: response.costUsd ?? 0.05,
        sessionId: null,
        duration: response.duration ?? 500,
        numTurns: response.numTurns ?? 3,
        maxTurnsHit: response.maxTurnsHit,
      },
      message: 'mock',
    };
  };

  return {
    /** The mock function — use with vi.fn().mockImplementation(mockFn) or vi.mock */
    mockFn,
    /** All captured calls for assertion */
    calls,
  };
}
