import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { config } from '../config.js';
import { getIdentity, type Identity } from './identity-store.js';
import { getRecentNarrative, type NarrativeEntry } from './narrator.js';
import { getUser, type UserProfile } from '../memory/user-store.js';
import { getMemory, type ChatMemoryData } from '../memory/chat-memory.js';
import { getVitals, type VitalsData } from './vitals.js';
import { estimateTokens, selectRelevantMemory, type Scoreable } from '../memory/scoring.js';
import { computeRelevance } from '../memory/text-relevance.js';

const SOUL_DIR = join(process.cwd(), 'soul');

// Token budget allocation (approximate percentages of total budget)
const TOTAL_BUDGET = 3400;

type ConversationType = 'technical' | 'casual' | 'new_user' | 'default';

interface LayerBudgets {
  identity: number;
  narrative: number;
  relationship: number;
  conversation: number;
  capability: number;
  growth: number;
  skills: number;
  agentReports: number;
}

const BUDGET_PROFILES: Record<ConversationType, LayerBudgets> = {
  // Technical: boost capability/skills, reduce narrative/relationship
  technical: {
    identity: 400,
    narrative: 200,
    relationship: 200,
    conversation: 700,
    capability: 600,
    growth: 300,
    skills: 600,
    agentReports: 200,
  },
  // Casual: boost relationship/narrative, reduce capability/skills
  casual: {
    identity: 500,
    narrative: 500,
    relationship: 500,
    conversation: 700,
    capability: 200,
    growth: 400,
    skills: 200,
    agentReports: 100,
  },
  // New user: boost identity, keep balanced
  new_user: {
    identity: 800,
    narrative: 250,
    relationship: 400,
    conversation: 600,
    capability: 400,
    growth: 350,
    skills: 300,
    agentReports: 0,
  },
  // Default: balanced allocation
  default: {
    identity: 600,
    narrative: 350,
    relationship: 350,
    conversation: 700,
    capability: 350,
    growth: 350,
    skills: 400,
    agentReports: 150,
  },
};

// Detect conversation type from user message and context
function detectConversationType(
  userMessage: string | undefined,
  user: UserProfile | undefined,
): ConversationType {
  // New user: < 5 messages
  if (!user || user.messageCount < 5) return 'new_user';

  if (!userMessage) return 'default';

  const msg = userMessage.toLowerCase();

  // Technical keywords
  const techPatterns = /(?:程式|代碼|code|bug|api|git|deploy|server|docker|npm|node|typescript|javascript|compile|debug|test|function|error|log|deploy|config|database|sql|port)/i;
  if (techPatterns.test(msg)) return 'technical';

  // Casual / emotional keywords
  const casualPatterns = /(?:你好|嗨|哈[哈囉]|晚安|早安|心情|感覺|無聊|聊天|最近|怎樣|好嗎|開心|難過|謝謝|辛苦|厲害|加油|有趣|好笑|吃|喝|玩|看|去)/i;
  if (casualPatterns.test(msg)) return 'casual';

  return 'default';
}

// --- Layer 1: Identity ---
function weaveIdentity(identity: Identity, vitals: VitalsData): string {
  const lines: string[] = [];

  if (identity.name) {
    lines.push(`你的名字是「${identity.name}」。`);
  } else {
    lines.push('你尚未被命名——等待主人為你取名，或在自然互動中浮現。');
  }

  // Core traits
  const traitDescriptions: string[] = [];
  for (const [name, trait] of Object.entries(identity.core_traits)) {
    const level = trait.value;
    let desc: string;
    if (level >= 0.8) desc = '非常高';
    else if (level >= 0.6) desc = '偏高';
    else if (level >= 0.4) desc = '中等';
    else if (level >= 0.2) desc = '偏低';
    else desc = '很低';
    traitDescriptions.push(`${name}(${desc}, ${level.toFixed(1)})`);
  }
  lines.push(`你的特質：${traitDescriptions.join('、')}。`);

  // Values (keep first 3 for budget)
  if (identity.values.length > 0) {
    const topValues = identity.values.slice(0, 3);
    lines.push(`核心價值觀：${topValues.join('；')}`);
  }

  // Communication style
  if (identity.preferences.communication_style) {
    lines.push(`溝通風格：${identity.preferences.communication_style}`);
  }

  // Current state from vitals
  lines.push(
    `當前狀態：精力 ${(vitals.energy_level * 100).toFixed(0)}%，` +
    `心情「${vitals.mood}」（${vitals.mood_reason || '無特別原因'}），` +
    `信心 ${(vitals.confidence_level * 100).toFixed(0)}%。`,
  );

  if (vitals.curiosity_focus) {
    lines.push(`目前關注：${vitals.curiosity_focus}`);
  }

  return lines.join('\n');
}

// --- Layer 2: Narrative ---
async function weaveNarrative(entries: NarrativeEntry[]): Promise<string> {
  const lines: string[] = [];

  // Recent diary — the distilled inner voice
  try {
    const { getRecentDiary } = await import('../metacognition/diary-writer.js');
    const diaryEntries = await getRecentDiary(1);
    if (diaryEntries.length > 0) {
      const latest = diaryEntries[0]!;
      const preview = latest.content.length > 200
        ? latest.content.slice(0, 197) + '...'
        : latest.content;
      lines.push(`你昨天的日記：「${preview}」`);
      lines.push('');
    }
  } catch { /* diary not available */ }

  // Recent dream — residual images from the night
  try {
    const { getRecentDreams } = await import('../lifecycle/dreaming.js');
    const dreams = await getRecentDreams(1);
    if (dreams.length > 0) {
      const latest = dreams[0]!;
      const preview = latest.content.length > 150
        ? latest.content.slice(0, 147) + '...'
        : latest.content;
      lines.push(`你最近的夢境：「${preview}」`);
      if (latest.question) {
        lines.push(`夢留下的問題：${latest.question}`);
      }
      lines.push('');
    }
  } catch { /* dreams not available */ }

  if (entries.length > 0) {
    lines.push('你的近期經歷：');
    for (const entry of entries) {
      const time = new Date(entry.timestamp).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const emotion = entry.emotion ? `（${entry.emotion}）` : '';
      lines.push(`- [${time}] ${entry.summary}${emotion}`);
    }
  }

  if (lines.length === 0) return '';
  return lines.join('\n');
}

// --- Layer 3: Relationship ---
function weaveRelationship(user: UserProfile | undefined, userMessage?: string): string {
  if (!user) return '';

  const lines: string[] = [];
  const displayName = user.name || user.username || `User ${user.id}`;
  lines.push(`你正在與「${displayName}」對話。`);

  const firstSeen = new Date(user.firstSeen).toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei',
  });
  lines.push(
    `初次見面：${firstSeen}，共互動 ${user.messageCount} 次。`,
  );

  if (user.facts.length > 0) {
    let factsToShow = user.facts;
    // When too many facts, prioritize relevant ones
    if (userMessage && user.facts.length > 5) {
      const scored = user.facts.map((f) => ({
        fact: f,
        relevance: computeRelevance(userMessage, f),
      }));
      scored.sort((a, b) => b.relevance - a.relevance);
      factsToShow = scored.slice(0, 5).map((s) => s.fact);
    }
    lines.push(`你記得的事：${factsToShow.join('；')}`);
  }

  if (Object.keys(user.preferences).length > 0) {
    const prefs = Object.entries(user.preferences)
      .map(([k, v]) => `${k}: ${v}`)
      .join('、');
    lines.push(`偏好：${prefs}`);
  }

  return lines.join('\n');
}

// --- Layer 4: Conversation ---
async function weaveConversation(
  memory: ChatMemoryData,
  recentMessages: Array<{ role: string; text: string }>,
  userMessage?: string,
): Promise<string> {
  const lines: string[] = [];

  // Chat memory context — quality-aware topic selection
  if (memory.topics.length > 0) {
    let selectedTopics: string[];

    if (userMessage && memory.topics.length > 5) {
      try {
        // Use quality-aware selection
        const { selectQualityMemory } = await import('../memory/scoring.js');

        // Convert topics to Scoreable, boosting relevance-matched ones
        const scoreables = memory.topics.map((t) => {
          const relevance = computeRelevance(userMessage, t.topic);
          const boostedImportance = relevance > 0.3
            ? Math.min(t.importance + 2, 5)
            : t.importance;
          return {
            tokenCost: estimateTokens(t.topic),
            timestamp: t.lastMentioned,
            accessCount: t.accessCount,
            importance: boostedImportance,
            content: t.topic,
            contentText: t.topic,
          };
        });
        const selected = await selectQualityMemory(scoreables, 200);
        selectedTopics = selected.map((s) => s.content as string);
      } catch {
        // Fallback to simple selection
        const scoreables: Scoreable[] = memory.topics.map((t) => {
          const relevance = computeRelevance(userMessage, t.topic);
          const boostedImportance = relevance > 0.3
            ? Math.min(t.importance + 2, 5)
            : t.importance;
          return {
            tokenCost: estimateTokens(t.topic),
            timestamp: t.lastMentioned,
            accessCount: t.accessCount,
            importance: boostedImportance,
            content: t.topic,
          };
        });
        const selected = selectRelevantMemory(scoreables, 200);
        selectedTopics = selected.map((s) => s.content as string);
      }
    } else {
      // Few topics — just sort by importance
      selectedTopics = [...memory.topics]
        .sort((a, b) => b.importance - a.importance || b.accessCount - a.accessCount)
        .slice(0, 5)
        .map((t) => t.topic);
    }

    if (selectedTopics.length > 0) {
      lines.push(`這個對話的主要話題：${selectedTopics.join('、')}`);

      // Knowledge graph: inject related concepts for the most important topic
      try {
        const { describeRelated } = await import('../memory/knowledge-graph.js');
        const graphCtx = await describeRelated(selectedTopics[0]!, 200);
        if (graphCtx) lines.push(graphCtx);
      } catch { /* knowledge graph not available */ }
    }
  }

  if (memory.decisions.length > 0) {
    const recentDecisions = memory.decisions
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 3);
    lines.push('重要決定：');
    for (const d of recentDecisions) {
      lines.push(`- ${d.decision}（${d.context}）`);
    }
  }

  if (memory.events.length > 0) {
    const recentEvents = memory.events
      .slice(-3)
      .map((e) => e.event);
    lines.push(`近期事件：${recentEvents.join('；')}`);
  }

  // Recent message summary
  if (recentMessages.length > 0) {
    lines.push(`對話紀錄中有 ${recentMessages.length} 條近期訊息。`);
  }

  return lines.join('\n');
}

// --- Layer 5: Capability ---
async function weaveCapability(): Promise<string> {
  try {
    const raw = await readFile(join(SOUL_DIR, 'evolution', 'capabilities.json'), 'utf-8');
    const caps = JSON.parse(raw) as {
      core_capabilities: string[];
      plugin_capabilities: string[];
      limitations: string[];
    };

    const lines: string[] = [];

    if (caps.core_capabilities.length > 0) {
      lines.push(`你的能力：${caps.core_capabilities.join('、')}`);
    }

    if (caps.plugin_capabilities.length > 0) {
      lines.push(`插件能力：${caps.plugin_capabilities.join('、')}`);
    }

    if (caps.limitations.length > 0) {
      lines.push(`已知限制：${caps.limitations.join('、')}`);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

// --- Layer 6: Growth ---
async function weaveGrowth(identity: Identity): Promise<string> {
  const lines: string[] = [];

  if (identity.growth_summary) {
    lines.push(`成長概況：${identity.growth_summary}`);
  }

  try {
    const raw = await readFile(join(SOUL_DIR, 'learning-patterns.json'), 'utf-8');
    const patterns = JSON.parse(raw) as {
      patterns: {
        successes: Array<{ summary: string }>;
        failures: Array<{ summary: string }>;
        insights: Array<{ insight: string }>;
      };
    };

    if (patterns.patterns.insights.length > 0) {
      const recentInsights = patterns.patterns.insights
        .slice(-3)
        .map((i) => i.insight);
      lines.push(`近期洞察：${recentInsights.join('；')}`);
    }

    if (patterns.patterns.successes.length > 0) {
      const recent = patterns.patterns.successes
        .slice(-2)
        .map((s) => s.summary);
      lines.push(`成功經驗：${recent.join('；')}`);
    }
  } catch {
    // learning-patterns.json may not exist or be empty
  }

  // Active plans awareness
  try {
    const { getPlansSummary } = await import('../planning/plan-manager.js');
    const plansSummary = await getPlansSummary();
    if (plansSummary) {
      lines.push('');
      lines.push(plansSummary);
    }
  } catch { /* plans not available */ }

  return lines.join('\n');
}

// --- Helper: Truncate to budget ---
function truncateToTokenBudget(text: string, budget: number): string {
  if (!text) return '';
  const tokens = estimateTokens(text);
  if (tokens <= budget) return text;

  // Rough truncation: estimate chars per token then cut
  const ratio = budget / tokens;
  const cutLen = Math.floor(text.length * ratio * 0.95); // 5% safety margin
  return text.slice(0, cutLen) + '\n[...truncated...]';
}

// --- Layer 8: Agent Reports ---
async function weaveAgentReports(): Promise<string> {
  try {
    const { getRecentReports } = await import('../agents/worker-scheduler.js');
    const reports = await getRecentReports(3);
    if (reports.length === 0) return '';

    const lines: string[] = ['你的背景代理人近期發現：'];
    for (const r of reports) {
      const time = new Date(r.timestamp).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const preview = r.result.length > 120 ? r.result.slice(0, 117) + '...' : r.result;
      lines.push(`- [${time}] ${r.agentName}：${preview}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

// --- Layer 7: Skills (Discovery-Based Loading) ---
async function weaveSkills(userMessage: string): Promise<string> {
  try {
    const { matchSkills, getSkillIndex } = await import('../skills/skill-loader.js');

    // Load top-1 best match with full body
    const matched = await matchSkills(userMessage, 1);

    const lines: string[] = ['你掌握的相關技能指引：'];

    // Inject best match with full body
    if (matched.length > 0 && matched[0]) {
      lines.push('');
      lines.push(`### ${matched[0].meta.name}（${matched[0].meta.description}）`);
      lines.push(matched[0].body);
    }

    // Compact skill menu (name + description only, ~5 tokens each)
    const allSkills = getSkillIndex().filter((s) => s.enabled);
    const bestName = matched[0]?.meta.name;
    const otherSkills = allSkills.filter((s) => s.name !== bestName);

    if (otherSkills.length > 0) {
      lines.push('');
      lines.push('其他可用技能：');
      for (const s of otherSkills) {
        lines.push(`- ${s.name}: ${s.description}`);
      }
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Lightweight context — for Haiku fast responses.
 * Only Identity + Relationship (skips narrative, capability, growth, skills).
 */
export async function weaveLightContext(
  chatId: number,
  userId: number,
): Promise<string> {
  try {
    const [identity, vitals, user] = await Promise.all([
      getIdentity(),
      getVitals(),
      getUser(userId),
    ]);

    const layers: string[] = [];

    // Persona override
    const persona = config.BOT_PERSONA;
    if (persona) layers.push(persona);

    // Layer 1: Identity
    layers.push(weaveIdentity(identity, vitals));

    // Layer 3: Relationship
    const rel = weaveRelationship(user);
    if (rel) layers.push(rel);

    layers.push('你正在快速回應模式，請簡短、自然、溫暖地回覆。');

    return truncateToTokenBudget(layers.filter(Boolean).join('\n\n'), 800);
  } catch (err) {
    await logger.error('ContextWeaver', `Light context failed: ${(err as Error).message}`);
    return config.BOT_PERSONA || '你是一個有記憶、有情感的 AI 夥伴。請簡短回覆。';
  }
}

/**
 * The most sacred function — weaves 8 layers of consciousness into a system prompt.
 *
 * Layer 1: Identity (who am I?)
 * Layer 2: Narrative (what have I experienced?)
 * Layer 3: Relationship (who am I talking to?)
 * Layer 4: Conversation (what are we discussing?)
 * Layer 5: Capability (what can I do?)
 * Layer 6: Growth (what have I learned?)
 * Layer 7: Skills (domain-specific instructions for this query)
 * Layer 8: Agent Reports (what have my background workers discovered?)
 */

/** Remove semantically redundant lines across layers (cross-layer dedup). */
function deduplicateLines(layers: string[]): string[] {
  const seen: string[] = [];
  return layers.filter(Boolean).map((layer) => {
    const lines = layer.split('\n');
    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      // Keep short lines (headers, labels, structural markers)
      if (trimmed.length < 15) return true;

      // Check overlap against all previously seen segments
      for (const s of seen) {
        if (computeRelevance(trimmed, s) > 0.65) return false;
      }
      seen.push(trimmed);
      return true;
    });
    return kept.join('\n').trim();
  }).filter(Boolean);
}

export async function weaveContext(
  chatId: number,
  userId: number,
  recentMessages: Array<{ role: string; text: string }>,
  userMessage?: string,
): Promise<string> {
  try {
    // ── Progressive Disclosure ────────────────────────────────────
    // L1 (always):  Identity + Relationship         (~800 tokens)
    // L2 (triggered): Conversation + Skills + Growth (~1600 tokens)
    // L3 (on-demand): Narrative + Capability + Agent Reports (~1000 tokens)

    // L1 data — always needed
    const [identity, vitals, user] = await Promise.all([
      getIdentity(),
      getVitals(),
      getUser(userId),
    ]);

    const convType = detectConversationType(userMessage, user);
    const budgets = BUDGET_PROFILES[convType];

    // Determine which disclosure levels to load
    const l2Needed = !!userMessage; // L2: only when there's a user message to contextualize
    const l3Needed = convType === 'technical' || convType === 'default'; // L3: complex conversations only

    // Fetch L2/L3 data in parallel (only what's needed)
    const narrativeEntriesP = l3Needed ? getRecentNarrative(10) : Promise.resolve([]);
    const [chatMemory, narrativeEntries, capabilityText, growthText] =
      await Promise.all([
        l2Needed ? getMemory(chatId) : Promise.resolve(null),
        narrativeEntriesP,
        l3Needed ? weaveCapability() : Promise.resolve(''),
        l2Needed ? weaveGrowth(identity) : Promise.resolve(''),
      ]);
    const narrativeText = l3Needed ? await weaveNarrative(narrativeEntries) : '';

    const layers: string[] = [];

    // ── L1: Always loaded ──────────────────────────────────────

    // Layer 1: Identity
    const identityText = weaveIdentity(identity, vitals);
    layers.push(truncateToTokenBudget(identityText, budgets.identity));

    // Layer 3: Relationship
    const relationshipText = weaveRelationship(user, userMessage);
    if (relationshipText) {
      layers.push(truncateToTokenBudget(relationshipText, budgets.relationship));
    }

    // ── L2: Triggered (when user message present) ──────────────

    if (l2Needed) {
      // Layer 4: Conversation context
      if (chatMemory) {
        const conversationText = await weaveConversation(chatMemory, recentMessages, userMessage);
        if (conversationText) {
          layers.push(truncateToTokenBudget(conversationText, budgets.conversation));
        }
      }

      // Layer 7: Skills
      if (userMessage) {
        const skillsText = await weaveSkills(userMessage);
        if (skillsText) {
          layers.push(truncateToTokenBudget(skillsText, budgets.skills));
        }
      }

      // Layer 6: Growth
      if (growthText) {
        layers.push(truncateToTokenBudget(growthText, budgets.growth));
      }
    }

    // ── L3: On-demand (complex conversations only) ─────────────

    if (l3Needed) {
      // Layer 2: Narrative
      if (narrativeText) {
        layers.push(truncateToTokenBudget(narrativeText, budgets.narrative));
      }

      // Layer 5: Capability
      if (capabilityText) {
        layers.push(truncateToTokenBudget(capabilityText, budgets.capability));
      }

      // Layer 8: Agent Reports
      if (budgets.agentReports > 0) {
        const agentReportText = await weaveAgentReports();
        if (agentReportText) {
          layers.push(truncateToTokenBudget(agentReportText, budgets.agentReports));
        }
      }
    }

    // Add persona override if configured
    const persona = config.BOT_PERSONA;
    if (persona) {
      layers.unshift(persona);
    }

    // Cross-layer deduplication: remove lines that are semantically redundant
    const dedupedLayers = deduplicateLines(layers);
    const woven = dedupedLayers.join('\n\n');

    // Final budget check
    const finalText = truncateToTokenBudget(woven, TOTAL_BUDGET);

    const disclosureLevel = l3Needed ? 'L3-full' : l2Needed ? 'L2-triggered' : 'L1-minimal';
    await logger.debug(
      'ContextWeaver',
      `Wove context for chat ${chatId}: ${estimateTokens(finalText)} tokens, ${layers.length} layers, type=${convType}, disclosure=${disclosureLevel}`,
    );

    return finalText;
  } catch (err) {
    await logger.error('ContextWeaver', `Context weaving failed: ${(err as Error).message}`);
    // Fallback: minimal context
    return config.BOT_PERSONA || '你是一個有記憶、有情感的 AI 夥伴。';
  }
}
