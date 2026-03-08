/**
 * MemoryManager agent — handles knowledge CRUD operations,
 * memory compression, and scored retrieval.
 */

import { type Agent, type AgentMessage, type AgentResponse, AgentRole } from './types.js';
import { logger } from '../core/logger.js';
import { computeRelevance } from '../memory/text-relevance.js';

export const memoryManager: Agent = {
  role: AgentRole.MemoryManager,

  async handle(msg: AgentMessage): Promise<AgentResponse> {
    switch (msg.type) {
      case 'store_memory':
        return handleStoreMemory(msg);
      case 'retrieve_memory':
        return handleRetrieveMemory(msg);
      case 'store_fact':
        return handleStoreFact(msg);
      case 'get_user':
        return handleGetUser(msg);
      case 'search_memory':
        return handleSearchMemory(msg);
      case 'compress_memory':
        return handleCompressMemory(msg);
      case 'memory_op':
        return handleGenericMemoryOp(msg);
      default:
        return { success: false, error: `MemoryManager cannot handle: ${msg.type}` };
    }
  },
};

/** Store a memory (topic, decision, or event) */
async function handleStoreMemory(msg: AgentMessage): Promise<AgentResponse> {
  const { chatId, type, data } = msg.payload as {
    chatId: number;
    type: string;
    data: Record<string, unknown>;
  };

  try {
    const chatMemory = await import('../memory/chat-memory.js');

    switch (type) {
      case 'topic':
        await chatMemory.addTopic(
          chatId,
          (data.topic as string) ?? String(data),
          data.importance as number | undefined,
        );
        break;
      case 'decision':
        await chatMemory.addDecision(
          chatId,
          (data.decision as string) ?? String(data),
          (data.context as string) ?? '',
          data.importance as number | undefined,
        );
        break;
      case 'event':
        await chatMemory.addEvent(
          chatId,
          (data.event as string) ?? String(data),
          data.participants as number[] | undefined,
          data.importance as number | undefined,
        );
        break;
      default:
        return { success: false, error: `Unknown memory type: ${type}` };
    }

    await logger.info('memory-manager', `Stored ${type} for chat ${chatId}`);
    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await logger.error('memory-manager', `Failed to store memory: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/** Retrieve all memories for a chat */
async function handleRetrieveMemory(msg: AgentMessage): Promise<AgentResponse> {
  const { chatId } = msg.payload as { chatId: number };

  try {
    const chatMemory = await import('../memory/chat-memory.js');
    const memory = await chatMemory.getMemory(chatId);
    return { success: true, data: memory };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}

/** Store a fact about a user */
async function handleStoreFact(msg: AgentMessage): Promise<AgentResponse> {
  const { userId, fact } = msg.payload as { userId: number; fact: string };

  try {
    const userStore = await import('../memory/user-store.js');
    await userStore.addFact(userId, fact);
    await logger.info('memory-manager', `Stored fact for user ${userId}`);
    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}

/** Get user profile */
async function handleGetUser(msg: AgentMessage): Promise<AgentResponse> {
  const { userId } = msg.payload as { userId: number };

  try {
    const userStore = await import('../memory/user-store.js');
    const user = await userStore.getUser(userId);
    return { success: true, data: user };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}

/** Search memories across chats, narrative, and learning patterns using CJK-aware relevance */
async function handleSearchMemory(msg: AgentMessage): Promise<AgentResponse> {
  const { query, chatId } = msg.payload as { query: string; chatId?: number };
  await logger.info('memory-manager', `Searching memory: "${query}"`);

  // Try BM25 index first (fast path)
  try {
    const { searchIndex } = await import('../memory/search-index.js');
    if (searchIndex.isInitialized) {
      const indexed = searchIndex.search(query, 20);
      if (indexed.length > 0) {
        await logger.debug('memory-manager', `BM25 index returned ${indexed.length} results`);
        return {
          success: true,
          data: {
            query,
            results: indexed.map((r) => ({
              chatId: (r.doc.metadata?.chatId as number) ?? undefined,
              type: r.doc.source,
              content: r.doc.text,
              score: r.score,
            })),
            totalMatches: indexed.length,
            source: 'bm25-index',
          },
        };
      }
    }
  } catch {
    // Index not available, fall through to Layer 1
  }

  // Fallback: Layer 1 linear scan
  try {
    const results: Array<{ chatId?: number; type: string; content: string; score: number }> = [];

    // 1. Search chat memory (topics, decisions, events)
    if (chatId) {
      const chatMemory = await import('../memory/chat-memory.js');
      try {
        const memory = await chatMemory.getMemory(chatId);
        if (memory) {
          for (const topic of memory.topics) {
            const score = computeRelevance(query, topic.topic);
            if (score > 0.1) {
              results.push({ chatId, type: 'topic', content: topic.topic, score });
            }
          }
          for (const decision of memory.decisions) {
            const text = `${decision.decision}（${decision.context}）`;
            const score = computeRelevance(query, text);
            if (score > 0.1) {
              results.push({ chatId, type: 'decision', content: text, score });
            }
          }
          for (const event of memory.events) {
            const score = computeRelevance(query, event.event);
            if (score > 0.1) {
              results.push({ chatId, type: 'event', content: event.event, score });
            }
          }
        }
      } catch {
        // Skip inaccessible chat
      }
    }

    // 2. Search narrative entries
    try {
      const { searchNarrative } = await import('../identity/narrator.js');
      const narrativeResults = await searchNarrative(query, 10);
      for (const entry of narrativeResults) {
        results.push({
          type: 'narrative',
          content: entry.summary,
          score: entry.score,
        });
      }
    } catch {
      // narrator search not available
    }

    // 3. Search learning patterns
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const raw = await readFile(join(process.cwd(), 'soul', 'learning-patterns.json'), 'utf-8');
      const patterns = JSON.parse(raw) as {
        patterns: {
          successes: Array<{ details: string; category: string }>;
          failures: Array<{ details: string; category: string }>;
          insights: Array<{ insight: string }>;
        };
      };

      for (const s of patterns.patterns.successes) {
        const score = computeRelevance(query, s.details);
        if (score > 0.15) {
          results.push({ type: 'learning-success', content: s.details, score });
        }
      }
      for (const insight of patterns.patterns.insights) {
        const score = computeRelevance(query, insight.insight);
        if (score > 0.15) {
          results.push({ type: 'learning-insight', content: insight.insight, score });
        }
      }
    } catch {
      // learning patterns not available
    }

    results.sort((a, b) => b.score - a.score);

    return {
      success: true,
      data: {
        query,
        results: results.slice(0, 20),
        totalMatches: results.length,
      },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}

/** Compress old memories to save space */
async function handleCompressMemory(msg: AgentMessage): Promise<AgentResponse> {
  const { chatId } = msg.payload as { chatId?: number };
  await logger.info('memory-manager', `Compressing memories${chatId ? ` for chat ${chatId}` : ''}`);

  try {
    const chatMemory = await import('../memory/chat-memory.js');

    if (chatId) {
      const memory = await chatMemory.getMemory(chatId);
      if (!memory) {
        return { success: true, data: { compressed: false, reason: 'No memory found' } };
      }

      // Report current memory state
      const counts = {
        topics: memory.topics.length,
        decisions: memory.decisions.length,
        events: memory.events.length,
      };

      return {
        success: true,
        data: {
          compressed: false,
          chatId,
          memoryCounts: counts,
          note: 'Compression available for high-volume chats',
        },
      };
    }

    return {
      success: true,
      data: { compressed: false, note: 'Provide chatId for targeted compression' },
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}

/** Handle generic memory_op dispatching */
async function handleGenericMemoryOp(msg: AgentMessage): Promise<AgentResponse> {
  const { operation, chatId, userId, query, key, value } = msg.payload as {
    operation: string;
    chatId?: number;
    userId?: number;
    query?: string;
    key?: string;
    value?: unknown;
  };

  switch (operation) {
    case 'read':
      if (chatId) {
        return handleRetrieveMemory({ ...msg, type: 'retrieve_memory', payload: { chatId } });
      }
      if (userId) {
        return handleGetUser({ ...msg, type: 'get_user', payload: { userId } });
      }
      return { success: false, error: 'Specify chatId or userId for read operation' };

    case 'write':
      if (chatId && key && value) {
        return handleStoreMemory({ ...msg, type: 'store_memory', payload: { chatId, type: key, data: value } });
      }
      if (userId && value) {
        return handleStoreFact({ ...msg, type: 'store_fact', payload: { userId, fact: String(value) } });
      }
      return { success: false, error: 'Insufficient parameters for write operation' };

    case 'search':
      return handleSearchMemory({ ...msg, type: 'search_memory', payload: { query: query ?? '', chatId } });

    case 'compress':
      return handleCompressMemory({ ...msg, type: 'compress_memory', payload: { chatId } });

    default:
      return { success: false, error: `Unknown memory operation: ${operation}` };
  }
}

