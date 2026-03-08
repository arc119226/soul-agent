/**
 * Knowledge Graph — semantic relationships between concepts.
 *
 * Stores nodes (concepts, skills, insights, projects, people) and
 * directed edges (relates_to, supports, implements, etc.) in a single
 * JSON file under soul/. Designed to be lightweight, portable, and
 * integrated with the existing debounced-writer for atomic persistence.
 *
 * The graph is populated organically: every addTopic() call in
 * chat-memory registers a concept node, and edges can be added
 * manually or by future heuristics.
 */

import { randomBytes } from 'node:crypto';
import { readSoulJson, scheduleSoulJson } from '../core/soul-io.js';
import { computeRelevance } from './text-relevance.js';
const MAX_NODES = 500;
const STRENGTH_INCREMENT = 0.05;
const FUZZY_THRESHOLD = 0.7;

// ── Types ──────────────────────────────────────────────────────

export type NodeType = 'concept' | 'skill' | 'insight' | 'project' | 'person';

export interface KnowledgeNode {
  id: string;
  type: NodeType;
  label: string;        // normalised (lowercase trimmed)
  summary?: string;
  strength: number;     // 0–1
  createdAt: string;
  updatedAt: string;
  mentionCount: number;
}

export type EdgeRelation =
  | 'relates_to'
  | 'evolved_from'
  | 'triggers'
  | 'conflicts_with'
  | 'supports'
  | 'implements'
  | 'part_of';

export interface KnowledgeEdge {
  from: string;  // nodeId
  to: string;    // nodeId
  relation: EdgeRelation;
  weight: number;        // 0–1
  evidenceCount: number;
  createdAt: string;
}

export interface KnowledgeGraphData {
  version: number;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  lastUpdated: string;
}

// ── In-memory state ────────────────────────────────────────────

let graphData: KnowledgeGraphData | null = null;

function genId(): string {
  return randomBytes(4).toString('hex');
}

function normalise(label: string): string {
  return label.trim().toLowerCase();
}

// ── Persistence ────────────────────────────────────────────────

async function load(): Promise<KnowledgeGraphData> {
  if (graphData) return graphData;
  try {
    graphData = await readSoulJson<KnowledgeGraphData>('knowledge-graph.json');
  } catch {
    graphData = { version: 1, nodes: [], edges: [], lastUpdated: new Date().toISOString() };
  }
  return graphData;
}

function persist(): void {
  if (!graphData) return;
  graphData.lastUpdated = new Date().toISOString();
  scheduleSoulJson('knowledge-graph.json', graphData);
}

// ── Node operations ────────────────────────────────────────────

/**
 * Add or strengthen a node. If a node with the same normalised label
 * and type already exists, its strength and mentionCount are bumped.
 */
export async function upsertNode(
  label: string,
  type: NodeType,
  summary?: string,
): Promise<{ id: string; isNew: boolean }> {
  const data = await load();
  const norm = normalise(label);

  const existing = data.nodes.find(n => n.label === norm && n.type === type);
  if (existing) {
    existing.mentionCount++;
    existing.strength = Math.min(existing.strength + STRENGTH_INCREMENT, 1);
    existing.updatedAt = new Date().toISOString();
    if (summary && !existing.summary) existing.summary = summary;
    persist();
    return { id: existing.id, isNew: false };
  }

  // Evict weakest node when at capacity
  if (data.nodes.length >= MAX_NODES) {
    const weakest = [...data.nodes]
      .filter(n => n.mentionCount < 2)
      .sort((a, b) => a.strength - b.strength)[0];
    if (weakest) {
      data.nodes = data.nodes.filter(n => n.id !== weakest.id);
      data.edges = data.edges.filter(e => e.from !== weakest.id && e.to !== weakest.id);
    }
  }

  const node: KnowledgeNode = {
    id: genId(),
    type,
    label: norm,
    summary,
    strength: STRENGTH_INCREMENT,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mentionCount: 1,
  };
  data.nodes.push(node);
  persist();

  return { id: node.id, isNew: true };
}

// ── Edge operations ────────────────────────────────────────────

/**
 * Add or strengthen a directed edge between two nodes.
 * If an edge with the same (from, to, relation) already exists,
 * its evidenceCount is bumped and weight adjusted.
 */
export async function upsertEdge(
  fromId: string,
  toId: string,
  relation: EdgeRelation,
  weight: number = 0.5,
): Promise<void> {
  const data = await load();

  // Validate both nodes exist
  if (!data.nodes.some(n => n.id === fromId) || !data.nodes.some(n => n.id === toId)) {
    return;
  }

  const existing = data.edges.find(
    e => e.from === fromId && e.to === toId && e.relation === relation,
  );
  if (existing) {
    existing.evidenceCount++;
    existing.weight = Math.min(existing.weight + 0.05, 1);
    persist();
    return;
  }

  data.edges.push({
    from: fromId,
    to: toId,
    relation,
    weight: Math.max(0, Math.min(weight, 1)),
    evidenceCount: 1,
    createdAt: new Date().toISOString(),
  });
  persist();
}

// ── Query operations ───────────────────────────────────────────

/**
 * Find a node by label. Tries exact match first, then fuzzy
 * (computeRelevance > FUZZY_THRESHOLD) falling back to null.
 */
export async function findNode(label: string): Promise<KnowledgeNode | null> {
  const data = await load();
  const norm = normalise(label);

  // Exact match
  const exact = data.nodes.find(n => n.label === norm);
  if (exact) return exact;

  // Fuzzy match — pick the highest relevance above threshold
  let best: KnowledgeNode | null = null;
  let bestScore = 0;
  for (const node of data.nodes) {
    const score = computeRelevance(norm, node.label);
    if (score > FUZZY_THRESHOLD && score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

/**
 * BFS traversal returning neighbour nodes (depth 1 by default).
 * Returns nodes sorted by edge weight descending.
 */
export async function getNeighbors(
  nodeId: string,
  maxDepth: number = 1,
  limit: number = 5,
): Promise<KnowledgeNode[]> {
  const data = await load();
  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: Array<{ id: string; weight: number }> = [];
    for (const current of frontier) {
      for (const edge of data.edges) {
        const neighbour =
          edge.from === current ? edge.to :
          edge.to === current ? edge.from :
          null;
        if (neighbour && !visited.has(neighbour)) {
          visited.add(neighbour);
          next.push({ id: neighbour, weight: edge.weight });
        }
      }
    }
    next.sort((a, b) => b.weight - a.weight);
    frontier = next.map(n => n.id);
    if (frontier.length === 0) break;
  }

  // Resolve IDs to nodes (excluding the start node)
  const nodeMap = new Map(data.nodes.map(n => [n.id, n]));
  const result: KnowledgeNode[] = [];
  for (const id of [...visited].slice(1)) {
    const node = nodeMap.get(id);
    if (node) result.push(node);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Produce a human-readable description of a topic's related concepts
 * for injection into the context weaver. Returns empty string when
 * no related nodes are found.
 *
 * Example output:
 *   「z-score 與 anomaly-detection（supports）、kill-switch（triggers）有關」
 */
export async function describeRelated(
  topic: string,
  maxChars: number = 200,
): Promise<string> {
  const node = await findNode(topic);
  if (!node) return '';

  const data = await load();
  const relations: Array<{ label: string; relation: string; weight: number }> = [];

  for (const edge of data.edges) {
    const otherId = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : null;
    if (!otherId) continue;
    const other = data.nodes.find(n => n.id === otherId);
    if (other) {
      relations.push({ label: other.label, relation: edge.relation, weight: edge.weight });
    }
  }

  if (relations.length === 0) return '';

  relations.sort((a, b) => b.weight - a.weight);
  const parts = relations.slice(0, 4).map(r => `${r.label}（${r.relation}）`);
  const text = `知識圖譜：${node.label} 與 ${parts.join('、')} 有關`;

  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}

// ── Stats ──────────────────────────────────────────────────────

export async function getGraphStats(): Promise<{
  nodeCount: number;
  edgeCount: number;
  topNodes: string[];
}> {
  const data = await load();
  const topNodes = [...data.nodes]
    .sort((a, b) => b.strength - a.strength || b.mentionCount - a.mentionCount)
    .slice(0, 5)
    .map(n => `${n.label}(${n.mentionCount})`);

  return {
    nodeCount: data.nodes.length,
    edgeCount: data.edges.length,
    topNodes,
  };
}

// ── Direct accessors (for testing / introspection) ─────────────

export async function getGraph(): Promise<KnowledgeGraphData> {
  return load();
}

export function resetCache(): void {
  graphData = null;
}
