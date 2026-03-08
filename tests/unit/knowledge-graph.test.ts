import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: {
    schedule: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock fs to avoid real disk I/O
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('not found')),
}));

import {
  upsertNode,
  upsertEdge,
  findNode,
  getNeighbors,
  describeRelated,
  getGraphStats,
  getGraph,
  resetCache,
} from '../../src/memory/knowledge-graph.js';

describe('KnowledgeGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
  });

  // ── upsertNode ───────────────────────────────────────────────

  describe('upsertNode', () => {
    it('creates a new node with correct defaults', async () => {
      const result = await upsertNode('Z-score', 'concept');
      expect(result.isNew).toBe(true);
      expect(result.id).toHaveLength(8);

      const graph = await getGraph();
      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0]!.label).toBe('z-score'); // normalised
      expect(graph.nodes[0]!.type).toBe('concept');
      expect(graph.nodes[0]!.mentionCount).toBe(1);
      expect(graph.nodes[0]!.strength).toBe(0.05);
    });

    it('strengthens existing node on duplicate upsert', async () => {
      await upsertNode('Z-score', 'concept');
      const result = await upsertNode('z-score', 'concept');
      expect(result.isNew).toBe(false);

      const graph = await getGraph();
      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0]!.mentionCount).toBe(2);
      expect(graph.nodes[0]!.strength).toBeCloseTo(0.1);
    });

    it('treats different types as different nodes', async () => {
      await upsertNode('Z-score', 'concept');
      await upsertNode('Z-score', 'skill');

      const graph = await getGraph();
      expect(graph.nodes).toHaveLength(2);
    });

    it('stores summary on first creation', async () => {
      await upsertNode('Merkle tree', 'concept', 'Hash-based data structure');
      const graph = await getGraph();
      expect(graph.nodes[0]!.summary).toBe('Hash-based data structure');
    });

    it('does not overwrite existing summary', async () => {
      await upsertNode('Merkle tree', 'concept', 'Original');
      await upsertNode('Merkle tree', 'concept', 'Replacement');
      const graph = await getGraph();
      expect(graph.nodes[0]!.summary).toBe('Original');
    });

    it('caps strength at 1.0', async () => {
      for (let i = 0; i < 25; i++) {
        await upsertNode('popular', 'concept');
      }
      const graph = await getGraph();
      expect(graph.nodes[0]!.strength).toBeLessThanOrEqual(1.0);
    });
  });

  // ── upsertEdge ───────────────────────────────────────────────

  describe('upsertEdge', () => {
    it('creates a new edge between existing nodes', async () => {
      const a = await upsertNode('anomaly', 'concept');
      const b = await upsertNode('z-score', 'concept');
      await upsertEdge(a.id, b.id, 'supports');

      const graph = await getGraph();
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]!.from).toBe(a.id);
      expect(graph.edges[0]!.to).toBe(b.id);
      expect(graph.edges[0]!.relation).toBe('supports');
      expect(graph.edges[0]!.evidenceCount).toBe(1);
      expect(graph.edges[0]!.weight).toBe(0.5);
    });

    it('strengthens existing edge on duplicate upsert', async () => {
      const a = await upsertNode('anomaly', 'concept');
      const b = await upsertNode('z-score', 'concept');
      await upsertEdge(a.id, b.id, 'supports');
      await upsertEdge(a.id, b.id, 'supports');

      const graph = await getGraph();
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]!.evidenceCount).toBe(2);
      expect(graph.edges[0]!.weight).toBeCloseTo(0.55);
    });

    it('ignores edges when node does not exist', async () => {
      const a = await upsertNode('anomaly', 'concept');
      await upsertEdge(a.id, 'nonexistent', 'supports');

      const graph = await getGraph();
      expect(graph.edges).toHaveLength(0);
    });

    it('allows different relations between same pair', async () => {
      const a = await upsertNode('anomaly', 'concept');
      const b = await upsertNode('z-score', 'concept');
      await upsertEdge(a.id, b.id, 'supports');
      await upsertEdge(a.id, b.id, 'triggers');

      const graph = await getGraph();
      expect(graph.edges).toHaveLength(2);
    });

    it('clamps weight to [0, 1]', async () => {
      const a = await upsertNode('a', 'concept');
      const b = await upsertNode('b', 'concept');
      await upsertEdge(a.id, b.id, 'relates_to', 5.0);

      const graph = await getGraph();
      expect(graph.edges[0]!.weight).toBe(1);
    });
  });

  // ── findNode ─────────────────────────────────────────────────

  describe('findNode', () => {
    it('finds node by exact label', async () => {
      await upsertNode('Z-score', 'concept');
      const node = await findNode('z-score');
      expect(node).not.toBeNull();
      expect(node!.label).toBe('z-score');
    });

    it('finds node case-insensitively', async () => {
      await upsertNode('Z-score', 'concept');
      const node = await findNode('Z-Score');
      expect(node).not.toBeNull();
    });

    it('returns null when no match', async () => {
      await upsertNode('Z-score', 'concept');
      const node = await findNode('completely-different');
      expect(node).toBeNull();
    });
  });

  // ── getNeighbors ─────────────────────────────────────────────

  describe('getNeighbors', () => {
    it('returns direct neighbors', async () => {
      const a = await upsertNode('z-score', 'concept');
      const b = await upsertNode('anomaly', 'concept');
      const c = await upsertNode('kill-switch', 'concept');
      await upsertEdge(a.id, b.id, 'supports');
      await upsertEdge(a.id, c.id, 'triggers');

      const neighbors = await getNeighbors(a.id);
      expect(neighbors).toHaveLength(2);
      const labels = neighbors.map(n => n.label);
      expect(labels).toContain('anomaly');
      expect(labels).toContain('kill-switch');
    });

    it('returns empty array for isolated node', async () => {
      const a = await upsertNode('lonely', 'concept');
      const neighbors = await getNeighbors(a.id);
      expect(neighbors).toHaveLength(0);
    });

    it('respects limit parameter', async () => {
      const a = await upsertNode('hub', 'concept');
      for (let i = 0; i < 10; i++) {
        const n = await upsertNode(`node-${i}`, 'concept');
        await upsertEdge(a.id, n.id, 'relates_to');
      }
      const neighbors = await getNeighbors(a.id, 1, 3);
      expect(neighbors).toHaveLength(3);
    });

    it('traverses bidirectionally', async () => {
      const a = await upsertNode('a', 'concept');
      const b = await upsertNode('b', 'concept');
      await upsertEdge(a.id, b.id, 'supports');

      // Should find 'a' when starting from 'b' (reverse traversal)
      const neighbors = await getNeighbors(b.id);
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0]!.label).toBe('a');
    });
  });

  // ── describeRelated ──────────────────────────────────────────

  describe('describeRelated', () => {
    it('returns empty string when topic not found', async () => {
      const result = await describeRelated('nonexistent');
      expect(result).toBe('');
    });

    it('returns empty string when no edges exist', async () => {
      await upsertNode('isolated', 'concept');
      const result = await describeRelated('isolated');
      expect(result).toBe('');
    });

    it('returns formatted description when edges exist', async () => {
      const a = await upsertNode('z-score', 'concept');
      const b = await upsertNode('anomaly', 'concept');
      await upsertEdge(a.id, b.id, 'supports');

      const result = await describeRelated('z-score');
      expect(result).toContain('z-score');
      expect(result).toContain('anomaly');
      expect(result).toContain('supports');
      expect(result).toContain('知識圖譜');
    });

    it('respects maxChars limit', async () => {
      const a = await upsertNode('z-score', 'concept');
      for (let i = 0; i < 10; i++) {
        const n = await upsertNode(`very-long-concept-name-${i}`, 'concept');
        await upsertEdge(a.id, n.id, 'relates_to');
      }
      const result = await describeRelated('z-score', 50);
      expect(result.length).toBeLessThanOrEqual(50);
    });
  });

  // ── getGraphStats ────────────────────────────────────────────

  describe('getGraphStats', () => {
    it('returns zeros for empty graph', async () => {
      const stats = await getGraphStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.topNodes).toEqual([]);
    });

    it('counts nodes and edges correctly', async () => {
      const a = await upsertNode('a', 'concept');
      const b = await upsertNode('b', 'concept');
      await upsertEdge(a.id, b.id, 'relates_to');

      const stats = await getGraphStats();
      expect(stats.nodeCount).toBe(2);
      expect(stats.edgeCount).toBe(1);
      expect(stats.topNodes).toHaveLength(2);
    });

    it('returns top nodes sorted by strength', async () => {
      await upsertNode('weak', 'concept');
      await upsertNode('strong', 'concept');
      await upsertNode('strong', 'concept'); // mention again

      const stats = await getGraphStats();
      expect(stats.topNodes[0]).toContain('strong');
    });
  });

  // ── Node eviction ────────────────────────────────────────────

  describe('eviction', () => {
    it('evicts weakest node when at capacity', async () => {
      // Create 500 nodes to fill capacity
      for (let i = 0; i < 500; i++) {
        await upsertNode(`node-${i}`, 'concept');
      }

      let graph = await getGraph();
      expect(graph.nodes).toHaveLength(500);

      // Adding one more should evict the weakest
      await upsertNode('new-node', 'concept');
      graph = await getGraph();
      expect(graph.nodes).toHaveLength(500);
      expect(graph.nodes.some(n => n.label === 'new-node')).toBe(true);
    });
  });
});
