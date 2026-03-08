import { describe, it, expect } from 'vitest';
import { AgentRole, createMessage } from '../../src/agents/types.js';

describe('Agent Types', () => {
  describe('AgentRole enum', () => {
    it('has all expected roles', () => {
      expect(AgentRole.Coordinator).toBe('coordinator');
      expect(AgentRole.Analyst).toBe('analyst');
      expect(AgentRole.Executor).toBe('executor');
      expect(AgentRole.Reviewer).toBe('reviewer');
      expect(AgentRole.MemoryManager).toBe('memory_manager');
    });

    it('has exactly 5 roles', () => {
      const values = Object.values(AgentRole);
      expect(values).toHaveLength(5);
    });

    it('has unique values', () => {
      const values = Object.values(AgentRole);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });
  });

  describe('createMessage()', () => {
    it('returns correct message structure', () => {
      const msg = createMessage(
        AgentRole.Coordinator,
        AgentRole.Analyst,
        'task',
        { description: 'test task' },
      );

      expect(msg.from).toBe(AgentRole.Coordinator);
      expect(msg.to).toBe(AgentRole.Analyst);
      expect(msg.type).toBe('task');
      expect(msg.payload).toEqual({ description: 'test task' });
      expect(msg.replyTo).toBeUndefined();
    });

    it('includes replyTo when provided', () => {
      const msg = createMessage(
        AgentRole.Analyst,
        AgentRole.Coordinator,
        'response',
        { data: 'result' },
        'msg-123',
      );

      expect(msg.replyTo).toBe('msg-123');
    });

    it('does not include id or timestamp (partial message)', () => {
      const msg = createMessage(
        AgentRole.Executor,
        AgentRole.Reviewer,
        'execute',
        {},
      );

      expect('id' in msg).toBe(false);
      expect('timestamp' in msg).toBe(false);
    });

    it('handles custom string type', () => {
      const msg = createMessage(
        AgentRole.Coordinator,
        AgentRole.Executor,
        'custom_action',
        null,
      );

      expect(msg.type).toBe('custom_action');
      expect(msg.payload).toBeNull();
    });

    it('handles all standard message types', () => {
      const types = ['task', 'result', 'query', 'response', 'error', 'status'] as const;

      for (const type of types) {
        const msg = createMessage(AgentRole.Coordinator, AgentRole.Analyst, type, {});
        expect(msg.type).toBe(type);
      }
    });
  });
});
