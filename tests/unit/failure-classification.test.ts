import { describe, it, expect, vi } from 'vitest';

// ── Heavy mocks to allow importing worker-scheduler ──────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  readdir: vi.fn(),
  rmdir: vi.fn(),
}));

vi.mock('../../src/core/tail-read.js', () => ({
  tailReadJsonl: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/core/event-bus.js', () => ({
  eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/core/timezone.js', () => ({
  getTodayString: vi.fn(() => '2026-01-01'),
  toLocalDateString: vi.fn((s: string) => s.slice(0, 10)),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { writeNow: vi.fn().mockResolvedValue(undefined), schedule: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    TIMEZONE: 'Asia/Taipei',
    MODEL_TIER_SONNET: 'claude-sonnet-4-6',
  },
}));

vi.mock('../../src/claude/claude-code.js', () => ({
  askClaudeCode: vi.fn(),
  isBusy: vi.fn(() => false),
  LIGHTWEIGHT_CWD: '/tmp/test-cwd',
}));

vi.mock('../../src/agents/monitoring/result-assessor.js', () => ({
  assessHeuristic: vi.fn(() => 0.5),
}));

vi.mock('../../src/core/database.js', () => ({
  getDb: vi.fn(() => null),
}));

vi.mock('../../src/agents/config/agent-config.js', () => ({
  loadAgentConfig: vi.fn(),
  loadAllAgentConfigs: vi.fn().mockResolvedValue([]),
  recordAgentRun: vi.fn().mockResolvedValue(undefined),
  recordAgentFailure: vi.fn().mockResolvedValue(undefined),
  isOverDailyLimit: vi.fn().mockResolvedValue(false),
  parseScheduleInterval: vi.fn(),
  isDailyScheduleDue: vi.fn(),
}));

vi.mock('../../src/agents/governance/agent-permissions.js', () => ({
  getEffectivePermissions: vi.fn(),
  buildPermissionPrompt: vi.fn(() => ''),
}));

import { classifyFailure } from '../../src/agents/worker-scheduler.js';

describe('classifyFailure() — SPEC-15', () => {
  describe('transient failures', () => {
    it('classifies timeout errors as transient', () => {
      expect(classifyFailure('Process timed out after 120000ms')).toBe('transient');
      expect(classifyFailure('Request timeout')).toBe('transient');
      expect(classifyFailure('ETIMEDOUT connecting to server')).toBe('transient');
    });

    it('classifies busy/rate limit errors as transient', () => {
      expect(classifyFailure('Claude Code is busy')).toBe('transient');
      expect(classifyFailure('Rate limit exceeded, retry later')).toBe('transient');
    });

    it('classifies network errors as transient', () => {
      expect(classifyFailure('ECONNRESET by peer')).toBe('transient');
      expect(classifyFailure('Network error while connecting')).toBe('transient');
      expect(classifyFailure('socket hang up')).toBe('transient');
    });

    it('classifies overloaded errors as transient', () => {
      expect(classifyFailure('overloaded_error: service unavailable')).toBe('transient');
    });

    it('classifies unexpected termination as transient', () => {
      expect(classifyFailure('Worker process terminated unexpectedly')).toBe('transient');
    });
  });

  describe('budget failures', () => {
    it('classifies budget errors as budget', () => {
      expect(classifyFailure('Daily budget exceeded')).toBe('budget');
      expect(classifyFailure('Agent over daily limit')).toBe('budget');
    });

    it('classifies cost limit errors as budget', () => {
      expect(classifyFailure('Task cost limit reached')).toBe('budget');
      expect(classifyFailure('Agent is over limit for today')).toBe('budget');
    });

    it('classifies per-task budget errors as budget', () => {
      expect(classifyFailure('Per-task budget exceeded: $0.50 > $0.30')).toBe('budget');
    });
  });

  describe('quality failures', () => {
    it('classifies max turns errors as quality (not transient — triggers graduated response)', () => {
      expect(classifyFailure('Agent exceeded max turns (100 turns, 120000ms)')).toBe('quality');
      expect(classifyFailure('Max turns reached')).toBe('quality');
    });

    it('classifies generic errors as quality', () => {
      expect(classifyFailure('Output validation failed')).toBe('quality');
      expect(classifyFailure('Low confidence score: 0.2')).toBe('quality');
      expect(classifyFailure('LLM judge rejected output')).toBe('quality');
    });

    it('classifies unknown errors as quality', () => {
      expect(classifyFailure('Something went wrong')).toBe('quality');
      expect(classifyFailure('unknown error')).toBe('quality');
    });

    it('classifies empty error as quality', () => {
      expect(classifyFailure('')).toBe('quality');
    });
  });

  describe('case insensitivity', () => {
    it('handles mixed case error messages', () => {
      expect(classifyFailure('TIMED OUT')).toBe('transient');
      expect(classifyFailure('Daily BUDGET exceeded')).toBe('budget');
      expect(classifyFailure('ECONNRESET')).toBe('transient');
    });
  });
});
