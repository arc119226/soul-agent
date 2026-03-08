import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadFile, mockLogger } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { TIMEZONE: 'Asia/Taipei' },
}));

vi.mock('../../src/core/timezone.js', () => ({
  getTodayString: vi.fn(() => '2026-01-01'),
  toLocalDateString: vi.fn((s: string) => s.slice(0, 10)),
  getLocalDateParts: vi.fn(() => ({ year: 2026, month: 1, day: 1, hour: 12, minute: 0, dayOfWeek: 3 })),
}));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn(),
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { writeNow: vi.fn() },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: mockLogger,
}));

import { parseScheduleInterval, isDailyScheduleDue, loadAgentConfig, AgentConfigSchema } from '../../src/agents/config/agent-config.js';

describe('Agent Config', () => {
  describe('parseScheduleInterval()', () => {
    it('parses minutes interval', () => {
      expect(parseScheduleInterval('every:5m')).toBe(5 * 60 * 1000);
    });

    it('parses large minutes interval', () => {
      expect(parseScheduleInterval('every:30m')).toBe(30 * 60 * 1000);
    });

    it('parses hours interval', () => {
      expect(parseScheduleInterval('every:2h')).toBe(2 * 60 * 60 * 1000);
    });

    it('parses 1-hour interval', () => {
      expect(parseScheduleInterval('every:1h')).toBe(60 * 60 * 1000);
    });

    it('returns null for manual', () => {
      expect(parseScheduleInterval('manual')).toBeNull();
    });

    it('returns null for daily@HH:MM schedule', () => {
      expect(parseScheduleInterval('daily@08:00')).toBeNull();
      expect(parseScheduleInterval('daily@23:30')).toBeNull();
    });

    it('returns null for unrecognized format', () => {
      expect(parseScheduleInterval('garbage')).toBeNull();
      expect(parseScheduleInterval('')).toBeNull();
      expect(parseScheduleInterval('every:5')).toBeNull();
      expect(parseScheduleInterval('every:m')).toBeNull();
    });
  });

  describe('isDailyScheduleDue()', () => {
    it('returns true at exact schedule time', () => {
      // UTC 00:00 → Taipei 08:00
      const now = new Date('2026-02-13T00:00:00.000Z');
      expect(isDailyScheduleDue('daily@08:00', now)).toBe(true);
    });

    it('returns true shortly after schedule time', () => {
      // UTC 00:02 → Taipei 08:02
      const now = new Date('2026-02-13T00:02:00.000Z');
      expect(isDailyScheduleDue('daily@08:00', now)).toBe(true);
    });

    it('returns true well after schedule time (dedup handled by caller)', () => {
      // UTC 01:00 → Taipei 09:00 — still "due"; caller prevents duplicate runs
      const now = new Date('2026-02-13T01:00:00.000Z');
      expect(isDailyScheduleDue('daily@08:00', now)).toBe(true);
    });

    it('returns false before schedule time', () => {
      // UTC 23:00 (prev day) → Taipei 07:00 — too early
      const now = new Date('2026-02-12T23:00:00.000Z');
      expect(isDailyScheduleDue('daily@08:00', now)).toBe(false);
    });

    it('returns false for non-daily schedule', () => {
      expect(isDailyScheduleDue('every:5m')).toBe(false);
      expect(isDailyScheduleDue('manual')).toBe(false);
    });

    it('returns false for invalid daily format', () => {
      expect(isDailyScheduleDue('daily@8:00')).toBe(false);
      expect(isDailyScheduleDue('daily@')).toBe(false);
    });
  });

  describe('AgentConfigSchema', () => {
    it('accepts a valid minimal config', () => {
      const result = AgentConfigSchema.safeParse({ name: 'test-agent' });
      expect(result.success).toBe(true);
    });

    it('accepts a full valid config', () => {
      const result = AgentConfigSchema.safeParse({
        name: 'github-patrol',
        description: 'Patrols GitHub repos',
        enabled: true,
        schedule: 'every:2h',
        systemPrompt: 'You are a patrol agent.',
        model: 'claude-haiku-4-5-20251001',
        maxTurns: 50,
        timeout: 120000,
        dailyCostLimit: 1.5,
        budgetLocked: true,
        scheduleLocked: false,
        notifyChat: true,
        targets: { repos: ['foo/bar'] },
        role: 'observer',
        capabilities: ['research', 'monitoring'],
        lastRun: '2026-01-01T00:00:00.000Z',
        totalCostToday: 0.5,
        costResetDate: '2026-01-01',
        totalRuns: 10,
        runsToday: 2,
        createdAt: '2025-12-01T00:00:00.000Z',
        valueScore: 0.8,
      });
      expect(result.success).toBe(true);
    });

    it('preserves extra fields via passthrough', () => {
      const result = AgentConfigSchema.safeParse({
        name: 'test',
        customField: 'hello',
        anotherExtra: 42,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty('customField', 'hello');
        expect(result.data).toHaveProperty('anotherExtra', 42);
      }
    });

    it('rejects missing name', () => {
      const result = AgentConfigSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects empty name', () => {
      const result = AgentConfigSchema.safeParse({ name: '' });
      expect(result.success).toBe(false);
    });

    it('rejects dailyCostLimit: NaN', () => {
      const result = AgentConfigSchema.safeParse({ name: 'test', dailyCostLimit: NaN });
      expect(result.success).toBe(false);
    });

    it('rejects negative dailyCostLimit', () => {
      const result = AgentConfigSchema.safeParse({ name: 'test', dailyCostLimit: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects maxTurns: "yes" (string instead of number)', () => {
      const result = AgentConfigSchema.safeParse({ name: 'test', maxTurns: 'yes' });
      expect(result.success).toBe(false);
    });

    it('rejects maxTurns: 0 (must be positive)', () => {
      const result = AgentConfigSchema.safeParse({ name: 'test', maxTurns: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects maxTurns: 1.5 (must be integer)', () => {
      const result = AgentConfigSchema.safeParse({ name: 'test', maxTurns: 1.5 });
      expect(result.success).toBe(false);
    });

    it('rejects invalid role', () => {
      const result = AgentConfigSchema.safeParse({ name: 'test', role: 'researcher' });
      expect(result.success).toBe(false);
    });

    it('rejects timeout: 0 (must be positive)', () => {
      const result = AgentConfigSchema.safeParse({ name: 'test', timeout: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects enabled: "true" (string instead of boolean)', () => {
      const result = AgentConfigSchema.safeParse({ name: 'test', enabled: 'true' });
      expect(result.success).toBe(false);
    });
  });

  describe('loadAgentConfig() validation', () => {
    beforeEach(() => {
      mockReadFile.mockReset();
      mockLogger.error.mockReset();
    });

    it('returns config for valid JSON', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'test-agent',
        description: 'A test agent',
        dailyCostLimit: 1.0,
      }));
      const result = await loadAgentConfig('test-agent');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('test-agent');
      expect(result!.dailyCostLimit).toBe(1.0);
    });

    it('returns null and logs error for dailyCostLimit: NaN', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'bad-agent',
        dailyCostLimit: null,
      }));
      // JSON.parse turns NaN → null, but let's test with a string that produces invalid type
      mockReadFile.mockResolvedValue('{"name":"bad-agent","dailyCostLimit":"not-a-number"}');
      const result = await loadAgentConfig('bad-agent');
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'agent-config',
        expect.stringContaining('Invalid config for "bad-agent"'),
      );
    });

    it('returns null and logs error for role: "researcher"', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'bad-role',
        role: 'researcher',
      }));
      const result = await loadAgentConfig('bad-role');
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'agent-config',
        expect.stringContaining('Invalid config for "bad-role"'),
      );
    });

    it('returns null and logs error for maxTurns: "yes"', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'bad-turns',
        maxTurns: 'yes',
      }));
      const result = await loadAgentConfig('bad-turns');
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'agent-config',
        expect.stringContaining('Invalid config for "bad-turns"'),
      );
    });

    it('returns null for file not found (non-validation error)', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const result = await loadAgentConfig('nonexistent');
      expect(result).toBeNull();
    });

    it('preserves extra fields in loaded config', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'extra-agent',
        customSetting: 'keep-me',
      }));
      const result = await loadAgentConfig('extra-agent');
      expect(result).not.toBeNull();
      expect((result as Record<string, unknown>)['customSetting']).toBe('keep-me');
    });

    it('merges defaults for missing optional fields', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ name: 'minimal' }));
      const result = await loadAgentConfig('minimal');
      expect(result).not.toBeNull();
      expect(result!.enabled).toBe(true);
      expect(result!.schedule).toBe('manual');
      expect(result!.maxTurns).toBe(100);
      expect(result!.dailyCostLimit).toBe(0.50);
    });
  });
});
