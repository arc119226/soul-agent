import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock agent-config before importing
vi.mock('../../src/agents/config/agent-config.js', () => ({
  loadAllAgentConfigs: vi.fn(),
}));

import {
  matchCapabilities,
  getAgentCapabilities,
  invalidateCapabilityCache,
  getCapabilityKeywords,
} from '../../src/agents/config/capability-registry.js';
import { loadAllAgentConfigs } from '../../src/agents/config/agent-config.js';
import type { AgentConfig } from '../../src/agents/config/agent-config.js';

const mockLoadAll = vi.mocked(loadAllAgentConfigs);

function makeConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    name: 'test-agent',
    description: '',
    enabled: true,
    schedule: 'manual',
    systemPrompt: '',
    model: '',
    maxTurns: 100,
    timeout: 120_000,
    dailyCostLimit: 1,
    notifyChat: false,
    targets: {},
    lastRun: null,
    totalCostToday: 0,
    costResetDate: '2026-01-01',
    totalRuns: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('Capability Registry', () => {
  beforeEach(() => {
    invalidateCapabilityCache();
    mockLoadAll.mockReset();
  });

  describe('matchCapabilities()', () => {
    it('ranks agents by keyword overlap score', () => {
      const caps = new Map<string, string[]>();
      caps.set('researcher', ['research', 'analysis']);
      caps.set('blogger', ['blog']);

      const matches = matchCapabilities('analyze metrics and research patterns', caps);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]!.agentName).toBe('researcher');
    });

    it('returns empty array for unmatched description', () => {
      const caps = new Map<string, string[]>();
      caps.set('security-agent', ['security']);

      const matches = matchCapabilities('what is the weather today', caps);
      expect(matches).toEqual([]);
    });

    it('handles multiple agents with same capability', () => {
      const caps = new Map<string, string[]>();
      caps.set('explorer', ['research']);
      caps.set('deep-researcher', ['research', 'analysis']);

      const matches = matchCapabilities('research AI trends', caps);
      // Both should match
      expect(matches.length).toBe(2);
    });

    it('scores higher when more keywords match', () => {
      const caps = new Map<string, string[]>();
      caps.set('full-researcher', ['research', 'analysis']);
      caps.set('monitor', ['monitoring']);

      const matches = matchCapabilities('analyze and evaluate patterns', caps);
      expect(matches.length).toBeGreaterThan(0);
      // analysis has more keyword hits for "analyze" and "evaluate"
      expect(matches[0]!.capability).toBe('analysis');
    });
  });

  describe('getAgentCapabilities()', () => {
    it('uses explicit capabilities when available', async () => {
      mockLoadAll.mockResolvedValue([
        makeConfig({ name: 'agent-a', capabilities: ['security', 'monitoring'] }),
      ]);

      const caps = await getAgentCapabilities();
      expect(caps.get('agent-a')).toEqual(['security', 'monitoring']);
    });

    it('infers capabilities from description when not set', async () => {
      mockLoadAll.mockResolvedValue([
        makeConfig({ name: 'my-scanner', description: 'security vulnerability scanner' }),
      ]);

      const caps = await getAgentCapabilities();
      expect(caps.get('my-scanner')).toContain('security');
    });

    it('excludes disabled agents', async () => {
      mockLoadAll.mockResolvedValue([
        makeConfig({ name: 'active', enabled: true, capabilities: ['research'] }),
        makeConfig({ name: 'disabled', enabled: false, capabilities: ['research'] }),
      ]);

      const caps = await getAgentCapabilities();
      expect(caps.has('active')).toBe(true);
      expect(caps.has('disabled')).toBe(false);
    });

    it('caches results across calls', async () => {
      mockLoadAll.mockResolvedValue([
        makeConfig({ name: 'agent-x', capabilities: ['code'] }),
      ]);

      await getAgentCapabilities();
      await getAgentCapabilities();

      expect(mockLoadAll).toHaveBeenCalledTimes(1);
    });

    it('returns ["general"] for agents with no matching keywords', async () => {
      mockLoadAll.mockResolvedValue([
        makeConfig({ name: 'mystery', description: 'does something unique' }),
      ]);

      const caps = await getAgentCapabilities();
      expect(caps.get('mystery')).toEqual(['general']);
    });
  });

  describe('invalidateCapabilityCache()', () => {
    it('forces reload on next call', async () => {
      mockLoadAll.mockResolvedValue([
        makeConfig({ name: 'a', capabilities: ['research'] }),
      ]);

      await getAgentCapabilities();
      invalidateCapabilityCache();
      await getAgentCapabilities();

      expect(mockLoadAll).toHaveBeenCalledTimes(2);
    });
  });

  describe('getCapabilityKeywords()', () => {
    it('returns all defined capability tags', () => {
      const kw = getCapabilityKeywords();
      expect(Object.keys(kw)).toContain('research');
      expect(Object.keys(kw)).toContain('security');
      expect(Object.keys(kw)).toContain('code');
      expect(Object.keys(kw)).toContain('memory');
    });
  });
});
