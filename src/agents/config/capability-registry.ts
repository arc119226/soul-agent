/**
 * Capability Registry — maps agent capability tags to routing keywords.
 *
 * Used by the coordinator to dynamically route tasks based on declared capabilities
 * instead of hardcoded keyword matching. Agents declare capabilities explicitly in
 * their config, or they are inferred from the description field (backward-compatible).
 *
 * Inspired by Google ADK's AutoFlow and Mastra's Agent Networks,
 * but implemented as zero-cost keyword matching (no LLM calls).
 */

import { loadAllAgentConfigs, type AgentConfig } from './agent-config.js';

// ── Capability Taxonomy ─────────────────────────────────────────────

/** Standard capability tags and their associated routing keywords. */
const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  research:      ['research', 'explore', 'investigate', 'discover', 'study', 'survey'],
  analysis:      ['analyze', 'analyse', 'metric', 'pattern', 'assess', 'evaluate', 'audit'],
  blog:          ['blog', 'write', 'article', 'post', 'draft', 'publish'],
  security:      ['security', 'scan', 'vulnerability', 'credential', 'safety'],
  monitoring:    ['monitor', 'patrol', 'check', 'watch', 'track', 'report'],
  code:          ['implement', 'create', 'fix', 'modify', 'evolve', 'build', 'code'],
  summarization: ['summarize', 'summary', 'digest', 'recap', 'overview'],
  memory:        ['remember', 'memory', 'knowledge', 'learn', 'recall', 'store'],
  review:        ['review', 'validate', 'verify'],
};

// ── Types ────────────────────────────────────────────────────────────

export interface CapabilityMatch {
  agentName: string;
  capability: string;
  score: number;   // 0-1, keyword overlap ratio
}

// ── Cache ────────────────────────────────────────────────────────────

let capabilityCache: Map<string, string[]> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 300_000; // 5 minutes

// ── Public API ──────────────────────────────────────────────────────

/** Load and cache all enabled agent capabilities. */
export async function getAgentCapabilities(): Promise<Map<string, string[]>> {
  const now = Date.now();
  if (capabilityCache && now - cacheTimestamp < CACHE_TTL) {
    return capabilityCache;
  }

  const configs = await loadAllAgentConfigs();
  const map = new Map<string, string[]>();

  for (const cfg of configs) {
    if (!cfg.enabled) continue;
    const caps = cfg.capabilities?.length ? cfg.capabilities : inferCapabilities(cfg);
    map.set(cfg.name, caps);
  }

  capabilityCache = map;
  cacheTimestamp = now;
  return map;
}

/**
 * Match a task description against agent capabilities.
 * Returns sorted list of matching agents (best match first).
 */
export function matchCapabilities(
  description: string,
  agentCaps: Map<string, string[]>,
): CapabilityMatch[] {
  const desc = description.toLowerCase();
  const matches: CapabilityMatch[] = [];

  for (const [agentName, caps] of agentCaps) {
    let bestScore = 0;
    let bestCap = '';

    for (const cap of caps) {
      const keywords = CAPABILITY_KEYWORDS[cap] ?? [];
      if (keywords.length === 0) continue;
      const matchCount = keywords.filter(kw => desc.includes(kw)).length;
      const score = matchCount / keywords.length;

      if (score > bestScore) {
        bestScore = score;
        bestCap = cap;
      }
    }

    if (bestScore > 0) {
      matches.push({ agentName, capability: bestCap, score: bestScore });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

/** Invalidate the capability cache (call when agent configs change). */
export function invalidateCapabilityCache(): void {
  capabilityCache = null;
  cacheTimestamp = 0;
}

/** Get the keyword list for a capability tag (for testing/introspection). */
export function getCapabilityKeywords(): Record<string, string[]> {
  return { ...CAPABILITY_KEYWORDS };
}

// ── Internal ────────────────────────────────────────────────────────

/**
 * Infer capabilities from existing config fields when `capabilities` is not set.
 * Backward-compatible: works with all existing agent configs.
 */
function inferCapabilities(cfg: AgentConfig): string[] {
  const caps: string[] = [];
  const text = `${cfg.description} ${cfg.name}`.toLowerCase();

  for (const [cap, keywords] of Object.entries(CAPABILITY_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      caps.push(cap);
    }
  }

  return caps.length > 0 ? caps : ['general'];
}
