import { describe, it, expect } from 'vitest';
import { getParallelStages } from '../../src/agents/config/team-config.js';
import type { TeamTemplate } from '../../src/agents/config/team-config.js';

function makeTemplate(
  stages: Array<{ id: string; agentName: string; inputFrom?: string[] }>,
  mode: 'sequential' | 'parallel' | 'mixed' = 'mixed',
): TeamTemplate {
  return {
    name: 'test-team',
    description: 'test',
    version: 1,
    members: [],
    workflow: {
      mode,
      stages: stages.map((s) => ({ ...s, inputFilter: 'passthrough' })),
    },
    budget: { maxTotalCostUsd: 1 },
    governance: {
      requireReviewStage: false,
      minConfidence: 0.5,
      escalateOnFailure: 'abort',
    },
  };
}

describe('TeamConfig', () => {
  describe('getParallelStages()', () => {
    it('puts independent stages in the same layer', () => {
      const t = makeTemplate([
        { id: 'a', agentName: 'explorer' },
        { id: 'b', agentName: 'security-scanner' },
      ]);
      const layers = getParallelStages(t);
      expect(layers).toHaveLength(1);
      expect(layers[0]).toHaveLength(2);
    });

    it('puts dependent stages in separate layers', () => {
      const t = makeTemplate([
        { id: 'research', agentName: 'explorer' },
        { id: 'write', agentName: 'blog-writer', inputFrom: ['research'] },
      ]);
      const layers = getParallelStages(t);
      expect(layers).toHaveLength(2);
      expect(layers[0]![0]!.id).toBe('research');
      expect(layers[1]![0]!.id).toBe('write');
    });

    it('handles mixed parallel + sequential (fan-out/fan-in)', () => {
      const t = makeTemplate([
        { id: 'scan-a', agentName: 'security-scanner' },
        { id: 'scan-b', agentName: 'github-patrol' },
        { id: 'investigate', agentName: 'deep-researcher', inputFrom: ['scan-a', 'scan-b'] },
      ]);
      const layers = getParallelStages(t);
      expect(layers).toHaveLength(2);
      expect(layers[0]).toHaveLength(2); // scan-a and scan-b in parallel
      expect(layers[1]).toHaveLength(1); // investigate after both
    });

    it('handles single stage', () => {
      const t = makeTemplate([{ id: 'solo', agentName: 'explorer' }]);
      const layers = getParallelStages(t);
      expect(layers).toHaveLength(1);
      expect(layers[0]).toHaveLength(1);
    });

    it('handles three-stage linear pipeline', () => {
      const t = makeTemplate([
        { id: 'a', agentName: 'explorer' },
        { id: 'b', agentName: 'blog-writer', inputFrom: ['a'] },
        { id: 'c', agentName: 'reviewer', inputFrom: ['b'] },
      ]);
      const layers = getParallelStages(t);
      expect(layers).toHaveLength(3);
      expect(layers[0]![0]!.id).toBe('a');
      expect(layers[1]![0]!.id).toBe('b');
      expect(layers[2]![0]!.id).toBe('c');
    });

    it('handles diamond dependency', () => {
      // A → B, A → C, B+C → D
      const t = makeTemplate([
        { id: 'a', agentName: 'explorer' },
        { id: 'b', agentName: 'scanner', inputFrom: ['a'] },
        { id: 'c', agentName: 'analyst', inputFrom: ['a'] },
        { id: 'd', agentName: 'writer', inputFrom: ['b', 'c'] },
      ]);
      const layers = getParallelStages(t);
      expect(layers).toHaveLength(3);
      expect(layers[0]).toHaveLength(1); // a
      expect(layers[1]).toHaveLength(2); // b, c in parallel
      expect(layers[2]).toHaveLength(1); // d
    });
  });
});
